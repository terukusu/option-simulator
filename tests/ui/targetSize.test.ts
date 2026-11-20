import { describe, expect, it } from 'vitest';
import { LAND_QUERY } from '../../ui/view/layout';

/**
 * #366: ⓘ 以外の 24px 未満の押せる要素の当たり判定（docs/ui-guidelines.md P8・5 章 5、docs/ui-redesign.md §5・§10.1）。
 * ui:check（--targets）は CI に入らないので、CSS の値をここで固定する。
 *
 * (a) Seg のボタン（.seg > button）は min-width 24px 以上。ほかの規則で Seg のボタンの幅を 24px 未満にしない
 * (b) シートのつまみ（縦向き）は並びの高さ 18px のまま、::after で上へ 6px 広げて当たり 24px。横向き（LAND_QUERY）は
 *     ::after を出さない（横向きの当たりは width 24px。#348）
 * (c) 先物推移の凡例の段の切替のチップは枠 18px のまま、::after で枠の外へ上下 3px（padding の箱から 4px）= 当たり 24px
 */
const fs = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: 'node:fs'): {
        readFileSync(p: URL, enc: 'utf8'): string;
        readdirSync(p: URL): string[];
      };
    };
  }
).process.getBuiltinModule('node:fs');
const CSS_DIR = new URL('../../ui/next/css/', import.meta.url);
const read = (name: string) =>
  fs.readFileSync(new URL(name, CSS_DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type Block = { at: string | null; selector: string; body: string };

/** 最上位の規則と @media / @container の中の規則を { } の対応で切り出す（at は一番内側の @ の条件） */
function rules(src: string): Block[] {
  const out: Block[] = [];
  const walk = (text: string, at: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).replace(/\s+/g, ' ').trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head.slice('@media'.length).trim());
      else if (head.startsWith('@')) walk(body, head);
      else out.push({ at, selector: head, body });
      i = j;
    }
  };
  walk(src, null);
  return out;
}

/** 宣言の値（最後の 1 つ）。無ければ throw（書式が変わって読めないときに黙って pass にしない） */
function decl(body: string, prop: string): string {
  const ms = [...body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`, 'g'))];
  const v = ms.at(-1)?.[1]?.trim();
  if (v === undefined) throw new Error(`${prop} が見つからない: ${body}`);
  return v;
}

/** px の値の並び（`-6px 0 0` → [-6, 0, 0]。0 は単位なしも可） */
function pxs(v: string): number[] {
  return v.split(/\s+/).map((t) => {
    const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(t);
    if (!m || (m[2] === undefined && m[1] !== '0')) throw new Error(`px の値でない: ${v}`);
    return Number(m[1]);
  });
}
const px = (v: string) => {
  const a = pxs(v);
  if (a.length !== 1) throw new Error(`px の 1 値でない: ${v}`);
  return a[0] as number;
};

/** inset の上・右・下・左（CSS の 1〜4 値の省略） */
function inset(v: string): [number, number, number, number] {
  const a = pxs(v);
  const [t = 0, r = t, b = t, l = r] = a;
  return [t, r, b, l];
}

function only(blocks: Block[], what: string): Block {
  if (blocks.length !== 1) throw new Error(`${what} が ${blocks.length} 個（1 個のはず）`);
  return blocks[0] as Block;
}

const files = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));
const parts = rules(read('parts.css'));
const shell = rules(read('shell.css'));
const iv = rules(read('iv.css'));

describe('24px 未満の押せる要素（#366）', () => {
  it('(a) Seg のボタンは幅 24px 以上', () => {
    const base = only(
      parts.filter((b) => b.at === null && b.selector === '.seg > button'),
      '@media の外の .seg > button',
    );
    expect(px(decl(base.body, 'min-width'))).toBeGreaterThanOrEqual(24);
    // ほかの CSS で Seg のボタンの幅を 24px 未満に決めていない（詰める規則は padding だけ）
    const narrow = files.flatMap((f) =>
      rules(read(f))
        // Seg のボタン自身の規則（`… .seg > button`・`:hover` など。中のアイコン `> svg.ic` は除く）
        .filter((b) =>
          b.selector.split(',').some((x) => /\.seg[^>]*>\s*button(?:[:[][^\s>]*)?$/.test(x.trim())),
        )
        .flatMap((b) =>
          ['width', 'min-width', 'max-width']
            .filter((p) => new RegExp(`(?:^|[;\\s])${p}\\s*:`).test(b.body))
            .map((p) => ({ f, sel: b.selector, p, v: decl(b.body, p) })),
        )
        .filter((d) => !(d.f === 'parts.css' && d.sel === '.seg > button' && d.p === 'min-width'))
        .filter((d) => !/^\d+(\.\d+)?px$/.test(d.v) || Number.parseFloat(d.v) < 24),
    );
    expect(narrow).toEqual([]);
  });

  it('(b) つまみは並び 18px・当たりは ::after で上へ 6px（横向きは ::after なし）', () => {
    const g = only(
      shell.filter((b) => b.at === null && b.selector === '.grabber'),
      '@media の外の .grabber',
    );
    expect(px(decl(g.body, 'height'))).toBe(18);
    expect(decl(g.body, 'position')).toBe('relative');
    const after = only(
      shell.filter((b) => b.at === null && b.selector === '.grabber::after'),
      '@media の外の .grabber::after',
    );
    expect(decl(after.body, 'position')).toBe('absolute');
    const [t, r, b, l] = inset(decl(after.body, 'inset'));
    expect({ r, b, l }).toEqual({ r: 0, b: 0, l: 0 });
    expect(px(decl(g.body, 'height')) - t).toBeGreaterThanOrEqual(24);
    const land = only(
      shell.filter((x) => x.at === LAND_QUERY && x.selector === '.grabber::after'),
      '横向きの .grabber::after',
    );
    expect(decl(land.body, 'display')).toBe('none');
  });

  it('(c) 段の切替のチップは枠 18px・当たりは ::after で上下へ広げて 24px', () => {
    const sel = '.iv-legend > .ind-toggles .chip';
    const c = only(
      iv.filter((b) => b.at === null && b.selector === sel),
      sel,
    );
    expect(px(decl(c.body, 'height'))).toBe(18);
    expect(decl(c.body, 'position')).toBe('relative');
    const after = only(
      iv.filter((b) => b.at === null && b.selector === `${sel}::after`),
      `${sel}::after`,
    );
    expect(decl(after.body, 'position')).toBe('absolute');
    // inset の基準は padding の箱（枠の内側）。枠は .chip の border の幅
    const chip = only(
      parts.filter((b) => b.at === null && b.selector === '.chip'),
      '.chip',
    );
    const border = px(decl(chip.body, 'border').split(/\s+/)[0] as string);
    const [t, r, b, l] = inset(decl(after.body, 'inset'));
    expect({ r, l }).toEqual({ r: 0, l: 0 });
    expect(px(decl(c.body, 'height')) - 2 * border - t - b).toBeGreaterThanOrEqual(24);
    // 凡例の行の上下の padding（6px）の中に収まる = 枠の外への張り出しが padding 以下（行の高さも見た目も変わらない）
    const legend = only(
      iv.filter((x) => x.at === null && x.selector === '.iv-legend'),
      '.iv-legend',
    );
    const pad = px(decl(legend.body, 'padding').split(/\s+/)[0] as string);
    expect(-t - border).toBeLessThanOrEqual(pad);
  });
});
