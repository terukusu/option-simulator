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
//                                          縦・横・折り返し・読み取り。
//                                          副題（#107）: タイルの .s・読み取りの .s の切れがすべて全文のボタン（aria-expanded）の中
//                                          で、ボタンの数がタイル 6・読み取りの全文のある項目（ミニは 0）。既定の足と掛け金の足
//                                          （買い 2 本）は千円（自動）で切れ 0、円固定の足（売り 5 枚）は件数だけ
//                                          市場（#85）: 板の列の数（360・390・900・1200×800・1280×800 で 5、1440 で 7、1800×1000 で 9）・
//                                          見えている行のセル・道具の行・脚注の F / ATM / SQ・スマイルの道具の行・操作行（選択なし / あり）・
//                                          凡例が切れていない・.board-wrap が横にはみ出さない・スマイルの描画域（360 peek で 140px 以上）。
//                                          1200 / 1280 / 1800 は市場の列の中の折り返しを判定（ページ全体は記録）。322 行の板
//                                          （buildWideChainJson を /fixtures/latest.json に差し替え）× 既定の字幅 / 実機相当の字幅
//                                          （--mono を DejaVu Sans Mono = Menlo と同じ 0.6em に。無ければ skip）でも測る
//   npm run ui:check -- --parts            部品の見本（?ui=next&parts。dev だけ）
//   npm run ui:check -- --legacy           旧画面（?ui=next なし）
//   npm run ui:check -- --flows            保存・共有・テーマ・キーボードの手順（#81 AC-11・AC-12）と舞台の手順
//                                          （#82: ハンドル・IV / 時間レール・キー・足マーカー・Long Animation Frame）とシナリオの手順
//                                          （#83: ステッパーの ± / Shift / スクラブ / ホイール / キー / 数値入力・プリセット・評価時刻・
//                                          前提・#82 のレールとの一致・Long Animation Frame。390×844 と 1440×900）と作業台の手順
//                                          （#84: 枚数・⇄・× と [元に戻す]・全クリアと [元に戻す]・詳細の入力・足の追加ダイアログ・
//                                          ヘッジ・舞台の足マーカー → 行の強調・Long Animation Frame。390×844 と 1440×900）と指標の手順
//                                          （#86: 旧画面の内訳・テール表との値の一致・タイル 5 と読み取りの一致・Δσ ±0.5 の追従
//                                          （390 は IV レールの ↑ / ↓）・Long Animation Frame。390×844 と 1440×900）と副題の全文の手順
//                                          （#107: タイル 6 枚のタップで全文・内訳との一致・Esc でボタンへ戻る・外側で閉じる・
//                                          同時に 1 つ・Tab → Enter / Space・窓と .panel-body の中・読み取りの損益の全文（上に開く）と
//                                          ハンドルで閉じる・Long Animation Frame。390×844 と 1440×900）と市場の手順
//                                          （#85: bid / ask で足が入る・追従・[元に戻す]・ジャンプと強調・ask ≤ 50 円・put / call・限月・
//                                          スマイルの操作。390×844・1440×900・1800×1000。322 行の板の Long Animation Frame・限月の切替の
//                                          時間。新しい画面の限月・種別・絞り込み・横軸が再読み込みと旧画面に残る）
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
    // 検査自身の時間（板の 322 行・2 千要素の getComputedStyle で 50ms を超えうる）を Long Animation Frame の件数から
    // 除けるように記録する（loafSinceExcludingChecks）
    const t0 = performance.now();
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
    if (Array.isArray(window.__checkRanges)) window.__checkRanges.push([t0, performance.now()]);
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
  await subCheck(page, label, 'readout', true);
  return ok;
}
const readoutStats = { pass: 0, total: 0 };

/**
 * 副題の全文（#107 AC-3）: 見えている副題（指標のタイルの .tile .s・読み取りの .readout .ro .s）のうち切れている
 * （scrollWidth > clientWidth）ものがすべて全文のポップオーバーのボタン（button[aria-expanded]）の中にある。
 * ボタンの数: タイルは見えているタイルの数（6）、読み取りは見えている項目のうち全文のある項目
 * （date・expiry・delta・premium。ui/view/stage.ts の bigReadout の full）の数、スマホでシート全開のミニは 0。
 * strict（千円（自動）の足）なら切れの件数 0 も条件。件数は統計に出す（円固定は yen = true で別に数える）
 */
async function subCheck(page, label, scope, strict, yen = false) {
  const r = await page.evaluate(
    ({ scope, phoneMax }) => {
      const vis = (el) => el.getClientRects().length > 0;
      const BTN = 'button[aria-expanded]';
      let items;
      let want;
      if (scope === 'tiles') {
        const sec = document.querySelector('section.metrics');
        if (!sec || !vis(sec)) return null;
        items = [...sec.querySelectorAll('.tile')].filter(vis);
        want = items.length;
      } else {
        items = [...document.querySelectorAll('.readout .ro[data-ro]')].filter(
          (el) => getComputedStyle(el).display !== 'none',
        );
        const mini =
          window.innerWidth <= phoneMax &&
          document.querySelector('.layout')?.getAttribute('data-sheet') === 'full';
        const FULL = ['date', 'expiry', 'delta', 'premium'];
        want = mini ? 0 : items.filter((el) => FULL.includes(el.getAttribute('data-ro'))).length;
      }
      const btns = items.filter((el) => el.querySelector(`:scope ${BTN}`)).length;
      const subs = items.flatMap((el) => [...el.querySelectorAll('.s')]).filter(vis);
      const cut = subs.filter((el) => el.scrollWidth > el.clientWidth);
      const bare = cut
        .filter((el) => !el.closest(BTN))
        .map((el) => `「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`);
      return {
        n: subs.length,
        btns,
        want,
        cut: cut.map((el) => `「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`),
        bare,
      };
    },
    { scope, phoneMax: PHONE_MAX },
  );
  if (r === null) return true;
  const ok = r.bare.length === 0 && r.btns === r.want && (!strict || r.cut.length === 0);
  subStats.total++;
  if (ok) subStats.pass++;
  else failed = true;
  subStats.cut += r.cut.length;
  if (yen) subStats.cutYen += r.cut.length;
  const what = scope === 'tiles' ? 'タイル' : '読み取り';
  if (!ok) {
    console.log(
      `${label}: ${what}の副題 ${r.n} 個・ボタン ${r.btns} / ${r.want}・切れ ${r.cut.join('・') || 0}・ボタン外の切れ ${r.bare.join('・') || 0}  ← NG`,
    );
  } else if (r.cut.length > 0) {
    console.log(`${label}: ${what}の副題の切れ（全文あり）${r.cut.join('・')}`);
  }
  return ok;
}
const subStats = { pass: 0, total: 0, cut: 0, cutYen: 0 };

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
  await subCheck(page, label, 'tiles', true);
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
            const mk = (panel === 'board' || panel === 'smile') && sheet !== 'hidden';
            await report(page, lbl, w, h, `${name}-${panel}-${sheet}`, scn || mx || mk);
            await readoutCheck(page, `${lbl} ${w}x${h}`, 3);
            await positionsCheck(page, `${lbl} ${w}x${h}`);
            if (scn) {
              await scenarioCheck(page, `${lbl} ${w}x${h}`);
              await advOpenCheck(page, lbl, w, h, `${name}-${panel}-${sheet}-adv`, 3);
            }
            if (mk) {
              // 市場（#85）: 板 5 列・切れ・スマイルの描画域（360 peek で 140px 以上）。スマイルは選択あり / なし
              const smileMin = w === 360 && sheet === 'peek' ? 140 : null;
              await marketCheck(page, `${lbl} ${w}x${h}`, { cols: 5, smileMin });
              if (panel === 'smile') {
                await smilePick(page, true);
                await report(page, `${lbl} 選択あり`, w, h, `${name}-${panel}-${sheet}-pick`);
                await marketCheck(page, `${lbl} 選択あり ${w}x${h}`, { smileMin });
                await smilePick(page, false);
              }
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
            // 市場（#85）: 板（既定）→ 市場の Seg でスマイル（選択なし / あり）→ 板へ戻す
            await marketCheck(page, `${tag} board ${w}x${h}`, { cols: marketCols(w) });
            await page.click('section.board .panel-head .seg button:has-text("スマイル")');
            await page.waitForTimeout(150);
            await report(page, `${tag} smile`, w, h, `${name}-smile`);
            await readoutCheck(page, `${tag} smile ${w}x${h}`, want);
            await marketCheck(page, `${tag} smile ${w}x${h}`, {});
            // 市場の列がスマイルのときも指標のタイルの副題の検査（#107）が通る
            await metricsCheck(page, `${tag} smile ${w}x${h}`);
            await smilePick(page, true);
            await report(page, `${tag} smile 選択あり`, w, h, `${name}-smile-pick`);
            await marketCheck(page, `${tag} smile 選択あり ${w}x${h}`, {});
            await smilePick(page, false);
            await page.click('section.smile .panel-head .seg button:has-text("板")');
            await page.waitForTimeout(150);
          } else {
            // タブレットはドックで「指標」を開いて測り、「ポジ」で戻す
            await page.click('.dock button[data-panel="metrics"]');
            await page.waitForTimeout(150);
            await report(page, `${tag} metrics`, w, h, `${name}-metrics`);
            await readoutCheck(page, `${tag} metrics ${w}x${h}`, want);
            await metricsCheck(page, `${tag} metrics ${w}x${h}`);
            await breakdownOpenCheck(page, `${tag} metrics`, w, h, `${name}-metrics-kv`, want);
            // 市場（#85）: ドックで「板」「スマイル」（選択なし / あり）
            for (const view of ['board', 'smile']) {
              await page.click(`.dock button[data-panel="${view}"]`);
              await page.waitForTimeout(150);
              await report(page, `${tag} ${view}`, w, h, `${name}-${view}`);
              await readoutCheck(page, `${tag} ${view} ${w}x${h}`, want);
              await marketCheck(page, `${tag} ${view} ${w}x${h}`, { cols: marketCols(w) });
              if (view === 'smile') {
                await smilePick(page, true);
                await report(page, `${tag} smile 選択あり`, w, h, `${name}-smile-pick`);
                await marketCheck(page, `${tag} smile 選択あり ${w}x${h}`, {});
                await smilePick(page, false);
              }
            }
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
    // 掛け金の足・円固定の足（#107 AC-3）
    await subtitleAll();
    console.log(
      `副題の検査: ${subStats.pass} / ${subStats.total} 状態で pass、切れ ${subStats.cut} 件（うち円固定 ${subStats.cutYen} 件。すべて全文のボタンの中）`,
    );
    // 市場の追加の状態（1200 / 1280 / 1800・322 行の板・字幅 2 通り。#85）
    await marketSweep();
    console.log(
      `市場の検査: ${marketStats.pass} / ${marketStats.total} 状態で pass${marketStats.skip ? `（実機相当の字幅は ${marketStats.skip} 幅で skip）` : ''}`,
    );
  }
}

