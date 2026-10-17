import { describe, expect, it } from 'vitest';

/**
 * #90: PWA（ホーム画面に追加とアイコン。docs/ui-redesign.md §10.1「PWA」・§11 決定 10）。
 *
 * (a) manifest の項目 (b) theme_color / background_color = tokens.css のダークの --bg
 * (c) icons と禁止の語 (d) PNG の署名・大きさ・不透明 (e) favicon.svg に script・style・外部参照なし
 * (f) index.html の head のリンク・meta
 *
 * 色の値はテストに写さず tokens.css を読む（色を変えたら manifest・index.html の直し漏れがここで落ちる）。
 * ファイルは Node の fs で読む（@types/node を足さないため型はここで最小限に書く。cssTokens.test.ts と同じ）。
 */
const fs = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: 'node:fs'): {
        readFileSync(p: URL, enc: 'utf8'): string;
        readFileSync(p: URL): Uint8Array;
      };
    };
  }
).process.getBuiltinModule('node:fs');

const url = (path: string) => new URL(path, import.meta.url);
const text = (path: string) => fs.readFileSync(url(path), 'utf8');

const PUBLIC = '../../ui/public/';
const manifestText = text(`${PUBLIC}manifest.webmanifest`);
const manifest = JSON.parse(manifestText) as Record<string, unknown>;
const svg = text(`${PUBLIC}favicon.svg`);
const html = text('../../ui/index.html');
const tokens = text('../../ui/next/css/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** tokens.css の、セレクタ（空白を詰めて比べる）がちょうど selector の規則の --bg */
function bg(selector: string): string {
  const norm = (s: string) => s.replace(/\s+/g, '');
  for (const m of tokens.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (norm(m[1] ?? '') !== norm(selector)) continue;
    const v = /(?:^|;)\s*--bg\s*:\s*([^;]+);/.exec(m[2] ?? '')?.[1]?.trim();
    if (v) return v.toLowerCase();
  }
  throw new Error(`tokens.css に ${selector} の --bg がありません`);
}
const DARK_BG = bg(':root, :root[data-theme="dark"]');
const LIGHT_BG = bg(':root[data-theme="light"]');

/** index.html の <tag ...> を属性の辞書で（属性の順序・改行に依存しない） */
function tags(name: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((m) =>
    Object.fromEntries(
      [...(m[1] ?? '').matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((a) => [
        (a[1] ?? '').toLowerCase(),
        a[2] ?? '',
      ]),
    ),
  );
}

describe('PWA の manifest（#90）', () => {
  it('(a) 名前・言語・id / start_url / scope・display', () => {
    expect(manifest.name).toBe('OP Simulator');
    expect(manifest.short_name).toBe('OP Sim');
    expect(manifest.lang).toBe('ja');
    expect(manifest.id).toBe('./');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.display).toBe('browser');
  });

  it('(b) theme_color と background_color は tokens.css のダークの --bg', () => {
    expect(DARK_BG).toMatch(/^#[0-9a-f]{6}$/);
    expect(String(manifest.theme_color).toLowerCase()).toBe(DARK_BG);
    expect(String(manifest.background_color).toLowerCase()).toBe(DARK_BG);
  });

  it('(c) icons は 192 と 512 の PNG の 2 件。外部 URL・全画面・Service Worker の語が無い', () => {
    expect(manifest.icons).toEqual([
      expect.objectContaining({ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }),
      expect.objectContaining({ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }),
    ]);
    expect(manifest.icons).toHaveLength(2);
    for (const word of [
      /https?:\/\//i,
      /standalone/i,
      /fullscreen/i,
      /minimal-ui/i,
      /serviceworker/i,
    ]) {
      expect(manifestText).not.toMatch(word);
    }
  });
});

describe('アイコンの PNG（#90）', () => {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  /** ビッグエンディアンの 32 ビット符号なし整数 */
  const be32 = (b: Uint8Array, o: number) =>
    new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o);
  /** チャンクの型を順に（長さ 4・型 4・データ・CRC 4） */
  function chunkTypes(b: Uint8Array): string[] {
    const out: string[] = [];
    for (let o = 8; o + 8 <= b.length; ) {
      const len = be32(b, o);
      out.push(String.fromCharCode(...b.subarray(o + 4, o + 8)));
      o += 12 + len;
    }
    return out;
  }

  it.each([
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
  ])('(d) %s は %i 角の不透明な PNG', (name, n) => {
    const b = fs.readFileSync(url(`${PUBLIC}${name}`));
    expect([...b.subarray(0, 8)]).toEqual(SIGNATURE);
    const types = chunkTypes(b);
    expect(types[0]).toBe('IHDR');
    expect(types.at(-1)).toBe('IEND');
    expect(be32(b, 16)).toBe(n);
    expect(be32(b, 20)).toBe(n);
    expect(b[24]).toBe(8); // ビット深度
    // 透過しえない形だけを通す: カラータイプ 2（RGB）かつ tRNS なし。6（RGBA）が出たら判定を緩めず scripts/icons.mjs を直す
    expect(b[25]).toBe(2);
    expect(types).not.toContain('tRNS');
  });
});

describe('favicon.svg（#90）', () => {
  it('(e) script・style・参照・外部 URL を含まない', () => {
    expect(svg).toMatch(/^<svg\s/);
    for (const word of [/<script/i, /<style/i, /href=/i, /xlink:href/i])
      expect(svg).not.toMatch(word);
    const urls = svg.match(/https?:\/\/[^\s"'>]*/gi) ?? [];
    expect(urls).toEqual(['http://www.w3.org/2000/svg']);
  });
});

describe('index.html の head（#90）', () => {
  const links = tags('link');
  const metas = tags('meta');

  it('(f) manifest・アイコンのリンク', () => {
    expect(links.filter((l) => l.rel === 'manifest')).toEqual([
      expect.objectContaining({ href: '/manifest.webmanifest', crossorigin: 'use-credentials' }),
    ]);
    expect(links.filter((l) => l.rel === 'apple-touch-icon')).toEqual([
      expect.objectContaining({ href: '/apple-touch-icon.png' }),
    ]);
    expect(links.filter((l) => l.rel === 'icon')).toEqual([
      expect.objectContaining({ href: '/favicon.svg', type: 'image/svg+xml' }),
      expect.objectContaining({ href: '/icon-192.png', sizes: '192x192', type: 'image/png' }),
    ]);
  });

  it('(f) theme-color はダーク / ライトの --bg、ホーム画面の名前、全画面の meta が無い', () => {
    const theme = metas.filter((m) => m.name === 'theme-color');
    expect(theme).toHaveLength(2);
    const byMedia = Object.fromEntries(
      theme.map((m) => [m.media, (m.content ?? '').toLowerCase()]),
    );
    expect(byMedia).toEqual({
      '(prefers-color-scheme: dark)': DARK_BG,
      '(prefers-color-scheme: light)': LIGHT_BG,
    });
    expect(metas.filter((m) => m.name === 'apple-mobile-web-app-title')).toEqual([
      expect.objectContaining({ content: 'OP Sim' }),
    ]);
    expect(html).not.toMatch(/apple-mobile-web-app-capable/i);
    expect(html).not.toMatch(/mobile-web-app-capable/i);
  });
});
