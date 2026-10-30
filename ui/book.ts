/**
 * ポジ帳（名前を付けて保存したポジションの一覧）の保存形式・検証・操作・書き出し / 読み込み（純関数）。
 * 設計 docs/design.md M8・13.4（#70）。
 *
 * - 保存は端末ごと（localStorage の 1 キーに全件）。I/O は ui/bookIo.ts、画面は ui/next/BookDialog.tsx
 * - 入れ物は版つき（`schema_version`）。項目の中身は 1 ポジションの文書（#23 の作業の形式 版 1 = `POSITION_DOC_VERSION`）
 *   そのもので、検証・読み替えは ui/persist.ts の readWorkspaceValue と共有する。#71 で作業のキーは版 2（タブの並び）に
 *   上がったが、項目・書き出すファイルは 1 ポジションの文書の版 1 のまま（ロールバックした画面でも一覧を読める）
 * - 外から来た値として扱う（localStorage・読み込むファイル）: 既知のキーだけで組み立て直す・`own()` で読む・
 *   配列の長さと文字数を先に切る。名前は制御文字・双方向の制御を除いて 40 字。表示は JSX のテキストだけ
 * - 読めない項目・新しい版の項目は勝手に消さない（読んだ値のまま書き戻す。削除だけできる）
 * - 件数・容量の上限を超える変更は断る（一部だけ入れない）
 *
 * 上限・既定（件数 100・文字数 100 万字・名前 40 字・ファイル 2MB）はこのファイルの定数だけで決める。
 */

import type { Leg, Scenario } from '../model';
import { cleanName, clipCodePoints } from './names';
import {
  isObj,
  type Obj,
  own,
  POSITION_DOC_VERSION,
  readTime,
  readWorkspaceValue,
  type SavedWorkspaceV1,
  savedFromWorkspace,
  savedLeg,
  savedScenario,
  type Workspace,
} from './persist';
import { fmtDateTime, fmtNum } from './view/format';

/** ポジ帳の保存のキー（作業のキー option-simulator.workspace とは別） */
export const BOOK_KEY = 'option-simulator.book';
export const BOOK_SCHEMA_VERSION = 1;
/** 項目数の上限（保存・複製・読み込みで超えるなら断る） */
export const MAX_ENTRIES = 100;
/** 読むときの項目数の上限（これを超える入れ物は壊れているとみなす。巨大な配列で固まらない） */
export const MAX_ENTRIES_READ = 500;
/** 直列化した文字数の上限（作業の数千字 + 板の約 33 万字と合わせても origin の上限の 3 割未満） */
export const BOOK_MAX_CHARS = 1_000_000;
/** 「残りが少ない」を出す割合 */
export const BOOK_WARN_RATIO = 0.8;
/** 名前の長さの上限（コードポイント数） */
export const NAME_MAX = 40;
/** 読み込むファイルの大きさの上限（バイト） */
export const IMPORT_MAX_BYTES = 2_000_000;
/** 足から名前が作れないときの名前 */
export const FALLBACK_NAME = 'ポジション';

/** 開ける作業（足・シナリオが読めた） */
export type OpenableWorkspace = Workspace & { position: NonNullable<Workspace['position']> };

export interface OkEntry {
  status: 'ok';
  id: string;
  name: string;
  /** 作った時刻（読めなければ null） */
  createdAt: number | null;
  /** 書くときの形（検証済みの値から組み立て直したもの） */
  saved: SavedWorkspaceV1;
  /** 検証済みの作業 */
  ws: OpenableWorkspace;
}

/** 読めない（invalid）・新しい版（newer）の項目。読んだ値のまま持ち、そのまま書き戻す */
export interface BadEntry {
  status: 'invalid' | 'newer';
  id: string;
  raw: unknown;
  /** 保存の時刻（読めれば） */
  savedAt: number | null;
}

export type BookEntry = OkEntry | BadEntry;

export interface Book {
  entries: BookEntry[];
}

export const EMPTY_BOOK: Book = { entries: [] };

export type BookRead =
  /** 保存が無い */
  | { kind: 'empty' }
  /** 入れ物が読めない（勝手に消さない。[空にする] だけ） */
  | { kind: 'invalid' }
  /** 新しい版の入れ物（読まない・書かない） */
  | { kind: 'newer'; version: number }
  /** 読めた。chars = 保存の文字数 */
  | { kind: 'ok'; book: Book; chars: number };

