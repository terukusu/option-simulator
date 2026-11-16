import { describe, expect, it } from 'vitest';
import type { AiMessage } from '../../data/aiStream';
import { attachReader, readAttachment } from '../../ui/aiAttachRead';
import type { EncodeResult } from '../../ui/imageEncode';
import {
  type AiAttachment,
  ATTACH_ONLY_TEXT,
  ATTACH_TEXT_TYPES,
  admit,
  attachmentBlocks,
  attachName,
  attachReasonText,
  attachViews,
  classifyFile,
  DETACHED_TEXT,
  decodeText,
  detachAttachments,
  MAX_ATTACH_NAME,
  MAX_ATTACH_TEXT,
  MAX_ATTACH_TEXT_TOTAL,
  MAX_ATTACHMENTS,
  MAX_IMAGES,
  pasteAttachFiles,
  TEXT_SOURCE_MAX_BYTES,
  userContent,
} from '../../ui/view/aiAttach';

/**
 * #369 AC6: AI のチャットの添付の純関数（ui/view/aiAttach.ts）。テキストの読み分け・種類の判定・上限と理由の文・
 * 送る block・保存のための外し方。上限の数と種類の列挙は中継（api/src/simulator_api/ai/allowlist.py）と突き合わせる。
 * 値はすべて架空。
 */

/** Node の fs（@types/node を足さないため型はここで最小限に書く。tests/ui/aiAsk.test.ts と同じ） */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const CSV = '日付,銘柄,数量\r\n2026-10-01,プット,2\r\n';
/** 同じ CSV の Shift_JIS のバイト列（TextEncoder は UTF-8 だけなので固定の配列） */
const CSV_SJIS = new Uint8Array([
  147, 250, 149, 116, 44, 150, 193, 149, 191, 44, 144, 148, 151, 202, 13, 10, 50, 48, 50, 54, 45,
  49, 48, 45, 48, 49, 44, 131, 118, 131, 98, 131, 103, 44, 50, 13, 10,
]);
const utf8 = (s: string) => new TextEncoder().encode(s);

const img = (id: string, bytes = 1000): AiAttachment => ({
  id,
  kind: 'image',
  name: `${id}.png`,
  mediaType: 'image/png',
  base64: 'iVBORw0KGgo=',
  bytes,
  width: 10,
  height: 10,
});
const txt = (id: string, text: string): AiAttachment => ({
  id,
  kind: 'text',
  name: `${id}.csv`,
  mediaType: 'text/csv',
  text,
});
const user = (...atts: AiAttachment[]): AiMessage => ({
  role: 'user',
  content: userContent('q', atts),
});
const answer: AiMessage = { role: 'assistant', content: [{ type: 'text', text: 'a' }] };

