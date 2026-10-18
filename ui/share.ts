/**
 * URL 共有（#72。設計 docs/design.md M8・13.4）: 作業中のタブ 1 つを URL のフラグメントに入れる・読む。
 *
 * 形式（URL の版 1）: `#p=1.<データ>`。データ = 1 ポジションの文書（ui/persist.ts の toSaved。版 1。保存一覧の項目・
 * 書き出しファイルと同じ）に任意の `name`（タブの名前）を足した JSON → UTF-8 → gzip → base64url（`=` なし）。
 * - gzip の CRC32・元の長さで、途中で切れた・1 字化けた URL を「壊れている」として検出する（別の値の足として開かない）
 * - 版は 2 段: URL の版（入れ物 = 圧縮・符号化。SHARE_VERSION）と文書の版（JSON の schema_version。
 *   readWorkspaceValue / POSITION_MIGRATIONS が読み替える）。版を上げるときは読み手を版ごとに足し、
 *   tests/ui/saved/share-v1.json は変えない
 * - 外から来た値として扱う: 字数・展開後の大きさに上限、TextDecoder は fatal、JSON.parse の例外を捕まえ、
 *   検証は保存一覧と同じ readWorkspaceValue（既知のキーだけ組み立て直す。`__proto__` を写さない）。
 *   名前はタブの名前と同じ正規化（制御文字・双方向の制御を除き 12 字まで）
 * - 変換・検証は純関数（圧縮だけ非同期。圧縮の関数は引数で差し替えられる = テストで非対応・失敗を作る）
 */

import { isObj, own, readWorkspaceValue, type SavedWorkspaceV1 } from './persist';
import { type Action, MAX_TABS, sanitizeTabName, type UiLeg } from './state';

// ---------------------------------------------------------------- 定数（オーナー確認の対象はここに 1 か所）

/** フラグメントのキー（`#p=...`）。これで始まらないフラグメントは扱わない（消さない） */
export const SHARE_PARAM = 'p';
/** URL の版（入れ物 = gzip + base64url） */
export const SHARE_VERSION = 1;
/** 作るとき: URL 全体がこの字数を超えたら注意（メール・一部のアプリで切れることがある。オーナー確認の対象） */
export const URL_WARN = 2_000;
/** 作るとき: URL 全体がこの字数を超えたら作らない（保存一覧の書き出しを使う。オーナー確認の対象） */
export const URL_MAX = 8_000;
/** 読むとき: フラグメントがこの字数を超えたら復号しない */
export const FRAGMENT_MAX = 16_384;
/** 読むとき: 展開した JSON がこのバイト数を超えたら打ち切る（展開爆弾。足 200 本の JSON 約 3.2 万字の 8 倍） */
export const INFLATED_MAX = 262_144;
/** URL にタブの名前を入れるか（オーナー確認の対象。読み手は名前が無くても開く） */
export const SHARE_CARRIES_NAME: boolean = true;

const PREFIX = `#${SHARE_PARAM}=`;

// ---------------------------------------------------------------- base64url

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  Array.from(B64, (c, i) => [c, i]),
);

/** バイト列 → base64url（`=` なし）。 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      B64.charAt((n >> 18) & 63) +
      B64.charAt((n >> 12) & 63) +
      B64.charAt((n >> 6) & 63) +
      B64.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63);
  }
  return out;
}

/**
 * base64url（`=` なし）→ バイト列。知らない字・ありえない長さ（4 で割って 1 余る）・末尾の使わないビットが 0 でない
 * （途中で切れた・化けた）なら null。
 */
export function fromBase64Url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of s) {
    const v = Object.hasOwn(B64_INDEX, c) ? B64_INDEX[c] : undefined;
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) return null;
  return out;
}

// ---------------------------------------------------------------- 圧縮（差し替えられる）

export type GunzipResult =
  | { kind: 'ok'; bytes: Uint8Array }
  /** 展開が上限を超えた（打ち切った） */
  | { kind: 'tooLarge' }
  /** gzip でない・途中で切れた・CRC / 長さが合わない */
  | { kind: 'invalid' };

export interface ShareCodec {
  gzip(bytes: Uint8Array): Promise<Uint8Array>;
  gunzip(bytes: Uint8Array, max: number): Promise<GunzipResult>;
}

