// 取引カレンダー（optionchan の config/trading_calendar.toml）と国民の祝日（内閣府の CSV）を同期して
// data/calendar/ に書く（`npm run calendar:sync`。設計 docs/design.md 7.5）。
// 取得先は環境変数 OPTIONCHAN_CALENDAR_URL（必須）と HOLIDAYS_CSV_URL（任意）。URL は出力しない。
// 本体は scripts/calendarSync.ts（Vite のモジュールランナーで読む。依存を増やさない）。ここは IO だけ。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 無ければ null。それ以外の読めない理由（権限など）は例外（新規扱いにしない）。 */
async function readTextOrNull(p) {
  try {
    return await readFile(p, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * まとめて書く: 全部を一時ファイルに書いてから順に rename。途中で失敗したら rename 済みのファイルを
 * 元の内容に戻し（元が無ければ消す）、一時ファイルを消して例外。
 * @param {ReadonlyArray<readonly [string, string]>} files
 */
async function writeFiles(files) {
  const staged = [];
  // 書きかけ・読み込み失敗でも一時ファイルを消せるように、書く前に記録する
  const tmps = [];
  try {
    for (const [p, content] of files) {
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}`;
      tmps.push(tmp);
      await writeFile(tmp, content);
      staged.push({ tmp, p, old: await readTextOrNull(p) });
    }
    const done = [];
    try {
      for (const s of staged) {
        await rename(s.tmp, s.p);
        done.push(s);
      }
    } catch (e) {
      const failed = [];
      for (const s of done.reverse()) {
        try {
          if (s.old === null) await rm(s.p, { force: true });
          else await writeFile(s.p, s.old);
        } catch {
          failed.push(s.p);
        }
      }
      if (failed.length > 0) {
        throw new Error(`${e?.message ?? e}。元に戻せなかった: ${failed.join(', ')}`);
      }
      throw e;
    }
  } finally {
    await Promise.all(tmps.map((t) => rm(t, { force: true })));
  }
}

const { module } = await runnerImport(join(root, 'scripts', 'calendarSync.ts'), {
  configFile: false,
  root,
  logLevel: 'error',
});

const result = await module.runCalendarSync({
  env: process.env,
  fetch: globalThis.fetch,
  readText: readTextOrNull,
  writeFiles,
  now: () => new Date(),
  outDir: join(root, 'data', 'calendar'),
});

for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
process.exitCode = result.code;
