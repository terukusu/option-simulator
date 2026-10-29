// README のスクリーンショット（`npm run readme:shots`。#160）。Chromium（Playwright）で画面を開き、docs/images/ に
// WebP で書く。板は dev サーバーの合成の板（fixtures/synthetic/ の latest。Black-76 から作った架空の値）、IV 推移・
// 先物推移・追証マップの過去の点・AI の返答（診断・シナリオの評価・提案・テクニカル・表。偽の SSE）は dev サーバーの合成の
// 応答（scripts/devFixtures.mjs）だけを使う。本番・API・BigQuery・Anthropic には触れない。資金（capital_yen）などの
// 設定値も架空の値。
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
/** 追証マップで追証の側が見える資金（架空の値） */
const CAPITAL_TIGHT = 9_000_000;
/** 追証マップで許容損失の境目が見える許容損失（架空の値。#180） */
const ALLOWED_LOSS = 1_500_000;
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
/** 提案の画像の作業: タブ A の put の売りだけ（ヘッジの put の買いで満期の最大損失が小さくなる） */
const putOnly = () => {
  const ws = JSON.parse(workspace(SCENARIO));
  ws.tabs[0].name = 'put 売り';
  ws.tabs[0].position.legs = ws.tabs[0].position.legs.filter((l) => l.leg.type === 'put');
  return JSON.stringify(ws);
};
const prefs = (theme, capital = CAPITAL, allowedLoss = 0) =>
  JSON.stringify({
    schema_version: 1,
    theme,
    // 舞台の操作の案内（#276。初めての 1 回だけ）は README の画像に入れない
    stage_hint_seen: true,
    ...(capital ? { capital_yen: capital } : {}),
    ...(allowedLoss ? { allowed_loss_yen: allowedLoss } : {}),
  });

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

