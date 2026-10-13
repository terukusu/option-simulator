// dev サーバーで合成の板（fixtures/synthetic/）を `/fixtures/<name>.json` で配る Vite プラグイン。
// apply: 'serve' なのでビルド（dist/）には入らない。許可リストの名前だけを配り、
// fixtures/local/（実データの dump・--wide の出力）は配らない（手元の JSON は画面のファイル選択で読む）。
// Node の型（@types/node）を入れていないので、型検査の対象外の .mjs に置く（型は devFixtures.d.mts）。

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const syntheticDir = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  'fixtures',
  'synthetic',
);

/** 配る板の名前（scripts/synthBoard.ts の SPECS と同じ） */
export const SERVED_FIXTURES = ['latest', 'night_early', 'pre_open'];

const FIXTURE_PATH = /^\/fixtures\/([a-z_]+)\.json$/;

/** @returns {import('vite').Plugin} */
export function serveSyntheticFixtures() {
  return {
    name: 'serve-synthetic-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const name = FIXTURE_PATH.exec(path)?.[1];
        if (!name) return next();
        if (!SERVED_FIXTURES.includes(name)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        readFile(join(syntheticDir, `${name}.json`))
          .then((body) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(body);
          })
          .catch(() => {
            res.statusCode = 404;
            res.end();
          });
      });
    },
  };
}
