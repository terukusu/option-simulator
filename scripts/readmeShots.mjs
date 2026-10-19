// README のスクリーンショット（`npm run readme:shots`。#160）。Chromium（Playwright）で画面を開き、docs/images/ に
// WebP で書く。板は dev サーバーの合成の板（fixtures/synthetic/ の latest。Black-76 から作った架空の値）、IV 推移と
// 持ちこたえマップの過去の点は dev サーバーの合成の応答（scripts/devFixtures.mjs）だけを使う。本番・API・BigQuery には
// 触れない。資金（capital_yen）などの設定値も架空の値。
//
// 前提: `npm ci` の後に一度 `npx playwright install chromium`（scripts/uiCheck.mjs と同じ）。
//
//   npm run readme:shots                 全部を撮り直す（dev サーバーは中で起こす）
//   npm run readme:shots -- --only hero  名前に hero を含むものだけ（カンマ区切りで複数）
//
// 足・シナリオ・設定は localStorage に作業（版 2）と端末の設定（版 1）を入れて開く（UI の操作に依存しない所はそうする）。
// 作業は tests/ui/saved/workspace-v2.json の足から作る（建値も架空の値）。PNG で撮ってからブラウザの canvas で WebP に
// 変える（依存を足さない）。スマホは 3 台を横に並べた 1 枚にまとめる。

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs/images');
const WORKSPACE_KEY = 'option-simulator.workspace';
const PREFS_KEY = 'option-simulator.prefs';
/** 資金（架空の値） */
const CAPITAL = 30_000_000;
/** 持ちこたえマップで追証の側が見える資金（架空の値） */
const CAPITAL_TIGHT = 9_000_000;
const WEBP_QUALITY = 0.86;

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').split(',').filter(Boolean) : [];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright が無い。`npm ci` の後に `npx playwright install chromium` を実行する');
  process.exit(2);
}

// ---- 作業（版 2）: workspace-v2.json の足を元にした 2 タブ（ストラングルの売り・ヘッジ案）
const fixture = JSON.parse(readFileSync(join(root, 'tests/ui/saved/workspace-v2.json'), 'utf8'));
const [tabA, tabB] = fixture.tabs;
const withQty = (legs, qty) => legs.map((l) => ({ ...l, leg: { ...l.leg, qty } }));
const workspace = (scenario = {}, ui = {}) =>
  JSON.stringify({
    ...fixture,
    active: 0,
    ui: { ...fixture.ui, ...ui },
    tabs: [
      {
        ...tabA,
        name: '売り',
        position: {
          ...tabA.position,
          legs: withQty(tabA.position.legs, 2),
          scenario: { ...tabA.position.scenario, ...scenario },
        },
      },
      {
        ...tabB,
        position: { ...tabB.position, scenario: { ...tabB.position.scenario, ...scenario } },
      },
    ],
  });
/** 見せたいシナリオ: 10 日後・原資産 −1,500 円・IV +4pt */
const SCENARIO = { days: 10, dX: -1500, dSigma: 4 };
const prefs = (theme, capital = CAPITAL) =>
  JSON.stringify({ schema_version: 1, theme, ...(capital ? { capital_yen: capital } : {}) });

// ---- dev サーバー
const { createServer } = await import('vite');
const server = await createServer({
  configFile: join(root, 'vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5198, strictPort: false },
});
await server.listen();
const base = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5198/';
const origin = new URL(base).origin;

const browser = await chromium.launch();

async function open({ w, h, theme, ws = workspace(SCENARIO), capital = CAPITAL, dpr = 1 }) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: dpr,
    colorScheme: theme,
    reducedMotion: 'reduce',
    storageState: {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [
            { name: WORKSPACE_KEY, value: ws },
            { name: PREFS_KEY, value: prefs(theme, capital) },
          ],
        },
      ],
    },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.waitForSelector('.layout', { timeout: 30000 });
  await page.waitForSelector('.pill[data-state="ready"], .pill[data-state="failed"]', {
    timeout: 30000,
  });
  const state = await page.getAttribute('.pill', 'data-state');
  if (state !== 'ready') throw new Error('合成の板を読めない');
  await page.waitForTimeout(400);
  // 起動時の知らせのトースト（復元など）を閉じる
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.toast.note > button')) b.click();
  });
  await page.waitForTimeout(200);
  return { ctx, page, errors };
}

