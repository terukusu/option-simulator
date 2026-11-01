// PWA の宣言の検査（`npm run pwa:check`。#90 の AC-6、docs/ui-redesign.md §10.1「PWA」）。CI には入れない（手元で流し、出力を PR に貼る）。
//
// 前提: `npm run build` の後、手元の Flask を CSP 付きで起動しておく（合成の板。api/README.md の「GCP なし」の形に STATIC_DIR を足す）:
//   cd api && DATA_SOURCE=file CHAIN_FILE=../fixtures/synthetic/latest.json STATIC_DIR=../dist \
//     uv run --locked flask --app simulator_api.app run -p 8080
// Vite の dev サーバーでは測らない（CSP が付かない）。`npx playwright install chromium` 済みであること。
//
//   npm run pwa:check [-- --base http://127.0.0.1:8080]
//
// `/` と古い入口 `/?ui=next`・`/?ui=legacy`（#91 からどれも同じ画面）を開いて、
//   (a) CDP の Page.getAppManifest の errors が 0 件・url のパスが /manifest.webmanifest
//   (b) manifest の要求に cookie が付く（crossorigin="use-credentials" の効き目。検査用の cookie を 1 つ入れて開く）
//   (c) コンソールの CSP 違反（Refused to / Content Security Policy）が 0 件・/favicon.svg が 200
//   (d) `/` で ⋯ → マニュアル → 節（表・コードブロック）を説明カードで開く（#322。マニュアルの chunk の動的 import）。
//       (c) の CSP 違反はこの操作の後に数える
//   (e) #341: `/` を本物の Chromium（`channel: 'chromium'` の新しい headless。headless shell は installability を
//       持たない）の永続の context（一時ディレクトリ。終わったら消す）で開き、CDP の Page.getInstallabilityErrors が 0 件
//       （display: standalone・アイコン・start_url など Chrome のインストールの条件）。一過性の pipeline-restarted だけなら
//       1 回だけ取り直す。in-incognito が出たらそれだけを除き、その旨を行に出す。CDP が取れなければ NG
// 出力は件数・パス・ステータスだけ（cookie の値・ヘッダの全文は出さない）。--base はループバック（127.0.0.1 / localhost / [::1]）だけ。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const at = args.indexOf('--base');
const base = new URL(at >= 0 && args[at + 1] ? args[at + 1] : 'http://127.0.0.1:8080');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  console.error(`--base はループバックだけ（本番に向けない）: ${base.hostname}`);
  process.exit(2);
}