// ---- 市場（#85）: 板の列の数・切れ・スマイルの描画域の高さ
/** 板の列の数の期待（section.board の幅で 9 / 7 / 5。docs/ui-redesign.md §2.4） */
const marketCols = (w) => (w >= 1800 ? 9 : w >= 1440 ? 7 : 5);
/** 市場の検査だけを判定する追加の幅（ページ全体の縦・横・折り返しは記録だけ） */
const MARKET_SIZES = [
  [1200, 800],
  [1280, 800],
  [1800, 1000],
];
const marketStats = { pass: 0, total: 0, skip: 0 };

/**
 * 見えている板・スマイルの (a) 板の列の数（表示中の表の thead th）、(b) 見出し行・道具の行・見えている行のセル /
 * ボタン・脚注（F / ATM / SQ）・スマイルの道具の行・操作行・凡例が切れていない（scrollWidth ≤ clientWidth）、
 * 表の枠 .board-wrap が横にはみ出していない、(c) スマイルの描画域の高さ（want.smileMin 以上）
 */
async function marketCheck(page, label, want) {
  const r = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const name = (el) =>
      `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim().replace(/\s+/g, '.')}「${(el.textContent ?? '').trim().slice(0, 16)}」${el.scrollWidth}/${el.clientWidth}`;
    const bad = [];
    let n = 0;
    const test = (els) => {
      for (const el of els) {
        if (!vis(el)) continue;
        n++;
        if (el.scrollWidth > el.clientWidth) bad.push(name(el));
      }
    };
    const out = { board: null, smile: null };
    const board = document.querySelector('section.board');
    if (vis(board)) {
      const wrap = board.querySelector('.board-month:not(.inactive) .board-wrap:not(.side-hidden)');
      test(
        board.querySelectorAll(
          '.panel-head > h2, .panel-head .seg > button, .board-tools .row, .board-tools .seg > button, .board-tools .chip, .board-tools .btn, .board-foot, .board-foot > .f, .board-foot > .atm, .board-foot > .sq',
        ),
      );
      let rows = 0;
      if (wrap) {
        test([wrap]);
        const wr = wrap.getBoundingClientRect();
        for (const tr of wrap.querySelectorAll('tbody tr')) {
          rows++;
          const rr = tr.getBoundingClientRect();
          if (rr.bottom < wr.top || rr.top > wr.bottom) continue;
          test(tr.querySelectorAll('td, th, button, .legbadge'));
        }
      }
      out.board = { cols: wrap ? wrap.querySelectorAll('thead th').length : 0, rows };
    }
    const smile = document.querySelector('section.smile');
    if (vis(smile)) {
      test(
        smile.querySelectorAll(
          '.panel-head > h2, .panel-head .seg > button, .smile-tools, .smile-tools .seg > button, .smile-act, .smile-act > *, .smile-legend, .smile-legend > span',
        ),
      );
      const plot = smile.querySelector('.smile-month:not(.inactive) .smile-wrap');
      // 凡例の項目（レビュー S2）: 隠さない = 見えている項目が 7（シナリオ ATM があれば 8）で、どれも凡例の箱の中
      const lg = smile.querySelector('.smile-legend');
      const lb = lg?.getBoundingClientRect();
      const items = [...(lg?.children ?? [])];
      const shown = items.filter((el) => {
        const b = el.getBoundingClientRect();
        return !!lb && b.width > 0 && b.left >= lb.left - 0.5 && b.right <= lb.right + 0.5;
      });
      out.smile = {
        height: plot ? Math.round(plot.getBoundingClientRect().height) : 0,
        picked: !!smile.querySelector('.smile-act .k'),
        legend: shown.length,
        legendWant: lg?.querySelector(':scope > .atm2') ? 8 : 7,
      };
    }
    return { ...out, n, bad };
  });
  if (!r.board && !r.smile) return true;
  const bad = [...r.bad];
  if (r.board && want.cols !== undefined && r.board.cols !== want.cols) {
    bad.push(`列 ${r.board.cols}（${want.cols} のはず）`);
  }
  if (r.board && r.board.rows === 0) bad.push('行が無い');
  if (r.smile && r.smile.legend !== r.smile.legendWant) {
    bad.push(`凡例の項目 ${r.smile.legend}（${r.smile.legendWant} のはず）`);
  }
  if (r.smile && want.smileMin && r.smile.height < want.smileMin) {
    bad.push(`描画域の高さ ${r.smile.height}px（${want.smileMin}px 以上のはず）`);
  }
  const ok = r.n > 0 && bad.length === 0;
  marketStats.total++;
  if (ok) marketStats.pass++;
  else failed = true;
  const what = r.board
    ? `板 ${r.board.cols} 列・${r.board.rows} 行`
    : `スマイル 高さ ${r.smile.height}px・凡例 ${r.smile.legend} 項目${r.smile.picked ? '・選択あり' : ''}`;
  console.log(`${label}: 市場 ${what}・${r.n} 個 ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`);
  return ok;
}

/** スマイルで選択を作る（描画域にフォーカスして . = 市場 ATM から）/ 消す（×） */
async function smilePick(page, on) {
  if (on) {
    const plot = page.locator('section.smile .smile-month:not(.inactive) .smile-wrap');
    await plot.focus();
    await page.keyboard.press('.');
  } else {
    const x = page.locator('section.smile .smile-act button[aria-label="選択を消す"]');
    if ((await x.count()) > 0) await x.click();
  }
  await page.waitForTimeout(120);
}