/** スマホのパネル・シート（uiCheck.mjs の setShell と同じ手順） */
async function setShell(page, panel, sheet) {
  for (let i = 0; i < 8; i++) {
    const cur = await page.evaluate(() => {
      const l = document.querySelector('.layout');
      return { panel: l?.getAttribute('data-panel'), sheet: l?.getAttribute('data-sheet') };
    });
    if (cur.panel === panel && cur.sheet === sheet) break;
    if (cur.panel !== panel || cur.sheet === 'hidden' || sheet === 'hidden') {
      await page.click(`.dock button[data-panel="${panel}"]`);
    } else {
      await page.click('.grabber');
    }
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(250);
}

/** PNG → WebP（ブラウザの canvas で。依存を足さない） */
let encoder;
async function toWebp(png) {
  if (!encoder) {
    const ctx = await browser.newContext();
    encoder = await ctx.newPage();
  }
  const b64 = await encoder.evaluate(
    async ({ src, q }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', q).split(',')[1];
    },
    { src: `data:image/png;base64,${png.toString('base64')}`, q: WEBP_QUALITY },
  );
  return Buffer.from(b64, 'base64');
}

const written = [];
async function save(name, png) {
  const webp = await toWebp(png);
  const path = join(OUT, `${name}.webp`);
  writeFileSync(path, webp);
  written.push([name, statSync(path).size]);
  console.log(`${name}.webp ${(statSync(path).size / 1024).toFixed(0)} KB`);
}

/** 要素の矩形（余白つき・画面内に収める）で撮る */
async function shotEl(page, sel, pad = 0) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`${sel} が無い`);
  const vp = page.viewportSize();
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return page.screenshot({
    clip: {
      x,
      y,
      width: Math.min(vp.width - x, b.width + pad * 2),
      height: Math.min(vp.height - y, b.height + pad * 2),
    },
  });
}

