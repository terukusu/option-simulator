// 画面の検査（`npm run ui:check`。#81、docs/ui-redesign.md §10.1）。Chromium（Playwright）で画面を開き、
// ページの縦・横スクロールと折り返しの件数を数値で出す。CI には入れない（手元で流し、各 PR に出力を貼る）。
//
// 前提: `npm ci` の後に一度 `npx playwright install chromium`（ブラウザは手元のキャッシュに入る。リポジトリには入らない）。
// 板は dev サーバーの合成の板（fixtures/synthetic/ の latest）。足は tests/ui/saved/workspace-v2.json のタブ A（足 2 本）を
// 作業の保存（版 2）として localStorage に入れて開く（UI の操作に依存しない。旧画面にも同じ足）。
//
//   npm run ui:check                       新しい画面（?ui=next）: 360 / 390 / 900 / 1440 × ダーク / ライト、
//                                          スマホはシート hidden / peek / full × パネル 5 つ。各状態で舞台の読み取り
//                                          （.readout .ro）が画面内に見えているか（スマホ 3・900 で 5・1440 で 6。#82）。
//                                          シナリオ（#83）の .stepper .val b・チップが切れていないか（scrollWidth ≤ clientWidth）を
//                                          「モデルの前提」の閉 / 開の両方で（開いた状態は縦・横・折り返し・読み取りも測る）。
//                                          ポジション（#84）の .leg-title（名前・@建値）・枚数の .stepper .val b・⇄・× が切れて
//                                          いないか、詳細を 1 本開いた状態の縦・横・折り返し・読み取り。
//                                          指標（#86）のタイルの .k・.v・テール表の全セル・（開いていれば）内訳の各行が切れて
//                                          いないか（と .panel-body の中で横にはみ出していないか）を、スマホの「指標」peek / full・
//                                          900（ドックで指標を開く）・1440 で。内訳を開いた状態（360 peek・390 full・900・1440）の
//                                          縦・横・折り返し・読み取り
//   npm run ui:check -- --parts            部品の見本（?ui=next&parts。dev だけ）
//   npm run ui:check -- --legacy           旧画面（?ui=next なし）
//   npm run ui:check -- --flows            保存・共有・テーマ・キーボードの手順（#81 AC-11・AC-12）と舞台の手順
//                                          （#82: ハンドル・IV / 時間レール・キー・足マーカー・Long Animation Frame）とシナリオの手順
//                                          （#83: ステッパーの ± / Shift / スクラブ / ホイール / キー / 数値入力・プリセット・評価時刻・
//                                          前提・#82 のレールとの一致・Long Animation Frame。390×844 と 1440×900）と作業台の手順
//                                          （#84: 枚数・⇄・× と [元に戻す]・全クリアと [元に戻す]・詳細の入力・足の追加ダイアログ・
//                                          ヘッジ・舞台の足マーカー → 行の強調・Long Animation Frame。390×844 と 1440×900）と指標の手順
//                                          （#86: 旧画面の内訳・テール表との値の一致・タイル 5 と読み取りの一致・Δσ ±0.5 の追従
//                                          （390 は IV レールの ↑ / ↓）・Long Animation Frame。390×844 と 1440×900）
//   --url <base>                           dev サーバーを起こさず、その URL を使う（例 http://127.0.0.1:5173/?ui=next&parts）
//   --dom <file>                           body の下の要素の tag.class の並びを書き出す（旧画面が変わらないことの比較用）
//   --shots <dir>                          スクリーンショットを書く（合成の板だけ。リポジトリに入れない）
//   --max-wraps <n>                        折り返しが n 件を超えたら失敗にする（渡したときだけ判定）
//
// 縦・横 = ページのスクロール量（scrollHeight − innerHeight・scrollWidth − innerWidth）。body が切っている（overflow: hidden）
// はみ出しも数える（body の scrollHeight − clientHeight との大きい方）。
// 終了コード: 新しい画面（部品の見本を含む）で縦か横が 0 より大きい、読み取りの検査の失敗、--max-wraps の超過、
// --flows の fail で 1。
// 折り返しの規則は EPIC #92 の as-is と同じ: 直下のテキストが 40 字以下の要素で、その中身の行（getClientRects の上端）が
// 2 つ以上。P・LI・DD・TEXTAREA・OPTION と .help-popover・[role="tooltip"]・閉じた details の中は除く。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WORKSPACE_KEY = 'option-simulator.workspace';
const PREFS_KEY = 'option-simulator.prefs';
const SIZES = [
  [360, 780],
  [390, 844],
  [900, 1100],
  [1440, 900],
];
const PHONE_MAX = 719.98;

// ---- 引数
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} には値が要る`);
    process.exit(2);
  }
  return v;
};
const known = new Set([
  '--legacy',
  '--parts',
  '--flows',
  '--url',
  '--dom',
  '--shots',
  '--max-wraps',
]);
for (const a of args) {
  if (a.startsWith('--') && !known.has(a)) {
    console.error(`知らない引数: ${a}`);
    process.exit(2);
  }
}
const urlArg = value('--url');
const domFile = value('--dom');
const shotsDir = value('--shots');
const maxWrapsArg = value('--max-wraps');
const maxWraps = maxWrapsArg === null ? null : Number(maxWrapsArg);
if (maxWraps !== null && !(Number.isInteger(maxWraps) && maxWraps >= 0)) {
  console.error('--max-wraps は 0 以上の整数');
  process.exit(2);
}
const urlParams = urlArg ? new URL(urlArg).searchParams : new URLSearchParams();
const legacy = flag('--legacy');
const parts = !legacy && (flag('--parts') || urlParams.has('parts'));
const flows = flag('--flows');
const mode = legacy ? 'legacy' : parts ? 'parts' : 'next';

// ---- 足 2 本の作業（版 2）: workspace-v2.json のタブ A だけ（fixture は変えない）
const fixture = JSON.parse(readFileSync(join(root, 'tests/ui/saved/workspace-v2.json'), 'utf8'));
const twoLegs = JSON.stringify({ ...fixture, active: 0, tabs: [fixture.tabs[0]] });
const prefsText = (theme) => JSON.stringify({ schema_version: 1, theme });
const share = JSON.parse(readFileSync(join(root, 'tests/ui/saved/share-v1.json'), 'utf8'));

// ---- Playwright（devDependency。無ければ手順を出して終わる）
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright が無い。`npm ci` の後に `npx playwright install chromium` を実行する');
  process.exit(2);
}

// ---- dev サーバー（--url が無ければ vite.config.ts で中に起こす）
let server = null;
let base;
if (urlArg) {
  const u = new URL(urlArg);
  base = `${u.origin}${u.pathname}`;
} else {
  const { createServer } = await import('vite');
  server = await createServer({
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5199, strictPort: false },
  });
  await server.listen();
  base = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5199/';
}
const origin = new URL(base).origin;
const pageUrl = (m) => {
  const u = new URL(base);
  if (m === 'next') u.search = '?ui=next';
  else if (m === 'parts') u.search = '?ui=next&parts';
  else u.search = '';
  return u.toString();
};

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error(
    `Chromium を起動できない（\`npx playwright install chromium\` を実行する）: ${e.message}`,
  );
  await server?.close();
  process.exit(2);
}

/** localStorage を入れた新しいコンテキスト（UI を操作しない・再読み込みで入れ直さない） */
async function newContext(viewport, storage, colorScheme = 'dark') {
  const localStorage = Object.entries(storage).map(([name, v]) => ({ name, value: v }));
  return browser.newContext({
    viewport,
    colorScheme,
    storageState: { cookies: [], origins: localStorage.length ? [{ origin, localStorage }] : [] },
  });
}

/** 板の読み込みが終わるまで待つ */
async function waitReady(page, m) {
  if (m === 'legacy') {
    await page.waitForSelector('.board-table, p.empty', { timeout: 20000 });
  } else if (m === 'parts') {
    await page.waitForSelector('.parts-gallery', { timeout: 20000 });
  } else {
    await page.waitForSelector('.layout', { timeout: 20000 });
    await page.waitForFunction(
      () => ![...document.querySelectorAll('.notice')].some((n) => n.textContent === '読み込み中…'),
      undefined,
      { timeout: 20000 },
    );
  }
  await page.waitForTimeout(400);
}

/** ページのスクロールと折り返し（EPIC の as-is と同じ規則） */
function measure(page) {
  return page.evaluate(() => {
    const wraps = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const txt = [...el.childNodes]
        .filter((c) => c.nodeType === 3)
        .map((c) => c.textContent)
        .join('')
        .trim();
      if (!txt) continue;
      if (['P', 'LI', 'DD', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE'].includes(el.tagName)) continue;
      if (el.closest('.help-popover,[role="tooltip"],details:not([open])')) continue;
      if (txt.length > 40) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set(
        [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
      );
      if (lines.size > 1)
        wraps.push(`${el.tagName}.${el.getAttribute('class') ?? ''}「${txt.slice(0, 20)}」`);
    }
    // ページのスクロール量。新しい画面は body が overflow: hidden なので、body の中で切れて見えない分も足す
    // （ページは動かないが、はみ出しを見逃さない。旧画面の body は切らないので値は変わらない）
    const d = document.documentElement;
    const b = document.body;
    return {
      v: Math.max(d.scrollHeight - window.innerHeight, b.scrollHeight - b.clientHeight),
      h: Math.max(d.scrollWidth - window.innerWidth, b.scrollWidth - b.clientWidth),
      wraps,
    };
  });
}

/** body の下の要素の tag.class の並び */
function domList(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .map((el) => {
        const c = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).join('.');
        return c ? `${el.tagName.toLowerCase()}.${c}` : el.tagName.toLowerCase();
      })
      .join('\n'),
  );
}

let failed = false;
const domOut = [];

async function report(page, label, w, h, shotName, shot = true) {
  const r = await measure(page);
  const bad = mode !== 'legacy' && (r.v > 0 || r.h > 0);
  const over = maxWraps !== null && r.wraps.length > maxWraps;
  if (bad || over) failed = true;
  const mark = bad || over ? '  ← NG' : '';
  console.log(`${label} ${w}x${h}: 縦 ${r.v}px 横 ${r.h}px 折り返し ${r.wraps.length} 件${mark}`);
  for (const s of r.wraps.slice(0, 30)) console.log(`    ${s}`);
  if (shotsDir && shot) await page.screenshot({ path: join(shotsDir, `${shotName}.png`) });
}

/**
 * 読み取り（大きな数字。#82 AC-12）: 表示している .readout .ro[data-ro] の個数が want、各要素が画面内（幅と高さ > 0）・
 * 中心の elementFromPoint がその要素の中（他の面に隠れていない）・値（.v）が切れていない（scrollWidth ≤ clientWidth）
 */
async function readoutCheck(page, label, want) {
  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const items = [...document.querySelectorAll('.readout .ro[data-ro]')].filter(
      (el) => getComputedStyle(el).display !== 'none',
    );
    const bad = [];
    for (const el of items) {
      const b = el.getBoundingClientRect();
      const inView =
        b.width > 0 && b.height > 0 && b.left >= 0 && b.top >= 0 && b.right <= vw && b.bottom <= vh;
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const onTop = hit !== null && el.contains(hit);
      const v = el.querySelector('.v');
      const cut = !v || v.scrollWidth > v.clientWidth;
      if (!inView || !onTop || cut) {
        bad.push(
          `${el.getAttribute('data-ro')}${inView ? '' : ' 画面外'}${onTop ? '' : ' 隠れ'}${cut ? ' 切れ' : ''}`,
        );
      }
    }
    return { n: items.length, bad };
  });
  const ok = r.n === want && r.bad.length === 0;
  readoutStats.total++;
  if (ok) readoutStats.pass++;
  else failed = true;
  if (!ok) console.log(`${label}: 読み取り ${r.n} / ${want} つ ${r.bad.join('・')}  ← NG`);
  return ok;
}
const readoutStats = { pass: 0, total: 0 };