describe('#369 AC6 (a) テキストの読み分け', () => {
  it('UTF-8（BOM あり / なし）と Shift_JIS の CSV が同じ本文になる（改行は変えない）', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(CSV)]);
    for (const bytes of [utf8(CSV), bom, CSV_SJIS]) {
      expect(decodeText(bytes)).toEqual({ ok: true, text: CSV });
    }
  });

  it('NUL・制御文字を含む・zip（PK\\x03\\x04）・どちらでも読めないバイト列は not_text', () => {
    expect(decodeText(utf8('a,b\u0000c'))).toEqual({ ok: false, reason: 'not_text' });
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toEqual({
      ok: false,
      reason: 'not_text',
    });
    expect(decodeText(utf8('a\u001bb'))).toEqual({ ok: false, reason: 'not_text' });
    expect(decodeText(utf8('a\u0085b'))).toEqual({ ok: false, reason: 'not_text' });
    // UTF-8 でも Shift_JIS でも読めない（0xFF・0xFE は両方で不正）
    expect(decodeText(new Uint8Array([0x61, 0xff, 0xfe, 0x62]))).toEqual({
      ok: false,
      reason: 'not_text',
    });
    // BOM があれば UTF-8 だけ（Shift_JIS に逃がさない）
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...CSV_SJIS]))).toEqual({
      ok: false,
      reason: 'not_text',
    });
  });

  it('タブ・改行・復帰は通り、空（BOM だけ）は empty', () => {
    expect(decodeText(utf8('a\tb\r\nc\n'))).toEqual({ ok: true, text: 'a\tb\r\nc\n' });
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf]))).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('#369 AC6 (b) 拡張子・MIME の判定', () => {
  it('テキストの拡張子は受け、種類は拡張子から（Windows の CSV の MIME でも csv）', () => {
    expect(classifyFile('a.csv', 'application/vnd.ms-excel', 10)).toEqual({
      kind: 'text',
      mediaType: 'text/csv',
    });
    expect(classifyFile('a.TSV', '', 10)).toEqual({
      kind: 'text',
      mediaType: 'text/tab-separated-values',
    });
    expect(classifyFile('a.txt', 'text/plain', 10)).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
    });
    expect(classifyFile('a.json', 'application/json', 10)).toEqual({
      kind: 'text',
      mediaType: 'application/json',
    });
    expect(classifyFile('a.xml', 'text/xml', 10)).toEqual({
      kind: 'text',
      mediaType: 'application/xml',
    });
  });

  it('画像は拡張子か MIME で受ける（貼り付けの名前なしは MIME）', () => {
    for (const n of ['a.png', 'a.jpg', 'a.JPEG', 'a.webp', 'a.gif', 'a.bmp']) {
      expect(classifyFile(n, '', 10)).toEqual({ kind: 'image' });
    }
    expect(classifyFile('image', 'image/png', 10)).toEqual({ kind: 'image' });
    expect(classifyFile('', 'text/csv', 10)).toEqual({ kind: 'text', mediaType: 'text/csv' });
  });

  it('.xlsx・.pdf・.heic（復号できない画像）・知らない MIME は unsupported、空のファイルは empty', () => {
    for (const [n, m] of [
      ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['a.pdf', 'application/pdf'],
      ['a.heic', 'image/heic'],
      ['a.svg', 'image/svg+xml'],
      ['noext', 'application/octet-stream'],
    ] as const) {
      expect(classifyFile(n, m, 10)).toEqual({ kind: 'reject', reason: 'unsupported' });
    }
    expect(classifyFile('a.csv', 'text/csv', 0)).toEqual({ kind: 'reject', reason: 'empty' });
    expect(classifyFile('a.png', 'image/png', 0)).toEqual({ kind: 'reject', reason: 'empty' });
  });

  it('名前: 制御文字を除き、長ければ拡張子を残して切る。空は決まった名前', () => {
    expect(attachName('a\tb\u0000.csv', 'csv')).toBe('ab.csv');
    const long = `${'あ'.repeat(200)}.csv`;
    const n = attachName(long, 'csv');
    expect(n.length).toBe(MAX_ATTACH_NAME);
    expect(n.endsWith('.csv')).toBe(true);
    expect(attachName('\u0001', 'png')).toBe('添付.png');
    // サロゲートの組を半分で切らない
    const emoji = attachName(`${'😀'.repeat(80)}`, 'txt');
    expect(emoji.length).toBeLessThanOrEqual(MAX_ATTACH_NAME);
    expect(/[\ud800-\udbff]$/.test(emoji)).toBe(false);
  });
});

