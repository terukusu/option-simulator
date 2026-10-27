import { describe, expect, it } from 'vitest';

/**
 * #81: 画面の CSS（ui/**\/*.css。#91 で旧画面の ui/style.css を消して対象を広げた）の色はトークンだけ
 * （docs/ui-redesign.md §7・§10.1）。
 *
 * (a) 色の値（hex・rgb()・hsl()・色の名前）は tokens.css のテーマの定義
 *     （`:root, :root[data-theme="dark"]` と `:root[data-theme="light"]`）の中だけ。color-mix() もトークン同士
 * (b) §7 の表のトークンがダーク・ライトの両方にあり、値が表と一致する
 * (c) var(--x) で使う名前がすべて定義済み
 * (d) 文字のトークン（--ink / --ink-2 / --ink-3）は面（--bg・--s1〜--s3）に、--ink / --ink-2 は --s4 にも 4.5:1 以上（#279）
 */
/**
 * 一覧は import.meta.glob の鍵だけ（読み込まない）、中身は Node の fs で読む
 * （vitest は CSS を空のモジュールにするので `?raw` では読めない。@types/node を足さないため型はここで最小限に書く）
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

const TOKENS = '../../ui/next/css/tokens.css';
const DARK_SELECTOR = ':root, :root[data-theme="dark"]';
const LIGHT_SELECTOR = ':root[data-theme="light"]';

/**
 * docs/ui-redesign.md §7.1 の全行と §7.2 の hex の行（[dark, light]）。設計書を直したらここも直す。
 * `--expiry` は両テーマとも `var(--ink)`、`--gain-fill`・`--loss-fill` は値が α なので存在だけを見る。
 */
const TABLE: Record<string, readonly [string, string]> = {
  // 7.1 面と文字
  '--bg': ['#0e1116', '#eef0f3'],
  '--s1': ['#151921', '#ffffff'],
  '--s2': ['#1b2029', '#f6f7f9'],
  '--s3': ['#232a36', '#eceef2'],
  '--s4': ['#2b3340', '#e1e4ea'],
  '--line': ['#262d3a', '#dde1e7'],
  '--line-2': ['#3a4455', '#c4cad4'],
  '--ink': ['#e6e9ef', '#12161c'],
  '--ink-2': ['#a3acbb', '#4f5867'],
  '--ink-3': ['#8891a2', '#626b79'],
  // 7.2 意味の色
  '--expiry': ['var(--ink)', 'var(--ink)'],
  '--accent': ['#3987e5', '#2a78d6'],
  '--today': ['#8b94a5', '#6b7380'],
  '--handle': ['#d95926', '#e05a1f'],
  '--pin1': ['#199e70', '#1baf7a'],
  '--pin2': ['#9085e9', '#6250d6'],
  '--pin3': ['#d55181', '#d8578a'],
  '--gain': ['#2fb483', '#0f8a5c'],
  '--loss': ['#ef6b6b', '#d13f3f'],
  '--warn': ['#d9962a', '#a86b00'],
  // #206 先物推移の EMA の 3 本
  '--ema-s': ['#b48a2c', '#b07d00'],
  '--ema-m': ['#9c6de4', '#8c52d6'],
  '--ema-l': ['#2196ad', '#0d8ca3'],
};
const PRESENT_ONLY = ['--gain-fill', '--loss-fill'];

/** 試作品が直書きしていた色を役割の名前にしたもの（§10.1）。両テーマにあること */
const ROLE_TOKENS = [
  '--accent-ink',
  '--accent-fill',
  '--handle-fill',
  '--bid',
  '--ask',
  '--warn-fill',
  '--on-accent',
  '--scrim',
  '--backdrop',
  '--shadow',
  '--shadow-sm',
];

/** CSS の色の名前（CSS Color 4 の named colors）。transparent・currentColor は色の値として数えない */
const NAMED = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen ' +
    'mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace ' +
    'olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred ' +
    'papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue ' +
    'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey ' +
    'snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen'
  ).split(' '),
);