/**
 * シナリオ（#83 AC-9）: 見えている section.scenario の .stepper .val b・.chip が切れていない（scrollWidth ≤ clientWidth）。
 * 要約（.vals）は省略記号で可なので測らない。見えていなければ数えない
 */
async function scenarioCheck(page, label) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.scenario');
    if (!sec || sec.getClientRects().length === 0) return null;
    const els = [...sec.querySelectorAll('.stepper .val b, .chip')].filter(
      (el) => el.getClientRects().length > 0,
    );
    const bad = els
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => `「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`);
    return { n: els.length, bad };
  });
  if (r === null) return true;
  const ok = r.n > 0 && r.bad.length === 0;
  scenarioStats.total++;
  if (ok) scenarioStats.pass++;
  else failed = true;
  if (!ok) console.log(`${label}: シナリオの値・チップ ${r.n} 個 ${r.bad.join('・')}  ← NG`);
  return ok;
}
const scenarioStats = { pass: 0, total: 0 };

/** 「モデルの前提」を開いて測り（縦・横・折り返し・読み取り・シナリオの切れ）、閉じて戻す */
async function advOpenCheck(page, label, w, h, shotName, readouts) {
  const summary = page.locator('section.scenario details.adv summary');
  if ((await summary.count()) === 0 || !(await summary.isVisible())) return;
  await summary.click();
  await page.waitForTimeout(120);
  await report(page, `${label} 前提を開く`, w, h, shotName);
  await readoutCheck(page, `${label} 前提を開く ${w}x${h}`, readouts);
  await scenarioCheck(page, `${label} 前提を開く ${w}x${h}`);
  await summary.click();
  await page.waitForTimeout(80);
}

/**
 * ポジション（#84 AC-10）: 見えている section.positions の .leg-title（名前・@建値）・枚数の .stepper .val b・⇄・× が
 * 切れていない（scrollWidth ≤ clientWidth。.leg-title は本文のボタンの幅にも収まる）。2 段目（.leg-sub）は省略記号で可。
 * 見えていなければ数えない
 */
async function positionsCheck(page, label) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.positions');
    if (!sec || sec.getClientRects().length === 0) return null;
    const rows = [...sec.querySelectorAll('li.leg')].filter((el) => el.getClientRects().length > 0);
    const bad = [];
    let n = 0;
    for (const li of rows) {
      const main = li.querySelector('.leg-main');
      const title = li.querySelector('.leg-title');
      const els = [
        title,
        ...li.querySelectorAll('.leg-title .name, .leg-title .px, .stepper .val b, .ops button'),
      ];
      for (const el of els) {
        if (!el) continue;
        n++;
        if (el.scrollWidth > el.clientWidth) {
          bad.push(`「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`);
        }
      }
      if (main && title && title.scrollWidth > main.clientWidth) {
        bad.push(`本文「${title.textContent}」${title.scrollWidth}/${main.clientWidth}`);
      }
    }
    return { rows: rows.length, n, bad };
  });
  if (r === null) return true;
  const ok = r.bad.length === 0;
  positionsStats.total++;
  if (ok) positionsStats.pass++;
  else failed = true;
  if (!ok) console.log(`${label}: ポジションの行 ${r.rows} 本 ${r.bad.join('・')}  ← NG`);
  return ok;
}
const positionsStats = { pass: 0, total: 0 };

/** ポジションの詳細を 1 本開いて測り（縦・横・折り返し・読み取り・行の切れ）、閉じて戻す（#84 AC-10） */
async function detailOpenCheck(page, label, w, h, shotName, readouts) {
  const main = page.locator('section.positions li.leg .leg-main').first();
  if ((await main.count()) === 0 || !(await main.isVisible())) {
    failed = true;
    console.log(`${label} 詳細を開く ${w}x${h}: 行が見えない  ← NG`);
    return;
  }
  await main.click();
  await page.waitForTimeout(150);
  const opened = (await main.getAttribute('aria-expanded')) === 'true';
  if (!opened) {
    failed = true;
    console.log(`${label} 詳細を開く ${w}x${h}: aria-expanded が true にならない  ← NG`);
  }
  detailStats.total++;
  if (opened) detailStats.pass++;
  await report(page, `${label} 詳細を開く`, w, h, shotName);
  await readoutCheck(page, `${label} 詳細を開く ${w}x${h}`, readouts);
  await positionsCheck(page, `${label} 詳細を開く ${w}x${h}`);
  await main.click();
  await page.waitForTimeout(100);
}
const detailStats = { pass: 0, total: 0 };

/**
 * 指標（#86 AC-8）: 見えている section.metrics の (a) タイルの .k・.v、テール表の th・td .txt、（開いていれば）内訳の
 * .kv-grid > .k・.v が切れていない（scrollWidth ≤ clientWidth）、(b) .panel-body が横にはみ出していない
 * （overflow: auto なのでページの横スクロールに出ない。別に測る）。見えていなければ数えない
 */
async function metricsCheck(page, label) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.metrics');
    if (!sec || sec.getClientRects().length === 0) return null;
    const els = [
      ...sec.querySelectorAll(
        '.tile .k, .tile .v, table.tail th, table.tail td .txt, .kv-grid > .k, .kv-grid > .v',
      ),
    ].filter((el) => el.getClientRects().length > 0);
    const bad = els
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => `「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`);
    const body = sec.querySelector('.panel-body');
    if (body && body.scrollWidth > body.clientWidth) {
      bad.push(`.panel-body ${body.scrollWidth}/${body.clientWidth}`);
    }
    return { n: els.length, bad };
  });
  if (r === null) return true;
  const ok = r.n > 0 && r.bad.length === 0;
  metricsStats.total++;
  if (ok) metricsStats.pass++;
  else failed = true;
  if (!ok) console.log(`${label}: 指標の値 ${r.n} 個 ${r.bad.join('・')}  ← NG`);
  return ok;
}
const metricsStats = { pass: 0, total: 0 };

/** 指標の「内訳」を開いて測り（縦・横・折り返し・読み取り・指標の切れ）、閉じて戻す（#86 AC-8） */
async function breakdownOpenCheck(page, label, w, h, shotName, readouts) {
  const btn = page.locator('section.metrics .mx-toggle');
  if ((await btn.count()) === 0 || !(await btn.isVisible())) {
    failed = true;
    console.log(`${label} 内訳を開く ${w}x${h}: ボタンが見えない  ← NG`);
    return;
  }
  await btn.click();
  await page.waitForTimeout(150);
  const opened =
    (await btn.getAttribute('aria-expanded')) === 'true' &&
    (await page.locator('section.metrics .kv-grid > .v').count()) > 0;
  if (!opened) {
    failed = true;
    console.log(`${label} 内訳を開く ${w}x${h}: 開かない  ← NG`);
  }
  breakdownStats.total++;
  if (opened) breakdownStats.pass++;
  await report(page, `${label} 内訳を開く`, w, h, shotName);
  await readoutCheck(page, `${label} 内訳を開く ${w}x${h}`, readouts);
  await metricsCheck(page, `${label} 内訳を開く ${w}x${h}`);
  await btn.click();
  await page.waitForTimeout(100);
}
const breakdownStats = { pass: 0, total: 0 };

const PANELS = ['positions', 'board', 'scenario', 'metrics', 'smile'];

/** スマホの画面の状態（パネル・シート）をドックとつまみで作る（.layout の data-panel / data-sheet を読んで確かめる） */
async function setShell(page, panel, sheet) {
  const st = () =>
    page.evaluate(() => {
      const l = document.querySelector('.layout');
      return { panel: l?.getAttribute('data-panel'), sheet: l?.getAttribute('data-sheet') };
    });
  for (let i = 0; i < 8; i++) {
    const cur = await st();
    if (cur.panel === panel && cur.sheet === sheet) return true;
    if (cur.panel !== panel || cur.sheet === 'hidden') {
      // 別のパネル → そのパネル（hidden なら peek）。同じパネルで hidden → peek
      await page.click(`.dock button[data-panel="${panel}"]`);
    } else if (sheet === 'hidden') {
      await page.click(`.dock button[data-panel="${panel}"]`);
    } else {
      // peek ⇄ full はつまみのタップ
      await page.click('.grabber');
    }
    await page.waitForTimeout(120);
  }
  const cur = await st();
  return cur.panel === panel && cur.sheet === sheet;
}

