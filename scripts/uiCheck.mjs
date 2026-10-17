// 画面の検査（`npm run ui:check`。#81、docs/ui-redesign.md §10.1）。Chromium（Playwright）で画面を開き、
// ページの縦・横スクロールと折り返しの件数を数値で出す。CI には入れない（手元で流し、各 PR に出力を貼る）。
//
// 前提: `npm ci` の後に一度 `npx playwright install chromium`（ブラウザは手元のキャッシュに入る。リポジトリには入らない）。
// 板は dev サーバーの合成の板（fixtures/synthetic/ の latest）。足は tests/ui/saved/workspace-v2.json のタブ A（足 2 本）を
// 作業の保存（版 2）として localStorage に入れて開く（UI の操作に依存しない。旧画面にも同じ足）。
//
//   npm run ui:check                       新しい画面（?ui=next）: 360 / 390 / 900 / 1440 × ダーク / ライト、
//                                          スマホはシート hidden / peek / full × パネル 5 つ。各状態で舞台の読み取り
//                                          （.readout .ro）が画面内に見えているか（スマホ 3・900 で 5・1440 で 6。#82）
//   npm run ui:check -- --parts            部品の見本（?ui=next&parts。dev だけ）
//   npm run ui:check -- --legacy           旧画面（?ui=next なし）
//   npm run ui:check -- --flows            保存・共有・テーマ・キーボードの手順（#81 AC-11・AC-12）と舞台の手順
//                                          （#82: ハンドル・IV / 時間レール・キー・足マーカー・Long Animation Frame）
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
        await page.click('.dock button[data-panel="positions"]');
        await page.waitForTimeout(150);
        await report(page, `${tag} hidden`, w, h, `${name}-hidden`);
        await readoutCheck(page, `${tag} positions/hidden ${w}x${h}`, 3);
        await page.click('.dock button[data-panel="positions"]');
        await page.click('.grabber');
        await page.waitForTimeout(150);
        await report(page, `${tag} full`, w, h, `${name}-full`);
        await readoutCheck(page, `${tag} positions/full ${w}x${h}`, 3);
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
            await report(page, lbl, w, h, `${name}-${panel}-${sheet}`, false);
            await readoutCheck(page, `${lbl} ${w}x${h}`, 3);
          }
        }
      } else {
        await report(page, tag, w, h, name);
        if (mode === 'next') await readoutCheck(page, `${tag} ${w}x${h}`, w >= 1200 ? 6 : 5);
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

try {
  if (flows) await runFlows();
  else await measureAll();
} finally {
  await browser.close();
  await server?.close();
}
process.exit(failed ? 1 : 0);