// 検査用の cookie（名前・値は意味のない固定の文字列）
const COOKIE = { name: 'pwa_check', value: 'x', url: base.origin };
const CSP_WORDS = /Refused to|Content Security Policy/i;

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'ok' : 'NG'}: ${label}`);
  if (!cond) failed++;
};

const browser = await chromium.launch();
try {
  for (const path of ['/', '/?ui=next', '/?ui=legacy']) {
    console.log(`--- ${path}`);
    const context = await browser.newContext();
    await context.addCookies([COOKIE]);
    const page = await context.newPage();
    const csp = [];
    page.on('console', (m) => {
      if (CSP_WORDS.test(m.text())) csp.push(m.type());
    });
    page.on('pageerror', (e) => {
      if (CSP_WORDS.test(String(e))) csp.push('pageerror');
    });
    const seen = new Map(); // パス → { status, cookie }
    page.on('requestfinished', async (req) => {
      const p = new URL(req.url()).pathname;
      if (p !== '/manifest.webmanifest' && p !== '/favicon.svg') return;
      const res = await req.response();
      const headers = await req.allHeaders();
      seen.set(p, { status: res?.status() ?? 0, cookie: 'cookie' in headers });
    });

    const res = await page.goto(new URL(path, base).href, { waitUntil: 'load' });
    ok(res?.status() === 200, `${path} ${res?.status()}`);
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    const manifestPath = manifest.url ? new URL(manifest.url).pathname : '(なし)';
    ok(manifest.errors.length === 0, `(a) manifest の errors ${manifest.errors.length} 件`);
    ok(manifestPath === '/manifest.webmanifest', `(a) manifest の url のパス ${manifestPath}`);
    // getAppManifest が manifest を取りに行くので、その要求の完了を待つ
    await page.waitForTimeout(500);

    const m = seen.get('/manifest.webmanifest');
    ok(
      m?.status === 200 || m?.status === 304,
      `(b) /manifest.webmanifest の要求 ${m ? m.status : 'なし'}`,
    );
    ok(m?.cookie === true, `(b) manifest の要求に cookie ${m?.cookie ? 'あり' : 'なし'}`);

    const fav = seen.get('/favicon.svg');
    if (fav) {
      ok(
        fav.status === 200 || fav.status === 304,
        `(c) /favicon.svg の要求（ページの読み込み）${fav.status}`,
      );
    } else {
      // ヘッドレスはタブのアイコンを取りに行かないことがある。その場合は同じ context で直接取りに行く（判定が弱い旨を出す）
      const r = await page.request.get(new URL('/favicon.svg', base).href);
      ok(
        r.status() === 200,
        `(c) /favicon.svg ${r.status()}（ページの読み込みでは要求なし。page.request で確認）`,
      );
    }
    if (path === '/') {
      // (d) #322: マニュアルの節を説明カードで開く（別の chunk の動的 import・表・コードブロック）。その間も CSP 違反 0
      const card = 'dialog.term-card[open]';
      await page.click('button[aria-label="メニュー"]');
      await page.click('header.top > .menu-wrap [role^="menuitem"]:has-text("マニュアル")');
      const toc = await page
        .waitForSelector(`${card} .tc-toc`, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      ok(toc, '(d) ⋯ → マニュアル で目次が出る（マニュアルの chunk を読んだ）');
      for (const label of ['16.3 ', '11.5 ']) {
        await page
          .locator(`${card} .tc-toc .tc-link`, { hasText: label })
          .first()
          .click()
          .catch(() => {});
        const title = await page
          .waitForFunction(
            ([c, l]) =>
              (document.querySelector(`${c} .tc-head h2`)?.textContent ?? '').startsWith(
                `マニュアル ${l}`,
              ),
            [card, label],
            { timeout: 5000 },
          )
          .then(() => true)
          .catch(() => false);
        const blocks = await page.$$eval(
          `${card} .tc-table, ${card} .tc-code`,
          (els) => els.length,
        );
        ok(title && blocks > 0, `(d) 節「${label.trim()}」を開く（表 / コード ${blocks}）`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }
    }
    ok(csp.length === 0, `(c) CSP 違反 ${csp.length} 件`);
    await context.close();
  }
} finally {
  await browser.close();
}

// (e) #341: インストールできるアプリか（永続の context・本物の Chromium）
console.log('--- / (e) installability');
const dir = mkdtempSync(join(tmpdir(), 'pwa-check-'));
try {
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium' });
  try {
    await context.addCookies([COOKIE]);
    const page = context.pages()[0] ?? (await context.newPage());
    const res = await page.goto(new URL('/', base).href, { waitUntil: 'load' });
    ok(res?.status() === 200, `(e) / ${res?.status()}`);
    await page.waitForTimeout(500);
    const cdp = await context.newCDPSession(page);
    const errorIds = async () =>
      (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.map((e) => e.errorId);
    let ids = await errorIds();
    if (ids.length > 0 && ids.every((id) => id === 'pipeline-restarted')) {
      await page.waitForTimeout(1000);
      ids = await errorIds();
    }
    const incognito = ids.includes('in-incognito');
    const rest = ids.filter((id) => id !== 'in-incognito');
    ok(
      rest.length === 0,
      `(e) installabilityErrors ${rest.length} 件${rest.length ? `（${rest.join(', ')}）` : ''}${incognito ? '（in-incognito を除いた）' : ''}`,
    );
  } catch (e) {
    ok(false, `(e) installabilityErrors を取れない（${String(e.message ?? e).split('\n')[0]}）`);
  } finally {
    await context.close();
  }
} catch (e) {
  ok(false, `(e) Chromium を開けない（${String(e.message ?? e).split('\n')[0]}）`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? 'pwa:check OK' : `pwa:check NG（${failed} 件）`);
process.exit(failed === 0 ? 0 : 1);
