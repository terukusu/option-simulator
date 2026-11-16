/**
 * AI のチャットの添付（#369 = docs/adr-0010-ai-chat-attachments.md。docs/design.md 14 章）の規則。純関数（DOM・通信に
 * 依存しない。TextDecoder だけ使う）。ファイルを読む所（File・画像の作り直し）は ui/aiAttachRead.ts、状態は
 * ui/view/aiChat.ts、画面は ui/next/regions/AiAttach.tsx。
 *
 * - 受けるもの: 画像（ブラウザが復号できるもの。ui/imageEncode.ts で PNG / JPEG に作り直す）とテキストのファイル
 *   （CSV・TSV・TXT・JSON・XML。UTF-8（BOM 可）→ Shift_JIS の順に厳密に読む）
 * - 上限は中継（api/src/simulator_api/ai/allowlist.py の MAX_ATTACHMENTS・MAX_IMAGES・MAX_ATTACH_TEXT・
 *   MAX_ATTACH_TEXT_TOTAL・MAX_ATTACH_NAME）と同じ数（tests/ui/aiAttach.test.ts が突き合わせる）。字数は UTF-16 の
 *   `.length`（中継の code point の数以上 = ブラウザの方が厳しい側）
 * - 保存しない: 会話の保存（sessionStorage）・評価に残すの JSON には、添付の block を DETACHED_TEXT の text 1 つに
 *   置き換えて書く（detachAttachments。名前も入れない）
 */

import type {
  AiAttachTextType,
  AiImageMediaType,
  AiMessage,
  AiUserBlock,
} from '../../data/aiStream';

/** 1 件の発言の添付の数（中継の MAX_ATTACHMENTS） */
export const MAX_ATTACHMENTS = 3;
/** 会話全体の画像の枚数（中継の MAX_IMAGES） */
export const MAX_IMAGES = 5;
/** テキストの添付 1 つの字数（中継の MAX_ATTACH_TEXT） */
export const MAX_ATTACH_TEXT = 20_000;
/** 会話全体のテキストの添付の字数の合計（中継の MAX_ATTACH_TEXT_TOTAL） */
export const MAX_ATTACH_TEXT_TOTAL = 40_000;
/** 添付の名前の字数（中継の MAX_ATTACH_NAME） */
export const MAX_ATTACH_NAME = 120;
/** テキストのファイルを読む前の大きさの上限（B） */
export const TEXT_SOURCE_MAX_BYTES = 1_000_000;
/** 添付のテキストの種類（中継の ATTACH_MEDIA_TYPES と同じ並び） */
export const ATTACH_TEXT_TYPES: readonly AiAttachTextType[] = [
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/xml',
  'text/xml',
  'text/plain',
];
/** 本文が空で添付だけを送るときの発言の文（吹き出しには出さない） */
export const ATTACH_ONLY_TEXT = 'この添付を見てください。';
/** 再読み込みで外れた添付の代わりに置く文（中継の allowlist.DETACHED_TEXT と同じ。名前は入れない） */
export const DETACHED_TEXT = '［添付は再読み込みで外れました］';
/** 送る前の注意（添付があるときだけ入力欄の近くに常に出す。ADR-0009 決定 9 の考え） */
export const ATTACH_NOTE_TEXT =
  '添付は送るたびに Anthropic に送ります。口座番号などは切り取ってから付けてください（保存はしません）';
/** 会話の吹き出しの外れた添付の文 */
export const DETACHED_LABEL = '添付（再読み込みで外れた）';
/** 入力欄の file input の accept（画像と、テキストの拡張子・MIME） */
export const ATTACH_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/bmp,.csv,.tsv,.txt,.json,.xml,text/csv,text/tab-separated-values,text/plain,application/json,application/xml,text/xml';