async function measureAll() {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const themes = mode === 'legacy' ? [null] : ['dark', 'light'];
  for (const [w, h] of SIZES) {
    for (const theme of themes) {
      const storage = { [WORKSPACE_KEY]: twoLegs };
      if (theme) storage[PREFS_KEY] = prefsText(theme);
      const ctx = await newContext({ width: w, height: h }, storage);
      const page = await ctx.newPage();
      await page.goto(pageUrl(mode));
      await waitReady(page, mode);
      const tag = theme ? `${mode} ${theme}` : mode;
      const name = `${mode}-${w}x${h}${theme ? `-${theme}` : ''}`;
      if (mode === 'next' && w <= PHONE_MAX) {
        // シート 3 段階: peek（既定）→ hidden（開いているドックのボタン）→ full（もう一度で peek、つまみのタップ）
        await report(page, `${tag} peek`, w, h, `${name}-peek`);
        await readoutCheck(page, `${tag} positions/peek ${w}x${h}`, 3);
        await positionsCheck(page, `${tag} positions/peek ${w}x${h}`);
        await detailOpenCheck(page, `${tag} positions/peek`, w, h, `${name}-peek-detail`, 3);
        await page.click('.dock button[data-panel="positions"]');
        await page.waitForTimeout(150);
        await report(page, `${tag} hidden`, w, h, `${name}-hidden`);
        await readoutCheck(page, `${tag} positions/hidden ${w}x${h}`, 3);
        await page.click('.dock button[data-panel="positions"]');
        await page.click('.grabber');
        await page.waitForTimeout(150);
        await report(page, `${tag} full`, w, h, `${name}-full`);
        await readoutCheck(page, `${tag} positions/full ${w}x${h}`, 3);
        await positionsCheck(page, `${tag} positions/full ${w}x${h}`);
        await detailOpenCheck(page, `${tag} positions/full`, w, h, `${name}-full-detail`, 3);
        const stageH = await page.evaluate(
          () => document.querySelector('section.stage')?.getBoundingClientRect().height ?? null,
        );
        if (stageH !== 92) {
          failed = true;
          console.log(
            `${tag} full ${w}x${h}: section.stage の高さ ${stageH}px（92px のはず）  ← NG`,
          );
        }
        // 残りのパネル × シート 3 段階（読み取りと、縦・横・折り返し）
        for (const panel of PANELS.slice(1)) {
          for (const sheet of ['peek', 'hidden', 'full']) {
            const ok = await setShell(page, panel, sheet);
            const lbl = `${tag} ${panel}/${sheet}`;
            if (!ok) {
              failed = true;
              console.log(`${lbl} ${w}x${h}: 画面の状態を作れない  ← NG`);
              continue;
            }
            await page.waitForTimeout(100);
            const scn = panel === 'scenario' && sheet !== 'hidden';
            const mx = panel === 'metrics' && sheet !== 'hidden';
            await report(page, lbl, w, h, `${name}-${panel}-${sheet}`, scn || mx);
            await readoutCheck(page, `${lbl} ${w}x${h}`, 3);
            await positionsCheck(page, `${lbl} ${w}x${h}`);
            if (scn) {
              await scenarioCheck(page, `${lbl} ${w}x${h}`);
              await advOpenCheck(page, lbl, w, h, `${name}-${panel}-${sheet}-adv`, 3);
            }
            if (mx) {
              await metricsCheck(page, `${lbl} ${w}x${h}`);
              // 内訳を開いた状態: 360 は peek、390 は full（#86 AC-8）
              if ((w === 360 && sheet === 'peek') || (w === 390 && sheet === 'full')) {
                await breakdownOpenCheck(page, lbl, w, h, `${name}-${panel}-${sheet}-kv`, 3);
              }
            }
          }
        }
      } else {
        await report(page, tag, w, h, name);
        if (mode === 'next') {
          const want = w >= 1200 ? 6 : 5;
          await readoutCheck(page, `${tag} ${w}x${h}`, want);
          await scenarioCheck(page, `${tag} ${w}x${h}`);
          await positionsCheck(page, `${tag} ${w}x${h}`);
          await advOpenCheck(page, tag, w, h, `${name}-adv`, want);
          await detailOpenCheck(page, tag, w, h, `${name}-detail`, want);
          if (w >= 1200) {
            // PC は指標が常に見えている
            await metricsCheck(page, `${tag} ${w}x${h}`);
            await breakdownOpenCheck(page, tag, w, h, `${name}-kv`, want);
          } else {
            // タブレットはドックで「指標」を開いて測り、「ポジ」で戻す
            await page.click('.dock button[data-panel="metrics"]');
            await page.waitForTimeout(150);
            await report(page, `${tag} metrics`, w, h, `${name}-metrics`);
            await readoutCheck(page, `${tag} metrics ${w}x${h}`, want);
            await metricsCheck(page, `${tag} metrics ${w}x${h}`);
            await breakdownOpenCheck(page, `${tag} metrics`, w, h, `${name}-metrics-kv`, want);
            await page.click('.dock button[data-panel="positions"]');
            await page.waitForTimeout(150);
          }
        }
      }
      if (domFile) domOut.push(`## ${w}x${h}${theme ? ` ${theme}` : ''}`, await domList(page));
      await ctx.close();
    }
  }
  if (domFile) writeFileSync(domFile, `${domOut.join('\n')}\n`);
  if (mode === 'next') {
    // ピン 3 本の凡例（#82 のレビュー B1）: 各サイズのダークで
    for (const [w, h] of SIZES) {
      await pinCheck(w, h, false);
      // タブの名前が上限（12 文字）の長さ（レビュー block-1 の回帰の検査）
      await pinCheck(w, h, true);
    }
    console.log(`読み取りの検査: ${readoutStats.pass} / ${readoutStats.total} 状態で pass`);
    console.log(
      `シナリオの値・チップの検査: ${scenarioStats.pass} / ${scenarioStats.total} 状態で pass`,
    );
    console.log(
      `ポジションの行の検査: ${positionsStats.pass} / ${positionsStats.total} 状態で pass、詳細を開いた状態 ${detailStats.pass} / ${detailStats.total}`,
    );
    console.log(
      `指標の検査: ${metricsStats.pass} / ${metricsStats.total} 状態で pass、内訳を開いた状態 ${breakdownStats.pass} / ${breakdownStats.total}`,
    );
  }
}

/** 足 2 本のタブ A + タブ「ヘッジ案」（重ねる相手）の作業 */
const twoTabs = JSON.stringify({ ...fixture, active: 0, tabs: [fixture.tabs[0], fixture.tabs[1]] });
/** 同じ作業で、タブの名前を上限（TAB_NAME_MAX = 12 文字）の長さにしたもの */
const LONG_NAMES = ['長い名前のタブ一二三四五', '別の長いヘッジ案ですよね'];
const twoTabsLong = JSON.stringify({
  ...fixture,
  active: 0,
  tabs: [
    { ...fixture.tabs[0], name: LONG_NAMES[0] },
    { ...fixture.tabs[1], name: LONG_NAMES[1] },
  ],
});

/**
 * ピン 3 本（今の線を残す × 2 + ヘッジ案を重ねる）の凡例: 各ピンの番号と × が凡例行の中に見え（幅 > 0）、× の当たりが
 * 24px 以上・中心の elementFromPoint が × 自身、× を押すとそのピンが外れる。この状態の縦・横・折り返し・読み取りも測る
 */
async function pinCheck(w, h, long) {
  const ctx = await newContext(
    { width: w, height: h },
    {
      [WORKSPACE_KEY]: long ? twoTabsLong : twoTabs,
      [PREFS_KEY]: prefsText('dark'),
    },
  );
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const add = async (text) => {
    await page.click('button[aria-label="ピン"]');
    await page.click(`[role="menuitem"]:has-text("${text}")`);
    await page.waitForTimeout(150);
  };
  await add('今の線を残す');
  await add(`${long ? LONG_NAMES[1] : 'ヘッジ案'} を重ねる`);
  await add('今の線を残す');
  const tag = `next dark ピン 3 本${long ? '（12 文字の名前）' : ''}`;
  const name = `next-${w}x${h}-dark-pins3${long ? '-long' : ''}`;
  await report(page, tag, w, h, name);
  await readoutCheck(page, `${tag} ${w}x${h}`, w <= PHONE_MAX ? 3 : w >= 1200 ? 6 : 5);
  const r = await page.evaluate(() => {
    const head = document.querySelector('.stage-head')?.getBoundingClientRect();
    const stage = document.querySelector('section.stage')?.getBoundingClientRect();
    const chips = [...document.querySelectorAll('.pins .pin-chip')];
    const bad = [];
    for (const c of chips) {
      const no = c.querySelector('.pin-no');
      const x = c.querySelector('.pin-x');
      const nb = no?.getBoundingClientRect();
      const xb = x?.getBoundingClientRect();
      const inside = (b) =>
        !!b && !!head && b.width > 0 && b.left >= head.left && b.right <= head.right + 0.5;
      const label = no?.textContent ?? '?';
      if (!inside(nb)) bad.push(`${label} 番号が見えない`);
      if (!inside(xb)) bad.push(`${label} × が見えない`);
      else {
        if (xb.width < 24 || xb.height < 24)
          bad.push(`${label} × の当たり ${xb.width}x${xb.height}`);
        const hit = document.elementFromPoint(xb.left + xb.width / 2, xb.top + xb.height / 2);
        if (hit !== x) bad.push(`${label} × が隠れている`);
      }
    }
    // 凡例行の右の道具（ピン・拡大縮小・⋯・ⓘ。出しているものすべて）が舞台の中にあって押せる
    const tools = [...document.querySelectorAll('.stage-tools button')].filter(
      (b) => b.getClientRects().length > 0,
    );
    for (const b of tools) {
      const bb = b.getBoundingClientRect();
      const label = b.getAttribute('aria-label') ?? b.textContent ?? '?';
      const inStage =
        !!stage && !!head && bb.width > 0 && bb.left >= stage.left && bb.right <= stage.right + 0.5;
      if (!inStage) {
        bad.push(`道具「${label}」が舞台の外`);
        continue;
      }
      const hit = document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2);
      if (!hit || !b.contains(hit)) bad.push(`道具「${label}」が押せない`);
    }
    return { n: chips.length, tools: tools.length, bad };
  });
  let ok = r.n === 3 && r.tools >= 3 && r.bad.length === 0;
  if (ok) {
    await page.click('.pins .pin-chip:nth-child(2) .pin-x');
    await page.waitForTimeout(150);
    const n = await page.locator('.pins .pin-chip').count();
    const btn = await page.textContent('button[aria-label="ピン"]');
    ok = n === 2 && (btn ?? '').includes('2/3');
    if (!ok) r.bad.push(`× の後 ${n} 本（${btn}）`);
  }
  if (!ok) failed = true;
  console.log(
    `${tag} ${w}x${h}: 凡例のピン ${r.n} 本・× と道具 ${r.tools} 個が見えて押せる ${ok ? 'pass' : `NG ${r.bad.join('・')}`}`,
  );
  await ctx.close();
}

// ---- 手順（AC-11・AC-12）
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failed = true;
  console.log(`${ok ? 'pass' : 'fail'}  ${name}${detail ? `（${detail}）` : ''}`);
}