/** このブラウザで圧縮・展開できるか（CompressionStream は Safari / iOS 16.4+・Firefox 113+・Chrome 80+）。 */
export function shareSupported(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** ブラウザ（と Node）の CompressionStream / DecompressionStream を使う圧縮。 */
export const streamCodec: ShareCodec = {
  async gzip(bytes) {
    const reader = streamOf(bytes)
      .pipeThrough(new CompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>)
      .getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    return concat(chunks, total);
  },
  async gunzip(bytes, max) {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = streamOf(bytes)
        .pipeThrough(
          new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>,
        )
        .getReader();
    } catch {
      return { kind: 'invalid' };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          // 残りを展開しない（展開爆弾）
          reader.cancel().catch(() => {});
          return { kind: 'tooLarge' };
        }
        chunks.push(value);
      }
    } catch {
      return { kind: 'invalid' };
    }
    return { kind: 'ok', bytes: concat(chunks, total) };
  },
};

/** 既定の圧縮（非対応のブラウザなら null）。 */
export function defaultCodec(): ShareCodec | null {
  return shareSupported() ? streamCodec : null;
}

// ---------------------------------------------------------------- フラグメントの形

export type ParsedHash =
  /** `#p=` で始まらない（扱わない） */
  | { kind: 'none' }
  | { kind: 'tooLong' }
  | { kind: 'invalid' }
  /** 新しい URL の版 */
  | { kind: 'newer'; version: number }
  | { kind: 'data'; bytes: Uint8Array };

/** location.hash（`#` 込み）の形を見る（復号はしない）。 */
export function parseShareHash(hash: string): ParsedHash {
  if (!hash.startsWith(PREFIX)) return { kind: 'none' };
  if (hash.length > FRAGMENT_MAX) return { kind: 'tooLong' };
  const m = /^(\d{1,3})\.([A-Za-z0-9_-]+)$/.exec(hash.slice(PREFIX.length));
  if (!m) return { kind: 'invalid' };
  const version = Number(m[1]);
  if (version < 1) return { kind: 'invalid' };
  if (version > SHARE_VERSION) return { kind: 'newer', version };
  const bytes = fromBase64Url(m[2] ?? '');
  return bytes === null ? { kind: 'invalid' } : { kind: 'data', bytes };
}

/** フラグメントの付いた URL か（`#p=` で始まる。消す対象）。 */
export function isShareHash(hash: string): boolean {
  return hash.startsWith(PREFIX);
}

// ---------------------------------------------------------------- 作る

/** URL に入れる JSON（1 ポジションの文書 + 任意のタブの名前。読み手は知らないキーを無視する） */
export type SharedDocV1 = SavedWorkspaceV1 & { name?: string };

export type ShareMake =
  /** long = URL_WARN を超えた（注意を添える） */
  | { kind: 'ok'; url: string; length: number; long: boolean }
  /** URL_MAX を超えた（作らない） */
  | { kind: 'tooLong'; length: number }
  /** このブラウザでは作れない */
  | { kind: 'unsupported' }
  /** 圧縮に失敗した */
  | { kind: 'failed' };

/**
 * 1 ポジションの文書から URL を作る。base = フラグメントを除いた URL（origin + pathname + search）。
 * name はタブの名前（正規化して入れる。空なら入れない）。
 */
export async function encodeShareUrl(
  doc: SavedWorkspaceV1,
  name: string,
  base: string,
  codec: ShareCodec | null = defaultCodec(),
): Promise<ShareMake> {
  if (codec === null) return { kind: 'unsupported' };
  const clean = sanitizeTabName(name);
  const body: SharedDocV1 = SHARE_CARRIES_NAME && clean !== '' ? { ...doc, name: clean } : doc;
  let gz: Uint8Array;
  try {
    gz = await codec.gzip(new TextEncoder().encode(JSON.stringify(body)));
  } catch {
    return { kind: 'failed' };
  }
  const url = `${base}${PREFIX}${SHARE_VERSION}.${toBase64Url(gz)}`;
  const length = url.length;
  if (length > URL_MAX) return { kind: 'tooLong', length };
  return { kind: 'ok', url, length, long: length > URL_WARN };
}

// ---------------------------------------------------------------- 読む

/** 開ける共有（検証済み） */
export interface SharedPosition {
  legs: Array<Omit<UiLeg, 'id'>>;
  scenario: SavedWorkspaceV1['position']['scenario'];
  feePerLot: number;
  futureBasis: 'fixed' | 'decay';
  /** タブの名前（正規化済み。無ければ空文字） */
  name: string;
  /** 共有した時刻（読めなければ null） */
  savedAt: number | null;
  /** 共有したときの板の時刻（無ければ null） */
  boardSnapshotAt: number | null;
}

