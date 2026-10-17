// ホーム画面のアイコンの PNG を作る（`npm run icons`。#90、docs/ui-redesign.md §10.1「PWA」）。
//
// 原本は手書きの ui/public/favicon.svg だけ。このスクリプトが Playwright の Chromium（既存の devDependency）で SVG を描いて
// スクリーンショットし、ui/public/apple-touch-icon.png（180）・icon-192.png・icon-512.png を書く。
//
// - PNG は手で直さない。favicon.svg を直したら `npm run icons` を手で流し、PNG をまとめてコミットする
// - Chromium の描画は環境で少し違うので CI では生成しない・バイト一致を求めない（CI は tests/ui/pwa.test.ts で大きさと形式だけ）。
//   差分のノイズになるので理由なく再生成しない
// - 角は SVG の地の色（最初の rect の fill）で埋める = 不透明（iOS は透過部分を黒にする。角丸は端末側のマスク）
// - 生成に使うページは生成時だけのもの（配らない。CSP の対象外）
//
// 前提: `npm ci` の後に一度 `npx playwright install chromium`。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'ui', 'public');
const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');

const OUT = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];

// 地の色は SVG の最初の rect の fill から取る（値を 2 か所に書かない）
const bg = /<rect\b[^>]*\bfill="(#[0-9a-fA-F]{6})"/.exec(svg)?.[1];
if (!bg) {
  console.error('favicon.svg の最初の rect に fill="#rrggbb" がありません');
  process.exit(1);
}
if (!/^<svg\s/.test(svg.trimStart())) {
  console.error('favicon.svg が <svg で始まっていません');
  process.exit(1);
}

const browser = await chromium.launch();
try {
  for (const [name, n] of OUT) {
    const page = await browser.newPage({ viewport: { width: n, height: n }, deviceScaleFactor: 1 });
    const sized = svg.trimStart().replace(/^<svg\s/, `<svg width="${n}" height="${n}" `);
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:${bg}}svg{display:block}</style></head><body>${sized}</body></html>`,
    );
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: n, height: n } });
    writeFileSync(join(pub, name), png);
    console.log(`${name}: ${n}x${n} ${png.length} bytes`);
    await page.close();
  }
} finally {
  await browser.close();
}