async function runFlows() {
  const phone = { width: 390, height: 844 };
  const pc = { width: 1440, height: 900 };
  const next = pageUrl('next');
  const legacyUrl = pageUrl('legacy');

  // (a) 開いただけでは作業の保存を書き換えない・ドックのバッジ
  {
    const ctx = await newContext(phone, { [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next');
    await page.waitForTimeout(2000);
    const after = await page.evaluate((k) => localStorage.getItem(k), WORKSPACE_KEY);
    check('AC-11(a) ?ui=next を開いて 2 秒: 作業の保存がバイト単位で同じ', after === twoLegs);
    const badge = await page
      .textContent('.dock button[data-panel="positions"] .cnt')
      .catch(() => null);
    check('AC-11(a) ドックのポジのバッジが 2', badge === '2', `バッジ ${badge}`);
    await ctx.close();
  }

  // (b) 共有 URL を ?ui=next で開く → 足 3 本、?ui=next が残りフラグメントが消える → 旧画面でも足 3 本
  {
    const ctx = await newContext(phone, {});
    const page = await ctx.newPage();
    await page.goto(`${next}${share.hash}`);
    await waitReady(page, 'next');
    const badge = await page
      .waitForFunction(
        () =>
          document.querySelector('.dock button[data-panel="positions"] .cnt')?.textContent === '3',
        undefined,
        { timeout: 5000 },
      )
      .then(() => '3')
      .catch(() => null);
    check('AC-11(b) 共有 URL を開いて足 3 本（バッジ）', badge === '3');
    const u = new URL(page.url());
    check(
      'AC-11(b) URL は ?ui=next が残りフラグメントが消える',
      u.searchParams.get('ui') === 'next' && u.hash === '',
      `${u.search}${u.hash}`,
    );
    await page.waitForTimeout(1500); // 自動保存（500ms の debounce）
    await page.goto(legacyUrl);
    await waitReady(page, 'legacy');
    const rows = await page.locator('ul.leg-list > li').count();
    const saved = await page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        return ws?.tabs?.[ws.active]?.position?.legs?.length ?? null;
      } catch {
        return null;
      }
    }, WORKSPACE_KEY);
    check(
      'AC-11(b) ?ui=next なしで開き直すと足 3 本',
      rows === 3 && saved === 3,
      `行 ${rows}・保存 ${saved}`,
    );
    await ctx.close();
  }

  // (c) テーマのメニュー: ライト → data-theme・prefs・再読み込み、端末に合わせる → emulateMedia に追従
  {
    const ctx = await newContext(pc, { [WORKSPACE_KEY]: twoLegs }, 'dark');
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next');
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? null);
    check(
      'AC-11(c) 既定（端末に合わせる・端末はダーク）で data-theme="dark"',
      (await theme()) === 'dark',
    );
    await page.click('button[aria-label="テーマ"]');
    await page.click('[role="menuitemradio"]:has-text("ライト")');
    check('AC-11(c) 「ライト」で html[data-theme="light"]', (await theme()) === 'light');
    const prefs = await page.evaluate((k) => localStorage.getItem(k), PREFS_KEY);
    check(
      'AC-11(c) option-simulator.prefs が {"schema_version":1,"theme":"light"}',
      prefs === '{"schema_version":1,"theme":"light"}',
      String(prefs),
    );
    await page.reload();
    await waitReady(page, 'next');
    check('AC-11(c) 再読み込み後もライト', (await theme()) === 'light');
    await page.click('button[aria-label="テーマ"]');
    await page.click('[role="menuitemradio"]:has-text("端末に合わせる")');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(100);
    const t1 = await theme();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(100);
    const t2 = await theme();
    check(
      'AC-11(c) 端末に合わせる: emulateMedia light / dark に追従',
      t1 === 'light' && t2 === 'dark',
      `${t1} / ${t2}`,
    );
    await ctx.close();
  }

  // (d) prefs がライトのまま旧画面を開く → data-theme 無し・背景色は prefs 無しと同じ
  {
    const bg = async (storage) => {
      const ctx = await newContext(pc, storage, 'dark');
      const page = await ctx.newPage();
      await page.goto(legacyUrl);
      await waitReady(page, 'legacy');
      const r = await page.evaluate(() => ({
        theme: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
      }));
      await ctx.close();
      return r;
    };
    const withPrefs = await bg({ [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('light') });
    const without = await bg({ [WORKSPACE_KEY]: twoLegs });
    check('AC-11(d) 旧画面の html に data-theme が無い', withPrefs.theme === null);
    check(
      'AC-11(d) 旧画面の body の背景色が prefs 無しと同じ',
      withPrefs.bg === without.bg,
      `${withPrefs.bg} / ${without.bg}`,
    );
  }

  // AC-12 キーボード
  {
    const ctx = await newContext(pc, { [WORKSPACE_KEY]: twoLegs }, 'dark');
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next');
    const onButton = () =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'テーマ');
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await onButton();
    }
    check('AC-12 Tab でテーマのボタンに届く', reached);
    await page.keyboard.press('Enter');
    const first = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"]');
      const items = menu ? [...menu.querySelectorAll('[role^="menuitem"]')] : [];
      return !!menu && document.activeElement === items[0];
    });
    check('AC-12 Enter でメニューが開き最初の項目にフォーカス', first);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const chosen = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      menu: !!document.querySelector('[role="menu"]'),
      onButton: document.activeElement?.getAttribute('aria-label') === 'テーマ',
    }));
    check(
      'AC-12 ↓ ↓ Enter でライトになり、メニューが閉じてボタンへ戻る',
      chosen.theme === 'light' && !chosen.menu && chosen.onButton,
      JSON.stringify(chosen),
    );
    await page.keyboard.press('Enter');
    const opened = await page.evaluate(() => !!document.querySelector('[role="menu"]'));
    await page.keyboard.press('Escape');
    const esc = await page.evaluate(() => ({
      menu: !!document.querySelector('[role="menu"]'),
      onButton: document.activeElement?.getAttribute('aria-label') === 'テーマ',
    }));
    check(
      'AC-12 Esc で閉じてボタンへ戻る',
      opened && !esc.menu && esc.onButton,
      JSON.stringify(esc),
    );
    await page.click('button[aria-label="テーマ"]');
    const opened2 = await page.evaluate(() => !!document.querySelector('[role="menu"]'));
    await page.mouse.click(700, 500);
    const outside = await page.evaluate(() => !!document.querySelector('[role="menu"]'));
    check(
      'AC-12 外側のクリックで閉じる',
      opened2 && !outside,
      `開いた ${opened2}・外側の後 ${outside}`,
    );
    await ctx.close();
  }

  // 参考（AC-14 の自動の部分）: ドックとつまみ
  {
    const ctx = await newContext(phone, { [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next');
    const st = () =>
      page.evaluate(() => {
        const l = document.querySelector('.layout');
        return `${l?.getAttribute('data-panel')}/${l?.getAttribute('data-sheet')}`;
      });
    const seq = [await st()];
    await page.click('.dock button[data-panel="board"]');
    seq.push(await st());
    await page.click('.dock button[data-panel="board"]');
    seq.push(await st());
    await page.click('.dock button[data-panel="scenario"]');
    seq.push(await st());
    const drag = async (dy) => {
      const b = await page.locator('.grabber').boundingBox();
      if (!b) return;
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + dy, { steps: 4 });
      await page.mouse.up();
    };
    await drag(-60);
    seq.push(await st());
    await drag(60);
    seq.push(await st());
    await drag(30);
    seq.push(await st());
    await drag(60);
    seq.push(await st());
    const want = [
      'positions/peek',
      'board/peek',
      'board/hidden',
      'scenario/peek',
      'scenario/full',
      'scenario/peek',
      'scenario/peek',
      'scenario/hidden',
    ];
    check(
      '参考 ドック（別 → 同じ → 別）とつまみのドラッグ（↑60 ↓60 ↓30 ↓60）',
      JSON.stringify(seq) === JSON.stringify(want),
      seq.join(' → '),
    );
    await ctx.close();
  }

  // #82 舞台の手順（AC-13・AC-14・AC-15）
  for (const vp of [phone, pc]) await stageFlows(vp);
  // #83 シナリオの手順（AC-10・AC-11）
  for (const vp of [phone, pc]) await scenarioFlows(vp);
  // #84 作業台の手順（AC-11・AC-12）
  for (const vp of [phone, pc]) await benchFlows(vp);
  // #86 指標の手順（AC-10・AC-11）
  for (const vp of [phone, pc]) await metricsFlows(vp);
}

// ---- 舞台の手順（#82）
const board = JSON.parse(readFileSync(join(root, 'fixtures/synthetic/latest.json'), 'utf8'));
/** 合成の板のその限月・K の put の bid */
const putBid = (month, k) =>
  board.months.find((m) => m.contract_month === month)?.rows.find((r) => r.k === k)?.put.bid ??
  null;
/** 画面の符号付きの整数（fmtSigned(v, 0) と同じ: +1,234 / −1,234 / 0） */
const signedText = (v) => {
  const s = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : '0';
};

/** Long Animation Frame（50ms 超）の数を数える observer（ページより先に入れる） */
const LOAF_INIT = `
  window.__loaf = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__loaf.push(e.duration);
    }).observe({ type: 'long-animation-frame', buffered: true });
    window.__loafOk = true;
  } catch {
    window.__loafOk = false;
  }
`;

async function stageFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const saved = async () => {
    await page.waitForTimeout(700); // 自動保存（500ms の debounce）
    return page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        const pos = ws?.tabs?.[ws.active]?.position;
        return { scenario: pos?.scenario ?? null, legs: pos?.legs ?? [] };
      } catch {
        return { scenario: null, legs: [] };
      }
    }, WORKSPACE_KEY);
  };
  const box = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} が無い`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const aria = (sel) =>
    page.evaluate((s) => Number(document.querySelector(s)?.getAttribute('aria-valuenow')), sel);
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  const drag = async (from, dx, dy, steps) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps });
    await page.mouse.up();
  };
  const axes = new Set();
  const loafs = [];

  // 始めにシナリオを 0 に（描画域にフォーカスして 0）
  await page.focus('.chart');
  await page.keyboard.press('0');
  const s0 = (await saved()).scenario;
  check(
    `#82 ${tag} 描画域の 0 でシナリオが 0 に`,
    s0?.dX === 0 && s0?.days === 0 && s0?.dSigma === 0,
    JSON.stringify(s0),
  );

  // (a) ハンドルを横に 60px → ΔX（10 円の倍数）。保存と読み取りの副題が同じ値
  {
    const h = await box('.chart .handle-hit');
    const mark = await loafMark();
    await drag(h, 60, 0, 30);
    const lf = await loafSince(mark);
    loafs.push(`ハンドル ${lf}`);
    const sc = (await saved()).scenario;
    const sub = await page.textContent('.ro[data-ro="date"] .s');
    const dX = sc?.dX ?? 0;
    const ok = dX !== 0 && dX % 10 === 0 && (sub ?? '').includes(`(${signedText(dX)}/`);
    if (ok) axes.add('ΔX');
    check(`#82 AC-13(a) ${tag} ハンドルを 60px → ΔX ${dX}・副題と同じ`, ok, sub ?? '');
    check(
      `#82 AC-15 ${tag} ハンドルのドラッグ 30 回の move で長いフレーム 0 件`,
      loafOk && lf === 0,
      loafOk ? `${lf} 件` : '未対応',
    );
  }

  // (b) IV レールのつまみを上に 40px → Δσ > 0、ダブルクリックで 0
  {
    const k = await box('.ivrail .knob');
    const mark = await loafMark();
    await drag(k, 0, -40, 30);
    const lf = await loafSince(mark);
    loafs.push(`IV レール ${lf}`);
    const now = await aria('.ivrail');
    const sc = (await saved()).scenario;
    const ok = now > 0 && sc?.dSigma === now;
    if (ok) axes.add('Δσ');
    check(`#82 AC-13(b) ${tag} IV レールを上に 40px → Δσ ${now}（保存 ${sc?.dSigma}）`, ok);
    check(
      `#82 AC-15 ${tag} IV レールのドラッグ 30 回で長いフレーム 0 件`,
      loafOk && lf === 0,
      loafOk ? `${lf} 件` : '未対応',
    );
    const k2 = await box('.ivrail .knob');
    await page.mouse.dblclick(k2.x, k2.y);
    await page.waitForTimeout(100);
    const z = await aria('.ivrail');
    const sc2 = (await saved()).scenario;
    check(
      `#82 AC-13(b) ${tag} IV レールのダブルクリックで 0`,
      z === 0 && sc2?.dSigma === 0,
      `${z} / ${sc2?.dSigma}`,
    );
  }

  // (c) 時間レールのつまみを右に 60px → d が 1 以上の整数、SQ の目盛りのタップ → daysToTarget の値
  {
    const k = await box('.timerail .knob');
    const mark = await loafMark();
    await drag(k, 60, 0, 30);
    const lf = await loafSince(mark);
    loafs.push(`時間レール ${lf}`);
    const now = await aria('.timerail');
    const sc = (await saved()).scenario;
    const ok = Number.isInteger(now) && now >= 1 && sc?.days === now;
    if (ok) axes.add('d');
    check(`#82 AC-13(c) ${tag} 時間レールを右に 60px → d ${now}（保存 ${sc?.days}）`, ok);
    check(
      `#82 AC-15 ${tag} 時間レールのドラッグ 30 回で長いフレーム 0 件`,
      loafOk && lf === 0,
      loafOk ? `${lf} 件` : '未対応',
    );
    const t = await box('.timerail .mark.sq');
    const want = Number(await page.getAttribute('.timerail .mark.sq', 'data-days'));
    await page.mouse.click(t.x, t.y);
    await page.waitForTimeout(100);
    const got = await aria('.timerail');
    const sc2 = (await saved()).scenario;
    check(
      `#82 AC-13(c) ${tag} SQ の目盛りのタップ → d = daysToTarget`,
      got === want && sc2?.days === want && !Number.isInteger(want),
      `${got} / 期待 ${want}`,
    );
  }

  // (d) キー: 描画域で → ↑ ] → ΔX +100・Δσ +0.5・d +1、IV レールで ↑、時間レールで →
  {
    await page.focus('.chart');
    await page.keyboard.press('0');
    const a = (await saved()).scenario;
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press(']');
    const b = (await saved()).scenario;
    check(
      `#82 AC-13(d) ${tag} 描画域の → ↑ ] で ΔX +100・Δσ +0.5・d +1`,
      b?.dX === a.dX + 100 && b?.dSigma === a.dSigma + 0.5 && b?.days === a.days + 1,
      `${JSON.stringify({ dX: b?.dX, dSigma: b?.dSigma, days: b?.days })}`,
    );
    await page.focus('.ivrail');
    await page.keyboard.press('ArrowUp');
    await page.focus('.timerail');
    await page.keyboard.press('ArrowRight');
    const c = (await saved()).scenario;
    check(
      `#82 AC-13(d) ${tag} IV レールの ↑ で Δσ +0.5、時間レールの → で d +1`,
      c?.dSigma === b.dSigma + 0.5 && c?.days === b.days + 1,
      `${c?.dSigma} / ${c?.days}`,
    );
  }
  check(
    `#82 AC-13 ${tag} グラフの上で動かせる軸 ${axes.size} / 3`,
    axes.size === 3,
    [...axes].join('・'),
  );

  // AC-15 ホイール 20 回・パン 30 回
  {
    const c = await box('.chart');
    const mark = await loafMark();
    await page.mouse.move(c.b.x + c.b.width * 0.3, c.b.y + c.b.height * 0.35);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i < 10 ? -60 : 60);
      await page.waitForTimeout(16);
    }
    const lfWheel = await loafSince(mark);
    const mark2 = await loafMark();
    await drag({ x: c.b.x + c.b.width * 0.3, y: c.b.y + c.b.height * 0.35 }, -90, 0, 30);
    const lfPan = await loafSince(mark2);
    loafs.push(`ホイール ${lfWheel}`, `パン ${lfPan}`);
    check(
      `#82 AC-15 ${tag} ホイール 20 回で長いフレーム 0 件`,
      loafOk && lfWheel === 0,
      loafOk ? `${lfWheel} 件` : '未対応',
    );
    check(
      `#82 AC-15 ${tag} パン 30 回で長いフレーム 0 件`,
      loafOk && lfPan === 0,
      loafOk ? `${lfPan} 件` : '未対応',
    );
    console.log(`      ${tag} Long Animation Frame（50ms 超）: ${loafs.join('・')}`);
    await page.focus('.chart');
    await page.keyboard.press('r');
  }

  // AC-14 (a) マーカーのタップ → ポジションのパネルが開き（スマホは peek）、マーカーが強調
  const phoneSize = vp.width <= PHONE_MAX;
  if (phoneSize) {
    await setShell(page, 'board', 'hidden');
    await page.waitForTimeout(150);
  }
  {
    const m = await box('.legmark[data-leg-id="1"]');
    await page.mouse.click(m.x, m.y);
    await page.waitForTimeout(150);
    const st = await page.evaluate(() => {
      const l = document.querySelector('.layout');
      return {
        panel: l?.getAttribute('data-panel'),
        sheet: l?.getAttribute('data-sheet'),
        sel: document.querySelector('.legmark.sel')?.getAttribute('data-leg-id') ?? null,
      };
    });
    check(
      `#82 AC-14(a) ${tag} マーカーのタップ → ポジションのパネル${phoneSize ? '（peek）' : ''}・強調`,
      st.panel === 'positions' && (!phoneSize || st.sheet === 'peek') && st.sel === '1',
      JSON.stringify(st),
    );
  }

  // AC-14 (b) 売りの put のマーカーを長押し 500ms → 1 つ上の行使価格までドラッグ → 離す → [元に戻す]
  {
    const before = (await saved()).legs[0]?.leg;
    const m = await box('.legmark[data-leg-id="1"]');
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    await page.waitForTimeout(500);
    const next = 63625;
    let reached = false;
    let label = '';
    for (let i = 1; i <= 80 && !reached; i++) {
      await page.mouse.move(m.x + i, m.y);
      await page.waitForTimeout(20);
      label = (await page.textContent('.chart .legdrag').catch(() => null)) ?? '';
      reached = label === `K ${next.toLocaleString('en-US')}`;
    }
    await page.mouse.up();
    const after = (await saved()).legs[0]?.leg;
    const bid = putBid('2026-11', next);
    const toast = (await page.textContent('.toast .txt').catch(() => null)) ?? '';
    check(
      `#82 AC-14(b) ${tag} マーカーの長押しドラッグで K ${before?.strike} → ${after?.strike}・建値 ${after?.entry}（bid ${bid}）`,
      reached &&
        before?.strike === 63500 &&
        after?.strike === next &&
        after?.entry === bid &&
        toast.includes('63,625'),
      `トースト「${toast}」`,
    );
    await page.click('.toast button');
    const back = (await saved()).legs[0]?.leg;
    check(
      `#82 AC-14(b) ${tag} [元に戻す] で元の strike・entry`,
      back?.strike === before?.strike && back?.entry === before?.entry,
      `${back?.strike} @${back?.entry}`,
    );
  }
  await ctx.close();
}