/** 本文の文字に使うトークンと、文字が載る面。#279 V-01 */
const TEXT_TOKENS = ['--ink', '--ink-2', '--ink-3'];
const TEXT_SURFACES = ['--bg', '--s1', '--s2', '--s3'];
/**
 * --s4（トースト・バッジの面）に載る文字は --ink と --ink-2 だけ（--ink-3 は --s4 に 4.5:1 を切る）。
 * BOX タブの件数のバッジ（top.css の .boxtab .n）が --ink-2（#279 のレビュー）
 */
const S4_TEXT_TOKENS = ['--ink', '--ink-2'];

const isHex6 = (c: string) => /^#[0-9a-f]{6}$/i.test(c);

/** WCAG 2.x の相対輝度（#rrggbb） */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return Number.NaN;
  const n = Number.parseInt(m[1] ?? '', 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** コントラスト比（1〜21。色が #rrggbb でなければ NaN = 検査が落ちる） */
function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Block {
  selector: string;
  body: string;
  start: number;
  end: number;
}

/** 宣言を持つ規則（@media の中も含む）を取り出す小さな解析。トークンの定義を探すためだけに使う */
function blocks(css: string): Block[] {
  const out: Block[] = [];
  const stack: { start: number; open: number }[] = [];
  let boundary = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      stack.push({ start: boundary, open: i });
      boundary = i + 1;
    } else if (c === '}') {
      const top = stack.pop();
      if (top) {
        const body = css.slice(top.open + 1, i);
        if (!body.includes('{')) {
          out.push({
            selector: css.slice(top.start, top.open).trim(),
            body,
            start: top.start,
            end: i + 1,
          });
        }
      }
      boundary = i + 1;
    } else if (c === ';') {
      boundary = i + 1;
    }
  }
  return out;
}

function decls(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part
      .slice(at + 1)
      .trim()
      .replace(/\s+/g, ' ');
    if (name) m.set(name, value);
  }
  return m;
}

const tokensCss = stripComments(files[TOKENS] ?? '');
const tokenBlocks = blocks(tokensCss);
const dark = tokenBlocks.find((b) => b.selector.replace(/\s+/g, ' ') === DARK_SELECTOR);
const light = tokenBlocks.find((b) => b.selector === LIGHT_SELECTOR);
const darkDecls = decls(dark?.body ?? '');
const lightDecls = decls(light?.body ?? '');

/** 色の値の出現（hex・rgb/rgba・hsl/hsla・色の名前） */
function colorHits(css: string): string[] {
  const hits: string[] = [];
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) hits.push(m[0]);
  for (const b of blocks(css)) {
    for (const [name, value] of decls(b.body)) {
      const v = value.replace(/"[^"]*"|'[^']*'/g, '').replace(/var\([^)]*\)/g, '');
      for (const w of v.matchAll(/(?<![\w-])[a-zA-Z]+(?![\w-])/g)) {
        if (NAMED.has(w[0].toLowerCase())) hits.push(`${name}: ${w[0]}`);
      }
    }
  }
  return hits;
}