export type AiAttachment =
  | {
      id: string;
      kind: 'image';
      name: string;
      mediaType: AiImageMediaType;
      /** 送る base64（作り直した画像） */
      base64: string;
      /** 送る生のバイト数 */
      bytes: number;
      width: number;
      height: number;
    }
  | { id: string; kind: 'text'; name: string; mediaType: AiAttachTextType; text: string };

export type AttachReason =
  | 'too_many'
  | 'images_total'
  | 'text_total'
  | 'text_size'
  | 'source_size'
  | 'unsupported'
  | 'empty'
  | 'not_text'
  | 'not_image'
  | 'too_large'
  | 'huge';

const REASON_TEXT: Record<AttachReason, string> = {
  too_many: `添付は 1 回に ${MAX_ATTACHMENTS} つまでです`,
  images_total: `画像は 1 つの会話で ${MAX_IMAGES} 枚までです（[新しい会話] で数え直します）`,
  text_total: 'テキストの添付は 1 つの会話で合計 40,000 字までです',
  text_size: 'テキストのファイルは 1 つ 20,000 字までです',
  source_size: 'テキストのファイルは 1 MB までです',
  unsupported:
    '添付できるのは画像（PNG・JPEG・WebP・GIF・BMP）とテキストのファイル（CSV・TSV・TXT・JSON・XML）です',
  empty: '空のファイルです',
  not_text: 'テキストとして読めないファイルです（UTF-8 か Shift_JIS の文字だけ）',
  not_image: '画像として読めませんでした（PNG・JPEG・WebP・GIF・BMP）',
  too_large:
    '画像が大きすぎて送れません（品質を下げても 500 KB を超える）。端末で切り取ってから付けてください',
  huge: '画像が大きすぎて開けません（30 MB・4,000 万画素まで）。端末で切り取るか縮めてから付けてください',
};

/** 断った理由の文（入力欄の下に出す） */
export function attachReasonText(reason: AttachReason): string {
  return REASON_TEXT[reason];
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
const TEXT_EXT: Record<string, AiAttachTextType> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
};

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i <= 0 || i === name.length - 1 ? '' : name.slice(i + 1).toLowerCase();
};

export type FileClass =
  | { kind: 'image' }
  | { kind: 'text'; mediaType: AiAttachTextType }
  | { kind: 'reject'; reason: AttachReason };

/**
 * ファイルの種類の判定（拡張子が優先。拡張子が無ければ MIME）。画像の拡張子・MIME → image（作り直しで復号できなければ
 * not_image）、テキストの拡張子 → text（Windows の CSV の MIME application/vnd.ms-excel でも csv）、ほか（.xlsx・.pdf・
 * .heic など）→ unsupported。0 B → empty、テキストで TEXT_SOURCE_MAX_BYTES 超 → source_size
 */
export function classifyFile(name: string, mime: string, size: number): FileClass {
  const ext = extOf(name);
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  let c: FileClass;
  if (ext !== '') {
    if (IMAGE_EXT.has(ext)) c = { kind: 'image' };
    else if (TEXT_EXT[ext]) c = { kind: 'text', mediaType: TEXT_EXT[ext] };
    else c = { kind: 'reject', reason: 'unsupported' };
  } else if (IMAGE_MIME.has(m)) c = { kind: 'image' };
  else if ((ATTACH_TEXT_TYPES as readonly string[]).includes(m))
    c = { kind: 'text', mediaType: m as AiAttachTextType };
  else c = { kind: 'reject', reason: 'unsupported' };
  if (c.kind === 'reject') return c;
  if (!(size > 0)) return { kind: 'reject', reason: 'empty' };
  if (c.kind === 'text' && size > TEXT_SOURCE_MAX_BYTES) {
    return { kind: 'reject', reason: 'source_size' };
  }
  return c;
}

