// dev サーバーで合成の板（fixtures/synthetic/）を `/fixtures/<name>.json` で配る Vite プラグイン。
// apply: 'serve' なのでビルド（dist/）には入らない。許可リストの名前だけを配り、
// fixtures/local/（実データの dump・--wide の出力）は配らない（手元の JSON は画面のファイル選択で読む）。
// Node の型（@types/node）を入れていないので、型検査の対象外の .mjs に置く（型は devFixtures.d.mts）。
// IV 推移（#79）の合成の応答も `/fixtures/atm_iv?tf=&start=&end=` で配る（`/api/atm_iv` と同じ形。架空の値。種つきの
// 決まった関数なので、同じ要求には同じ応答）。Docker の context の許可リストの 1 本なので別ファイルにしない。

import { readFileSync } from 'node:fs';
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
const ATM_IV_PATH = '/fixtures/atm_iv';

// ---- IV 推移の合成の応答（#79。架空の値）
/** 合成の板（latest）の snapshot_at を「今」とする（UNIX 秒） */
export const SYNTH_IV_NOW = Date.parse('2026-10-13T21:31:00+09:00') / 1000;
/** 表の最後の行 = 今の 50 分前（表は毎時 45 分に作られる想定） */
export const SYNTH_IV_LAST_AT = SYNTH_IV_NOW - 50 * 60;
/** 合成のデータの始まり（これより前は行が無い） */
export const SYNTH_IV_FIRST = Date.parse('2025-04-01T00:00:00+09:00') / 1000;
const DAY = 86400;
const JST = 9 * 3600;
/** 取引の無い平日（同梱の取引カレンダーの is_trading_day = false。合成の行もこの日は作らない） */
const NON_TRADING = new Set(
  JSON.parse(
    readFileSync(
      join(
        resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        'data',
        'calendar',
        'calendar.json',
      ),
      'utf8',
    ),
  )
    .days.filter((d) => !d.is_trading_day)
    .map((d) => d.date),
);
const tradingDay = (day) => {
  const wd = (((day + 4) % 7) + 7) % 7;
  return (
    wd !== 0 && wd !== 6 && !NON_TRADING.has(new Date(day * DAY * 1000).toISOString().slice(0, 10))
  );
};
/** 足ごとの (読む足の秒, 右端の 1 回分の日数)（api/src/simulator_api/settings.py と画面の 1 回分） */
const IV_TF = { '1m': [60, 3], '1h': [3600, 60], '1d': [3600, 365] };

