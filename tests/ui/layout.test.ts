import { describe, expect, it } from 'vitest';
import {
  CSS_MEDIA,
  LAND_QUERY,
  PC_QUERY,
  PHONE_QUERY,
  TABLET_MEDIA,
  TABLET_UP_MEDIA,
} from '../../ui/view/layout';

/**
 * #348: 画面の段階の条件（ui/view/layout.ts）と CSS の @media の照合（docs/ui-redesign.md §2.5・§10.1）。
 *
 * (a) 定数の文字列（横向き・スマホ・PC）
 * (b) ui/**\/*.css の @media の条件（prefers-*・forced-colors を除く）がすべて CSS_MEDIA のどれか（JS と CSS の食い違い 0）。
 *     段の CSS（スマホ・タブレット・タブレット以上）がそれぞれ少なくとも 1 か所で使われている
 * (c) タブレットの条件は横向きを含まない（pointer: fine / pointer: none / min-height: 500.02px の 3 つの和）
 * (d) 条件の意味: 代表の窓（幅・高さ・pointer）で、スマホ・タブレット・PC のちょうど 1 つに当たる
 */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const files: Record<string, string> = Object.fromEntries(
  Object.keys(import.meta.glob('../../ui/**/*.css')).map((path) => [
    path,
    fs.readFileSync(new URL(path, import.meta.url), 'utf8'),
  ]),
);

/** コメントを除いた CSS の @media の条件（空白を 1 つにそろえる） */
function mediaConditions(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...src.matchAll(/@media\s+([^{]+)\{/g)].map((m) =>
    (m[1] ?? '').replace(/\s+/g, ' ').trim(),
  );
}

const all = Object.entries(files).flatMap(([path, css]) =>
  mediaConditions(css).map((q) => ({ path, q })),
);

type Pointer = 'coarse' | 'fine' | 'none';
interface Win {
  w: number;
  h: number;
  pointer: Pointer;
}

/** MQ3 の条件（カンマの和・and・min/max-width・min/max-height・pointer）を窓で評価する（このテストの書き方だけ） */
function matches(query: string, win: Win): boolean {
  return query.split(',').some((part) =>
    part
      .trim()
      .split(/\s+and\s+/)
      .every((f) => {
        const m = /^\((min|max)-(width|height): ([0-9.]+)px\)$/.exec(f);
        if (m) {
          const v = m[2] === 'width' ? win.w : win.h;
          const n = Number(m[3]);
          return m[1] === 'min' ? v >= n : v <= n;
        }
        const p = /^\(pointer: (coarse|fine|none)\)$/.exec(f);
        if (p) return win.pointer === p[1];
        throw new Error(`評価できない条件: ${f}`);
      }),
  );
}

describe('画面の段階の条件（#348）', () => {
  it('(a) 定数の文字列', () => {
    expect(LAND_QUERY).toBe(
      '(pointer: coarse) and (min-width: 560px) and (max-width: 1199.98px) and (max-height: 500px)',
    );
    expect(PHONE_QUERY).toBe(`(max-width: 719.98px), ${LAND_QUERY}`);
    expect(PC_QUERY).toBe('(min-width: 1200px)');
    expect(TABLET_UP_MEDIA).toBe(`${PC_QUERY}, ${TABLET_MEDIA}`);
  });

  it('(b) CSS の @media の条件はすべて ui/view/layout.ts の一覧のどれか', () => {
    expect(all.length).toBeGreaterThan(10);
    const allowed = new Set(CSS_MEDIA);
    // prefers-*・forced-colors は利用者の環境のメディア特性で、画面の段の条件ではない（#327: 強制カラーの ⓘ の輪）
    const bad = all.filter(
      ({ q }) => !q.startsWith('(prefers-') && !q.startsWith('(forced-colors:') && !allowed.has(q),
    );
    expect(bad).toEqual([]);
  });

  it('(b) 段の CSS はそれぞれ使われている（スマホ・タブレット・タブレット以上・横向き）', () => {
    const used = new Set(all.map(({ q }) => q));
    for (const q of [PHONE_QUERY, PC_QUERY, TABLET_MEDIA, TABLET_UP_MEDIA, LAND_QUERY]) {
      expect(used.has(q), q).toBe(true);
    }
    // 幅だけのスマホ・タブレットの条件は残っていない（横向きを取りこぼす）
    expect(used.has('(max-width: 719.98px)')).toBe(false);
    expect(used.has('(min-width: 720px) and (max-width: 1199.98px)')).toBe(false);
    expect(used.has('(min-width: 720px)')).toBe(false);
  });

  it('(c) タブレットの条件は横向きを含まない 3 つの和', () => {
    const w = '(min-width: 720px) and (max-width: 1199.98px)';
    expect(TABLET_MEDIA.split(', ')).toEqual([
      `${w} and (pointer: fine)`,
      `${w} and (pointer: none)`,
      `${w} and (min-height: 500.02px)`,
    ]);
  });

  const tierOf = (win: Win) => {
    const hits = [
      matches(PHONE_QUERY, win) && 'phone',
      matches(TABLET_MEDIA, win) && 'tablet',
      matches(PC_QUERY, win) && 'pc',
    ].filter(Boolean);
    expect(hits, `${win.w}x${win.h} ${win.pointer}`).toHaveLength(1);
    return { tier: hits[0], land: matches(LAND_QUERY, win) };
  };

  it.each<[number, number, Pointer, string, boolean]>([
    // スマホの縦向き
    [360, 780, 'coarse', 'phone', false],
    [390, 844, 'coarse', 'phone', false],
    // スマホの横向き
    [844, 390, 'coarse', 'phone', true],
    [915, 412, 'coarse', 'phone', true],
    [740, 360, 'coarse', 'phone', true],
    [667, 375, 'coarse', 'phone', true],
    [568, 320, 'coarse', 'phone', true],
    [1199, 500, 'coarse', 'phone', true],
    // 横向きにしない: 高さ > 500 のタッチ（タブレットの縦・横）、マウスの低い窓、幅 ≥ 1200 の低いタッチ
    [820, 1180, 'coarse', 'tablet', false],
    [1180, 820, 'coarse', 'tablet', false],
    [1000, 501, 'coarse', 'tablet', false],
    [900, 450, 'fine', 'tablet', false],
    [900, 450, 'none', 'tablet', false],
    [900, 1100, 'fine', 'tablet', false],
    [1280, 500, 'fine', 'pc', false],
    [1280, 400, 'coarse', 'pc', false],
    [1440, 900, 'fine', 'pc', false],
    // 幅 < 560 の低い窓は縦向きのスマホの形（キーボードを開いた縦向きを巻き込まない）
    [540, 300, 'coarse', 'phone', false],
  ])('(d) %ix%i %s → %s・横向き %s', (w, h, pointer, tier, land) => {
    expect(tierOf({ w, h, pointer })).toEqual({ tier, land });
  });

  it('(d) タブレット以上 = PC かタブレット（スマホの段の補集合）', () => {
    for (const w of [560, 719, 720, 900, 1199, 1200, 1440]) {
      for (const h of [320, 450, 500, 501, 900]) {
        for (const pointer of ['coarse', 'fine', 'none'] as const) {
          const win = { w, h, pointer };
          expect(matches(TABLET_UP_MEDIA, win), `${w}x${h} ${pointer}`).toBe(
            !matches(PHONE_QUERY, win),
          );
        }
      }
    }
  });
});
