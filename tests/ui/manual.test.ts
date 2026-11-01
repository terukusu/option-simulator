import { describe, expect, it } from 'vitest';
import { AI_ASK_TOPICS, ASK_DOCS } from '../../ui/view/aiAsk';
import { GLOSSARY } from '../../ui/view/glossary';
import {
  cleanTitle,
  docSections,
  HINT_GUIDE,
  inlineText,
  type ManualBlock,
  type ManualInline,
  manualBlocks,
  manualIndex,
  manualInline,
  sectionLabel,
  slug,
  tocModel,
} from '../../ui/view/manual';

/**
 * #322: マニュアルの節の索引（AC1・AC2）と描き方の表示モデル（AC3）。マニュアルは Node の fs で読む（画面は Vite の
 * `?raw` の動的 import。ui/next/parts/manualDoc.ts）。合成の Markdown は架空の文。
 */

/** Node の fs（@types/node を足さないため型は最小限。glossary.test.ts と同じ） */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const guide = fs.readFileSync(new URL('../../docs/user-guide.md', import.meta.url), 'utf8');
const INDEX = manualIndex(guide);

describe('索引（#322 AC1）', () => {
  it('番号と見出しが AI の索引（docSections = docs.py の parse の規則）と同じ', () => {
    const docs = docSections(guide, null);
    const numbered = INDEX.sections.filter((s) => s.id !== null);
    expect(numbered.map((s) => ({ id: s.id, title: s.title }))).toEqual(docs);
    expect(INDEX.byId.size).toBe(docs.length);
  });

  it('fixtures/docs/user-guide-sections.json（API の pytest が docs.py の parse と比べる）と番号・見出し・アンカーが同じ', () => {
    // TS と Python の番号の規則の突き合わせ（レビュー指摘 6）: このファイルは npm run fixtures が ui/view/manual.ts で書き、
    // api/tests/test_ai_docs.py が Python の parse（と GitHub のアンカーの規則）で同じになることを確かめる
    const want = JSON.parse(
      fs.readFileSync(
        new URL('../../fixtures/docs/user-guide-sections.json', import.meta.url),
        'utf8',
      ),
    ) as { id: string; level: number; title: string; anchor: string }[];
    const got = INDEX.sections
      .filter((s) => s.id !== null)
      .map((s) => ({ id: s.id, level: s.level, title: s.title, anchor: s.anchor }));
    expect(got).toEqual(want);
  });

  it('見出しの開発の経緯を外す規則は docs.py の clean_title と同じ（語の境は Unicode。api/tests/test_ai_docs.py と同じ例）', () => {
    expect(cleanTitle('追証マップ（#131・#150）')).toBe('追証マップ');
    expect(cleanTitle('見出し（K7 → Q2 でオーナー再確認）')).toBe('見出し');
    expect(cleanTitle('見出し（D3）')).toBe('見出し');
    expect(cleanTitle('見出し (R12)  の後')).toBe('見出し の後');
    // 和文・英字・数字・_ に続く K7 は経緯の印ではない（Python の \b と同じ）
    expect(cleanTitle('見出し（オーナーK7）')).toBe('見出し（オーナーK7）');
    expect(cleanTitle('見出し（AK7）')).toBe('見出し（AK7）');
    expect(cleanTitle('見出し（K7a）')).toBe('見出し（K7a）');
    expect(cleanTitle('見出し（_K7）')).toBe('見出し（_K7）');
  });

  it('既知の節: 8.1・8.3・8.4・8.5「追証マップ」・10.3.1・10.4・10.7', () => {
    const at = (id: string) => INDEX.byId.get(id);
    expect(at('8.1')?.title).toBe('タイル');
    expect(at('8.3')?.title).toBe('テール表');
    expect(at('8.4')?.title).toBe('証拠金（概算）');
    expect(at('8.5')?.title).toBe('追証マップ');
    expect(at('8.5')?.anchor).toBe('追証マップ');
    expect(at('8.5')?.level).toBe(3);
    expect(at('10.4')?.title).toBe('IV 推移（ATM IV の 30 日固定）');
    expect(at('10.3.1')?.title).toBe('理論価格（気配が広い行の妥当な価格）');
    expect(at('10.3.1')?.level).toBe(4);
    expect(at('10.7')?.title).toBe('「今」の点とシナリオの水準');
    expect(at('8')?.title).toBe('指標 · テール');
  });

  it('ASK_DOCS のマニュアルの節が全部、番号で引けて見出しも同じ', () => {
    let n = 0;
    for (const topic of AI_ASK_TOPICS) {
      for (const d of ASK_DOCS[topic]) {
        if (d.file !== 'user-guide') continue;
        n++;
        expect(INDEX.byId.get(d.section)?.title, `${topic} ${d.section}`).toBe(d.title);
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('番号の無い章（目次）は id = null。本文は見出しの次の行から、子の節を含む', () => {
    const toc = INDEX.byAnchor.get('目次');
    expect(toc?.id).toBeNull();
    expect(INDEX.byAnchor.get('8-指標--テール')?.body).toContain('### 追証マップ');
    expect(INDEX.byAnchor.get('追証マップ')?.body.startsWith('### ')).toBe(false);
  });

  it('合成: 番号の規則（見出しの番号・兄弟の順・経緯の除去・コードブロックの中の # は数えない）とアンカーの重複', () => {
    const md = [
      '# 題',
      '## 目次',
      '## 1. はじめ',
      '### 開き方（#12）',
      '```',
      '### 見出しではない',
      '```',
      '### 開き方',
      '#### 小節',
      '## 2. 次',
      '### 2.5 番号つき',
      '### 後ろ',
    ].join('\n');
    const idx = manualIndex(md);
    expect(idx.sections.map((s) => [s.anchor, s.id, s.title])).toEqual([
      ['目次', null, '目次'],
      ['1-はじめ', '1', 'はじめ'],
      ['開き方12', '1.1', '開き方'],
      ['開き方', '1.2', '開き方'],
      ['小節', '1.2.1', '小節'],
      ['2-次', '2', '次'],
      ['25-番号つき', '2.5', '番号つき'],
      ['後ろ', '2.2', '後ろ'],
    ]);
    // 同じ見出し（開き方）は見出しでは引かない
    expect(idx.byTitle.has('開き方')).toBe(false);
    expect(idx.byTitle.get('小節')?.id).toBe('1.2.1');
    // 重複のアンカーは -1
    expect(manualIndex('## A\n## A\n').sections.map((s) => s.anchor)).toEqual(['a', 'a-1']);
    expect(slug('10. 市場: スマイル・IV 推移・先物推移')).toBe('10-市場-スマイルiv-推移先物推移');
  });
});

describe('リンクの先（#322 AC2）', () => {
  it('マニュアルの節へのリンク ](#…) が全部、索引の節に当たる', () => {
    const links = [...guide.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(links.length).toBeGreaterThanOrEqual(150);
    for (const l of links) expect(INDEX.byAnchor.has(l), l).toBe(true);
  });

  it('用語集の 25 語の guide.anchor が当たる', () => {
    expect(GLOSSARY).toHaveLength(25);
    for (const t of GLOSSARY) expect(INDEX.byAnchor.has(t.guide.anchor), t.id).toBe(true);
  });

  it('ⓘ の場所 → 節の表（13 か所。#319 で銘柄の推移）の全部が当たり、見出しも同じ', () => {
    const places = Object.entries(HINT_GUIDE);
    expect(places).toHaveLength(13);
    for (const [place, g] of places) {
      const s = INDEX.byAnchor.get(g.anchor);
      expect(s, place).toBeDefined();
      expect(s?.title, place).toBe(g.title);
    }
  });
});

// ---------------------------------------------------------------- 描き方

const SYN = manualIndex(['## 1. 章', '### 行き先', '### 別の節'].join('\n'));
const blocks = (body: string, level = 3) => manualBlocks(body, level, SYN);
const text = (xs: readonly ManualInline[]) => inlineText(xs);
const links = (xs: readonly ManualInline[]) => xs.flatMap((x) => ('anchor' in x ? [x.anchor] : []));

describe('描き方（#322 AC3）', () => {
  it('見出し（番号を付けた文字。h3 から）・段落・区切り線', () => {
    const b = blocks(['段落 1 行目', '2 行目', '', '---', '', '### 行き先', '本文'].join('\n'), 2);
    expect(b).toEqual([
      { kind: 'p', inl: [{ text: '段落 1 行目\n2 行目', bold: false, code: false }] },
      { kind: 'hr' },
      { kind: 'h', level: 3, text: '1.1 行き先' },
      { kind: 'p', inl: [{ text: '本文', bold: false, code: false }] },
    ]);
    // 節（level 3）の中の #### は h3、知らない見出しは見出しの文字のまま
    expect(blocks('#### 知らない（#9）')).toEqual([{ kind: 'h', level: 3, text: '知らない' }]);
  });

  it('同じ見出しが 2 つの章: 本文の中の見出しは自分の節の番号（アンカーの `-1` を数える。レビュー指摘 4）', () => {
    const md = [
      '## 1. 一',
      '### 同じ',
      '#### 小',
      '```',
      '### コードの中（見出しにしない）',
      '```',
      '## 2. 二',
      '### 同じ',
      '#### 小',
    ].join('\n');
    const idx = manualIndex(md);
    const two = idx.byId.get('2');
    expect(two?.headAnchors).toEqual(['同じ-1', '小-1']);
    expect(idx.byId.get('1')?.headAnchors).toEqual(['同じ', '小']);
    const hs = (sec: typeof two) =>
      manualBlocks(sec?.body ?? '', sec?.level ?? 2, idx, sec?.headAnchors ?? null)
        .filter((x) => x.kind === 'h')
        .map((x) => x.text);
    expect(hs(two)).toEqual(['2.1 同じ', '2.1.1 小']);
    expect(hs(idx.byId.get('1'))).toEqual(['1.1 同じ', '1.1.1 小']);
    // 2 つ目の節そのもの（2.1）の本文の見出しも 2.1.1
    expect(hs(idx.byId.get('2.1'))).toEqual(['2.1.1 小']);
  });

  it('箇条書き（入れ子 1 段・字下げした続きの行）と番号つき', () => {
    const b = blocks(
      [
        '- 一つ目',
        '  - 子 A',
        '  - 子 B',
        '    続きの行',
        '- 二つ目',
        '  続き',
        '',
        '1. 手順 1',
        '2. 手順 2',
        '',
        '3. 手順 3',
      ].join('\n'),
    );
    expect(b).toHaveLength(2);
    const ul = b[0] as Extract<ManualBlock, { kind: 'ul' }>;
    expect(ul.kind).toBe('ul');
    expect(ul.items.map((x) => text(x.inl))).toEqual(['一つ目', '二つ目\n続き']);
    expect(ul.items[0]?.sub?.kind).toBe('ul');
    expect(ul.items[0]?.sub?.items.map(text)).toEqual(['子 A', '子 B\n続きの行']);
    expect(ul.items[1]?.sub).toBeNull();
    const ol = b[1] as Extract<ManualBlock, { kind: 'ol' }>;
    expect(ol.kind).toBe('ol');
    expect(ol.start).toBe(1);
    expect(ol.items.map((x) => text(x.inl))).toEqual(['手順 1', '手順 2', '手順 3']);
    // 5 から始まる番号つき
    expect(blocks('5. 五')[0]).toMatchObject({ kind: 'ol', start: 5 });
  });

  it('表（\\| とコードの中の |。列数を見出しに揃える）', () => {
    const b = blocks(
      [
        '| キー | 意味 |',
        '|---|:-:|',
        '| `a|b` | 線 \\| 面 |',
        '| 足りない |',
        '| 1 | 2 | 余り |',
      ].join('\n'),
    );
    expect(b).toHaveLength(1);
    const t = b[0] as Extract<ManualBlock, { kind: 'table' }>;
    expect(t.kind).toBe('table');
    expect(t.head.map(text)).toEqual(['キー', '意味']);
    expect(t.rows.map((r) => r.map(text))).toEqual([
      ['a|b', '線 | 面'],
      ['足りない', ''],
      ['1', '2'],
    ]);
    expect(t.rows[0]?.[0]).toEqual([{ text: 'a|b', bold: false, code: true }]);
    // 区切りの行が無い | の行は段落の文字
    expect(blocks('| ただの | 行 |')[0]?.kind).toBe('p');
  });

  it('コードブロック（行のまま。中の記法は解釈しない）', () => {
    expect(blocks(['```', '│ **x** [a](#行き先)', '  ## y', '```', '後'].join('\n'))).toEqual([
      { kind: 'code', lines: ['│ **x** [a](#行き先)', '  ## y'] },
      { kind: 'p', inl: [{ text: '後', bold: false, code: false }] },
    ]);
  });

  it('行の中: 太字・コード・節へのリンク・太字の中のリンク・角括弧の入れ子・外へのリンク・当たらないアンカー・エスケープ', () => {
    const inl = (s: string) => manualInline(s, SYN);
    expect(inl('a **太字** `c*d` e')).toEqual([
      { text: 'a ', bold: false, code: false },
      { text: '太字', bold: true, code: false },
      { text: ' ', bold: false, code: false },
      { text: 'c*d', bold: false, code: true },
      { text: ' e', bold: false, code: false },
    ]);
    expect(inl('[1 章](#行き先) へ')).toEqual([
      { anchor: '行き先', label: [{ text: '1 章', bold: false, code: false }] },
      { text: ' へ', bold: false, code: false },
    ]);
    expect(inl('**[線 \\| 面](#別の節)**')).toEqual([
      { anchor: '別の節', label: [{ text: '線 | 面', bold: true, code: false }] },
    ]);
    expect(links(inl('[AI 相談（[AI に聞く]・評価）](#行き先)'))).toEqual(['行き先']);
    expect(text(inl('[AI 相談（[AI に聞く]・評価）](#行き先)'))).toBe(
      'AI 相談（[AI に聞く]・評価）',
    );
    // 外へのリンク・当たらないアンカーは表示する文字だけ
    expect(inl('[README の免責](../README.md#免責)・[`design.md`](design.md)・[x](#無い)')).toEqual(
      [
        { text: 'README の免責・', bold: false, code: false },
        { text: 'design.md', bold: false, code: true },
        { text: '・x', bold: false, code: false },
      ],
    );
    // 閉じていない ** と [ は文字のまま、\* は記号だけ
    expect(text(inl('**閉じない [括弧 \\*星'))).toBe('**閉じない [括弧 *星');
    // 知らない記法（引用・HTML の形・画像の形）は文字のまま
    expect(text(inl('> 引用 <b>x</b> ~~消~~'))).toBe('> 引用 <b>x</b> ~~消~~');
  });

  it('目次: 番号のある章と、その中の節（目次の章は出さない）', () => {
    const toc = tocModel(INDEX);
    expect(toc).toHaveLength(20);
    expect(toc[0]?.label).toBe('1 はじめに');
    const ch8 = toc.find((c) => c.anchor === '8-指標--テール');
    expect(ch8?.items.map((x) => x.label)).toContain('8.5 追証マップ');
    expect(toc.find((c) => c.label.startsWith('10 '))?.items).toContainEqual({
      anchor: '理論価格気配が広い行の妥当な価格',
      label: '10.3.1 理論価格（気配が広い行の妥当な価格）',
      level: 4,
    });
    const toc0 = INDEX.byAnchor.get('目次');
    if (!toc0) throw new Error('目次が無い');
    expect(sectionLabel(toc0)).toBe('目次');
  });

  it('マニュアルの全部の節を例外なく描ける（当たったリンクの ]( と閉じた ** が文字に残らない・表の列が揃う）', () => {
    let tables = 0;
    let found = 0;
    const check = (xs: readonly ManualInline[], where: string) => {
      for (const x of xs) {
        if ('anchor' in x) {
          found++;
          expect(INDEX.byAnchor.has(x.anchor), where).toBe(true);
        }
      }
      const t = text(xs);
      expect(t, where).not.toMatch(/\]\(#/);
      // 文字に残る ** は閉じていないものだけ（コードの外）
      const plain = xs
        .flatMap((x) => ('anchor' in x ? x.label : [x]))
        .filter((x) => !x.code)
        .map((x) => x.text)
        .join('');
      expect((plain.match(/\*\*/g) ?? []).length, where).toBeLessThanOrEqual(1);
    };
    for (const s of INDEX.sections) {
      const bs = manualBlocks(s.body, s.level, INDEX, s.headAnchors);
      for (const b of bs) {
        if (b.kind === 'p') check(b.inl, s.anchor);
        else if (b.kind === 'ul' || b.kind === 'ol')
          for (const it of b.items) {
            check(it.inl, s.anchor);
            for (const y of it.sub?.items ?? []) check(y, s.anchor);
          }
        else if (b.kind === 'table') {
          tables++;
          for (const r of b.rows) expect(r.length, s.anchor).toBe(b.head.length);
          for (const c of [...b.head, ...b.rows.flat()]) check(c, s.anchor);
        }
      }
    }
    expect(tables).toBeGreaterThan(10);
    expect(found).toBeGreaterThan(150);
  });
});

describe('節の道筋（#322）', () => {
  it('章から節まで（番号の無い章は見出しだけ）', async () => {
    const { sectionPath } = await import('../../ui/view/manual');
    const s = INDEX.byId.get('10.3.1');
    if (!s) throw new Error('10.3.1 が無い');
    expect(sectionPath(s, INDEX)).toBe(
      '10 市場: スマイル・IV 推移・先物推移 > 10.3 スマイルから足を入れる > 10.3.1 理論価格（気配が広い行の妥当な価格）',
    );
    const toc = INDEX.byAnchor.get('目次');
    if (!toc) throw new Error('目次が無い');
    expect(sectionPath(toc, INDEX)).toBe('目次');
  });
});