/** 市場の列（section.board / .smile）の中の折り返し（measure と同じ規則） */
function marketWraps(page) {
  return page.evaluate(() => {
    const wraps = [];
    for (const el of document.querySelectorAll('section.board *, section.smile *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0)
        continue;
      const txt = [...el.childNodes]
        .filter((c) => c.nodeType === 3)
        .map((c) => c.textContent)
        .join('')
        .trim();
      if (!txt || txt.length > 40) continue;
      if (['P', 'LI', 'DD', 'TEXTAREA', 'OPTION'].includes(el.tagName)) continue;
      if (el.closest('.help-popover,[role="tooltip"],details:not([open])')) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set(
        [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
      );
      if (lines.size > 1) wraps.push(`${el.tagName}.${el.getAttribute('class') ?? ''}「${txt}」`);
    }
    return wraps;
  });
}

/** 合成の 322 行 × 2 限月の板（scripts/synthBoard.ts の buildWideChainJson。ファイルを書かない） */
let wideBoardText = null;
async function wideBoard() {
  if (wideBoardText) return wideBoardText;
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport(join(root, 'scripts', 'synthBoard.ts'), {
    configFile: false,
    root,
    logLevel: 'error',
  });
  wideBoardText = module.serializeChainJson(module.buildWideChainJson());
  return wideBoardText;
}
/** dev の板の応答（/fixtures/latest.json）を 322 行の板に差し替える */
async function routeWide(target) {
  const body = await wideBoard();
  await target.route('**/fixtures/latest.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body }),
  );
}

/** 実機相当の等幅（Menlo / SF Mono と同じ 0.6em の DejaVu Sans Mono）が使えるか */
async function realMonoAvailable(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return false;
    c.font = '20px "DejaVu Sans Mono", serif';
    const a = c.measureText('0000000000').width;
    const b = c.measureText('iiiiiiiiii').width;
    return Math.abs(a - b) < 0.5 && Math.abs(a / 200 - 0.602) < 0.02;
  });
}
/** --mono を実機相当の字幅に（CSSOM。検査だけ。製品のコードには入らない） */
async function useRealMono(page) {
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--mono', '"DejaVu Sans Mono", monospace'),
  );
  await page.waitForTimeout(300);
}

/**
 * 市場の検査の追加の状態（既定の 4 幅のほか）: (1) 1200×800・1280×800・1800×1000 の板 / スマイル（市場の検査と市場の列の中の
 * 折り返しを判定、ページ全体の縦・横・折り返しは記録）、(2) 322 行の板 × 既定の字幅 / 実機相当の字幅 × 全 7 幅の板 / スマイル
 * （選択なし / あり）。スクリーンショットは 1800 と 322 行の 390 / 1800
 */
async function marketSweep() {
  const sizes = [...SIZES, ...MARKET_SIZES].sort((a, b) => a[0] - b[0]);
  for (const [w, h] of MARKET_SIZES) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const tag = `next ${theme} 市場`;
      for (const view of ['board', 'smile']) {
        if (view === 'smile') {
          await page.click('section.board .panel-head .seg button:has-text("スマイル")');
          await page.waitForTimeout(200);
        }
        const m = await measure(page);
        const mw = await marketWraps(page);
        const lbl = `${tag} ${view} ${w}x${h}`;
        console.log(
          `${lbl}: （記録）ページ 縦 ${m.v}px 横 ${m.h}px 折り返し ${m.wraps.length} 件・市場の列の中の折り返し ${mw.length} 件${mw.length ? '  ← NG' : ''}`,
        );
        for (const s of mw.slice(0, 10)) console.log(`    ${s}`);
        if (mw.length) failed = true;
        await marketCheck(page, lbl, { cols: marketCols(w) });
        if (view === 'smile') {
          await smilePick(page, true);
          await marketCheck(page, `${lbl} 選択あり`, {});
          if (shotsDir)
            await page.screenshot({
              path: join(shotsDir, `next-${w}x${h}-${theme}-smile-pick.png`),
            });
          await smilePick(page, false);
        } else if (shotsDir) {
          await page.screenshot({ path: join(shotsDir, `next-${w}x${h}-${theme}-board.png`) });
        }
      }
      await ctx.close();
    }
  }
  // 322 行の板 × 字幅 2 通り
  for (const mono of ['既定の字幅', '実機相当の字幅']) {
    for (const [w, h] of sizes) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') },
      );
      await routeWide(ctx);
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      if (mono !== '既定の字幅') {
        if (!(await realMonoAvailable(page))) {
          marketStats.skip++;
          console.log(`322 行 ${mono} ${w}x${h}: DejaVu Sans Mono が無いので skip`);
          await ctx.close();
          continue;
        }
        await useRealMono(page);
      }
      const tag = `next dark 322 行 ${mono}`;
      const phone = w <= PHONE_MAX;
      const tablet = !phone && w < 1200;
      for (const view of ['board', 'smile']) {
        const sheets = phone ? ['peek', 'full'] : [null];
        for (const sheet of sheets) {
          if (phone) await setShell(page, view, sheet);
          else if (tablet) {
            await page.click(`.dock button[data-panel="${view}"]`);
            await page.waitForTimeout(150);
          } else if (view === 'smile') {
            // PC: 市場の Seg で板 → スマイル
            await page.click('section.board .panel-head .seg button:has-text("スマイル")');
            await page.waitForTimeout(150);
          }
          await page.waitForTimeout(250);
          const lbl = `${tag} ${view}${sheet ? `/${sheet}` : ''} ${w}x${h}`;
          await marketCheck(page, lbl, {
            cols: marketCols(w),
            smileMin: w === 360 && sheet === 'peek' ? 140 : null,
          });
          const shotName = `next-${w}x${h}-dark-wide-${mono === '既定の字幅' ? 'default' : 'real'}-${view}${sheet ? `-${sheet}` : ''}`;
          if (view === 'smile') {
            await smilePick(page, true);
            await marketCheck(page, `${lbl} 選択あり`, {
              smileMin: w === 360 && sheet === 'peek' ? 140 : null,
            });
            if (shotsDir) await page.screenshot({ path: join(shotsDir, `${shotName}-pick.png`) });
            await smilePick(page, false);
          } else if (shotsDir && (w === 390 || w === 1800 || w === 1440)) {
            await page.screenshot({ path: join(shotsDir, `${shotName}.png`) });
          }
        }
      }
      await ctx.close();
    }
  }
}

// ---- 副題の全文（#107）: 掛け金の足（買い 2 本）と円固定の足（売り 5 枚）。タブ A の足から作る（架空の建値）
const tabA = fixture.tabs[0];
const legsOf = (side, qty) =>
  tabA.position.legs.map((l) => ({ ...l, leg: { ...l.leg, side, qty } }));
const withLegs = (legs, ui = fixture.ui) =>
  JSON.stringify({
    ...fixture,
    ui,
    active: 0,
    tabs: [{ ...tabA, position: { ...tabA.position, legs } }],
  });
/** 買い 2 本（put 63,500 / call 71,000 を 1 枚ずつ。建値 640 / 520）= 掛け金のタイル */
const buyTwo = withLegs(legsOf('buy', 1));
/** 売り 5 枚ずつ・金額の単位を円に固定（桁が増える） */
const sellFiveYen = withLegs(legsOf('sell', 5), { ...fixture.ui, metrics_unit: 'yen' });

/**
 * 副題の検査の追加の状態（#107 AC-3）: 掛け金の足 × 4 幅 × 2 テーマ（千円・自動。切れ 0 が条件）と
 * 円固定の足 × 4 幅 × ダーク（件数だけ）。スマホは「指標」peek と full、900 はドックで指標、1440 はそのまま
 */
