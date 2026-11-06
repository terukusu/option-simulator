import { describe, expect, it } from 'vitest';
import { PHONE_QUERY } from '../../ui/view/layout';

/**
 * #327: ⓘ（Popover の既定のボタン .hintbtn）の当たり判定（docs/ui-guidelines.md P8・5 章 5、docs/ui-redesign.md §2.2・§10）。
 * スマホの条件（PHONE_QUERY）だけ箱を 24×24px にし、見た目（18px の丸い枠）と並びの大きさ（18px）は変えない。
 * ui:check（--targets）は CI に入らないので、CSS の値をここで固定する。
 *
 * (a) @media の外の .hintbtn の width・height が 18px（PC / タブレットは不変）
 * (b) スマホの @media の中の .hintbtn の width・height が 24px 以上
 * (c) 並びの大きさ = スマホの width + 2 × margin が (a) の 18px（行の配置・折り返しを変えない）
 * (d) スマホの .hintbtn::before の丸 = スマホの width − 2 × inset が (a) の 18px、border が 1px solid var(--line-2)
 * (e) スマホの .hintbtn は border-radius 0（当たりを 24px の正方形のまま = 円に切らない）、フォーカスの輪は ::before（丸）
 */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const css = fs
  .readFileSync(new URL('../../ui/next/css/parts.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

type Block = { media: string | null; selector: string; body: string };

/** 最上位の規則と @media の中の規則を { } の対応で切り出す（入れ子は @media の 1 段だけ） */
function rules(src: string): Block[] {
  const out: Block[] = [];
  const walk = (text: string, media: string | null) => {
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
      else out.push({ media, selector: head, body });
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

/** px の 1 値だけを読む */
function px(v: string): number {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  if (!m) throw new Error(`px の 1 値でない: ${v}`);
  return Number(m[1]);
}

function only(blocks: Block[], what: string): Block {
  if (blocks.length !== 1) throw new Error(`${what} が ${blocks.length} 個（1 個のはず）`);
  return blocks[0] as Block;
}

const all = rules(css);
const phone = all.filter((b) => b.media === PHONE_QUERY);
const base = only(
  all.filter((b) => b.media === null && b.selector === '.hintbtn'),
  '@media の外の .hintbtn',
);

describe('ⓘ の当たり判定（#327）', () => {
  it('(a) @media の外の .hintbtn は 18×18px', () => {
    expect(px(decl(base.body, 'width'))).toBe(18);
    expect(px(decl(base.body, 'height'))).toBe(18);
  });

  it('(b) スマホの @media の中の .hintbtn は 24×24px 以上', () => {
    const b = only(
      phone.filter((x) => x.selector === '.hintbtn'),
      'スマホの .hintbtn',
    );
    expect(px(decl(b.body, 'width'))).toBeGreaterThanOrEqual(24);
    expect(px(decl(b.body, 'height'))).toBeGreaterThanOrEqual(24);
  });

  it('(c) スマホの並びの大きさ（width + 2 × margin）は 18px のまま', () => {
    const b = only(
      phone.filter((x) => x.selector === '.hintbtn'),
      'スマホの .hintbtn',
    );
    const m = px(decl(b.body, 'margin'));
    expect(px(decl(b.body, 'width')) + 2 * m).toBe(px(decl(base.body, 'width')));
    expect(px(decl(b.body, 'height')) + 2 * m).toBe(px(decl(base.body, 'height')));
  });

  it('(d) スマホの丸い枠（::before）は 18px・1px solid var(--line-2)', () => {
    const b = only(
      phone.filter((x) => x.selector === '.hintbtn'),
      'スマホの .hintbtn',
    );
    const before = only(
      phone.filter((x) => x.selector === '.hintbtn::before'),
      'スマホの .hintbtn::before',
    );
    const inset = px(decl(before.body, 'inset'));
    expect(px(decl(b.body, 'width')) - 2 * inset).toBe(px(decl(base.body, 'width')));
    expect(decl(before.body, 'border')).toBe('1px solid var(--line-2)');
    expect(decl(before.body, 'border-radius')).toBe('50%');
  });

  it('(e) スマホの当たりは正方形（border-radius 0）・フォーカスの輪は丸（::before）', () => {
    const b = only(
      phone.filter((x) => x.selector === '.hintbtn'),
      'スマホの .hintbtn',
    );
    expect(px(decl(b.body, 'border-radius').replace(/^0$/, '0px'))).toBe(0);
    const ring = only(
      phone.filter((x) => x.selector === '.hintbtn:focus-visible::before'),
      'スマホの .hintbtn:focus-visible::before',
    );
    expect(decl(ring.body, 'outline')).toBe('2px solid var(--accent)');
  });
});