describe('#369 AC6 (c) 上限と理由の文', () => {
  it('読む前の大きさ 1 MB 超は source_size', () => {
    expect(classifyFile('a.csv', 'text/csv', TEXT_SOURCE_MAX_BYTES)).toEqual({
      kind: 'text',
      mediaType: 'text/csv',
    });
    expect(classifyFile('a.csv', 'text/csv', TEXT_SOURCE_MAX_BYTES + 1)).toEqual({
      kind: 'reject',
      reason: 'source_size',
    });
  });

  it('1 件に 4 つ目は too_many（3 つまでは入れる）', () => {
    const r = admit([], [img('p1')], [img('a'), txt('b', 'x'), img('c')]);
    expect(r.accepted.map((a) => a.id)).toEqual(['a', 'b']);
    expect(r.reason).toBe('too_many');
  });

  it('会話で 6 枚目の画像は images_total（会話の 5 枚 = 前の発言 + 送る前）', () => {
    const msgs = [user(img('m1'), img('m2'), img('m3')), answer, user(img('m4'))];
    expect(admit(msgs, [], [img('a')]).accepted).toHaveLength(1);
    const r = admit(msgs, [img('p')], [img('a'), txt('t', 'x')]);
    expect(r.accepted.map((a) => a.id)).toEqual(['t']);
    expect(r.reason).toBe('images_total');
    // 外れた添付（再読み込み）は数えない
    expect(admit(detachAttachments(msgs), [img('p')], [img('a')]).reason).toBeNull();
  });

  it('テキストの合計 40,000 字・1 ファイル 20,000 字（ちょうどは通る、+1 で断る）', () => {
    const msgs = [user(txt('m', 'x'.repeat(MAX_ATTACH_TEXT))), answer];
    expect(admit(msgs, [], [txt('a', 'y'.repeat(MAX_ATTACH_TEXT))]).reason).toBeNull();
    expect(admit(msgs, [], [txt('a', 'y'.repeat(MAX_ATTACH_TEXT + 1))]).reason).toBe('text_size');
    const r = admit(msgs, [txt('p', 'z'.repeat(MAX_ATTACH_TEXT))], [txt('a', 'w')]);
    expect(r).toEqual({ accepted: [], reason: 'text_total' });
    expect(MAX_ATTACH_TEXT_TOTAL).toBe(2 * MAX_ATTACH_TEXT);
  });

  it('理由の文（固定）', () => {
    expect(attachReasonText('too_many')).toBe('添付は 1 回に 3 つまでです');
    expect(attachReasonText('images_total')).toBe(
      '画像は 1 つの会話で 5 枚までです（[新しい会話] で数え直します）',
    );
    expect(attachReasonText('text_total')).toBe(
      'テキストの添付は 1 つの会話で合計 40,000 字までです',
    );
    expect(attachReasonText('text_size')).toBe('テキストのファイルは 1 つ 20,000 字までです');
    expect(attachReasonText('source_size')).toBe('テキストのファイルは 1 MB までです');
    expect(attachReasonText('unsupported')).toBe(
      '添付できるのは画像（PNG・JPEG・WebP・GIF・BMP）とテキストのファイル（CSV・TSV・TXT・JSON・XML）です',
    );
    expect(attachReasonText('empty')).toBe('空のファイルです');
    expect(attachReasonText('not_text')).toBe(
      'テキストとして読めないファイルです（UTF-8 か Shift_JIS の文字だけ）',
    );
    for (const r of ['not_image', 'too_large', 'huge'] as const) {
      expect(attachReasonText(r)).toMatch(/画像/);
    }
  });

  it('上限の数と種類の列挙は中継の allowlist.py と同じ', () => {
    const py = read('api/src/simulator_api/ai/allowlist.py');
    const num = (name: string) =>
      Number((new RegExp(`^${name} = ([0-9_]+)`, 'm').exec(py)?.[1] ?? 'NaN').replace(/_/g, ''));
    expect(num('MAX_ATTACHMENTS')).toBe(MAX_ATTACHMENTS);
    expect(num('MAX_IMAGES')).toBe(MAX_IMAGES);
    expect(num('MAX_ATTACH_TEXT')).toBe(MAX_ATTACH_TEXT);
    expect(num('MAX_ATTACH_TEXT_TOTAL')).toBe(MAX_ATTACH_TEXT_TOTAL);
    expect(num('MAX_ATTACH_NAME')).toBe(MAX_ATTACH_NAME);
    const m = /^ATTACH_MEDIA_TYPES = \(([^)]*)\)/m.exec(py);
    expect([...(m?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1])).toEqual([
      ...ATTACH_TEXT_TYPES,
    ]);
    expect(py).toContain(`DETACHED_TEXT = "${DETACHED_TEXT}"`);
  });
});