describe('ui/next の CSS のトークン（§7）', () => {
  it('CSS のファイルが読めて、tokens.css に 2 つのテーマの定義がある', () => {
    expect(Object.keys(files)).toContain(TOKENS);
    expect(Object.keys(files)).toContain('../../ui/next/next.css');
    expect(dark, DARK_SELECTOR).toBeDefined();
    expect(light, LIGHT_SELECTOR).toBeDefined();
    expect(darkDecls.get('color-scheme')).toBe('dark');
    expect(lightDecls.get('color-scheme')).toBe('light');
  });

  it('(a) 色の値は tokens.css のテーマの定義の中だけ', () => {
    for (const [path, raw] of Object.entries(files)) {
      let css = stripComments(raw);
      if (path === TOKENS) {
        // テーマの定義を取り除いた残りを調べる（後ろから消して位置をずらさない）
        for (const b of [dark, light]
          .filter((x): x is Block => !!x)
          .sort((a, b) => b.start - a.start)) {
          css = css.slice(0, b.start) + css.slice(b.end);
        }
      }
      expect(colorHits(css), path).toEqual([]);
    }
  });

  it('(a) color-mix() はトークン同士（var() と割合・transparent だけ）', () => {
    for (const [path, raw] of Object.entries(files)) {
      for (const m of stripComments(raw).matchAll(/color-mix\(([^;]*)\)/g)) {
        const rest = (m[1] ?? '')
          .replace(/var\(--[\w-]+\)/g, '')
          .replace(/\bin (srgb|oklab|oklch)\b/g, '')
          .replace(/\btransparent\b/g, '')
          .replace(/[\d.]+%/g, '')
          .replace(/[\s,]/g, '');
        expect(rest, `${path}: ${m[0]}`).toBe('');
      }
    }
  });

  it('(b) §7 の表のトークンがダーク・ライトの両方にあり、値が表と一致', () => {
    for (const [name, [d, l]] of Object.entries(TABLE)) {
      expect(darkDecls.get(name)?.toLowerCase(), `dark ${name}`).toBe(d);
      expect(lightDecls.get(name)?.toLowerCase(), `light ${name}`).toBe(l);
    }
    for (const name of [...PRESENT_ONLY, ...ROLE_TOKENS]) {
      expect(darkDecls.has(name), `dark ${name}`).toBe(true);
      expect(lightDecls.has(name), `light ${name}`).toBe(true);
    }
  });

  it('(b) ダークとライトは同じ名前の集合（片方だけの色を作らない）', () => {
    expect([...lightDecls.keys()].sort()).toEqual([...darkDecls.keys()].sort());
  });

  it('(c) var(--x) で使う名前はすべて定義済み', () => {
    const defined = new Set<string>();
    for (const raw of Object.values(files)) {
      for (const m of stripComments(raw).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1] ?? '');
    }
    const missing: string[] = [];
    for (const [path, raw] of Object.entries(files)) {
      for (const m of stripComments(raw).matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!defined.has(m[1] ?? '')) missing.push(`${path}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('(d) 文字のトークンは文字の載る面に両テーマとも 4.5:1 以上（WCAG 2.x の AA。#279 V-01）', () => {
    for (const [theme, d] of [
      ['dark', darkDecls],
      ['light', lightDecls],
    ] as const) {
      const pairs = [
        ...TEXT_TOKENS.flatMap((ink) => TEXT_SURFACES.map((surface) => [ink, surface] as const)),
        ...S4_TEXT_TOKENS.map((ink) => [ink, '--s4'] as const),
      ];
      for (const [ink, surface] of pairs) {
        const fg = d.get(ink) ?? '';
        const bg = d.get(surface) ?? '';
        const what = `${theme} ${ink}(${fg}) / ${surface}(${bg})`;
        for (const c of [fg, bg]) expect(isHex6(c), `${what}: ${c} が #rrggbb でない`).toBe(true);
        expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('--s4 の上の文字（BOX タブの件数のバッジ）は --ink-3 でない（#279 のレビュー）', () => {
    const top = stripComments(files['../../ui/next/css/top.css'] ?? '');
    const badge = blocks(top).find((b) => b.selector === '.boxtab .n');
    expect(badge, '.boxtab .n').toBeDefined();
    const d = decls(badge?.body ?? '');
    expect(d.get('background')).toBe('var(--s4)');
    expect(S4_TEXT_TOKENS.map((t) => `var(${t})`)).toContain(d.get('color'));
  });

  it('コントラストの計算そのもの（白 / 黒 = 21、同じ色 = 1、#767676 / 白 ≈ 4.54）', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 6);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrast('#8b94a3', '#ffffff')).toBeLessThan(4.5);
  });

  it('検査そのものが色を見つけられる（偽の CSS）', () => {
    expect(colorHits('.a { color: #fff; }')).toEqual(['#fff']);
    expect(colorHits('.a { background: rgba(0,0,0,.4); }')).toEqual(['rgba(']);
    expect(colorHits('.a { border: 1px solid red; }')).toEqual(['border: red']);
    expect(
      colorHits('.a { color: var(--ink); background: transparent; white-space: nowrap; }'),
    ).toEqual([]);
  });
});