async function subtitleAll() {
  const runs = [
    ['掛け金', buyTwo, ['dark', 'light'], true],
    ['円固定', sellFiveYen, ['dark'], false],
  ];
  for (const [name, ws, themes, strict] of runs) {
    for (const [w, h] of SIZES) {
      for (const theme of themes) {
        const ctx = await newContext(
          { width: w, height: h },
          { [WORKSPACE_KEY]: ws, [PREFS_KEY]: prefsText(theme) },
        );
        const page = await ctx.newPage();
        await page.goto(pageUrl('next'));
        await waitReady(page, 'next');
        const tag = `next ${theme} ${name}`;
        const shot = `next-${w}x${h}-${theme}-sub-${strict ? 'stake' : 'yen'}`;
        const states = w <= PHONE_MAX ? ['peek', 'full'] : w >= 1200 ? ['pc'] : ['dock'];
        for (const st of states) {
          if (st === 'peek' || st === 'full') {
            if (!(await setShell(page, 'metrics', st))) {
              failed = true;
              console.log(`${tag} metrics/${st} ${w}x${h}: 画面の状態を作れない  ← NG`);
              continue;
            }
          } else if (st === 'dock') {
            await page.click('.dock button[data-panel="metrics"]');
          }
          await page.waitForTimeout(150);
          const lbl = `${tag} ${st}`;
          const want = w <= PHONE_MAX ? 3 : w >= 1200 ? 6 : 5;
          if (strict) {
            await report(page, lbl, w, h, `${shot}-${st}`);
            await readoutCheck(page, `${lbl} ${w}x${h}`, want);
            await metricsCheck(page, `${lbl} ${w}x${h}`);
          } else {
            if (shotsDir) await page.screenshot({ path: join(shotsDir, `${shot}-${st}.png`) });
            await subCheck(page, `${lbl} ${w}x${h}`, 'tiles', false, true);
            await subCheck(page, `${lbl} ${w}x${h}`, 'readout', false, true);
          }
        }
        await ctx.close();
      }
    }
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
  // #107 副題の全文のポップオーバーの手順（AC-4）
  for (const vp of [phone, pc]) await subtitleFlows(vp);
  // #85 市場の手順（AC-9・AC-10・AC-12）: 5 列（390）・7 列（1440）・9 列（1800）
  const wide = { width: 1800, height: 1000 };
  for (const vp of [phone, pc, wide]) await marketFlows(vp);
  for (const vp of [phone, pc, wide]) await marketWideFlows(vp);
  await marketPersistFlow();
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
  window.__loafAt = [];
  window.__checkRanges = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__loaf.push(e.duration);
        window.__loafAt.push([e.startTime, e.startTime + e.duration]);
      }
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

// ---- 副題の全文のポップオーバーの手順（#107 AC-4）
/** 開いているポップオーバーのボタン（タイル・読み取り）の数 */
const openPops = (page) =>
  page.evaluate(
    () =>
      document.querySelectorAll('.tile-btn[aria-expanded="true"], .ro-btn[aria-expanded="true"]')
        .length,
  );

async function subtitleFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: buyTwo });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (phoneSize) {
    const ok = await setShell(page, 'metrics', 'peek');
    check(`#107 ${tag} ドックで「指標」を開く（peek）`, ok);
  }
  const M = 'section.metrics';
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = await page.evaluate(() => window.__loaf.length);

  // 比較の正: 内訳を開いた行（見出し → 値）
  const toggle = page.locator(`${M} .mx-toggle`);
  await toggle.click();
  await page.waitForTimeout(150);
  const kv = await page.evaluate(
    (m) =>
      [...document.querySelectorAll(`${m} .kv-grid > .k`)].map((k) => [
        k.textContent,
        k.nextElementSibling?.textContent ?? '',
      ]),
    M,
  );
  await toggle.click();
  await page.waitForTimeout(100);

  /** そのボタンの全文の行・見た目の値・矩形・ページのスクロール */
  const popInfo = (btnSel, hostSel) =>
    page.evaluate(
      ({ btnSel, hostSel }) => {
        const btn = document.querySelector(btnSel);
        const wrap = btn?.closest('.pop-wrap');
        const pop = wrap?.querySelector('.popover');
        if (!btn || !pop) return null;
        const rows = [];
        const cells = [...pop.querySelectorAll('.full > span')];
        for (let i = 0; i + 1 < cells.length; i += 2) {
          rows.push([cells[i].textContent, cells[i + 1].textContent]);
        }
        const v = btn.querySelector('.v');
        const vText = [
          v?.querySelector(':scope > span')?.textContent ?? '',
          v?.querySelector('small')?.textContent ?? '',
        ]
          .filter(Boolean)
          .join(' ');
        const r = pop.getBoundingClientRect();
        const h = btn.closest(hostSel)?.getBoundingClientRect();
        const inWin =
          r.left >= 0 &&
          r.top >= 0 &&
          r.right <= window.innerWidth &&
          r.bottom <= window.innerHeight;
        const inHost =
          !!h &&
          r.left >= h.left - 0.5 &&
          r.top >= h.top - 0.5 &&
          r.right <= h.right + 0.5 &&
          r.bottom <= h.bottom + 0.5;
        return {
          expanded: btn.getAttribute('aria-expanded'),
          hidden: pop.hidden,
          up: pop.classList.contains('up'),
          rows,
          k: btn.querySelector('.k')?.textContent ?? '',
          vText,
          inWin,
          inHost,
          rect: `${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)}`,
        };
      },
      { btnSel, hostSel },
    );

  // (a)(f) 各タイルをタップ → 開く・中身が全文（内訳・見た目の値と一致）・窓と .panel-body の中・縦・横 0px
  const keys = ['maxProfit', 'maxLoss', 'bep', 'premium', 'scenario', 'greeks'];
  const tileBtn = (k) => `${M} .tile[data-tile="${k}"] .tile-btn`;
  const kvHas = (v) => kv.some(([, bv]) => bv.includes(v));
  for (const k of keys) {
    await page.click(tileBtn(k));
    await page.waitForTimeout(120);
    const i = await popInfo(tileBtn(k), '.panel-body');
    const m = await measure(page);
    if (!i) {
      check(`#107 AC-4(a) ${tag} タイル ${k} のポップオーバー`, false, '無い');
      continue;
    }
    const first = i.rows[0] ?? ['', ''];
    let content =
      i.rows.length > 0 &&
      i.rows.every(([rk, rv]) => rv !== '' && (rk === 'X' || rk === 'd' || kvHas(rv)));
    if (k === 'greeks') {
      const want = kv.filter(([bk]) => ['Δ', 'Γ', 'Θ', 'V'].includes(bk));
      content = JSON.stringify(i.rows) === JSON.stringify(want);
    } else {
      content = content && first[0].startsWith(i.k) && first[1] === i.vText;
    }
    if (k === 'premium') {
      const fee = kv.find(([bk]) => bk === '手数料の合計');
      content =
        content && !!fee && i.rows.some(([rk, rv]) => rk === '手数料の合計' && rv === fee[1]);
    }
    check(
      `#107 AC-4(a) ${tag} タイル ${k} をタップ → 全文（${i.rows.length} 行）が表示モデルの全文と一致`,
      i.expanded === 'true' && !i.hidden && content,
      i.rows.map((r) => r.join(' ')).join(' / '),
    );
    check(
      `#107 AC-4(f) ${tag} タイル ${k} の全文が窓と .panel-body の中・ページの縦・横 0px`,
      i.inWin && i.inHost && m.v === 0 && m.h === 0,
      `${i.rect} 縦 ${m.v} 横 ${m.h}`,
    );
    // 開いた全文は下のタイルに重なる（押しても閉じない）ので Esc で閉じて次へ
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  // (b) Esc で閉じてそのタイルのボタンへフォーカス
  {
    const k = 'premium';
    await page.click(tileBtn(k));
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const r = await page.evaluate(
      (sel) => ({
        expanded: document.querySelector(sel)?.getAttribute('aria-expanded'),
        focus: document.activeElement === document.querySelector(sel),
      }),
      tileBtn(k),
    );
    check(
      `#107 AC-4(b) ${tag} Esc で閉じてタイルのボタンへフォーカス`,
      r.expanded === 'false' && r.focus,
    );
  }
  // (c) 外側（パネルの見出し）のタップで閉じる
  {
    await page.click(tileBtn('maxLoss'));
    await page.waitForTimeout(100);
    const before = await openPops(page);
    await page.click(`${M} .panel-head h2`);
    await page.waitForTimeout(100);
    check(`#107 AC-4(c) ${tag} 外側のタップで閉じる`, before === 1 && (await openPops(page)) === 0);
  }
  // (d) 別のタイルのタップで前のものが閉じる（同時に 1 つ）
  {
    await page.click(tileBtn('maxProfit'));
    await page.waitForTimeout(100);
    await page.click(tileBtn('greeks'));
    await page.waitForTimeout(100);
    const r = await page.evaluate(
      ({ a, b }) => [
        document.querySelector(a)?.getAttribute('aria-expanded'),
        document.querySelector(b)?.getAttribute('aria-expanded'),
      ],
      { a: tileBtn('maxProfit'), b: tileBtn('greeks') },
    );
    check(
      `#107 AC-4(d) ${tag} 別のタイルのタップで前のものが閉じる（開いているのは 1 つ）`,
      r[0] === 'false' && r[1] === 'true' && (await openPops(page)) === 1,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  // (e) キーボード: パネルの ⓘ から Tab → 最初のタイル、Enter で開く、Space で閉じる
  {
    await page.focus(`${M} .panel-head .hintbtn`);
    await page.keyboard.press('Tab');
    const onTile = await page.evaluate(
      (sel) => document.activeElement === document.querySelector(sel),
      tileBtn('maxProfit'),
    );
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const opened = (await page.getAttribute(tileBtn('maxProfit'), 'aria-expanded')) === 'true';
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    const closed = (await page.getAttribute(tileBtn('maxProfit'), 'aria-expanded')) === 'false';
    check(
      `#107 AC-4(e) ${tag} Tab → タイル、Enter で開く、Space で閉じる`,
      onTile && opened && closed,
    );
  }
  // (g) 読み取りの date: 全文に Δσ、上に開いて .stage-main の中、ハンドルのドラッグ（pointerdown）で閉じる
  {
    const ro = '.readout .ro[data-ro="date"] .ro-btn';
    await page.click(ro);
    await page.waitForTimeout(120);
    const i = await popInfo(ro, '.stage-main');
    const m = await measure(page);
    check(
      `#107 AC-4(g) ${tag} 読み取りの損益をタップ → 全文に Δσ +2.0 pt・上に開いて舞台の中・縦・横 0px`,
      !!i &&
        i.expanded === 'true' &&
        i.up &&
        i.inWin &&
        i.inHost &&
        m.v === 0 &&
        m.h === 0 &&
        i.rows.some(([k, v]) => k === 'Δσ' && v === '+2.0 pt') &&
        i.rows[0]?.[1] === i.vText,
      i ? `${i.rows.map((r) => r.join(' ')).join(' / ')}・${i.rect}` : '無い',
    );
    const hb = await page.locator('.chart .handle-hit').first().boundingBox();
    if (hb) {
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(100);
    }
    check(
      `#107 AC-4(g) ${tag} 舞台のハンドルの pointerdown で閉じる`,
      !!hb && (await openPops(page)) === 0,
    );
  }
  // (h) 開閉の間の Long Animation Frame（50ms 超）
  {
    // 検査の measure（ページ全体の要素を走査する。#85 で板の 322 行が入ると 50ms を超えうる）のフレームは除く
    const n = await page.evaluate((i) => {
      const self = window.__checkRanges ?? [];
      return window.__loaf
        .map((d, j) => [d, window.__loafAt[j]])
        .slice(i)
        .filter(([d, at]) => d > 50 && !self.some(([a, b]) => at[0] < b && a < at[1])).length;
    }, loafMark);
    check(
      `#107 AC-4(h) ${tag} 全文の開閉の間の長いフレーム 0 件`,
      loafOk && n === 0,
      loafOk ? `${n} 件` : '未対応',
    );
  }
  await ctx.close();
}

// ---- 市場の手順（#85 AC-9・AC-10・AC-12）
/** ui/view/board.ts のジャンプの規則と data/ の正規化（Vite のモジュールランナーで読む。期待値を画面と別に求める） */
let boardRules = null;
async function rules() {
  if (boardRules) return boardRules;
  const { runnerImport } = await import('vite');
  const load = async (p) =>
    (await runnerImport(join(root, p), { configFile: false, root, logLevel: 'error' })).module;
  const data = await load('data/index.ts');
  const view = await load('ui/view/board.ts');
  boardRules = { normalizeChain: data.normalizeChain, ...view };
  return boardRules;
}
const fmtK = (k) => new Intl.NumberFormat('en-US').format(k);
const twoFrames = (page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))),
  );