// NUL と \t\n\r 以外の C0・DEL・C1（中継の _TEXT_BAD。サロゲート単体は TextDecoder が作らない）
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を見つけて断るための式
const TEXT_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// 名前に入れない文字（C0・DEL・C1 とサロゲート単体）
const NAME_BAD =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を名前から除くための式
  /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function decodeWith(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * テキストのファイルの読み分け: UTF-8（先頭の BOM を除く）を厳密に → 読めなければ Shift_JIS を厳密に → どちらも
 * 読めなければ not_text。読めても NUL・\t\n\r 以外の制御文字を含めば not_text（拡張子だけ .csv の xlsx・zip など）。
 * 中身が空なら empty。改行は変えない
 */
export function decodeText(
  bytes: Uint8Array,
): { ok: true; text: string } | { ok: false; reason: 'not_text' | 'empty' } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  const text = decodeWith('utf-8', body) ?? (bom ? null : decodeWith('shift_jis', body));
  if (text === null || TEXT_BAD.test(text)) return { ok: false, reason: 'not_text' };
  if (text === '') return { ok: false, reason: 'empty' };
  return { ok: true, text };
}

/**
 * 送る名前（1〜MAX_ATTACH_NAME 字・制御文字なし）: 制御文字を除き、長ければ拡張子を残して切る（拒否しない）。
 * 空なら `添付.<fallbackExt>`
 */
export function attachName(name: string, fallbackExt: string): string {
  const clean = name.replace(NAME_BAD, '').trim();
  if (clean === '') return `添付.${fallbackExt}`;
  if (clean.length <= MAX_ATTACH_NAME) return clean;
  const i = clean.lastIndexOf('.');
  const ext = i > 0 && clean.length - i <= 10 ? clean.slice(i) : '';
  let head = clean.slice(0, MAX_ATTACH_NAME - ext.length);
  // サロゲートの組を半分で切らない
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  return head + ext;
}

/**
 * 入力欄への貼り付けで添付にするファイル（#369 レビュー指摘 1）: クリップボードに文字（text/plain）があれば文字の貼り付けを
 * 優先して添付にしない（Excel・Word の表のコピーは文字と一緒に絵も入り、ブラウザはそれをファイルとして出す）。文字の無い
 * 画像・ファイルだけを添付にする
 */
export function pasteAttachFiles<T>(files: readonly T[], plainText: string): T[] {
  return plainText.trim() !== '' ? [] : [...files];
}

/** 会話（messages）の画像の枚数とテキストの添付の字数の合計（外れた添付は数えない） */
export function attachUsage(messages: readonly AiMessage[]): { images: number; textChars: number } {
  let images = 0;
  let textChars = 0;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'image') images++;
      else if (b.type === 'attachment_text') textChars += b.text.length;
    }
  }
  return { images, textChars };
}

/**
 * 上限の判定: 送る前の添付（pending）に add を入力の順に足せるだけ足す。1 件 MAX_ATTACHMENTS・会話全体（messages +
 * pending）の画像 MAX_IMAGES・テキストの合計 MAX_ATTACH_TEXT_TOTAL・1 ファイル MAX_ATTACH_TEXT を超える候補は足さず、
 * 最初の理由を返す
 */
export function admit(
  messages: readonly AiMessage[],
  pending: readonly AiAttachment[],
  add: readonly AiAttachment[],
): { accepted: AiAttachment[]; reason: AttachReason | null } {
  const used = attachUsage(messages);
  let images = used.images + pending.filter((a) => a.kind === 'image').length;
  let chars =
    used.textChars + pending.reduce((n, a) => n + (a.kind === 'text' ? a.text.length : 0), 0);
  let count = pending.length;
  const accepted: AiAttachment[] = [];
  let reason: AttachReason | null = null;
  for (const a of add) {
    let why: AttachReason | null = null;
    if (count + 1 > MAX_ATTACHMENTS) why = 'too_many';
    else if (a.kind === 'image' && images + 1 > MAX_IMAGES) why = 'images_total';
    else if (a.kind === 'text' && a.text.length > MAX_ATTACH_TEXT) why = 'text_size';
    else if (a.kind === 'text' && chars + a.text.length > MAX_ATTACH_TEXT_TOTAL) why = 'text_total';
    if (why !== null) {
      reason ??= why;
      continue;
    }
    accepted.push(a);
    count++;
    if (a.kind === 'image') images++;
    else chars += a.text.length;
  }
  return { accepted, reason };
}