// ---- シナリオの手順（#83 AC-10・AC-11）
async function scenarioFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (vp.width <= PHONE_MAX) {
    const ok = await setShell(page, 'scenario', 'peek');
    check(`#83 ${tag} ドックで「シナリオ」を開く（peek）`, ok);
  }
  const saved = async () => {
    await page.waitForTimeout(700); // 自動保存（500ms の debounce）
    return page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        return {
          scenario: ws?.tabs?.[ws.active]?.position?.scenario ?? null,
          basis: ws?.ui?.future_basis ?? null,
        };
      } catch {
        return { scenario: null, basis: null };
      }
    }, WORKSPACE_KEY);
  };
  const st = (f) => `section.scenario .stepper[data-name="${f}"]`;
  const plus = (f) => `${st(f)} > button:last-child`;
  const val = (f) => `${st(f)} > .val`;
  const now = (f) =>
    page.evaluate((s) => Number(document.querySelector(s)?.getAttribute('aria-valuenow')), val(f));
  const center = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} が無い`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
  const loafs = [];

  // 始めにシナリオを 0 に（描画域にフォーカスして 0）
  await page.focus('.chart');
  await page.keyboard.press('0');
  const s0 = (await saved()).scenario;
  check(
    `#83 ${tag} 描画域の 0 でシナリオが 0 に`,
    s0?.dX === 0 && s0?.days === 0 && s0?.dSigma === 0 && s0?.skew === 0,
    JSON.stringify(s0),
  );

  // (a) d の ＋ → +1、Shift + ＋ → +10（上限で止まる）
  let pctHalf = 0;
  {
    await page.click(plus('days'));
    const a = (await saved()).scenario;
    check(`#83 AC-10(a) ${tag} d の ＋ → d +1`, a?.days === 1, `${a?.days}`);
    const max = Number(await page.getAttribute(val('days'), 'aria-valuemax'));
    await page.click(plus('days'), { modifiers: ['Shift'] });
    const b = (await saved()).scenario;
    const want = Math.min(11, max);
    check(
      `#83 AC-10(a) ${tag} Shift + ＋ → d +10（上限 ${max} で止まる）`,
      b?.days === want && (await now('days')) === want,
      `${b?.days} / 期待 ${want}`,
    );
    for (let i = 0; i < 5 && (await page.isEnabled(plus('days'))); i++) {
      await page.click(plus('days'), { modifiers: ['Shift'] });
    }
    const c = (await saved()).scenario;
    check(
      `#83 AC-10(a) ${tag} Shift + ＋ を続けると上限 ${max} で止まる`,
      c?.days === max,
      `${c?.days}`,
    );
    // Δσ の値を右に 40px スクラブ → +2.5pt（5 段）
    const v = await center(val('dSigma'));
    await page.mouse.move(v.x, v.y);
    await page.mouse.down();
    await page.mouse.move(v.x + 40, v.y, { steps: 10 });
    await page.mouse.up();
    const d = (await saved()).scenario;
    check(
      `#83 AC-10(a) ${tag} Δσ の値を右に 40px スクラブ → +2.5pt`,
      d?.dSigma === 2.5 && (await now('dSigma')) === 2.5,
      `${d?.dSigma}`,
    );
    // Δs の値の上でホイール上 1 回 → +0.5
    const k = await center(val('skew'));
    await page.mouse.move(k.x, k.y);
    await page.mouse.wheel(0, -100);
    const e = (await saved()).scenario;
    check(`#83 AC-10(a) ${tag} Δs の値の上でホイール上 1 回 → +0.5`, e?.skew === 0.5, `${e?.skew}`);
    // ΔX にフォーカスして ↑ → +0.5%
    await page.focus(val('dX'));
    await page.keyboard.press('ArrowUp');
    const f = (await saved()).scenario;
    pctHalf = f?.dX ?? 0;
    check(
      `#83 AC-10(a) ${tag} ΔX にフォーカスして ↑ → +0.5%（状態 ${pctHalf} 円）`,
      (await now('dX')) === 0.5 && pctHalf > 0,
    );
  }

  // (b) ΔX の数値入力: -3 Enter → X₀ × −3%、-99 → 赤く保存は変わらない、Esc で元の表示
  {
    // X₀ = ΔX = 0 のときの副題の X'（整数に丸めた値）。合成の板の X₀ は整数でないので、丸めの分を許す
    await page.focus(val('dX'));
    await page.keyboard.press('r');
    await page.waitForTimeout(100);
    const sub = (await page.textContent(`${val('dX')} small`)) ?? '';
    const x0 = Number((/X ([\d,]+)/.exec(sub)?.[1] ?? 'NaN').replaceAll(',', ''));
    await page.dblclick(val('dX'));
    const input = `${val('dX')} input`;
    await page.waitForSelector(input);
    await page.fill(input, '-3');
    await page.keyboard.press('Enter');
    const a = (await saved()).scenario;
    const dX = a?.dX ?? Number.NaN;
    check(
      `#83 AC-10(b) ${tag} ΔX に -3 Enter → 保存の ΔX ${dX} = X₀ × −3%（X₀ ≈ ${x0}）`,
      close(dX, pctHalf * -6) && Math.abs(dX - x0 * -0.03) <= 0.03 * 0.5 + 0.01,
      `+0.5% の ${pctHalf} × −6 = ${pctHalf * -6}`,
    );
    const shown = await page.textContent(`${val('dX')} b`);
    await page.dblclick(val('dX'));
    await page.waitForSelector(input);
    await page.fill(input, '-99');
    const inv = await page.getAttribute(input, 'aria-invalid');
    const alert =
      (await page.textContent('section.scenario .scn-err[role="alert"]').catch(() => null)) ?? '';
    const b = (await saved()).scenario;
    check(
      `#83 AC-10(b) ${tag} -99 → aria-invalid="true"・保存は変わらない`,
      inv === 'true' && b?.dX === dX && alert.startsWith('原資産 ΔXは'),
      `「${alert}」`,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const back = await page.textContent(`${val('dX')} b`).catch(() => null);
    const gone = (await page.locator(input).count()) === 0;
    const err = await page.locator('section.scenario .scn-err').count();
    check(
      `#83 AC-10(b) ${tag} Esc で元の表示（${back}）`,
      gone && back === shown && err === 0 && (await saved()).scenario?.dX === dX,
    );
  }

  // (e) 前提: β の ＋ → 1.1、sticky moneyness、basis 減衰、ΔX 円（表示は円・状態の ΔX は同じ）
  {
    await page.click('section.scenario details.adv summary');
    await page.click(plus('beta'));
    const a = (await saved()).scenario;
    check(`#83 AC-10(e) ${tag} 前提を開いて β の ＋ → 1.1`, a?.beta === 1.1, `${a?.beta}`);
    await page.click(
      'section.scenario .seg[aria-label="IV の動き方"] button:has-text("sticky moneyness")',
    );
    const b = (await saved()).scenario;
    check(
      `#83 AC-10(e) ${tag} sticky moneyness → ivDynamics = "sticky_moneyness"`,
      b?.ivDynamics === 'sticky_moneyness',
      `${b?.ivDynamics}`,
    );
    await page.click('section.scenario .seg[aria-label="先物の basis"] button:has-text("減衰")');
    const c = await saved();
    check(
      `#83 AC-10(e) ${tag} basis 減衰 → future_basis = "decay"`,
      c.basis === 'decay',
      `${c.basis}`,
    );
    await page.click('section.scenario .seg[aria-label="ΔX の単位"] button:has-text("円")');
    const d = (await saved()).scenario;
    const text = (await page.textContent(`${val('dX')} b`)) ?? '';
    const yen = await now('dX');
    check(
      `#83 AC-10(e) ${tag} ΔX 円 → 表示 ${text}・状態の ΔX は変わらない`,
      text.endsWith(' 円') && yen === d?.dX && d?.dX === c.scenario?.dX,
      `表示 ${yen} / 状態 ${d?.dX}`,
    );
    const vals = await page.textContent('section.scenario details.adv .vals');
    check(
      `#83 AC-10(e) ${tag} 前提の要約`,
      vals === 'β 1.1 · sticky moneyness · basis 減衰 · ΔX 円',
      `${vals}`,
    );
    await page.click('section.scenario .seg[aria-label="ΔX の単位"] button:has-text("%")');
    await page.click('section.scenario details.adv summary');
  }

  // (c) [急落] → ΔX = X₀ × −10%・Δσ 20・Δs 3、[リセット] → d・ΔX・Δσ・Δs が 0 で β・IV の動き方は前のまま
  {
    await page.click('section.scenario .chip:has-text("急落")');
    const a = (await saved()).scenario;
    const pressed = await page.getAttribute(
      'section.scenario .chip:has-text("急落")',
      'aria-pressed',
    );
    check(
      `#83 AC-10(c) ${tag} [急落] → ΔX ${a?.dX}（X₀ × −10%）・Δσ ${a?.dSigma}・Δs ${a?.skew}`,
      close(a?.dX ?? Number.NaN, pctHalf * -20) &&
        a?.dSigma === 20 &&
        a?.skew === 3 &&
        pressed === 'true',
    );
    await page.click('section.scenario .chip:has-text("リセット")');
    const b = (await saved()).scenario;
    check(
      `#83 AC-10(c) ${tag} [リセット] → d・ΔX・Δσ・Δs が 0、β・IV の動き方は前のまま`,
      b?.days === 0 &&
        b?.dX === 0 &&
        b?.dSigma === 0 &&
        b?.skew === 0 &&
        b?.beta === 1.1 &&
        b?.ivDynamics === 'sticky_moneyness',
      JSON.stringify(b),
    );
  }

  // (d) 評価時刻の「SQ 9:00」→ d が daysToTarget の値で、#82 の時間レールの aria-valuenow と同じ
  {
    await page.click('section.scenario .chip:has-text("SQ 9:00")');
    const a = (await saved()).scenario;
    const rail = Number(await page.getAttribute('.timerail', 'aria-valuenow'));
    const tick = Number(await page.getAttribute('.timerail .mark.sq', 'data-days'));
    const pressed = await page.getAttribute(
      'section.scenario .chip:has-text("SQ 9:00")',
      'aria-pressed',
    );
    check(
      `#83 AC-10(d) ${tag} 評価時刻の「SQ 9:00」→ d ${a?.days}・時間レール ${rail}・目盛り ${tick}`,
      a?.days === rail && a?.days === tick && (await now('days')) === rail && pressed === 'true',
    );

    // レビュー B-1: 端数の d（上限）で数値入力を開き、何も打たずに Enter / フォーカスを外しても d は変わらない
    const input = `${val('days')} input`;
    const focused = () =>
      page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), input);
    await page.dblclick(val('days'));
    await focused();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const b = (await saved()).scenario;
    const closedEnter = (await page.locator(input).count()) === 0;
    await page.dblclick(val('days'));
    await focused();
    await page.focus(val('dSigma'));
    await page.waitForTimeout(100);
    const c = (await saved()).scenario;
    const closedBlur = (await page.locator(input).count()) === 0;
    const errs = await page.locator('section.scenario .scn-err').count();
    const stillPressed = await page.getAttribute(
      'section.scenario .chip:has-text("SQ 9:00")',
      'aria-pressed',
    );
    check(
      `#83 B-1 ${tag} 数値入力を開いて何も打たずに Enter / フォーカスを外す → d ${c?.days} のまま`,
      closedEnter &&
        closedBlur &&
        errs === 0 &&
        b?.days === a?.days &&
        c?.days === a?.days &&
        stillPressed === 'true',
      `Enter ${b?.days}${closedEnter ? '' : '（開いたまま）'}・blur ${c?.days}${closedBlur ? '' : '（開いたまま）'}・エラー ${errs}・押下 ${stillPressed}`,
    );
  }

  // (f) #82 の IV レールを上に 40px → Δσ のステッパー = レール、Δσ の ＋ → レール +0.5
  {
    const k = await center('.ivrail .knob');
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x, k.y - 40, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const rail = Number(await page.getAttribute('.ivrail', 'aria-valuenow'));
    const mine = await now('dSigma');
    check(
      `#83 AC-10(f) ${tag} IV レールを上に 40px → Δσ のステッパー ${mine} = レール ${rail}`,
      rail > 0 && mine === rail && (await saved()).scenario?.dSigma === rail,
    );
    await page.click(plus('dSigma'));
    await page.waitForTimeout(100);
    const rail2 = Number(await page.getAttribute('.ivrail', 'aria-valuenow'));
    check(
      `#83 AC-10(f) ${tag} Δσ のステッパーの ＋ → レール ${rail} → ${rail2}`,
      rail2 === rail + 0.5,
    );
  }

  // レビュー B-2: ステッパーの外の操作（リセット・プリセット・評価時刻のチップ）で値が戻った後の [＋] / [−] と
  // 数値入力の初期値は、今の値から作る（古い送った値を使わない）
  {
    const chip = (t) => page.click(`section.scenario .chip:has-text("${t}")`);
    await chip('リセット');
    await page.click(plus('dSigma'));
    await chip('リセット');
    await page.click(plus('dSigma'));
    const a = (await saved()).scenario;
    check(
      `#83 B-2 ${tag} Δσ: ＋ → リセット → ＋ で 0.5（1 段だけ）`,
      a?.dSigma === 0.5 && (await now('dSigma')) === 0.5,
      `${a?.dSigma}`,
    );
    await chip('リセット');
    await page.click(plus('dX'));
    await chip('急落');
    await page.click(plus('dX'));
    const b = (await saved()).scenario;
    check(
      `#83 B-2 ${tag} ΔX: ＋ → [急落] → ＋ で −9.5%`,
      close(b?.dX ?? Number.NaN, pctHalf * -19) && close(await now('dX'), -9.5, 1e-9),
      `${b?.dX} / 期待 ${pctHalf * -19}`,
    );
    await chip('リセット');
    await page.click(plus('days'));
    await chip('最終日 15:45');
    const lastDays = (await saved()).scenario?.days ?? Number.NaN;
    await page.click(`${st('days')} > button:first-child`);
    const c = (await saved()).scenario;
    check(
      `#83 B-2 ${tag} d: ＋ → 「最終日 15:45」→ − でチップの d − 1（${lastDays} → ${c?.days}）`,
      close(c?.days ?? Number.NaN, lastDays - 1, 1e-9) && !Number.isInteger(lastDays),
    );
    await chip('リセット');
    await page.click(plus('skew'));
    await chip('リセット');
    await page.dblclick(val('skew'));
    const input = `${val('skew')} input`;
    await page.waitForSelector(input);
    const text = await page.inputValue(input);
    await page.keyboard.press('Escape');
    check(`#83 B-2 ${tag} Δs: ＋ → リセット → 数値入力の欄が 0.0`, text === '0.0', `「${text}」`);
  }

  // AC-11 長いフレーム: スクラブ 30 段・[＋] の長押し 2 秒・プリセットの切替 10 回
  {
    await page.click('section.scenario .chip:has-text("リセット")');
    await page.waitForTimeout(100);
    const v = await center(val('dSigma'));
    const mark = await loafMark();
    await page.mouse.move(v.x, v.y);
    await page.mouse.down();
    await page.mouse.move(v.x + 240, v.y, { steps: 60 });
    await page.mouse.up();
    const lfScrub = await loafSince(mark);
    const scrubbed = (await saved()).scenario?.dSigma;
    check(`#83 AC-11 ${tag} スクラブ 240px → Δσ +15（30 段）`, scrubbed === 15, `${scrubbed}`);

    await page.click('section.scenario .chip:has-text("リセット")');
    await page.waitForTimeout(100);
    const p = await center(plus('dSigma'));
    const mark2 = await loafMark();
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.waitForTimeout(2000);
    await page.mouse.up();
    const lfHold = await loafSince(mark2);
    const held = (await saved()).scenario?.dSigma ?? 0;
    // 2 秒で 22 段（REPEAT_DELAY_MS 400・REPEAT_INTERVAL_MS 80）。タイマーの揺れを ±2 段許す
    check(
      `#83 AC-11 ${tag} [＋] の長押し 2 秒で連続 → Δσ ${held}（22 段 = 11pt の前後）`,
      held >= 10 && held <= 12,
    );

    const mark3 = await loafMark();
    const names = ['急落', '下落', '反発'];
    for (let i = 0; i < 10; i++) {
      await page.click(`section.scenario .chip:has-text("${names[i % 3]}")`);
      await page.waitForTimeout(16);
    }
    const lfPreset = await loafSince(mark3);
    loafs.push(`スクラブ ${lfScrub}`, `長押し ${lfHold}`, `プリセット ${lfPreset}`);
    for (const [name, n] of [
      ['スクラブ 30 段', lfScrub],
      ['[＋] の長押し 2 秒', lfHold],
      ['プリセットの切替 10 回', lfPreset],
    ]) {
      check(
        `#83 AC-11 ${tag} ${name}で長いフレーム 0 件`,
        loafOk && n === 0,
        loafOk ? `${n} 件` : '未対応',
      );
    }
    console.log(`      ${tag} シナリオの Long Animation Frame（50ms 超）: ${loafs.join('・')}`);
  }
  await ctx.close();
}