/** 0〜1 の決まった値（分の通し番号から） */
function hash01(n) {
  let a = (n * 2654435761) >>> 0;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/** その分に行があるか（取引日の日中 08:45〜15:45・夜間 17:00〜翌 06:00） */
function inSession(t) {
  const j = t + JST;
  const day = Math.floor(j / DAY);
  const min = Math.floor((j - day * DAY) / 60);
  if (min >= 525 && min < 945) return tradingDay(day);
  if (min >= 1020) return tradingDay(day);
  // 夜間の後半（0:00〜6:00）は前の日が取引日のとき
  if (min < 360) return tradingDay(day - 1);
  return false;
}

/** その分の iv30（%。深夜 02:00〜02:59 は NULL = 欠け） */
function ivAt(t) {
  const m = Math.floor(t / 60);
  const min = Math.floor(((t + JST) % DAY) / 60);
  if (min >= 120 && min < 180) return null;
  const tau = 2 * Math.PI;
  const spike = (at, width, height) => height * Math.exp(-(((t - at) / width) ** 2));
  const v =
    19 +
    3.5 * Math.sin((tau * t) / (DAY * 37)) +
    1.4 * Math.sin((tau * t) / (DAY * 4.3)) +
    0.35 * Math.sin((tau * t) / 1800) +
    0.5 * (hash01(m) - 0.5) +
    spike(Date.parse('2026-08-05T10:00:00+09:00') / 1000, DAY * 2, 11) +
    spike(Date.parse('2026-10-09T09:00:00+09:00') / 1000, DAY * 0.6, 6);
  return Math.round(v * 1e4) / 1e4;
}

/** 取引日（JST + 7 時間の日付から土日・取引の無い平日を飛ばした最初の日）の 00:00 JST（UNIX 秒） */
function tradingDayStart(t) {
  let day = Math.floor((t + JST + 7 * 3600) / DAY);
  while (!tradingDay(day)) day++;
  return day * DAY - JST;
}

const jstIso = (t) => `${new Date((t + JST) * 1000).toISOString().slice(0, 19)}+09:00`;

/**
 * `/api/atm_iv` と同じ形の合成の応答。range が無ければ右端（end = 今の UTC の日の翌 0 時、start = end − 1 回分）。
 * 束ね方はサーバーと同じ（open / close = 最初 / 最後の NULL でない値、high / low = 最大 / 最小、全部 NULL の足は返さない、
 * 日足は取引日に束ねて読んだ先頭の取引日を出さない）。
 */
const synthCache = new Map();
export function synthAtmIv(tf, range = null, now = SYNTH_IV_NOW) {
  const key = `${tf} ${range?.start} ${range?.end} ${now}`;
  if (!synthCache.has(key)) {
    if (synthCache.size > 32) synthCache.clear();
    synthCache.set(key, buildSynthAtmIv(tf, range, now));
  }
  return synthCache.get(key);
}

function buildSynthAtmIv(tf, range, now) {
  const spec = IV_TF[tf];
  if (!spec) return null;
  const [step, chunk] = spec;
  const end = range ? range.end : (Math.floor(now / DAY) + 1) * DAY;
  const start = range ? range.start : end - chunk * DAY;
  const readStart = tf === '1d' ? start - 10 * DAY : start;
  const readEnd = Math.min(tf === '1d' ? end + DAY : end, SYNTH_IV_LAST_AT + 1);
  const bars = [];
  let lastAt = null;
  let cur = null;
  for (let t = Math.max(readStart, SYNTH_IV_FIRST); t < readEnd; t += 60) {
    if (!inSession(t)) continue;
    if (t >= start && t < end) lastAt = t;
    const v = ivAt(t);
    const key = tf === '1d' ? tradingDayStart(t) : Math.floor(t / step) * step;
    if (!cur || cur.key !== key) {
      cur = { key, o: null, h: null, l: null, c: null };
      bars.push(cur);
    }
    if (v === null) continue;
    if (cur.o === null) cur.o = v;
    cur.h = cur.h === null ? v : Math.max(cur.h, v);
    cur.l = cur.l === null ? v : Math.min(cur.l, v);
    cur.c = v;
  }
  let out = bars.filter((b) => b.h !== null);
  if (tf === '1d') {
    const first = tradingDayStart(readStart - 1);
    out = out.filter((b) => b.key > first && b.key >= start && (end >= now || b.key < end));
  }
  return {
    schema_version: 1,
    tf,
    start: jstIso(start),
    end: jstIso(Math.min(end, Math.floor(now))),
    last_at: lastAt === null ? null : jstIso(lastAt),
    bars: out.map((b) => ({ t: jstIso(b.key), o: b.o, h: b.h, l: b.l, c: b.c })),
  };
}

/** `?tf=&start=&end=` を読む（形が違えば null = 400） */
function atmIvQuery(url) {
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  const tf = q.get('tf') ?? '';
  if (!(tf in IV_TF)) return null;
  const s = q.get('start');
  const e = q.get('end');
  if ((s === null) !== (e === null)) return null;
  if (s === null || e === null) return { tf, range: null };
  const start = Date.parse(s) / 1000;
  const end = Date.parse(e) / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end)) return null;
  return { tf, range: { start, end } };
}

/** @returns {import('vite').Plugin} */
export function serveSyntheticFixtures() {
  return {
    name: 'serve-synthetic-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (path === ATM_IV_PATH) {
          const q = atmIvQuery(req.url ?? '');
          const body = q && synthAtmIv(q.tf, q.range);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (!body) {
            res.statusCode = 400;
            res.end('{"error":"bad_request"}');
            return;
          }
          res.end(JSON.stringify(body));
          return;
        }
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