/** 送る block（画像 → image、テキスト → attachment_text） */
export function attachmentBlocks(atts: readonly AiAttachment[]): AiUserBlock[] {
  return atts.map((a) =>
    a.kind === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } }
      : { type: 'attachment_text', name: a.name, media_type: a.mediaType, text: a.text },
  );
}

/**
 * 発言の content: [添付の block…, text]（画像を text の前 = Anthropic の推奨）。本文が空なら ATTACH_ONLY_TEXT
 */
export function userContent(text: string, atts: readonly AiAttachment[]): AiUserBlock[] {
  return [
    ...attachmentBlocks(atts),
    { type: 'text', text: text === '' && atts.length > 0 ? ATTACH_ONLY_TEXT : text },
  ];
}

const isAttachBlock = (b: AiUserBlock) => b.type === 'image' || b.type === 'attachment_text';

/**
 * 添付を外した会話（保存・評価に残す用）: 添付のある user の発言は、添付の並びを最初の添付の位置の
 * `{type:'text', text: DETACHED_TEXT}` 1 つに置き換える（ほかの block・順序は変えない）。添付の無い発言は同じ参照。冪等
 */
export function detachAttachments(messages: readonly AiMessage[]): AiMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || !m.content.some(isAttachBlock)) return m;
    const content: AiUserBlock[] = [];
    let placed = false;
    for (const b of m.content) {
      if (!isAttachBlock(b)) content.push(b);
      else if (!placed) {
        content.push({ type: 'text', text: DETACHED_TEXT });
        placed = true;
      }
    }
    return { role: 'user', content };
  });
}

/** 吹き出しのチップの表示（会話の発言・失敗の行） */
export type AttachView =
  | { kind: 'image'; mediaType: AiImageMediaType; data: string; key: string }
  | { kind: 'text'; name: string; type: string; chars: number; key: string }
  | { kind: 'detached'; key: string };

const TYPE_LABEL: Record<AiAttachTextType, string> = {
  'text/csv': 'CSV',
  'text/tab-separated-values': 'TSV',
  'application/json': 'JSON',
  'application/xml': 'XML',
  'text/xml': 'XML',
  'text/plain': 'TXT',
};

/** テキストの種類の短い名前（CSV・TSV・JSON・XML・TXT） */
export const textTypeLabel = (t: AiAttachTextType): string => TYPE_LABEL[t];

/** 字数の表示（「1,234 字」） */
export const charsText = (n: number): string => `${n.toLocaleString('en-US')} 字`;

/** 発言の block → 吹き出しのチップ（外れた添付は detached 1 つ） */
export function attachViews(content: readonly AiUserBlock[], prefix: string): AttachView[] {
  const out: AttachView[] = [];
  content.forEach((b, j) => {
    const key = `${prefix}a${j}`;
    if (b.type === 'image')
      out.push({ kind: 'image', mediaType: b.source.media_type, data: b.source.data, key });
    else if (b.type === 'attachment_text')
      out.push({
        kind: 'text',
        name: b.name,
        type: textTypeLabel(b.media_type),
        chars: b.text.length,
        key,
      });
    else if (b.type === 'text' && b.text === DETACHED_TEXT) out.push({ kind: 'detached', key });
  });
  return out;
}

/** 送る前の添付 → 吹き出しのチップ（失敗の行） */
export function pendingViews(atts: readonly AiAttachment[], prefix: string): AttachView[] {
  return attachViews(attachmentBlocks(atts), prefix);
}