// ---- 作業台の手順（#84 AC-11・AC-12）
async function benchFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (phoneSize) {
    const ok = await setShell(page, 'positions', 'full');
    check(`#84 ${tag} ドックで「ポジ」を開く（full）`, ok);
  }
  const P = 'section.positions';
  const leg = (i) => `${P} li.leg:nth-child(${i})`;
  const saved = async () => {
    await page.waitForTimeout(700); // 自動保存（500ms の debounce）
    return page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        return {
          legs: ws?.tabs?.[ws.active]?.position?.legs ?? [],
          hedge: ws?.ui?.hedge ?? null,
        };
      } catch {
        return { legs: [], hedge: null };
      }
    }, WORKSPACE_KEY);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rowCount = () => page.locator(`${P} li.leg`).count();
  const toastText = () =>
    page.evaluate(() => [...document.querySelectorAll('.toast .txt')].map((t) => t.textContent));
  /** トーストが消えるまで待つ（スマホでは下の行に重なるので、押す前に） */
  const noToasts = () =>
    page
      .waitForFunction(() => document.querySelectorAll('.toast').length === 0, undefined, {
        timeout: 8000,
      })
      .catch(() => {});
  const undoToast = (text) =>
    page.locator('.toast', { hasText: text }).locator('button', { hasText: '元に戻す' });
  const menu = async (item) => {
    await page.click(`${P} button[aria-label="ポジションの操作"]`);
    await page.click(`[role="menuitem"]:has-text("${item}")`);
    await page.waitForTimeout(120);
  };
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  const loafs = [];
  const start = await saved();

  // (a) 1 本目の枚数の ＋ → 2、− → 1、qty 1 で − が disabled
  {
    const st = `${leg(1)} .stepper`;
    await page.click(`${st} > button:last-child`);
    const a = (await saved()).legs[0]?.leg.qty;
    const shown = await page.textContent(`${st} .val b`);
    await page.click(`${st} > button:first-child`);
    const b = (await saved()).legs[0]?.leg.qty;
    const dis = await page.isDisabled(`${st} > button:first-child`);
    check(
      `#84 AC-11(a) ${tag} 枚数 ＋ → ${a}（表示 ${shown}）、− → ${b}、1 で − が disabled`,
      a === 2 && shown === '2' && b === 1 && dis,
    );
  }

  // (b) ⇄ → side が反対・entry は同じ・トーストの文（もう一度押して戻す）
  {
    const before = (await saved()).legs[0]?.leg;
    await page.click(`${leg(1)} button[data-op="flip"]`);
    const after = (await saved()).legs[0]?.leg;
    const texts = await toastText();
    const want = '買 P 63,500 に切替（建値は保持）';
    const btn = await page.locator('.toast', { hasText: want }).locator('button').count();
    check(
      `#84 AC-11(b) ${tag} ⇄ → ${before?.side} → ${after?.side}・建値 ${after?.entry} のまま・トースト（[元に戻す] なし）`,
      before?.side === 'sell' &&
        after?.side === 'buy' &&
        after?.entry === before?.entry &&
        texts.includes(want) &&
        btn === 0,
      texts.join(' / '),
    );
    await page.click(`${leg(1)} button[data-op="flip"]`);
    const back = (await saved()).legs[0]?.leg;
    check(`#84 AC-11(b) ${tag} もう一度 ⇄ で売りに戻る`, back?.side === 'sell');
  }

  // (c) × → 足 1 本・[元に戻す]・確認ダイアログなし → [元に戻す] で保存の legs が消す前と同じ
  {
    await noToasts();
    const before = (await saved()).legs;
    await page.click(`${leg(1)} button[data-op="remove"]`);
    const dlg = await page.locator('dialog[open]').count();
    const mid = (await saved()).legs;
    const rows = await rowCount();
    const u = undoToast('を消した');
    const hasUndo = (await u.count()) === 1;
    if (hasUndo) await u.click();
    const back = (await saved()).legs;
    check(
      `#84 AC-11(c) ${tag} × → 足 ${mid.length} 本（行 ${rows}）・確認ダイアログ ${dlg} 個・[元に戻す] → 足 ${back.length} 本で消す前と同じ`,
      mid.length === 1 && rows === 1 && dlg === 0 && hasUndo && same(back, before),
    );
  }

  // (d) ⋯ > 全クリア → 足 0 本・空の状態 → [元に戻す] → 2 本が元の順
  {
    await noToasts();
    const before = (await saved()).legs;
    await menu('全クリア');
    const mid = (await saved()).legs;
    const empty = await page.isVisible(`${P} .empty-state`);
    const u = undoToast('足 2 本を消した');
    const hasUndo = (await u.count()) === 1;
    if (hasUndo) await u.click();
    const back = (await saved()).legs;
    check(
      `#84 AC-11(d) ${tag} 全クリア → 足 ${mid.length} 本・空の状態 ${empty} → [元に戻す] → ${back.length} 本が元の順`,
      mid.length === 0 && empty && hasUndo && same(back, before),
    );
  }

  // (e) 詳細: 建値 700 → entry 700、枚数 0 → aria-invalid で保存が変わらない、IV 25 → iv 0.25・印「IV 編集」
  {
    await noToasts();
    const main = page.locator(`${leg(1)} .leg-main`);
    await main.click();
    const expanded = await main.getAttribute('aria-expanded');
    const detail = await page.isVisible(`${leg(1)} .leg-detail`);
    check(
      `#84 AC-11(e) ${tag} 行を押す → aria-expanded=${expanded}・詳細`,
      expanded === 'true' && detail,
    );
    const entry = page.locator(`${leg(1)} input[aria-label$=" の建値"]`);
    await entry.fill('700');
    await entry.press('Enter');
    const e1 = (await saved()).legs[0]?.leg;
    check(`#84 AC-11(e) ${tag} 建値 700 Enter → 保存の entry ${e1?.entry}`, e1?.entry === 700);
    const qty = page.locator(`${leg(1)} input[aria-label$=" の枚数を入力"]`);
    await qty.fill('0');
    await qty.press('Enter');
    const inv = await qty.getAttribute('aria-invalid');
    const alert = await page.locator(`${leg(1)} .leg-detail [role="alert"]`).count();
    const q1 = (await saved()).legs[0]?.leg.qty;
    check(
      `#84 AC-11(e) ${tag} 枚数 0 → aria-invalid=${inv}・文言 ${alert} 件・保存の qty ${q1} のまま`,
      inv === 'true' && alert === 1 && q1 === 1,
    );
    const iv = page.locator(`${leg(1)} input[aria-label$=" の IV（%）"]`);
    await iv.fill('25');
    await iv.press('Enter');
    const i1 = (await saved()).legs[0]?.leg;
    const badge = await page.locator(`${leg(1)} .leg-sub .tag`, { hasText: 'IV 編集' }).count();
    check(
      `#84 AC-11(e) ${tag} IV 25 → 保存の iv ${i1?.iv}・印「IV 編集」`,
      i1?.iv === 0.25 && badge === 1,
    );
    await main.click();
  }

  // (f) 足の追加ダイアログ: 先物（既定のまま）→ 足 3 本・閉じる・トースト。枚数 0 → 開いたまま alert。Esc → ⋯ にフォーカス。
  // 手入力 OP（板に無い限月）→ 足が増えて印「手入力」
  {
    await noToasts();
    await menu('足を追加…');
    const open1 = await page.locator('dialog[open]').count();
    await page.click('dialog[open] button[type="submit"]');
    await page.waitForTimeout(150);
    const s1 = (await saved()).legs;
    const closed = (await page.locator('dialog[open]').count()) === 0;
    const texts = await toastText();
    const last = s1[s1.length - 1]?.leg;
    check(
      `#84 AC-11(f) ${tag} 足を追加…（先物の既定）→ 足 ${s1.length} 本（${last?.product}）・閉じる・トースト`,
      open1 === 1 &&
        s1.length === 3 &&
        last?.product === 'fut_mini' &&
        closed &&
        texts.some((t) => /^ミニ先物 \d{4}-\d{2} 買 ×1 を追加$/.test(t ?? '')),
      texts.join(' / '),
    );
    await menu('足を追加…');
    await page.fill('dialog[open] input[name="qty"]', '0');
    await page.click('dialog[open] button[type="submit"]');
    await page.waitForTimeout(120);
    const stillOpen = await page.locator('dialog[open]').count();
    const alert = (await page.textContent('dialog[open] [role="alert"]').catch(() => null)) ?? '';
    const s2 = (await saved()).legs;
    check(
      `#84 AC-11(f) ${tag} 枚数 0 で [追加] → 開いたまま「${alert}」・足 ${s2.length} 本のまま`,
      stillOpen === 1 && alert === '枚数は 1 以上の整数' && s2.length === 3,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const focus = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    check(
      `#84 AC-11(f) ${tag} Esc → 閉じて ⋯ にフォーカス（${focus}）`,
      (await page.locator('dialog[open]').count()) === 0 && focus === 'ポジションの操作',
    );
    await menu('足を追加…');
    await page.click('dialog[open] .seg button:has-text("OP（手入力）")');
    await page.fill('dialog[open] input[name="expiry"]', '2027-06');
    await page.fill('dialog[open] input[name="k"]', '66000');
    await page.fill('dialog[open] input[name="entry"]', '300');
    await page.fill('dialog[open] input[name="iv"]', '30');
    await page.press('dialog[open] input[name="iv"]', 'Enter');
    await page.waitForTimeout(150);
    const s3 = (await saved()).legs;
    const m = s3[s3.length - 1];
    const badge = await page
      .locator(`${P} li.leg:last-child .leg-sub .tag`, { hasText: '手入力' })
      .count();
    check(
      `#84 AC-11(f) ${tag} 手入力 OP（2027-06 P 66,000）を Enter → 足 ${s3.length} 本・印「手入力」`,
      s3.length === 4 &&
        m?.leg.expiry === '2027-06' &&
        (m?.marks ?? []).includes('no_board') &&
        badge === 1 &&
        (await page.locator('dialog[open]').count()) === 0,
    );
  }

  // (g) ヘッジ: ⋯ > ヘッジの設定… で目標 Δ 1 → 保存の target 1・1 段目が変わる。押せる段の [追加] → 先物の足（枚数 = 段の枚数）。
  // 評価点「シナリオ時点」→ 保存の at
  {
    await noToasts();
    const head0 = await page.textContent(`${P} .hedge .hl.head`);
    await menu('ヘッジの設定…');
    await page.fill('dialog[open] input[name="target"]', '1');
    const h1 = (await saved()).hedge;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    const head1 = await page.textContent(`${P} .hedge .hl.head`);
    check(
      `#84 AC-11(g) ${tag} 目標 Δ 1 → 保存の target ${h1?.target}・1 段目「${head1}」`,
      h1?.target === 1 && head1 !== head0 && (head1 ?? '').endsWith('→ 目標 1'),
    );
    const line = page.locator(`${P} .hedge .hl.line`, {
      has: page.locator('button:not([disabled])'),
    });
    const n = await line.count();
    const lotsText = n > 0 ? ((await line.first().locator('.txt b').textContent()) ?? '') : '';
    const lots = Math.abs(Number(lotsText.replace(/[^\d−-]/g, '').replace('−', '-')));
    const before = (await saved()).legs;
    if (n > 0) await line.first().locator('button').click();
    const after = (await saved()).legs;
    const added = after[after.length - 1];
    check(
      `#84 AC-11(g) ${tag} ヘッジの [追加]（${lotsText}）→ 足 ${before.length} → ${after.length} 本・枚数 ${added?.leg.qty}`,
      n > 0 &&
        after.length === before.length + 1 &&
        added?.leg.kind === 'future' &&
        added.leg.qty === lots,
    );
    await page.click(`${P} .sec-head .seg button[aria-label="シナリオ時点"]`);
    const h2 = (await saved()).hedge;
    check(`#84 AC-11(g) ${tag} 評価点「シナリオ時点」→ 保存の at ${h2?.at}`, h2?.at === 'scenario');
  }

  // AC-12: 枚数の ＋ 20 回・⇄ 10 回・× と [元に戻す] 5 回の間の Long Animation Frame
  {
    await noToasts();
    const st = `${leg(1)} .stepper > button:last-child`;
    const q0 = (await saved()).legs[0]?.leg.qty ?? 0;
    const m1 = await loafMark();
    for (let i = 0; i < 20; i++) await page.click(st, { delay: 0 });
    const lfQty = await loafSince(m1);
    const q1 = (await saved()).legs[0]?.leg.qty ?? 0;
    check(`#84 AC-12 ${tag} 枚数の ＋ 20 回 → qty ${q0} → ${q1}`, q1 === q0 + 20);
    const m2 = await loafMark();
    for (let i = 0; i < 10; i++) await page.click(`${leg(1)} button[data-op="flip"]`);
    const lfFlip = await loafSince(m2);
    await noToasts();
    const before = (await saved()).legs;
    const m3 = await loafMark();
    for (let i = 0; i < 5; i++) {
      await page.click(`${leg(1)} button[data-op="remove"]`);
      await undoToast('を消した').first().click();
    }
    const lfDel = await loafSince(m3);
    const after = (await saved()).legs;
    check(`#84 AC-12 ${tag} × と [元に戻す] 5 回の後も足は同じ`, same(after, before));
    loafs.push(`枚数 ${lfQty}`, `⇄ ${lfFlip}`, `×・戻す ${lfDel}`);
    for (const [name, v] of [
      ['枚数の ＋ 20 回', lfQty],
      ['⇄ 10 回', lfFlip],
      ['× と [元に戻す] 5 回', lfDel],
    ]) {
      check(
        `#84 AC-12 ${tag} ${name}で長いフレーム 0 件`,
        loafOk && v === 0,
        loafOk ? `${v} 件` : '未対応',
      );
    }
    console.log(`      ${tag} 作業台の Long Animation Frame（50ms 超）: ${loafs.join('・')}`);
  }

  // (h) 舞台の足マーカーのタップ → ポジションのパネルが開き、その足の行が data-selected で .panel-body の見える範囲にある
  {
    await noToasts();
    if (phoneSize) await setShell(page, 'board', 'hidden');
    await page.waitForTimeout(150);
    const pick = await page.evaluate(() => {
      const ms = [...document.querySelectorAll('.legmark[data-leg-id]')].reverse();
      for (const m of ms) {
        const b = m.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (b.width > 0 && hit && (hit === m || m.contains(hit)))
          return { id: m.getAttribute('data-leg-id'), x, y };
      }
      return null;
    });
    if (pick) {
      await page.mouse.click(pick.x, pick.y);
      await page.waitForTimeout(200);
    }
    const st = await page.evaluate((id) => {
      const l = document.querySelector('.layout');
      const body = document.querySelector('section.positions .panel-body');
      const li = document.querySelector(`section.positions li.leg[data-leg-id="${id}"]`);
      const vb = body?.getBoundingClientRect();
      const rb = li?.getBoundingClientRect();
      return {
        panel: l?.getAttribute('data-panel'),
        selected: li?.hasAttribute('data-selected') ?? false,
        inView:
          !!vb && !!rb && rb.height > 0 && rb.top >= vb.top - 0.5 && rb.bottom <= vb.bottom + 0.5,
      };
    }, pick?.id ?? '');
    check(
      `#84 AC-11(h) ${tag} 足マーカー（id ${pick?.id}）のタップ → ポジションのパネル・行が data-selected で見える範囲`,
      pick !== null && st.panel === 'positions' && st.selected && st.inView,
      JSON.stringify(st),
    );
  }
  // 最初の保存と比べて足が増えている（手順の後始末は不要。コンテキストごと捨てる）
  if (start.legs.length !== 2) check(`#84 ${tag} 始めの足は 2 本`, false, `${start.legs.length}`);
  await ctx.close();
}