const ACTIVE_WRAP = 'section.board .board-month:not(.inactive) .board-wrap:not(.side-hidden)';

async function marketFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const R = await rules();
  const chain = R.normalizeChain(board);
  if (phoneSize)
    check(`#85 ${tag} ドックで「板」を開く（peek）`, await setShell(page, 'board', 'peek'));
  const cols = await page.locator(`${ACTIVE_WRAP} thead th`).count();
  check(
    `#85 ${tag} 板の列の数 ${cols}`,
    cols === marketCols(vp.width),
    `${marketCols(vp.width)} のはず`,
  );

  const counts = () =>
    page.evaluate(() => ({
      rows: document.querySelectorAll('section.positions li.leg').length,
      marks: document.querySelectorAll('.chart .legmark').length,
      sel: document.querySelector('.chart .legmark.sel')?.getAttribute('data-leg-id') ?? null,
      dock:
        document.querySelector('.dock button[data-panel="positions"] .cnt')?.textContent ?? null,
      toast: [...document.querySelectorAll('.toast .txt')].map((t) => t.textContent),
      panel: document.querySelector('.layout')?.getAttribute('data-panel'),
      market: document.querySelector('.layout')?.getAttribute('data-market'),
      boardShown: (document.querySelector('section.board')?.getClientRects().length ?? 0) > 0,
    }));
  const pageScroll = () =>
    page.evaluate(() => ({
      doc: document.scrollingElement?.scrollTop ?? 0,
      body: document.body.scrollTop,
      sec: Math.round(document.querySelector('section.board')?.getBoundingClientRect().top ?? -1),
    }));
  const info = () =>
    page.evaluate((sel) => {
      const wrap = document.querySelector(sel);
      const atm = wrap?.querySelector('tr.atm')?.getAttribute('data-k');
      const foot = document.querySelector('section.board .board-foot > .atm')?.textContent ?? '';
      const month = document
        .querySelector('section.board .board-month:not(.inactive)')
        ?.getAttribute('data-month');
      const target = document.querySelector(
        'section.board [aria-label="対象の種別"] button[aria-pressed="true"]',
      )?.textContent;
      return {
        atm: atm ? Number(atm) : null,
        basis: /（([AB])）/.exec(foot)?.[1] ?? 'B',
        month,
        target,
      };
    }, ACTIVE_WRAP);
  /** その K の行を枠の中央に置いた（スクロールした）うえで、ボタンを押す */
  const centerRow = (k) =>
    page.evaluate(
      ({ sel, k }) => {
        const wrap = document.querySelector(sel);
        const tr = wrap?.querySelector(`tr[data-k="${k}"]`);
        if (!wrap || !tr) return false;
        const r = tr.getBoundingClientRect();
        const b = wrap.getBoundingClientRect();
        wrap.scrollTop += r.top - b.top - wrap.clientHeight / 2;
        return true;
      },
      { sel: ACTIVE_WRAP, k },
    );
  /** 行が枠の中央 ±1 行（端で中央に来られない行は枠の中に見えている） */
  const centered = (k) =>
    page.evaluate(
      ({ sel, k }) => {
        const wrap = document.querySelector(sel);
        const tr = wrap?.querySelector(`tr[data-k="${k}"]`);
        if (!wrap || !tr) return { ok: false, why: '行が無い' };
        const head = wrap.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        const b = wrap.getBoundingClientRect();
        const r = tr.getBoundingClientRect();
        const mid = b.top + head + (wrap.clientHeight - head) / 2;
        const off = r.top + r.height / 2 - mid;
        const atEdge =
          wrap.scrollTop <= 0 || wrap.scrollTop >= wrap.scrollHeight - wrap.clientHeight - 1;
        const inside = r.top >= b.top + head - 1 && r.bottom <= b.top + wrap.clientHeight + 1;
        return {
          ok: Math.abs(off) <= r.height + 1 || (atEdge && inside),
          why: `中央からの差 ${Math.round(off)}px`,
          hit: tr.classList.contains('hit'),
        };
      },
      { sel: ACTIVE_WRAP, k },
    );

  const start = await counts();
  const i0 = await info();
  const month = chain.months.find((m) => m.id === i0.month);
  const atm = i0.atm;
  // (a) ATM − 2,000 の put の bid
  const k = (atm ?? 0) - 2000;
  if (phoneSize && i0.target !== 'put')
    await page.click('section.board [aria-label="対象の種別"] button:has-text("put")');
  await centerRow(k);
  const bidBtn = page.locator(`${ACTIVE_WRAP} button[aria-label^="${fmtK(k)} put bid "]`);
  const bidText = (await bidBtn.textContent())?.trim() ?? '';
  await bidBtn.click();
  await twoFrames(page);
  const a = await counts();
  const badgeA = await page
    .locator(`${ACTIVE_WRAP} tr[data-k="${k}"] .legbadge.sell`)
    .allTextContents();
  check(
    `#85 AC-9(a) ${tag} ATM−2,000（${fmtK(k)}）の put の bid: 次の描画で 行 +1・マーカー +1（その足が .sel）・バッジ 売1・トースト`,
    a.rows === start.rows + 1 &&
      a.marks === start.marks + 1 &&
      a.sel !== null &&
      a.sel !== start.sel &&
      badgeA.includes('売1') &&
      a.toast.includes(`売 P ${fmtK(k)} @${bidText} を追加`) &&
      (!phoneSize || Number(a.dock) === start.rows + 1),
    `行 ${start.rows}→${a.rows}・マーカー ${start.marks}→${a.marks}・選択 ${a.sel}・バッジ ${badgeA.join(' ')}・ドック ${a.dock}・${a.toast.join(' / ')}`,
  );
  check(
    `#85 AC-9(a) ${tag} 市場のパネルは開いたまま`,
    a.boardShown && (phoneSize ? a.panel === 'board' : a.market === 'board'),
    `${a.panel} / ${a.market}`,
  );
  // (b) 同じ K の call の ask（5 列は call に替えて）
  if (cols === 5) {
    await page.click('section.board [aria-label="対象の種別"] button:has-text("call")');
    await twoFrames(page);
  }
  await centerRow(k);
  const askBtn = page.locator(`${ACTIVE_WRAP} button[aria-label^="${fmtK(k)} call ask "]`);
  const askText = (await askBtn.textContent())?.trim() ?? '';
  await askBtn.click();
  await twoFrames(page);
  const b = await counts();
  check(
    `#85 AC-9(b) ${tag} 同じ K の call の ask で 買 C`,
    b.rows === a.rows + 1 &&
      b.marks === a.marks + 1 &&
      b.toast.includes(`買 C ${fmtK(k)} @${askText} を追加`),
    `行 ${b.rows}・${b.toast.join(' / ')}`,
  );
  // (c) [元に戻す]
  await page
    .locator('.toast', { hasText: `買 C ${fmtK(k)}` })
    .locator('button', { hasText: '元に戻す' })
    .click();
  await twoFrames(page);
  const c = await counts();
  const badgeC = await page.locator(`${ACTIVE_WRAP} tr[data-k="${k}"] .legbadge.buy`).count();
  check(
    `#85 AC-9(c) ${tag} トーストの [元に戻す] で足が消える（行・マーカー・バッジが元の数）`,
    c.rows === a.rows && c.marks === a.marks && badgeC === 0 && (!phoneSize || c.dock === a.dock),
    `行 ${c.rows}・マーカー ${c.marks}・買のバッジ ${badgeC}`,
  );
  if (cols === 5) {
    await page.click('section.board [aria-label="対象の種別"] button:has-text("put")');
    await twoFrames(page);
  }
  // レビュー S3: 同じ K に両側の売り・買い（バッジ 4 つ）でも P bid のボタンが押せる（バッジに当たらない）
  if (cols !== 5 && atm !== null) {
    await centerRow(atm);
    for (const lbl of ['call bid', 'call ask', 'put bid', 'put ask']) {
      await page.locator(`${ACTIVE_WRAP} button[aria-label^="${fmtK(atm)} ${lbl} "]`).click();
      await twoFrames(page);
    }
    const before = await counts();
    const geo = await page.evaluate(
      ({ sel, k }) => {
        const tr = document.querySelector(sel)?.querySelector(`tr[data-k="${k}"]`);
        const btn = [...(tr?.querySelectorAll('button') ?? [])].find((b) =>
          b.getAttribute('aria-label')?.includes(' put bid '),
        );
        const badges = [...(tr?.querySelectorAll('.legbadge') ?? [])].map((e) =>
          e.getBoundingClientRect(),
        );
        const b = btn?.getBoundingClientRect();
        if (!b) return null;
        // バッジと重なる所（無ければボタンの左下）を押す
        const over = badges.find((r) => r.right > b.left && r.left < b.right);
        const x = over
          ? (Math.max(over.left, b.left) + Math.min(over.right, b.right)) / 2
          : b.left + 3;
        const y = over ? (over.top + over.bottom) / 2 : b.bottom - 3;
        return { x, y, overlap: !!over, n: badges.length };
      },
      { sel: ACTIVE_WRAP, k: atm },
    );
    if (geo) await page.mouse.click(geo.x, geo.y);
    await twoFrames(page);
    const after = await counts();
    check(
      `#85 レビュー S3 ${tag} バッジ ${geo?.n ?? 0} つの行の P bid を${geo?.overlap ? 'バッジと重なる所で' : ''}押すと足が入る`,
      !!geo &&
        geo.n >= 4 &&
        after.rows === before.rows + 1 &&
        after.toast.some((t) => t?.startsWith(`売 P ${fmtK(atm)} `)),
      `${before.rows} → ${after.rows}`,
    );
  }

  // (d) [ATM]・OTM 20%・|Δ| .10: その K が枠の中央 ±1 行、強調 0.9 秒（±0.3）、ページ・シートは動かない
  if (month) {
    const rows = R.boardRows(chain, month);
    const x0 = R.referencePrice(month, i0.basis);
    const jumps = [
      ['ATM', 'button[aria-label="ATM へ"]', R.atmStrike(month, i0.basis)],
      ['OTM 20%', 'button[aria-label="OTM 20% へ"]', R.jumpToOtm(rows, 'put', x0, 0.2)],
      ['|Δ| .10', 'button[aria-label="|Δ| 0.10 へ"]', R.jumpToDelta(rows, 'put', 0.1)],
    ];
    for (const [name, sel, want] of jumps) {
      // いったん表の先頭へ（ジャンプで動くことを確かめる）
      await page.evaluate((s) => {
        const w = document.querySelector(s);
        if (w) w.scrollTop = 0;
      }, ACTIVE_WRAP);
      const before = await pageScroll();
      await page.click(`section.board .board-tools ${sel}`);
      const t0 = Date.now();
      await twoFrames(page);
      const at = await centered(want);
      let off = null;
      while (Date.now() - t0 < 2000) {
        const st = await centered(want);
        if (!st.hit) {
          off = Date.now() - t0;
          break;
        }
        await page.waitForTimeout(25);
      }
      const after = await pageScroll();
      check(
        `#85 AC-9(d) ${tag} ${name} → ${fmtK(want)}: 枠の中央 ±1 行・強調が付いて ${off ?? '—'}ms で外れる・ページ / シートは動かない`,
        at.ok &&
          at.hit &&
          off !== null &&
          off >= 600 &&
          off <= 1200 &&
          JSON.stringify(before) === JSON.stringify(after),
        `${at.why}・${JSON.stringify(before)} → ${JSON.stringify(after)}`,
      );
    }
  }

  // (e) ask ≤ 50 円: 見えている行の ask がすべて 50 以下、絞り込み中に [ATM] で外れて ATM へ
  {
    const chip = page.locator('section.board .board-tools .chip:has-text("ask ≤ 50 円")');
    await chip.click();
    await twoFrames(page);
    const asks = await page.evaluate((s) => {
      const wrap = document.querySelector(s);
      return [...(wrap?.querySelectorAll('button[aria-label*=" put ask "]') ?? [])].map(
        (b) => b.textContent,
      );
    }, ACTIVE_WRAP);
    const nums = asks.map((t) => Number((t ?? '').replace(/,/g, '')));
    check(
      `#85 AC-9(e) ${tag} ask ≤ 50 円: 行の put の ask がすべて 50 以下（${nums.length} 行）`,
      (await chip.getAttribute('aria-pressed')) === 'true' &&
        nums.length > 0 &&
        nums.every((v) => Number.isFinite(v) && v <= 50),
      nums.slice(0, 8).join(' '),
    );
    await page.click('section.board .board-tools button[aria-label="ATM へ"]');
    await twoFrames(page);
    await twoFrames(page);
    const st = await centered(atm);
    check(
      `#85 AC-9(e) ${tag} 絞り込み中に [ATM] で絞り込みが外れて ATM へ`,
      (await chip.getAttribute('aria-pressed')) === 'false' && st.ok,
      st.why,
    );
  }

  // (f) 5 列で put → call を替えても枠の中央の K が ±1 行
  if (cols === 5) {
    const mid = () =>
      page.evaluate((s) => {
        const wrap = document.querySelector(s);
        if (!wrap) return null;
        const head = wrap.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        const b = wrap.getBoundingClientRect();
        const y = b.top + head + (wrap.clientHeight - head) / 2;
        const trs = [...wrap.querySelectorAll('tbody tr')];
        const i = trs.findIndex((tr) => tr.getBoundingClientRect().bottom >= y);
        return { i, k: Number(trs[i]?.getAttribute('data-k')) };
      }, ACTIVE_WRAP);
    await page.evaluate((s) => {
      const w = document.querySelector(s);
      if (w) w.scrollTop += 700;
    }, ACTIVE_WRAP);
    const m0 = await mid();
    await page.click('section.board [aria-label="対象の種別"] button:has-text("call")');
    await twoFrames(page);
    await twoFrames(page);
    const m1 = await mid();
    check(
      `#85 AC-9(f) ${tag} 5 列で put → call: 枠の中央の K が ±1 行`,
      !!m0 && !!m1 && Math.abs(m0.i - m1.i) <= 1,
      `${fmtK(m0?.k)} → ${fmtK(m1?.k)}`,
    );
    await page.click('section.board [aria-label="対象の種別"] button:has-text("put")');
    await twoFrames(page);
  }

  // (h) スマイル: タップ・もう一度タップ・長押し + 横ドラッグ・. ・[×]・[売り]・ホイール / ⟲・横軸
  if (phoneSize) await setShell(page, 'smile', 'peek');
  else await page.click('section.board .panel-head .seg button:has-text("スマイル")');
  await page.waitForTimeout(250);
  const S = 'section.smile .smile-month:not(.inactive) .smile-wrap';
  const actK = () =>
    page
      .locator('section.smile .smile-act .k')
      .textContent({ timeout: 300 })
      .catch(() => null);
  /** mid の点の中心（画面の座標。ATM の縦線に近いものから） */
  const points = await page.evaluate((s) => {
    const wrap = document.querySelector(s);
    const svg = wrap?.querySelector('svg');
    const d = svg?.querySelector('.pt.mid')?.getAttribute('d') ?? '';
    const atm = Number(svg?.querySelector('line.atm')?.getAttribute('x1') ?? Number.NaN);
    const b = svg?.getBoundingClientRect();
    const pts = [...d.matchAll(/M([\d.]+) ([\d.]+)a2\.5/g)].map((m) => ({
      x: Number(m[1]) + 2.5,
      y: Number(m[2]),
    }));
    if (!b) return [];
    return pts
      .map((p) => ({ x: b.left + p.x, y: b.top + p.y, d: Math.abs(p.x - atm) }))
      .sort((a, c) => a.d - c.d);
  }, S);
  const p0 = points[0];
  if (!p0) check(`#85 AC-9(h) ${tag} スマイルの点`, false, '点が無い');
  else {
    await page.mouse.click(p0.x, p0.y);
    await twoFrames(page);
    const k1 = await actK();
    // 続けて押すとダブルクリック（リセット）になるので間を空ける
    await page.waitForTimeout(600);
    await page.mouse.click(p0.x, p0.y);
    await twoFrames(page);
    const k2 = await actK();
    check(
      `#85 AC-9(h) ${tag} 点のタップで操作行に K、同じ点のタップで解除`,
      !!k1 && k2 === null,
      `${k1} → ${k2}`,
    );
    // 長押し（0.5 秒）して横に 60px ドラッグ
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.waitForTimeout(550);
    const k3 = await actK();
    await page.mouse.move(p0.x + 60, p0.y, { steps: 12 });
    await page.mouse.up();
    await twoFrames(page);
    const k4 = await actK();
    check(
      `#85 AC-9(h) ${tag} 長押し + 横に 60px で選択の K が変わる`,
      !!k3 && !!k4 && k3 !== k4,
      `${k3} → ${k4}`,
    );
    await page.locator(S).focus();
    await page.keyboard.press('.');
    await twoFrames(page);
    const k5 = await actK();
    check(`#85 AC-9(h) ${tag} . で次の K`, !!k5 && k5 !== k4, `${k4} → ${k5}`);
    const before = await counts();
    await page.click('section.smile .smile-act button[aria-label*="を売り"]');
    await twoFrames(page);
    const after = await counts();
    check(
      `#85 AC-9(h) ${tag} [売り] で足 +1 とトースト`,
      after.rows === before.rows + 1 &&
        after.toast.some((t) => /^売 [PC] .* を追加$/.test(t ?? '')),
      `${before.rows} → ${after.rows}・${after.toast.join(' / ')}`,
    );
    await page.click('section.smile .smile-act button[aria-label="選択を消す"]');
    await twoFrames(page);
    check(`#85 AC-9(h) ${tag} [×] で選択が消える`, (await actK()) === null);
    const ticks = () => page.locator(`${S} .ax .tx`).allTextContents();
    const t0 = await ticks();
    const box = await page.locator(S).boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(50);
      }
    }
    await twoFrames(page);
    const t1 = await ticks();
    await page.click('section.smile .panel-head button[aria-label="リセット"]');
    await twoFrames(page);
    const t2 = await ticks();
    check(
      `#85 AC-9(h) ${tag} ホイールで横軸の範囲が狭まり ⟲ で戻る`,
      JSON.stringify(t0) !== JSON.stringify(t1) && JSON.stringify(t0) === JSON.stringify(t2),
      `${t0.at(0)}〜${t0.at(-1)} → ${t1.at(0)}〜${t1.at(-1)} → ${t2.at(0)}〜${t2.at(-1)}`,
    );
    await page.click('section.smile [aria-label="横軸"] button:has-text("moneyness")');
    await twoFrames(page);
    const tm = await ticks();
    await page.click('section.smile [aria-label="横軸"] button[aria-label="デルタ"]');
    await twoFrames(page);
    const td = await ticks();
    await page.click('section.smile [aria-label="横軸"] button:has-text("行使価格")');
    await twoFrames(page);
    check(
      `#85 AC-9(h) ${tag} 横軸の Seg で目盛りの文言が変わる`,
      tm.some((t) => t.includes('%')) && td.some((t) => /^[PC] /.test(t) || t === '0.50'),
      `${tm.slice(0, 3).join(' ')} / ${td.slice(0, 3).join(' ')}`,
    );
  }
  // (g) 限月を替えると板の行とスマイルが別の限月になり、スマイルの選択が消える
  {
    await page.locator(S).focus();
    await page.keyboard.press('.');
    await twoFrames(page);
    const picked = await actK();
    const other = chain.months.find((m) => m.id !== i0.month)?.id;
    await page.click(`section.smile [aria-label="限月"] button[aria-label="${other} 限"]`);
    await twoFrames(page);
    const sm = await page
      .locator('section.smile .smile-month:not(.inactive)')
      .getAttribute('data-month');
    const k6 = await actK();
    if (phoneSize) await setShell(page, 'board', 'peek');
    else await page.click('section.smile .panel-head .seg button:has-text("板")');
    await twoFrames(page);
    const bm = (await info()).month;
    check(
      `#85 AC-9(g) ${tag} 限月の切替: 板とスマイルが ${other}・スマイルの選択が消える`,
      !!picked && sm === other && bm === other && k6 === null,
      `選択 ${picked} → ${k6}・板 ${bm}・スマイル ${sm}`,
    );
    await page.click(`section.board [aria-label="限月"] button[aria-label="${i0.month} 限"]`);
    await twoFrames(page);
  }
  const lf = await page.evaluate(() =>
    window.__loafOk ? window.__loaf.filter((d) => d > 50).length : -1,
  );
  console.log(`      ${tag} 市場の手順の Long Animation Frame（50ms 超・記録）: ${lf} 件`);
  await ctx.close();
}