describe('#369 送る block と外し方', () => {
  it('発言の content は [添付…, text]。本文が空なら決まった文', () => {
    const c = userContent('', [img('a'), txt('b', 'x')]);
    expect(c.map((b) => b.type)).toEqual(['image', 'attachment_text', 'text']);
    expect(c[2]).toEqual({ type: 'text', text: ATTACH_ONLY_TEXT });
    expect(userContent('q', [])).toEqual([{ type: 'text', text: 'q' }]);
    expect(attachmentBlocks([img('a')])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  it('detachAttachments: 添付の並びを最初の位置の決まった text 1 つに（ほかの block・順序は同じ）。冪等', () => {
    const plain: AiMessage = { role: 'user', content: [{ type: 'text', text: 'p' }] };
    const msgs = [plain, answer, user(img('a'), txt('b', '秘密の本文'))];
    const d = detachAttachments(msgs);
    expect(d[0]).toBe(plain);
    expect(d[1]).toBe(answer);
    expect(d[2]?.content).toEqual([
      { type: 'text', text: DETACHED_TEXT },
      { type: 'text', text: 'q' },
    ]);
    expect(detachAttachments(d)).toEqual(d);
    expect(JSON.stringify(d)).not.toContain('秘密の本文');
  });

  it('吹き出しのチップ: 画像・テキスト（名前・種類・字数）・外れた印', () => {
    const v = attachViews(userContent('q', [img('a'), txt('b', 'xyz')]), 'm0');
    expect(v).toEqual([
      { kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', key: 'm0a0' },
      { kind: 'text', name: 'b.csv', type: 'CSV', chars: 3, key: 'm0a1' },
    ]);
    const d = detachAttachments([user(img('a'))])[0] as AiMessage;
    expect(attachViews(d.content as never, 'm2')).toEqual([{ kind: 'detached', key: 'm2a0' }]);
  });
});

describe('#369 ファイルを読む（ui/aiAttachRead.ts。作り直しは偽物）', () => {
  const file = (parts: BlobPart[], name: string, type: string) => new File(parts, name, { type });
  const fakeEncode = async (): Promise<EncodeResult> => ({
    ok: true,
    image: {
      mediaType: 'image/jpeg',
      base64: 'AAAA',
      bytes: 3,
      width: 4,
      height: 2,
      srcWidth: 8,
      srcHeight: 4,
      preview: { close() {} } as ImageBitmap,
    },
  });

  it('テキスト（Shift_JIS）・画像・断るものを順に読む', async () => {
    const t = await readAttachment(file([CSV_SJIS as BlobPart], '約定.csv', ''), fakeEncode);
    expect(t).toMatchObject({ ok: true, att: { kind: 'text', name: '約定.csv', text: CSV } });
    const i = await readAttachment(file([new Uint8Array(4)], 'shot.png', 'image/png'), fakeEncode);
    expect(i).toMatchObject({
      ok: true,
      att: { kind: 'image', mediaType: 'image/jpeg', base64: 'AAAA', bytes: 3 },
    });
    const z = await readAttachment(
      file([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'fake.csv', 'text/csv'),
      fakeEncode,
    );
    expect(z).toEqual({ ok: false, reason: 'not_text' });
    const bad = await readAttachment(file([new Uint8Array(4)], 'x.png', 'image/png'), async () => ({
      ok: false,
      error: 'not_image',
    }));
    expect(bad).toEqual({ ok: false, reason: 'not_image' });
  });

  it('attachReader: 読めた分と最初の理由。cancel の後の結果は捨てる', async () => {
    const r = attachReader((f) => readAttachment(f, fakeEncode));
    const out = await r.read([
      file(['a,b'], 'a.csv', 'text/csv'),
      file(['x'], 'a.pdf', 'application/pdf'),
    ]);
    expect(out?.items).toHaveLength(1);
    expect(out?.reason).toBe('unsupported');
    const p = r.read([file(['a,b'], 'a.csv', 'text/csv')]);
    r.cancel();
    expect(await p).toBeNull();
  });
});

describe('#369 貼り付け（レビュー指摘 1）', () => {
  it('文字（text/plain）があれば文字の貼り付けを優先して添付にしない（Excel の表 = 文字 + 絵）', () => {
    expect(pasteAttachFiles(['excel-bitmap.png'], '日付\t数量\n2026-10-01\t2')).toEqual([]);
    expect(pasteAttachFiles(['a.png', 'b.csv'], 'x')).toEqual([]);
  });

  it('文字の無い画像・ファイルだけを添付にする（空白だけの文字は無い扱い）', () => {
    expect(pasteAttachFiles(['shot.png'], '')).toEqual(['shot.png']);
    expect(pasteAttachFiles(['shot.png', 'rec.csv'], ' \n')).toEqual(['shot.png', 'rec.csv']);
    expect(pasteAttachFiles([], '')).toEqual([]);
  });
});