/** スマホの画面を横に並べた 1 枚（ブラウザで並べて撮る） */
async function composite(pngs, theme) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1.5,
    colorScheme: theme,
  });
  const page = await ctx.newPage();
  const bg = theme === 'dark' ? '#0b0f14' : '#e9edf2';
  const imgs = pngs
    .map((p) => `<img src="data:image/png;base64,${p.toString('base64')}">`)
    .join('');
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:${bg}">
     <div id="row" style="display:inline-flex;gap:28px;padding:28px;background:${bg}">${imgs}</div>
     <style>img{width:390px;height:auto;border-radius:22px;box-shadow:0 10px 30px rgba(0,0,0,.35)}</style>
     </body></html>`,
  );
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const png = await page.locator('#row').screenshot();
  await ctx.close();
  return png;
}

// ---- 撮るもの
const PC = { w: 1440, h: 900, dpr: 1.5 };
/** 要素だけを切り出す撮影（細かい所が読めるように DPR 2） */
const PC_CROP = { w: 1440, h: 900, dpr: 2 };
const PHONE = { w: 390, h: 844, dpr: 2 };

const shots = {
  // ヒーロー: PC・ダーク。損益グラフ（今日・指定日・満期）・シナリオのハンドル・指標
  async hero() {
    const { ctx, page } = await open({ ...PC, theme: 'dark' });
    await save('hero', await page.screenshot());
    await ctx.close();
  },
  // 損益グラフ: ピン（今の線を残す + ヘッジ案を重ねる）。ライト
  async 'stage-pins'() {
    const { ctx, page } = await open({
      ...PC_CROP,
      theme: 'light',
      ws: workspace({ days: 3, dX: 0, dSigma: 0 }),
    });
    await page.click('button[aria-label="ピン"]');
    await page.click('[role="menuitem"]:has-text("今の線を残す")');
    await page.waitForTimeout(200);
    await page.click('button[aria-label="ピン"]');
    await page.click('[role="menuitem"]:has-text("ヘッジ案 を重ねる")');
    await page.waitForTimeout(400);
    await save('stage-pins', await shotEl(page, 'section.stage'));
    await ctx.close();
  },
  // 損益グラフの長押しの読み取り（つかんで左右に動かしている途中）
  async 'stage-scrub'() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'dark' });
    const b = await page.locator('.chart:not(.mini)').boundingBox();
    await page.mouse.move(b.x + b.width * 0.62, b.y + b.height * 0.5);
    await page.mouse.down();
    await page.waitForTimeout(700);
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(b.x + b.width * (0.62 - i * 0.02), b.y + b.height * 0.5);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(250);
    await save('stage-scrub', await shotEl(page, 'section.stage'));
    await page.mouse.up();
    await ctx.close();
  },
  // 面モード（日数 × 原資産の損益の面）
  async 'stage-surface'() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'dark' });
    await page.click('.stage-head .seg button:has-text("面")');
    await page.waitForTimeout(800);
    await save('stage-surface', await shotEl(page, 'section.stage'));
    await ctx.close();
  },
  // 証拠金の追証の線（全域まで縮小）
  async 'margin-line'() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'light' });
    const btn = page.locator('button[aria-label="縮小"]:visible').first();
    for (let i = 0; i < 12; i++) await btn.click();
    await page.waitForTimeout(500);
    await save('margin-line', await shotEl(page, 'section.stage'));
    await ctx.close();
  },
  // シナリオ: 急落のプリセットを入れた状態
  async scenario() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'dark' });
    await page.click('section.scenario button:has-text("急落")');
    await page.waitForTimeout(400);
    await save('scenario', await shotEl(page, 'section.scenario'));
    await ctx.close();
  },
  // 指標 · テール
  async metrics() {
    const { ctx, page } = await open({ ...PC_CROP, h: 1760, theme: 'light' });
    await save('metrics', await shotEl(page, 'section.metrics'));
    await ctx.close();
  },
  // 持ちこたえマップ（過去の点は dev の合成の日次データ）
  async holdmap() {
    const { ctx, page } = await open({
      ...PC_CROP,
      h: 1300,
      theme: 'dark',
      capital: CAPITAL_TIGHT,
    });
    await page.click('section.metrics .hm-toggle');
    await page.waitForSelector('section.metrics .hm-svg', { timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.locator('section.metrics .hm-toggle').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const t = document.querySelector('section.metrics .hm-toggle');
      const body = t?.closest('.panel-body');
      if (t && body)
        body.scrollTop += t.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    });
    await page.waitForTimeout(300);
    // 折りたたみの見出しから指標の枠の下端まで
    const t = await page.locator('section.metrics .hm-toggle').boundingBox();
    const m = await page.locator('section.metrics').boundingBox();
    const bottom = Math.min(m.y + m.height, page.viewportSize().height);
    await save(
      'holdmap',
      await page.screenshot({
        clip: { x: m.x, y: t.y - 4, width: m.width, height: bottom - t.y + 4 },
      }),
    );
    await ctx.close();
  },
  // スマイル（点を選んで、板と同じ規則で足を入れる操作行）
  async smile() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'dark' });
    await page.click('section.board .panel-head .seg button:has-text("スマイル")');
    const plot = page.locator('section.smile .smile-month:not(.inactive) .smile-wrap');
    await plot.waitFor({ timeout: 15000 });
    await plot.focus();
    await page.keyboard.press('.');
    await page.waitForTimeout(300);
    await save('smile', await shotEl(page, 'section.smile'));
    await ctx.close();
  },
  // IV 推移（ローソク足と十字線）
  async 'iv-history'() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'dark' });
    await page.click('section.board .panel-head .seg button:has-text("IV 推移")');
    await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 15000 });
    await page.waitForTimeout(600);
    const b = await page.locator('section.smile .iv-wrap').boundingBox();
    await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.4);
    await page.waitForTimeout(300);
    await save('iv-history', await shotEl(page, 'section.smile'));
    await ctx.close();
  },
  // コマンドパレット
  async palette() {
    const { ctx, page } = await open({ ...PC, theme: 'dark' });
    await page.keyboard.press('Control+K');
    await page.waitForSelector('dialog.palette[open] input');
    await page.waitForTimeout(250);
    await save('palette', await page.screenshot());
    await ctx.close();
  },
  // 用語集の説明カード
  async 'term-card'() {
    const { ctx, page } = await open({ ...PC, theme: 'light' });
    await page.keyboard.press('Control+K');
    await page.waitForSelector('dialog.palette[open] input');
    await page.keyboard.type('?追証');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog.term-card[open] .tc-head h2');
    await page.waitForTimeout(250);
    await save('term-card', await page.screenshot());
    await ctx.close();
  },
  // スマホ: ドックとシート（ダーク 3 台）
  async 'phone-dark'() {
    const pngs = [];
    for (const [panel, sheet] of [
      ['positions', 'peek'],
      ['scenario', 'peek'],
      ['metrics', 'full'],
    ]) {
      const { ctx, page } = await open({ ...PHONE, theme: 'dark' });
      await setShell(page, panel, sheet);
      pngs.push(await page.screenshot());
      await ctx.close();
    }
    await save('phone-dark', await composite(pngs, 'dark'));
  },
  // スマホ: 板・スマイル・IV 推移（ライト 3 台）
  async 'phone-light'() {
    const pngs = [];
    for (const step of ['board', 'smile', 'iv']) {
      const { ctx, page } = await open({ ...PHONE, theme: 'light' });
      if (step === 'board') await setShell(page, 'board', 'full');
      else {
        await setShell(page, 'smile', 'full');
        const seg = page.locator(
          `section.smile .panel-head .seg button:has-text("${step === 'iv' ? 'IV 推移' : 'スマイル'}")`,
        );
        if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
        await page.waitForTimeout(800);
      }
      pngs.push(await page.screenshot());
      await ctx.close();
    }
    await save('phone-light', await composite(pngs, 'light'));
  },
};

mkdirSync(OUT, { recursive: true });
let failed = false;
try {
  for (const [name, fn] of Object.entries(shots)) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    try {
      await fn();
    } catch (e) {
      failed = true;
      console.error(`${name}: ${e.message}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
const total = written.reduce((s, [, n]) => s + n, 0);
console.log(`${written.length} 枚・合計 ${(total / 1024).toFixed(0)} KB`);
process.exit(failed ? 1 : 0);