/** AC-10: 322 行の板（合成）で、行数・各操作の Long Animation Frame 0 件・限月の切替の時間（記録） */
async function marketWideFlows(vp) {
  const tag = `${vp.width}x${vp.height} 322 行`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  await ctx.addInitScript(LOAF_INIT);
  await routeWide(ctx);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (phoneSize) await setShell(page, 'board', 'peek');
  await page.waitForTimeout(500);
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const mark = () => page.evaluate(() => window.__loaf.length);
  const since = (i) => page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50), i);
  const rows = await page.locator(`${ACTIVE_WRAP} tbody tr`).count();
  check(`#85 AC-10(a) ${tag} 表の行が 322`, rows === 322, `${rows} 行`);
  const results = [];
  // 隠れた表の空き時間の割り付け（regions/Board.tsx）が済むのを待ってから測る
  const settle = () =>
    page
      .waitForSelector('section.board .board-months[data-warm="done"]', { timeout: 5000 })
      .catch(() => null);
  const run = async (name, fn) => {
    await settle();
    await page.waitForTimeout(300);
    const m = await mark();
    await fn();
    await page.waitForTimeout(300);
    const l = await since(m);
    results.push([name, l]);
  };
  const box = await page.locator(ACTIVE_WRAP).boundingBox();
  await run('板の枠のホイール 20 回', async () => {
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i < 10 ? 240 : -240);
      await page.waitForTimeout(30);
    }
  });
  await run('put / call の切替 10 回', async () => {
    for (let i = 0; i < 10; i++) {
      await page.click(
        `section.board [aria-label="対象の種別"] button:has-text("${i % 2 ? 'put' : 'call'}")`,
      );
      await twoFrames(page);
    }
  });
  const months = await page.locator('section.board [aria-label="限月"] button').count();
  const times = [];
  await run('限月の切替 10 回', async () => {
    for (let i = 0; i < 10; i++) {
      const t = await page.evaluate(
        (n) =>
          new Promise((r) => {
            const b = document.querySelectorAll('section.board [aria-label="限月"] button')[n];
            const t0 = performance.now();
            b?.click();
            requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0)));
          }),
        (i + 1) % months,
      );
      times.push(t);
      await page.waitForTimeout(50);
    }
  });
  const chips = [
    'ATM へ',
    'OTM 10% へ',
    'OTM 20% へ',
    'OTM 30% へ',
    '|Δ| 0.05 へ',
    '|Δ| 0.10 へ',
    '|Δ| 0.20 へ',
    '|Δ| 0.30 へ',
  ];
  await run('ジャンプ 8 回', async () => {
    for (const c of chips) {
      await page.click(`section.board .board-tools button[aria-label="${c}"]`);
      await twoFrames(page);
    }
  });
  await run('bid / ask での追加 5 回', async () => {
    await page.click('section.board .board-tools button[aria-label="ATM へ"]');
    await twoFrames(page);
    const btns = page.locator(`${ACTIVE_WRAP} tr.atm button`);
    const n = await btns.count();
    for (let i = 0; i < 5; i++) {
      await btns.nth(i % n).click();
      await twoFrames(page);
    }
  });
  if (phoneSize) await setShell(page, 'smile', 'peek');
  else await page.click('section.board .panel-head .seg button:has-text("スマイル")');
  await page.waitForTimeout(300);
  const sb = await page
    .locator('section.smile .smile-month:not(.inactive) .smile-wrap')
    .boundingBox();
  await run('スマイルのドラッグ（パン）と拡大縮小', async () => {
    if (!sb) return;
    const x = sb.x + sb.width / 2;
    const y = sb.y + sb.height / 2;
    await page.mouse.move(x, y);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -150);
      await page.waitForTimeout(40);
    }
    await page.mouse.down();
    await page.mouse.move(x + 80, y, { steps: 20 });
    await page.mouse.up();
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 150);
      await page.waitForTimeout(40);
    }
  });
  for (const [name, l] of results) {
    check(
      `#85 AC-10(b) ${tag} ${name}の Long Animation Frame（50ms 超）0 件`,
      loafOk && l.length === 0,
      loafOk
        ? `${l.length} 件${l.length ? `（${l.map((d) => Math.round(d)).join('・')}ms）` : ''}`
        : '未対応',
    );
  }
  const sorted = [...times].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
  console.log(
    `      ${tag} AC-10(c) 限月の切替のクリックから次の描画まで（記録）: 中央値 ${med.toFixed(1)}ms（${sorted.map((t) => t.toFixed(0)).join('・')}）`,
  );
  await ctx.close();
}

