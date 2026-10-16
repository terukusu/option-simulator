// 画面の検査（`npm run ui:check`。#81、docs/ui-redesign.md §10.1）。Chromium（Playwright）で画面を開き、
// ページの縦・横スクロールと折り返しの件数を数値で出す。CI には入れない（手元で流し、各 PR に出力を貼る）。
//
// 前提: `npm ci` の後に一度 `npx playwright install chromium`（ブラウザは手元のキャッシュに入る。リポジトリには入らない）。
// 板は dev サーバーの合成の板（fixtures/synthetic/ の latest）。足は tests/ui/saved/workspace-v2.json のタブ A（足 2 本）を
// 作業の保存（版 2）として localStorage に入れて開く（UI の操作に依存しない。旧画面にも同じ足）。
//
//   npm run ui:check                       新しい画面（?ui=next）: 360 / 390 / 900 / 1440 × ダーク / ライト、
//                                          スマホはシート hidden / peek / full
//   npm run ui:check -- --parts            部品の見本（?ui=next&parts。dev だけ）
//   npm run ui:check -- --legacy           旧画面（?ui=next なし）
//   npm run ui:check -- --flows            保存・共有・テーマ・キーボードの手順（AC-11・AC-12）を pass / fail で出す
//   --url <base>                           dev サーバーを起こさず、その URL を使う（例 http://127.0.0.1:5173/?ui=next&parts）
//   --dom <file>                           body の下の要素の tag.class の並びを書き出す（旧画面が変わらないことの比較用）
//   --shots <dir>                          スクリーンショットを書く（合成の板だけ。リポジトリに入れない）
//   --max-wraps <n>                        折り返しが n 件を超えたら失敗にする（渡したときだけ判定）
//
// 縦・横 = ページのスクロール量（scrollHeight − innerHeight・scrollWidth − innerWidth）。body が切っている（overflow: hidden）
// はみ出しも数える（body の scrollHeight − clientHeight との大きい方）。
// 終了コード: 新しい画面（部品の見本を含む）で縦か横が 0 より大きい、--max-wraps の超過、--flows の fail で 1。
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

async function report(page, label, w, h, shotName) {
  const r = await measure(page);
  const bad = mode !== 'legacy' && (r.v > 0 || r.h > 0);
  const over = maxWraps !== null && r.wraps.length > maxWraps;
  if (bad || over) failed = true;
  const mark = bad || over ? '  ← NG' : '';
  console.log(`${label} ${w}x${h}: 縦 ${r.v}px 横 ${r.h}px 折り返し ${r.wraps.length} 件${mark}`);
  for (const s of r.wraps.slice(0, 30)) console.log(`    ${s}`);
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `${shotName}.png`) });
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
        await page.click('.dock button[data-panel="positions"]');
        await page.waitForTimeout(150);
        await report(page, `${tag} hidden`, w, h, `${name}-hidden`);
        await page.click('.dock button[data-panel="positions"]');
        await page.click('.grabber');
        await page.waitForTimeout(150);
        await report(page, `${tag} full`, w, h, `${name}-full`);
      } else {
        await report(page, tag, w, h, name);
      }
      if (domFile) domOut.push(`## ${w}x${h}${theme ? ` ${theme}` : ''}`, await domList(page));
      await ctx.close();
    }
  }
  if (domFile) writeFileSync(domFile, `${domOut.join('\n')}\n`);
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
}

try {
  if (flows) await runFlows();
  else await measureAll();
} finally {
  await browser.close();
  await server?.close();
}
process.exit(failed ? 1 : 0);