export type ShareRead =
  | { kind: 'none' }
  | { kind: 'ok'; shared: SharedPosition }
  /** 壊れている・途中で切れた・1 字化けた・足を読めない */
  | { kind: 'invalid' }
  /** フラグメントが長すぎる（復号しない） */
  | { kind: 'tooLong' }
  /** 展開が大きすぎる（打ち切った） */
  | { kind: 'tooLarge' }
  /** 新しい版（URL の版か文書の版） */
  | { kind: 'newer' }
  /** 足が 0 本 */
  | { kind: 'noLegs' }
  /** このブラウザでは展開できない */
  | { kind: 'unsupported' };

/** 展開した JSON の文字列を検証する（純関数。readShareHash の後半）。 */
export function readSharedText(text: string): ShareRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  const r = readWorkspaceValue(raw);
  if (r.kind === 'newer') return { kind: 'newer' };
  if (r.kind !== 'ok' || r.dropped || r.saved.position === null) return { kind: 'invalid' };
  const { position, ui, savedAt } = r.saved;
  if (position.legs.length === 0) return { kind: 'noLegs' };
  const rawName = isObj(raw) ? own(raw, 'name') : undefined;
  return {
    kind: 'ok',
    shared: {
      legs: position.legs,
      scenario: position.scenario,
      feePerLot: ui.feePerLot,
      futureBasis: ui.futureBasis,
      name: SHARE_CARRIES_NAME && typeof rawName === 'string' ? sanitizeTabName(rawName) : '',
      savedAt,
      boardSnapshotAt: position.boardSnapshotAt,
    },
  };
}

/** location.hash を読んで検証する（`#p=` で始まらなければ none）。落ちない（例外を投げない）。 */
export async function readShareHash(
  hash: string,
  codec: ShareCodec | null = defaultCodec(),
): Promise<ShareRead> {
  const p = parseShareHash(hash);
  if (p.kind !== 'data') return p.kind === 'newer' ? { kind: 'newer' } : p;
  if (codec === null) return { kind: 'unsupported' };
  let g: GunzipResult;
  try {
    g = await codec.gunzip(p.bytes, INFLATED_MAX);
  } catch {
    return { kind: 'invalid' };
  }
  if (g.kind !== 'ok') return g;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(g.bytes);
  } catch {
    return { kind: 'invalid' };
  }
  return readSharedText(text);
}

// ---------------------------------------------------------------- 開き方

/**
 * 共有を開く先（オーナー確認の対象）: 作業中のタブが足 0 本ならそのタブ（replace）、足があれば新しいタブ（newTab。
 * 作業中の内容を置き換えないので確認しない）、タブが上限なら作業中のタブを置き換えるかを確かめる（full）。
 */
export function shareOpenMode(
  tabCount: number,
  activeLegCount: number,
): 'replace' | 'newTab' | 'full' {
  if (activeLegCount === 0) return 'replace';
  return tabCount >= MAX_TABS ? 'full' : 'newTab';
}

/**
 * 共有を開く reducer の操作。URL から入れるのは**足と名前だけ**（main の決定）: シナリオ・手数料・先物の basis は
 * null（受け手の今の値のまま。全タブ共通の値を他人の URL で変えない）。表示の設定はもともと開く操作で変えない。
 * URL の文書には保存一覧と同じくシナリオ等が入っているが、この経路では使わない（保存一覧の [開く] は従来どおり適用）。
 */
export function shareOpenAction(shared: SharedPosition, mode: 'replace' | 'newTab'): Action {
  return {
    type: mode === 'replace' ? 'openPosition' : 'openPositionInNewTab',
    legs: shared.legs,
    scenario: null,
    feePerLot: null,
    futureBasis: null,
    name: shared.name,
  };
}

/**
 * `location.search` から `ui` のクエリだけを落とす（#91。共有 URL の base と `#p=` を開いた後の URL。docs/ui-redesign.md 10.1）。
 * `&` で分けた断片のうち、キーを `URLSearchParams` と同じ規則で復号した値が `ui` のものだけを除き、残りは入力の文字列のまま
 * 同じ順でつなぐ（再直列化しない = `%20` などを書き換えない）。空の断片は捨てる。残りが無ければ `''`。例外を投げない
 */
export function withoutUiParam(search: string): string {
  const body = search.startsWith('?') ? search.slice(1) : search;
  const kept = body.split('&').filter((part) => {
    if (part === '') return false;
    // 先頭に & を付けて渡す（URLSearchParams は文字列の先頭の ? を 1 つ捨てるので、断片の ? を残すため）
    // 断片は 1 つなので、has('ui') = その断片のキーが ui
    return !new URLSearchParams(`&${part}`).has('ui');
  });
  return kept.length ? `?${kept.join('&')}` : '';
}
