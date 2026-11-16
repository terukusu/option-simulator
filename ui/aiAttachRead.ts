/**
 * AI のチャットの添付のファイルを読む（#369 = docs/adr-0010-ai-chat-attachments.md）。DOM（File・Blob）を使う所だけ。
 * 規則（種類・読み分け・名前・上限）は ui/view/aiAttach.ts の純関数、画像の作り直しは ui/imageEncode.ts（建玉の
 * 読み取り #318 と共用）。
 *
 * - 複数のファイルを順に読む。画像は作り直した後すぐプレビューを閉じる（チップの縮小画像は送る base64 から描く）
 * - 読んでいる途中で [新しい会話]・パネルを閉じたら（cancel）結果を捨てる（世代番号。latestPicker と同じ考え）
 * - 添付はメモリだけ（Web Storage・IndexedDB・URL に入れない）
 */

import { disposeImage, type EncodeResult, encodeImage } from './imageEncode';
import {
  type AiAttachment,
  type AttachReason,
  attachName,
  classifyFile,
  decodeText,
} from './view/aiAttach';

let seq = 0;
const nextId = () => `att${++seq}`;

const TEXT_EXT: Record<string, string> = {
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/plain': 'txt',
};

/** 1 つのファイル → 添付か断った理由 */
export async function readAttachment(
  file: File,
  encode: (f: Blob) => Promise<EncodeResult> = encodeImage,
): Promise<{ ok: true; att: AiAttachment } | { ok: false; reason: AttachReason }> {
  const c = classifyFile(file.name, file.type, file.size);
  if (c.kind === 'reject') return { ok: false, reason: c.reason };
  if (c.kind === 'image') {
    let r: EncodeResult;
    try {
      r = await encode(file);
    } catch {
      r = { ok: false, error: 'not_image' };
    }
    if (!r.ok) return { ok: false, reason: r.error };
    const img = r.image;
    disposeImage(img);
    return {
      ok: true,
      att: {
        id: nextId(),
        kind: 'image',
        name: attachName(file.name, img.mediaType === 'image/png' ? 'png' : 'jpg'),
        mediaType: img.mediaType,
        base64: img.base64,
        bytes: img.bytes,
        width: img.width,
        height: img.height,
      },
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, reason: 'not_text' };
  }
  const d = decodeText(bytes);
  if (!d.ok) return { ok: false, reason: d.reason };
  return {
    ok: true,
    att: {
      id: nextId(),
      kind: 'text',
      name: attachName(file.name, TEXT_EXT[c.mediaType] ?? 'txt'),
      mediaType: c.mediaType,
      text: d.text,
    },
  };
}

/**
 * 添付の読み手（世代番号）。read は読めたものと最初の理由を返し、途中で cancel されたら null（結果を捨てる）。
 * 続けて選んだ分は前の分を捨てない（どちらも足す。上限は reducer の admit が見る）
 */
export function attachReader(
  read: (f: File) => ReturnType<typeof readAttachment> = readAttachment,
) {
  let gen = 0;
  return {
    async read(
      files: readonly File[],
    ): Promise<{ items: AiAttachment[]; reason: AttachReason | null } | null> {
      const mine = gen;
      const items: AiAttachment[] = [];
      let reason: AttachReason | null = null;
      for (const f of files) {
        const r = await read(f);
        if (mine !== gen) return null;
        if (r.ok) items.push(r.att);
        else reason ??= r.reason;
      }
      return { items, reason };
    },
    cancel(): void {
      gen++;
    },
  };
}
