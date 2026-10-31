// 合成の板 JSON を fixtures/synthetic/ に書き出す（`npm run fixtures`）。
// `--check` はコミット済みのファイルと一致するかだけを見て、違えば失敗する（`npm run fixtures:check`。CI）。
// `--wide` は 322 行 × 2 限月の板を fixtures/local/synthetic_wide.json に書く（gitignore。コミットしない）。
// `--later` は latest の 3 日後の板（F・IV を動かした別の板。#299 の前の板で建てた足の確認用）を
// fixtures/local/synthetic_later.json に書く（gitignore。コミットしない）。
// TypeScript の生成器（scripts/synthBoard.ts）は Vite のモジュールランナーで読む（依存を増やさない）。
//
// あわせて、マニュアル（docs/user-guide.md）の節の番号・見出し・アンカーを画面の規則（ui/view/manual.ts）で
// fixtures/docs/user-guide-sections.json に書く（#322。板ではない）。`--check` は同じく一致を見る。同じファイルを
// API の pytest（api/tests/test_ai_docs.py）が AI の索引（docs.py の parse）と比べる = TS と Python の番号の規則の突き合わせ。
// マニュアルの見出しを変えたら `npm run fixtures` で作り直してコミットする。

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'fixtures', 'synthetic');
const docsOut = join(root, 'fixtures', 'docs', 'user-guide-sections.json');
const check = process.argv.includes('--check');
const wide = process.argv.includes('--wide');
const later = process.argv.includes('--later');

const { module } = await runnerImport(join(root, 'scripts', 'synthBoard.ts'), {
  configFile: false,
  root,
  logLevel: 'error',
});
/** @type {Record<string, string>} */
const files = module.buildFixtureFiles();

const { module: manual } = await runnerImport(join(root, 'ui', 'view', 'manual.ts'), {
  configFile: false,
  root,
  logLevel: 'error',
});
/** マニュアルの番号のある節（id・level・title・anchor。文書の順）。1 行 1 節の JSON */
async function docsSections() {
  const md = await readFile(join(root, 'docs', 'user-guide.md'), 'utf8');
  const rows = manual
    .manualIndex(md)
    .sections.filter((s) => s.id !== null)
    .map((s) => JSON.stringify({ id: s.id, level: s.level, title: s.title, anchor: s.anchor }));
  return `[\n${rows.map((r) => `  ${r}`).join(',\n')}\n]\n`;
}

if (wide) {
  const localDir = join(root, 'fixtures', 'local');
  const content = module.serializeChainJson(module.buildWideChainJson());
  await mkdir(localDir, { recursive: true });
  await writeFile(join(localDir, 'synthetic_wide.json'), content);
  console.log(`wrote fixtures/local/synthetic_wide.json (${content.length} bytes。コミットしない)`);
} else if (later) {
  const localDir = join(root, 'fixtures', 'local');
  const content = module.serializeChainJson(module.buildLaterChainJson());
  await mkdir(localDir, { recursive: true });
  await writeFile(join(localDir, 'synthetic_later.json'), content);
  console.log(
    `wrote fixtures/local/synthetic_later.json (${content.length} bytes。コミットしない)`,
  );
} else if (check) {
  const problems = [];
  for (const [name, content] of Object.entries(files)) {
    const current = await readFile(join(outDir, name), 'utf8').catch(() => null);
    if (current === null) problems.push(`${name}: ファイルが無い`);
    else if (current !== content) problems.push(`${name}: 生成器の出力と違う`);
  }
  const existing = (await readdir(outDir).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const f of existing) if (!(f in files)) problems.push(`${f}: 生成器が作らないファイル`);
  const docsNow = await readFile(docsOut, 'utf8').catch(() => null);
  if (docsNow === null) problems.push('fixtures/docs/user-guide-sections.json: ファイルが無い');
  else if (docsNow !== (await docsSections()))
    problems.push(
      'fixtures/docs/user-guide-sections.json: マニュアルの節（ui/view/manual.ts）と違う',
    );
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error('npm run fixtures で作り直してコミットする');
    process.exit(1);
  }
  console.log(
    `ok: fixtures/synthetic/ の ${Object.keys(files).length} ファイルと fixtures/docs/user-guide-sections.json が生成器の出力と一致`,
  );
} else {
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(outDir, name), content);
    console.log(`wrote fixtures/synthetic/${name} (${content.length} bytes)`);
  }
  const docs = await docsSections();
  await mkdir(dirname(docsOut), { recursive: true });
  await writeFile(docsOut, docs);
  console.log(`wrote fixtures/docs/user-guide-sections.json (${docs.length} bytes)`);
}