// ---- 指標の手順（#86 AC-10・AC-11）
/** 数値のトークン（要素ごとに取り出して連ねる。見出しの末尾と値の先頭の数字をつなげない） */
const METRIC_TOKEN = '[+−]?[0-9][0-9,.]*|[+−]∞|なし|—';

/** 旧画面の指標（dl.metrics-list の dt / dd のトークン列とテール表の 30 個） */
async function legacyMetrics(vp) {
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('legacy'));
  await waitReady(page, 'legacy');
  const r = await page.evaluate((re) => {
    const tokens = [
      ...document.querySelectorAll('dl.metrics-list > dt, dl.metrics-list > dd'),
    ].flatMap((el) => el.textContent.match(new RegExp(re, 'g')) ?? []);
    // 主の文字列（.note を除く）と .note
    const split = (el) => {
      const c = el.cloneNode(true);
      for (const n of c.querySelectorAll('.note')) n.remove();
      return [c.textContent.trim(), el.querySelector('.note')?.textContent.trim() ?? ''];
    };
    const tail = [...document.querySelectorAll('table.tail-table tbody tr')].flatMap((tr) =>
      [...tr.querySelectorAll('th, td')].flatMap(split),
    );
    return { tokens, tail };
  }, METRIC_TOKEN);
  await ctx.close();
  return r;
}