/** AC-12: 新しい画面で限月・種別・ask ≤ 50 円・横軸を替え → 再読み込み → 旧画面で同じ */
async function marketPersistFlow() {
  const vp = { width: 1440, height: 900 };
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const monthBtn = page.locator('section.board [aria-label="限月"] button').nth(1);
  const monthText = (await monthBtn.textContent())?.trim();
  const monthLabel = await monthBtn.getAttribute('aria-label');
  await monthBtn.click();
  await page.click('section.board [aria-label="対象の種別"] button:has-text("call")');
  await page.click('section.board .board-tools .chip:has-text("ask ≤ 50 円")');
  await page.click('section.board .panel-head .seg button:has-text("スマイル")');
  await page.click('section.smile [aria-label="横軸"] button:has-text("moneyness")');
  await page.waitForTimeout(800);
  await page.reload();
  await waitReady(page, 'next');
  const pressed = (sel) =>
    page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
  const nextMonth = await pressed('section.board [aria-label="限月"] button[aria-pressed="true"]');
  const nextTarget = await pressed(
    'section.board [aria-label="対象の種別"] button[aria-pressed="true"]',
  );
  const nextFilter = await page
    .locator('section.board .board-tools .chip:has-text("ask ≤ 50 円")')
    .getAttribute('aria-pressed');
  check(
    '#85 AC-12 新しい画面の再読み込みで限月・種別・ask ≤ 50 円が残る',
    nextMonth === monthText && nextTarget === 'call' && nextFilter === 'true',
    `${nextMonth}・${nextTarget}・${nextFilter}`,
  );
  await page.goto(pageUrl('legacy'));
  // 表示中の限月が 2 つ目なので、先頭の .board-table（隠れた限月）ではなく表示中の板を待つ
  await page.waitForSelector('.board:not(.inactive) .board-table', { timeout: 20000 });
  await page.waitForTimeout(400);
  const old = await page.evaluate(() => ({
    month: document.querySelector('nav.tabs button[aria-pressed="true"]')?.textContent?.trim(),
    target: document
      .querySelector(
        '.board:not(.inactive) fieldset[aria-label="対象の種別"] button[aria-pressed="true"]',
      )
      ?.textContent?.trim(),
    filter: [...document.querySelectorAll('.board:not(.inactive) .board-tools > button')]
      .find((b) => b.textContent?.includes('ask'))
      ?.getAttribute('aria-pressed'),
    axis: document
      .querySelector(
        '.smile:not(.inactive) fieldset[aria-label="横軸"] button[aria-pressed="true"]',
      )
      ?.textContent?.trim(),
  }));
  check(
    '#85 AC-12 旧画面（?ui=next なし）で同じ限月・種別・絞り込み・横軸',
    old.month === monthLabel &&
      old.target === 'call' &&
      old.filter === 'true' &&
      old.axis === 'moneyness',
    JSON.stringify(old),
  );
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
