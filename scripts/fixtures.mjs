// 合成の板 JSON を fixtures/synthetic/ に書き出す（`npm run fixtures`）。
// `--check` はコミット済みのファイルと一致するかだけを見て、違えば失敗する（`npm run fixtures:check`。CI）。
// `--wide` は 322 行 × 2 限月の板を fixtures/local/synthetic_wide.json に書く（gitignore。コミットしない）。
// TypeScript の生成器（scripts/synthBoard.ts）は Vite のモジュールランナーで読む（依存を増やさない）。

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'fixtures', 'synthetic');
const check = process.argv.includes('--check');
const wide = process.argv.includes('--wide');

const { module } = await runnerImport(join(root, 'scripts', 'synthBoard.ts'), {
  configFile: false,
  root,
  logLevel: 'error',
});
/** @type {Record<string, string>} */
const files = module.buildFixtureFiles();

if (wide) {
  const localDir = join(root, 'fixtures', 'local');
  const content = module.serializeChainJson(module.buildWideChainJson());
  await mkdir(localDir, { recursive: true });
  await writeFile(join(localDir, 'synthetic_wide.json'), content);
  console.log(`wrote fixtures/local/synthetic_wide.json (${content.length} bytes。コミットしない)`);
} else if (check) {
  const problems = [];
  for (const [name, content] of Object.entries(files)) {
    const current = await readFile(join(outDir, name), 'utf8').catch(() => null);
    if (current === null) problems.push(`${name}: ファイルが無い`);
    else if (current !== content) problems.push(`${name}: 生成器の出力と違う`);
  }
  const existing = (await readdir(outDir).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const f of existing) if (!(f in files)) problems.push(`${f}: 生成器が作らないファイル`);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error('npm run fixtures で作り直してコミットする');
    process.exit(1);
  }
  console.log(
    `ok: fixtures/synthetic/ の ${Object.keys(files).length} ファイルが生成器の出力と一致`,
  );
} else {
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(outDir, name), content);
    console.log(`wrote fixtures/synthetic/${name} (${content.length} bytes)`);
  }
}