async function metricsFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const old = phoneSize ? null : await legacyMetrics(vp);
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (phoneSize) {
    const ok = await setShell(page, 'metrics', 'peek');
    check(`#86 ${tag} ドックで「指標」を開く（peek）`, ok);
  }
  const M = 'section.metrics';
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  /** タイル 5 の値（主の文字列）・テールの SQ の列・指定日の列（5 個ずつ） */
  const snap = () =>
    page.evaluate((m) => {
      const main = (el) => el?.querySelector(':scope > span')?.textContent ?? null;
      const col = (i) =>
        [...document.querySelectorAll(`${m} table.tail tbody tr`)].map((tr) => {
          const td = tr.querySelectorAll('td')[i];
          return td
            ? `${main(td.querySelector('.txt'))} ${td.querySelector('.txt small')?.textContent}`
            : null;
        });
      return {
        t5: main(document.querySelector(`${m} .tile[data-tile="scenario"] .v`)),
        sq: col(0),
        sc: col(1),
      };
    }, M);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // AC-10: 旧画面と同じ値（1440×900）
  if (old) {
    const toggle = page.locator(`${M} .mx-toggle`);
    await toggle.click();
    await page.waitForTimeout(150);
    const now = await page.evaluate(
      ({ m, re }) => {
        const tokens = [
          ...document.querySelectorAll(`${m} .kv-grid > .k, ${m} .kv-grid > .v`),
        ].flatMap((el) => el.textContent.match(new RegExp(re, 'g')) ?? []);
        const pair = (el) => [
          el?.querySelector(':scope > span')?.textContent.trim() ?? '',
          el?.querySelector('small')?.textContent.trim() ?? '',
        ];
        const tail = [...document.querySelectorAll(`${m} table.tail tbody tr`)].flatMap((tr) => [
          ...pair(tr.querySelector('th')),
          ...[...tr.querySelectorAll('td')].flatMap((td) => pair(td.querySelector('.txt'))),
        ]);
        const t5 = document.querySelector(
          `${m} .tile[data-tile="scenario"] .v > span`,
        )?.textContent;
        const ro = document.querySelector('.ro[data-ro="date"] .v > span')?.textContent;
        return { tokens, tail, t5, ro };
      },
      { m: M, re: METRIC_TOKEN },
    );
    check(
      `#86 AC-10(a) ${tag} 内訳のトークン列が旧画面の dl.metrics-list と一致（${now.tokens.length} 個）`,
      now.tokens.length > 20 && same(now.tokens, old.tokens),
      same(now.tokens, old.tokens) ? '' : `新 ${now.tokens.join(' ')} / 旧 ${old.tokens.join(' ')}`,
    );
    check(
      `#86 AC-10(b) ${tag} テール表の 30 個が旧画面と一致`,
      now.tail.length === 30 && same(now.tail, old.tail),
      same(now.tail, old.tail)
        ? now.tail.slice(0, 6).join(' ')
        : `新 ${now.tail.join(' ')} / 旧 ${old.tail.join(' ')}`,
    );
    check(
      `#86 AC-10(c) ${tag} タイル 5 の値 = 読み取りの指定日の損益`,
      !!now.t5 && now.t5 === now.ro,
      `${now.t5} / ${now.ro}`,
    );
    await toggle.click();
    await page.waitForTimeout(100);
    check(
      `#86 ${tag} 内訳を閉じる（1 回で aria-expanded = false・行が消える）`,
      (await toggle.getAttribute('aria-expanded')) === 'false' &&
        (await page.locator(`${M} .kv-grid`).count()) === 0,
    );
  } else {
    // スマホ: 内訳の開閉が 1 タップで効く
    const toggle = page.locator(`${M} .mx-toggle`);
    await toggle.click();
    await page.waitForTimeout(150);
    const opened =
      (await toggle.getAttribute('aria-expanded')) === 'true' &&
      (await page.locator(`${M} .kv-grid > .v`).count()) > 0;
    await toggle.click();
    await page.waitForTimeout(100);
    const closed = (await toggle.getAttribute('aria-expanded')) === 'false';
    check(`#86 ${tag} 内訳の開閉（開く → 閉じる）`, opened && closed);
  }

  // AC-11 (a)(b): Δσ ＋ 1 回でタイル 5 と指定日の列が変わり SQ の列は同じ、− 1 回で元に戻る
  // PC はシナリオのステッパー、スマホは指標のシートとシナリオが同時に見えないので舞台の IV レールの ↑ / ↓（同じ ±0.5）
  const dsPlus = 'section.scenario .stepper[data-name="dSigma"] > button:last-child';
  const dsMinus = 'section.scenario .stepper[data-name="dSigma"] > button:first-child';
  const up = async () => {
    if (phoneSize) {
      await page.focus('.ivrail');
      await page.keyboard.press('ArrowUp');
    } else await page.click(dsPlus);
  };
  const down = async () => {
    if (phoneSize) {
      await page.focus('.ivrail');
      await page.keyboard.press('ArrowDown');
    } else await page.click(dsMinus);
  };
  const how = phoneSize ? 'IV レールの ↑ / ↓' : 'Δσ の ＋ / −';
  {
    const a = await snap();
    await up();
    await page.waitForTimeout(150);
    const b = await snap();
    check(
      `#86 AC-11(a) ${tag} ${how}: ＋ 1 回でタイル 5 と指定日の列が変わり SQ の列は同じ`,
      !!a.t5 && a.t5 !== b.t5 && !same(a.sc, b.sc) && same(a.sq, b.sq) && a.sq.length === 5,
      `タイル 5 ${a.t5} → ${b.t5}・指定日 ${a.sc[0]} → ${b.sc[0]}`,
    );
    await down();
    await page.waitForTimeout(150);
    const c = await snap();
    check(`#86 AC-11(b) ${tag} ${how}: − 1 回で元の値に戻る`, same(a, c), `タイル 5 ${c.t5}`);
  }

  // AC-11 (c): ＋ の 20 回の連打・舞台のハンドルのドラッグの間の Long Animation Frame（50ms 超）
  {
    const mark = await loafMark();
    if (phoneSize) await page.focus('.ivrail');
    for (let i = 0; i < 20; i++) {
      if (phoneSize) await page.keyboard.press('ArrowUp');
      else await page.click(dsPlus);
      await page.waitForTimeout(16);
    }
    const lfPlus = await loafSince(mark);
    const hb = await page.locator('.chart .handle-hit').first().boundingBox();
    let lfDrag = -1;
    if (hb) {
      const x = hb.x + hb.width / 2;
      const y = hb.y + hb.height / 2;
      const mark2 = await loafMark();
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y, { steps: 30 });
      await page.mouse.up();
      lfDrag = await loafSince(mark2);
    }
    for (const [name, n] of [
      [`${phoneSize ? 'IV レールの ↑' : 'Δσ の ＋'} 20 回の連打`, lfPlus],
      ['ハンドルのドラッグ（30 回の move）', lfDrag],
    ]) {
      check(
        `#86 AC-11(c) ${tag} 指標が見えている状態で${name}の長いフレーム 0 件`,
        loafOk && n === 0,
        loafOk ? `${n} 件` : '未対応',
      );
    }
    console.log(
      `      ${tag} 指標の Long Animation Frame（50ms 超）: 連打 ${lfPlus}・ハンドル ${lfDrag}`,
    );
  }
  await ctx.close();
}

try {
  if (flows) await runFlows();
  else await measureAll();
} finally {
  await browser.close();
  await server?.close();
}
process.exit(failed ? 1 : 0);