async function open({
  w,
  h,
  theme,
  ws = workspace(SCENARIO),
  capital = CAPITAL,
  allowedLoss = 0,
  dpr = 1,
}) {
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
            { name: PREFS_KEY, value: prefs(theme, capital, allowedLoss) },
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

/** AI のパネルを開く（初めての注意書きは閉じる）。返答は dev サーバーの偽の SSE（Anthropic を呼ばない） */
async function openAi(opts) {
  const o = await open(opts);
  const { page } = o;
  if ((await page.getAttribute('.layout', 'data-left')) !== 'ai') {
    await page.click('.top button[data-ai="top"]');
  }
  await page.waitForSelector('section.ai .ai-foot', { state: 'visible', timeout: 5000 });
  const close = page.locator('section.ai [data-ai="disclaimer"] button');
  if (await close.count()) await close.click();
  return o;
}
/** AI に質問を送り、返答が終わるまで待つ */
async function ask(page, text) {
  await page.fill('section.ai .ai-input textarea', text);
  await page.press('section.ai .ai-input textarea', 'Enter');
  await page
    .waitForSelector('section.ai .ai-progress', { state: 'attached', timeout: 5000 })
    .catch(() => {});
  await page.waitForSelector('section.ai .ai-progress', { state: 'detached', timeout: 15000 });
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
  // 損益グラフの十字線（PC はマウスを載せると出る。#201・#217）。ライト
  async 'stage-cross'() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'light' });
    const b = await page.locator('.chart:not(.mini)').boundingBox();
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.62);
    await page.waitForTimeout(400);
    await save('stage-cross', await shotEl(page, 'section.stage'));
    await ctx.close();
  },
  // 損益グラフ: ピン（今の線を残す + ヘッジ案を重ねる）と、凡例の ② を押したピンの中身（#125）。ライト
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
    await page.locator('section.stage button.pin-open').nth(1).click();
    await page.waitForSelector('section.stage .pin-pop:not([hidden])', {
      state: 'visible',
      timeout: 5000,
    });
    await page.waitForTimeout(300);
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
    // 面の十字線（PC のホバー。#217）: 原資産・経過日数の札とその点の損益
    const b = await page.locator('section.stage .chart:not(.mini)').boundingBox();
    await page.mouse.move(b.x + b.width * 0.36, b.y + b.height * 0.4);
    await page.waitForTimeout(400);
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
    // パネルの枠は窓の高さまで伸びるので、中身（子を持たない要素）の下端で切る（下の余白を写さない。#294）
    const m = await page.locator('section.metrics').boundingBox();
    const bottom = await page.evaluate(() => {
      const els = document.querySelectorAll('section.metrics *');
      let b = 0;
      for (const el of els) {
        if (el.children.length > 0) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0) b = Math.max(b, r.bottom);
      }
      return b;
    });
    await save(
      'metrics',
      await page.screenshot({
        clip: { x: m.x, y: m.y, width: m.width, height: Math.min(m.height, bottom - m.y + 12) },
      }),
    );
    await ctx.close();
  },
  // 追証マップ（過去の点は dev の合成の日次データ）。許容損失の境目・3 色・凡例（#180）
  async holdmap() {
    const { ctx, page } = await open({
      ...PC_CROP,
      h: 1300,
      theme: 'dark',
      capital: CAPITAL_TIGHT,
      allowedLoss: ALLOWED_LOSS,
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
  // スマイル（点を選んで、板と同じ規則で足を入れる操作行）と [効率] の売りの効率の線（#163）
  async smile() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'dark' });
    await page.click('section.board .panel-head .seg button:has-text("スマイル")');
    const plot = page.locator('section.smile .smile-month:not(.inactive) .smile-wrap');
    await plot.waitFor({ timeout: 15000 });
    await page.click('section.smile button[aria-label="売りの効率の線"]');
    await page.waitForTimeout(600);
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
  // 先物推移（日足のローソク足・EMA の 3 本・RSI / MACD / SO の段・限月交代の点線と札・十字線。#190・#200・#206）
  async 'fut-history'() {
    // 左の列は幅の 30%。横に広い画面で開き、チャートを横長に撮る
    const { ctx, page } = await open({ w: 2400, h: 1000, dpr: 1.5, theme: 'dark' });
    await page.click('section.board .panel-head .seg button:text-is("先物")');
    await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 15000 });
    await page.click('section.smile .iv-tools button[aria-label="日足"]');
    // 足の切替は見ていた時間（1 時間足の数日）を保つので、R で日足の初期表示（100 本 = 限月交代を含む）にする
    await page.waitForTimeout(600);
    await page.focus('section.smile .iv-wrap');
    await page.keyboard.press('r');
    await page.waitForSelector('section.smile .fut-roll', { state: 'attached', timeout: 15000 });
    for (const k of ['RSI', 'MACD', 'SO']) {
      await page.click(`section.smile .ind-toggles button:text-is("${k}")`);
    }
    await page.waitForSelector('section.smile .ind-pane.stoch', { timeout: 15000 });
    await page.waitForTimeout(600);
    const b = await page.locator('section.smile .iv-wrap').boundingBox();
    await page.mouse.move(b.x + b.width * 0.75, b.y + b.height * 0.2);
    await page.waitForTimeout(300);
    await save('fut-history', await shotEl(page, 'section.smile'));
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
  // 設定のテクニカル指標（期間・EMA の線・オシレーターの線。#205・#214・#223）
  async 'settings-tech'() {
    const { ctx, page } = await open({ ...PC_CROP, theme: 'dark' });
    await page.click('button[aria-label="メニュー"]');
    await page.click('header.top > .menu-wrap [role="menuitem"]:has-text("設定…")');
    await page.waitForSelector('dialog.sheet.settings[open] .set-tech');
    await page.evaluate(() => {
      const t = document.querySelector('dialog.sheet.settings[open] .set-tech');
      t?.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(300);
    await save('settings-tech', await shotEl(page, 'dialog.sheet.settings[open] .set-tech', 12));
    await ctx.close();
  },
  // AI に相談: [このポジションを診断] の返答と、続けた質問のシナリオの評価のカード。返答は dev サーバーの偽の SSE
  // （scripts/devFixtures.mjs の /fixtures/ai。Anthropic を呼ばない）で、数字は合成の板からの計算の値
  async ai() {
    const { ctx, page } = await openAi({ ...PC, theme: 'dark' });
    await page.click('section.ai button[data-ai="diagnose"]');
    await page.waitForSelector('section.ai .ai-progress', { state: 'detached', timeout: 15000 });
    await ask(page, '−6% で 3 日後、IV +5pt ならどうなる？');
    await page.waitForSelector('section.ai .ai-tool button[data-ai="apply"]', { timeout: 15000 });
    await page.waitForTimeout(400);
    await save('ai', await page.screenshot());
    await ctx.close();
  },
  // AI のポジションの提案（#139）: 「ヘッジ」を含む質問 → 偽の SSE の propose_position → 提案のカード
  async 'ai-propose'() {
    const { ctx, page } = await openAi({ ...PC_CROP, h: 640, theme: 'light', ws: putOnly() });
    await ask(page, '最大損失を抑えるヘッジの足を足して');
    await page.waitForSelector('section.ai .ai-prop button[data-ai="propose"]', { timeout: 15000 });
    await page.waitForTimeout(400);
    await save('ai-propose', await shotEl(page, 'section.ai'));
    await ctx.close();
  },
  // AI のテクニカルの読み（#200・#206）: 「RSI」を含む質問 → 偽の SSE の technicals → ツールのカードと返答
  async 'ai-tech'() {
    const { ctx, page } = await openAi({ ...PC_CROP, h: 560, theme: 'dark' });
    await ask(page, '日足の RSI は？');
    await page.waitForSelector('section.ai .ai-tool[data-ai-tool="technicals"]', {
      timeout: 15000,
    });
    await page.waitForTimeout(400);
    await save('ai-tech', await shotEl(page, 'section.ai'));
    await ctx.close();
  },
  // AI の返答の表と用語のリンク（#234・#232）: 「表で」を含む質問 → 偽の SSE の tail_table → 結果と文脈の足の値の表
  async 'ai-table'() {
    const { ctx, page } = await openAi({ ...PC_CROP, h: 760, theme: 'light' });
    await ask(page, '足ごとの建値と、下げの幅ごとの損益を表で見せて');
    await page.waitForSelector('section.ai table', { timeout: 15000 });
    await page.waitForTimeout(400);
    await save('ai-table', await shotEl(page, 'section.ai'));
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
  // スマホ: 板・スマイル・先物推移（RSI・MACD の段。ライト 3 台）
  async 'phone-light'() {
    const pngs = [];
    for (const step of ['board', 'smile', 'fut']) {
      const { ctx, page } = await open({ ...PHONE, theme: 'light' });
      if (step === 'board') await setShell(page, 'board', 'full');
      else {
        await setShell(page, 'smile', 'full');
        const seg = page.locator(
          `section.smile .panel-head .seg button:text-is("${step === 'fut' ? '先物' : 'スマイル'}")`,
        );
        if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
        await page.waitForTimeout(800);
        if (step === 'fut') {
          await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 15000 });
          for (const k of ['RSI', 'MACD']) {
            await page.click(`section.smile .ind-toggles button:text-is("${k}")`);
          }
          await page.waitForSelector('section.smile .ind-pane.macd', { timeout: 15000 });
          await page.waitForTimeout(600);
        }
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
