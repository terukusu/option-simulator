// 性能の判定（`npm run perf`）: 性能テストの 2 ファイルだけを、ほかのファイルと並列にせず既定 16 ms で走らせる。
// `npm test`・CI の既定は 200 ms（桁違いの悪化だけを落とす。tests/support/perf.ts）。16 ms の判定は負荷の低いときに流す。
// PERF_BUDGET_MS が設定済み（空でない）ならその値を使う。PERF_FULL=1 で記録のみの計測も全回数（RECORD_RUNS）で測る。始めに load average（1 分）と CPU の数を出し、load が CPU の数以上なら
// 警告する（判定は変えない。失敗は失敗）。各テストの最小値・中央値・閾値を出す（verbose）。終了コードは vitest のものをそのまま返す。

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 空文字も未設定と同じに扱う（空のまま渡すと helper が既定 200 ms にして、16 ms の判定が黙って外れる）
const budget = process.env.PERF_BUDGET_MS || '16';
const load = os.loadavg()[0] ?? 0;
const cpus = os.availableParallelism();

console.log(`load average（1 分）${load.toFixed(2)} / CPU ${cpus} 個・閾値 ${budget} ms`);
if (load >= cpus) {
  console.warn(
    `警告: load average ${load.toFixed(2)} が CPU の数 ${cpus} 以上。負荷が高く判定が不確か（失敗は失敗として扱う）`,
  );
}

const r = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--no-file-parallelism',
    // 各テストの最小値・中央値・閾値（console.info）を、通ったテストでも出す
    '--reporter=verbose',
    'tests/model/perf.test.ts',
    'tests/ui/perf.test.ts',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', cwd: root, env: { ...process.env, PERF_BUDGET_MS: budget, PERF_FULL: '1' } },
);
if (r.error) console.error(r.error);
process.exit(r.status ?? 1);