/** 操作が断られた理由（文言は ui/view/bookList.ts） */
export type BookFail =
  | 'full'
  | 'tooLarge'
  | 'notFound'
  | 'emptyName'
  | 'noLegs'
  | 'importInvalid'
  | 'importNewer'
  | 'importEmpty'
  | 'fileTooLarge';

export type BookOp =
  | { ok: true; book: Book; text: string; added?: number; skipped?: number }
  | { ok: false; reason: BookFail };

// ---------------------------------------------------------------- 名前

/** 先頭から max コードポイントまで（サロゲートペアを割らない）。 */
export function clipName(s: string, max: number = NAME_MAX): string {
  return clipCodePoints(s, max);
}

/** 名前の正規化: 制御文字・双方向の制御を除き、前後の空白を取り、40 字で切る（空なら空文字。ui/names.ts）。 */
export function sanitizeName(s: string): string {
  return cleanName(s, NAME_MAX);
}

const SIDE_SHORT = { buy: '買', sell: '売' } as const;
const FUTURE_SHORT = { fut_large: 'ラージ先物', fut_mini: 'ミニ先物', fut_micro: 'マイクロ先物' };

function legShort(leg: Leg): string {
  if (leg.kind === 'future') return `${SIDE_SHORT[leg.side]}${FUTURE_SHORT[leg.product]}`;
  return `${SIDE_SHORT[leg.side]}${leg.type === 'put' ? 'P' : 'C'}${fmtNum(leg.strike)}`;
}

/** 既定の名前（`2026-11 売P64,000 売C70,500 買P60,000 他2本`。40 字に収まるよう本数を減らす）。 */
export function defaultName(legs: readonly Leg[]): string {
  if (legs.length === 0) return FALLBACK_NAME;
  const months = [...new Set(legs.flatMap((l) => (l.kind === 'option' ? [l.expiry] : [])))].sort();
  const head = months.length >= 3 ? `${months[0]}〜` : months.join('・');
  const shorts = legs.map(legShort);
  const build = (n: number) =>
    `${head ? `${head} ` : ''}${shorts.slice(0, n).join(' ')}${shorts.length > n ? ` 他${shorts.length - n}本` : ''}`;
  // 先頭 3 本まで。40 字に収まらなければ本数を減らして「他 N 本」に回す（1 本でも収まらなければ切る）
  let n = Math.min(3, shorts.length);
  while (n > 1 && Array.from(build(n)).length > NAME_MAX) n--;
  return sanitizeName(build(n)) || FALLBACK_NAME;
}

/** 同名があれば ` (2)`・` (3)`…を付ける（40 字に収める）。 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const cand = `${clipName(name, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(cand)) return cand;
  }
}

/** 複製の名前（`<名前> (コピー)`。40 字に収まるよう元の名前を切る）。 */
export function copyName(name: string): string {
  const suffix = ' (コピー)';
  return `${clipName(name, NAME_MAX - suffix.length)}${suffix}`;
}

// ---------------------------------------------------------------- 変更の判定

/**
 * 「作業中の内容と同じ項目か」の判定に使う文字列: 足の入力値・シナリオ・手数料・先物の basis・保有の印（#301）
 * （開いたときに戻す範囲。表示の設定・足の市場・保存の時刻は含めない）。印なしは印の無かったころと同じ文字列。
 */
export function bookKey(
  legs: ReadonlyArray<{ leg: Leg }>,
  scenario: Scenario,
  feePerLot: number,
  futureBasis: 'fixed' | 'decay',
  held = false,
): string {
  return JSON.stringify({
    legs: legs.map((l) => savedLeg(l.leg)),
    scenario: savedScenario(scenario),
    fee: feePerLot,
    basis: futureBasis,
    ...(held ? { held: true } : {}),
  });
}

export function entryKey(e: OkEntry): string {
  const { position, ui } = e.ws;
  return bookKey(
    position.legs,
    position.scenario,
    ui.feePerLot,
    ui.futureBasis,
    position.held === true,
  );
}

// ---------------------------------------------------------------- 読み取り・検証

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * 古い版 → 次の版の読み替え（入れ物の版。キー = 読み替え前の版）。版 1 が最初の版なので今は空。
 * 版 2 を入れるときは tests/ui/saved/book-v1.json を読み替えるテストを足す（fixture は変えない）。
 */
export const BOOK_MIGRATIONS: Readonly<Record<number, (raw: Obj) => Obj>> = {};

function migrateBook(raw: Obj, version: number): Obj | null {
  let cur = raw;
  for (let v = version; v < BOOK_SCHEMA_VERSION; v++) {
    const step = Object.hasOwn(BOOK_MIGRATIONS, v) ? BOOK_MIGRATIONS[v] : undefined;
    if (!step) return null;
    cur = step(cur);
  }
  return cur;
}

