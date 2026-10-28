import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon } from '../../ui/next/parts/Icon';

/**
 * #292: ボタンの記号は文字にせず共通のアイコン部品（ui/next/parts/Icon.tsx）で描く（docs/ui-redesign.md §5・§10.1）。
 *
 * (a) 部品の形: すべての名前で svg・viewBox 0 0 18 18・aria-hidden="true"・class に ic
 * (b) 色は currentColor か none だけ（色の値を書かない）、style の prop が無い（CSP）
 * (c) 名前の一覧が 10 個を含む
 * (d) ソースの検査: ボタンの記号の文字・Popover / Menu の button="記号"・CSS の content: "▸" / "▾" が残らない
 *     （許すのはボタンでない記号の 2 か所 = 板の IV 不安定の印・損益グラフの十字線の読み取りの ×）
 */

type VNodeLike = { type: unknown; props: Record<string, unknown> };

function isVNode(x: unknown): x is VNodeLike {
  return typeof x === 'object' && x !== null && 'type' in x && 'props' in x;
}

/** VNode とその子孫（children は 1 個なら配列でない）を列挙する */
function walk(node: unknown, out: VNodeLike[] = []): VNodeLike[] {
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
    return out;
  }
  if (!isVNode(node)) return out;
  out.push(node);
  walk(node.props.children, out);
  return out;
}

describe('Icon（#292）', () => {
  it('(c) 名前の一覧が 10 個を含み重複がない', () => {
    const want = [
      'refresh',
      'reset',
      'plus',
      'minus',
      'close',
      'more',
      'swap',
      'info',
      'moon',
      'chevron',
    ];
    for (const n of want) expect(ICON_NAMES).toContain(n);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  for (const name of ICON_NAMES) {
    it(`(a)(b) ${name}: svg・18 の格子・aria-hidden・class・色は currentColor / none だけ・style なし`, () => {
      const root = Icon({ name }) as unknown;
      expect(isVNode(root)).toBe(true);
      const svg = root as VNodeLike;
      expect(svg.type).toBe('svg');
      expect(svg.props.viewBox).toBe('0 0 18 18');
      expect(svg.props['aria-hidden']).toBe('true');
      expect(svg.props.focusable).toBe('false');
      const cls = String(svg.props.class).split(/\s+/);
      expect(cls).toContain('ic');
      expect(cls).toContain(`ic-${name}`);

      const nodes = walk(svg);
      // 空の svg でない
      expect(nodes.length).toBeGreaterThan(1);
      for (const n of nodes) {
        expect(n.props).not.toHaveProperty('style');
        for (const key of ['fill', 'stroke'] as const) {
          const v = n.props[key];
          if (v !== undefined) expect(['none', 'currentColor']).toContain(v);
        }
      }
    });
  }
});

/** 一覧は import.meta.glob の鍵だけ、中身は Node の fs で読む（tests/ui/cssTokens.test.ts と同じ読み方） */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const read = (keys: string[]): Record<string, string> =>
  Object.fromEntries(keys.map((p) => [p, fs.readFileSync(new URL(p, import.meta.url), 'utf8')]));
const tsx = read(Object.keys(import.meta.glob('../../ui/next/**/*.tsx')));
const css = read(Object.keys(import.meta.glob('../../ui/**/*.css')));

/** 行ごとに正規表現に当たったものを「ファイル:行」で返す */
function hits(files: Record<string, string>, re: RegExp): string[] {
  const out: string[] = [];
  for (const [path, src] of Object.entries(files)) {
    src.split('\n').forEach((line, i) => {
      if (re.test(line)) out.push(`${path.replace('../../', '')}:${i + 1}`);
    });
  }
  return out;
}

describe('ソースに記号の文字が残らない（#292）', () => {
  it('読む対象が空でない', () => {
    expect(Object.keys(tsx).length).toBeGreaterThan(10);
    expect(Object.keys(css).length).toBeGreaterThan(5);
  });

  it('子テキストの記号はボタンでない 2 か所だけ（板の IV 不安定の印・損益グラフの十字線の ×）', () => {
    const found = hits(tsx, /^\s*[⟳⟲⇄×⋯−＋+ⓘ☾▸▾]\s*$/);
    const files = found.map((h) => h.replace(/:\d+$/, ''));
    expect(files.sort()).toEqual(['ui/next/market/BoardMonth.tsx', 'ui/next/stage/PnlPlot.tsx']);
  });

  it('Popover / Menu の button に記号の文字を渡さない', () => {
    expect(hits(tsx, /button="[⟳⟲⇄×⋯−＋ⓘ☾]"/)).toEqual([]);
  });

  it('CSS の content で折りたたみの印を描かない', () => {
    expect(hits(css, /content:\s*"[▸▾]"/)).toEqual([]);
  });
});