function workspaceVersion(ws: unknown): number | null {
  if (!isObj(ws)) return null;
  const v = own(ws, 'schema_version');
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function rawSavedAt(raw: unknown): number | null {
  if (!isObj(raw)) return null;
  const ws = own(raw, 'workspace');
  return isObj(ws) ? readTime(own(ws, 'saved_at')) : null;
}

/** 作業の値を検証して開ける作業にする（読めない・足を捨てた・新しい版は null / 'newer'）。 */
function readOpenable(ws: unknown): OpenableWorkspace | 'newer' | null {
  const r = readWorkspaceValue(ws);
  if (r.kind === 'newer') return 'newer';
  if (r.kind !== 'ok' || r.dropped || r.saved.position === null) return null;
  return r.saved as OpenableWorkspace;
}

/** 検証済みの作業から項目を作る。 */
function okEntry(
  id: string,
  name: string,
  createdAt: number | null,
  ws: OpenableWorkspace,
  fallbackTime: number,
): OkEntry {
  return { status: 'ok', id, name, createdAt, saved: savedFromWorkspace(ws, fallbackTime), ws };
}

/** 1 項目を読む。id は不正・重複なら `~<番号>`（正しい id と衝突しない。同じ保存なら同じ値）。 */
function readEntry(raw: unknown, index: number, seen: Set<string>): BookEntry {
  const rawId = isObj(raw) ? own(raw, 'id') : undefined;
  const id =
    typeof rawId === 'string' && ID_RE.test(rawId) && !seen.has(rawId) ? rawId : `~${index}`;
  seen.add(id);
  const bad = (status: BadEntry['status']): BadEntry => ({
    status,
    id,
    raw,
    savedAt: rawSavedAt(raw),
  });
  if (!isObj(raw)) return bad('invalid');
  const wsRaw = own(raw, 'workspace');
  const v = workspaceVersion(wsRaw);
  if (v !== null && v > POSITION_DOC_VERSION) return bad('newer');
  const ws = readOpenable(wsRaw);
  if (ws === 'newer') return bad('newer');
  if (!ws) return bad('invalid');
  const rawName = own(raw, 'name');
  const name =
    (typeof rawName === 'string' ? sanitizeName(rawName) : '') ||
    defaultName(ws.position.legs.map((l) => l.leg));
  const createdAt = readTime(own(raw, 'created_at'));
  return okEntry(id, name, createdAt, ws, createdAt ?? 0);
}

/** 入れ物の版（JSON でない・オブジェクトでない・版が整数でなければ null）。 */
function containerVersion(raw: Obj): number | null {
  const v = own(raw, 'schema_version');
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/** 保存したポジ帳を読む（localStorage の値。無ければ empty）。 */
export function readBook(text: string | null): BookRead {
  if (text === null) return { kind: 'empty' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isObj(raw)) return { kind: 'invalid' };
  const version = containerVersion(raw);
  if (version === null || version < 1) return { kind: 'invalid' };
  if (version > BOOK_SCHEMA_VERSION) return { kind: 'newer', version };
  const cur = migrateBook(raw, version);
  if (!cur) return { kind: 'invalid' };
  const list = own(cur, 'entries');
  if (!Array.isArray(list) || list.length > MAX_ENTRIES_READ) return { kind: 'invalid' };
  const seen = new Set<string>();
  const entries = list.map((e, i) => readEntry(e, i, seen));
  return { kind: 'ok', book: { entries }, chars: text.length };
}

// ---------------------------------------------------------------- 書き出し

function entryValue(e: BookEntry): unknown {
  if (e.status !== 'ok') return e.raw;
  return {
    id: e.id,
    name: e.name,
    created_at: e.createdAt === null ? null : new Date(e.createdAt).toISOString(),
    workspace: e.saved,
  };
}

export function serializeBook(book: Book): string {
  return JSON.stringify({
    schema_version: BOOK_SCHEMA_VERSION,
    entries: book.entries.map(entryValue),
  });
}

/** 上限の検査（増える変更だけ断る。読めた時点で上限を超えていても、減らす変更はできる）。 */
function finish(prev: Book, next: Book, extra: { added?: number; skipped?: number } = {}): BookOp {
  if (next.entries.length > MAX_ENTRIES && next.entries.length > prev.entries.length) {
    return { ok: false, reason: 'full' };
  }
  const text = serializeBook(next);
  if (text.length > BOOK_MAX_CHARS && text.length > serializeBook(prev).length) {
    return { ok: false, reason: 'tooLarge' };
  }
  return { ok: true, book: next, text, ...extra };
}

// ---------------------------------------------------------------- 操作

/** 保存の形（toSaved の結果）を検証して項目にする（足 0 本・不正なら null）。 */
export function makeEntry(
  saved: SavedWorkspaceV1,
  name: string,
  id: string,
  createdAt: number,
): OkEntry | null {
  const ws = readOpenable(saved);
  if (!ws || ws === 'newer' || ws.position.legs.length === 0) return null;
  return okEntry(id, name, createdAt, ws, createdAt);
}

const indexOf = (book: Book, id: string) => book.entries.findIndex((e) => e.id === id);

/** 名前を付けて保存（先頭に入れる。空の名前は既定名）。 */
export function addEntry(
  book: Book,
  saved: SavedWorkspaceV1,
  name: string,
  now: number,
  id: string,
): BookOp {
  if (saved.position.legs.length === 0) return { ok: false, reason: 'noLegs' };
  const ws = readOpenable(saved);
  if (!ws || ws === 'newer') return { ok: false, reason: 'noLegs' };
  const clean = sanitizeName(name) || defaultName(ws.position.legs.map((l) => l.leg));
  const entry = okEntry(id, clean, now, ws, now);
  return finish(book, { entries: [entry, ...book.entries] });
}

/** 上書き保存（中身と保存の時刻だけ変える。id・名前・作った時刻・並びは変えない）。 */
export function overwriteEntry(book: Book, id: string, saved: SavedWorkspaceV1): BookOp {
  const i = indexOf(book, id);
  const cur = book.entries[i];
  if (cur?.status !== 'ok') return { ok: false, reason: 'notFound' };
  if (saved.position.legs.length === 0) return { ok: false, reason: 'noLegs' };
  const ws = readOpenable(saved);
  if (!ws || ws === 'newer') return { ok: false, reason: 'noLegs' };
  const entries = [...book.entries];
  entries[i] = okEntry(cur.id, cur.name, cur.createdAt, ws, Date.parse(saved.saved_at) || 0);
  return finish(book, { entries });
}

/**
 * 上書きを戻す（#87 (C)。[元に戻す] 付きのトースト）。`prev` = 上書きの直前の項目、`written` = 上書きで書いた項目。
 * 今の項目が `written` と同じ（id・名前・作った時刻・中身と保存の時刻）ときだけ、その位置を `prev` に戻す。
 * 上書きの後に名前の変更・削除・別の上書きがあった（または id が違う）なら `notFound` で断る（別の変更を潰さない）。
 */
export function restoreEntry(book: Book, prev: OkEntry, written: OkEntry): BookOp {
  if (prev.id !== written.id) return { ok: false, reason: 'notFound' };
  const i = indexOf(book, prev.id);
  const cur = book.entries[i];
  if (cur?.status !== 'ok') return { ok: false, reason: 'notFound' };
  if (JSON.stringify(entryValue(cur)) !== JSON.stringify(entryValue(written))) {
    return { ok: false, reason: 'notFound' };
  }
  const entries = [...book.entries];
  entries[i] = prev;
  return finish(book, { entries });
}

/** 複製（`<名前> (コピー)`、新しい id、元の項目の直後）。 */
export function duplicateEntry(book: Book, id: string, now: number, newId: string): BookOp {
  const i = indexOf(book, id);
  const cur = book.entries[i];
  if (cur?.status !== 'ok') return { ok: false, reason: 'notFound' };
  // 写しは検討中（#301 オーナー判断 4）: 保有の印を落とす
  const { held: _wh, ...wsPosition } = cur.ws.position;
  const { held: _sh, ...savedPosition } = cur.saved.position;
  const copy: OkEntry = {
    ...cur,
    id: newId,
    name: copyName(cur.name),
    createdAt: now,
    saved: { ...cur.saved, position: savedPosition },
    ws: { ...cur.ws, position: wsPosition },
  };
  const entries = [...book.entries];
  entries.splice(i + 1, 0, copy);
  return finish(book, { entries });
}

/** 名前の変更（空・制御文字のみは断る）。 */
export function renameEntry(book: Book, id: string, name: string): BookOp {
  const i = indexOf(book, id);
  const cur = book.entries[i];
  if (cur?.status !== 'ok') return { ok: false, reason: 'notFound' };
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, reason: 'emptyName' };
  const entries = [...book.entries];
  entries[i] = { ...cur, name: clean };
  return finish(book, { entries });
}

/** 削除（読めない・新しい版の項目も消せる）。 */
export function removeEntry(book: Book, id: string): BookOp {
  if (indexOf(book, id) < 0) return { ok: false, reason: 'notFound' };
  return finish(book, { entries: book.entries.filter((e) => e.id !== id) });
}

/** 空にする（入れ物が読めないときの [空にする]）。 */
export function clearBook(): BookOp {
  return finish(EMPTY_BOOK, EMPTY_BOOK);
}

// ---------------------------------------------------------------- 書き出し / 読み込み（JSON ファイル）

/** 書き出すファイル名（時刻だけ。利用者の名前を入れない）。 */
export function exportFilename(now: number): string {
  const t = fmtDateTime(now); // YYYY-MM-DD HH:mm（JST）
  const d = Number.isFinite(now) ? t.replace(/[-: ]/g, '') : '';
  const stamp = d.length === 12 ? `${d.slice(0, 8)}-${d.slice(8)}` : 'export';
  return `option-simulator-positions-${stamp}.json`;
}

/** ポジ帳全体の書き出し（読める項目だけ。除いた件数を返す）。 */
export function exportBook(
  book: Book,
  now: number,
): { text: string; filename: string; count: number; skipped: number } {
  const ok = book.entries.filter((e): e is OkEntry => e.status === 'ok');
  const text = JSON.stringify(
    {
      schema_version: BOOK_SCHEMA_VERSION,
      exported_at: new Date(now).toISOString(),
      entries: ok.map(entryValue),
    },
    null,
    1,
  );
  return {
    text,
    filename: exportFilename(now),
    count: ok.length,
    skipped: book.entries.length - ok.length,
  };
}

/**
 * 読み込み: ポジ帳の書き出し（`entries` を持つ）か #23 の作業 1 つ（`position` を持つ）を検証して、読める項目
 * だけを先頭に追加する（既存は上書きしない）。id は振り直し、作った時刻は今、同名は ` (2)`… を付ける。
 * 件数・文字数の上限を超えるなら全体を断る。
 */
export function importIntoBook(book: Book, text: string, now: number, newId: () => string): BookOp {
  if (text.length > IMPORT_MAX_BYTES) return { ok: false, reason: 'fileTooLarge' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'importInvalid' };
  }
  if (!isObj(raw)) return { ok: false, reason: 'importInvalid' };

  const found: Array<{ name: string | null; ws: OpenableWorkspace }> = [];
  let skipped = 0;
  let newer = 0;
  if (Object.hasOwn(raw, 'entries')) {
    const version = containerVersion(raw);
    if (version === null || version < 1) return { ok: false, reason: 'importInvalid' };
    if (version > BOOK_SCHEMA_VERSION) return { ok: false, reason: 'importNewer' };
    const cur = migrateBook(raw, version);
    const list = cur ? own(cur, 'entries') : undefined;
    if (!Array.isArray(list) || list.length > MAX_ENTRIES_READ) {
      return { ok: false, reason: 'importInvalid' };
    }
    const seen = new Set<string>();
    list.forEach((e, i) => {
      const entry = readEntry(e, i, seen);
      if (entry.status === 'ok') found.push({ name: entry.name, ws: entry.ws });
      else {
        skipped++;
        if (entry.status === 'newer') newer++;
      }
    });
  } else if (Object.hasOwn(raw, 'position')) {
    const ws = readOpenable(raw);
    if (ws === 'newer') return { ok: false, reason: 'importNewer' };
    if (!ws || ws.position.legs.length === 0) return { ok: false, reason: 'importInvalid' };
    found.push({ name: null, ws });
  } else {
    return { ok: false, reason: 'importInvalid' };
  }
  if (found.length === 0) {
    if (newer > 0 && newer === skipped) return { ok: false, reason: 'importNewer' };
    return { ok: false, reason: skipped > 0 ? 'importInvalid' : 'importEmpty' };
  }

  const taken = new Set(book.entries.flatMap((e) => (e.status === 'ok' ? [e.name] : [])));
  const added: OkEntry[] = found.map(({ name, ws }) => {
    const base = name ?? defaultName(ws.position.legs.map((l) => l.leg));
    const unique = uniqueName(base, taken);
    taken.add(unique);
    return okEntry(newId(), unique, now, ws, now);
  });
  return finish(book, { entries: [...added, ...book.entries] }, { added: added.length, skipped });
}

/** 別のタブの `storage` イベントがポジ帳のキーか（ダイアログを開いていれば読み直す）。 */
export function bookStorageChange(key: string | null): boolean {
  return key === BOOK_KEY || key === null;
}
