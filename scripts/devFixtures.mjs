// dev サーバーで合成の板（fixtures/synthetic/）を `/fixtures/<name>.json` で配る Vite プラグイン。
// apply: 'serve' なのでビルド（dist/）には入らない。許可リストの名前だけを配り、
// fixtures/local/（実データの dump・--wide の出力）は配らない（手元の JSON は画面のファイル選択で読む）。
// Node の型（@types/node）を入れていないので、型検査の対象外の .mjs に置く（型は devFixtures.d.mts）。
// IV 推移（#79）の合成の応答も `/fixtures/atm_iv?tf=&start=&end=` で配る（`/api/atm_iv` と同じ形。架空の値。種つきの
// 決まった関数なので、同じ要求には同じ応答）。Docker の context の許可リストの 1 本なので別ファイルにしない。
// 先物推移（#190）の合成の応答も `/fixtures/future_bars?tf=&start=&end=` で配る（`/api/future_bars` と同じ形。架空の値。
// 合成の板 latest の先物の値で終わる決まった関数。既定の 1 時間足の範囲に限月交代（取引最終日の 17:00）を 1 回含む）。
// 日次の値（#152）の合成の応答も `/fixtures/atm_daily` で配る（`/api/atm_daily` と同じ形。架空の値。種つき）。
// AI の中継（#135）の偽の応答も `/fixtures/ai/status`・`/fixtures/ai/messages`（偽の SSE。Anthropic を呼ばない）で配る。
// 診断 = 考え中 → 文（事前計算の値を書き写す）、追加の質問 = tool_use（evaluate_scenario）→ ツールの結果を受けて文。
// 「ヘッジ」を含む質問はツール propose_position（#139）→ 提案のカード。
// 質問に「切断」を含むと done の無いまま終える（画面の incomplete の確認用）。遅れつき（進み具合の表示の確認用）。

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
/** start の下限（サーバーの ATM_IV_EPOCH_ISO） */
const IV_EPOCH = Date.parse('2010-01-01T00:00:00Z') / 1000;
/** 1 回の最大の日数（サーバーの ATM_IV_TIMEFRAMES） */
const IV_MAX_DAYS = { '1m': 3, '1h': 100, '1d': 400 };
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
export function atmIvQuery(url) {
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  const tf = q.get('tf') ?? '';
  if (!(tf in IV_TF)) return null;
  const s = q.get('start');
  const e = q.get('end');
  if ((s === null) !== (e === null)) return null;
  if (s === null || e === null) return { tf, range: null };
  // サーバー（api/src/simulator_api/atm_iv.py の parse_request）と同じ検査: オフセット付き・UTC の 0 時ちょうど・
  // 2010-01-01 ≤ start < end・end は今の UTC の日の翌 0 時に縮め、縮めた後の end − start が 1 回の最大以下（#79 段 C。
  // 画面の追加読み込みの範囲の誤りを dev で 400 にする）
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
  if (!iso.test(s) || !iso.test(e)) return null;
  const start = Date.parse(s) / 1000;
  const end0 = Date.parse(e) / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end0)) return null;
  if (start % DAY !== 0 || end0 % DAY !== 0) return null;
  const end = Math.min(end0, (Math.floor(SYNTH_IV_NOW / DAY) + 1) * DAY);
  if (start < IV_EPOCH || !(start < end) || end - start > IV_MAX_DAYS[tf] * DAY) return null;
  return { tf, range: { start, end } };
}

// ---- 先物推移の合成の応答（#190。架空の値）
const FUTURE_BARS_PATH = '/fixtures/future_bars';
/**
 * 合成の板 latest の先物の値（「今」の値。架空）。初めて使うときに読む（import では読まない = イメージのビルドには
 * fixtures/ が入らない。.dockerignore）
 */
let synthFutPrice = null;
function futNowPrice() {
  synthFutPrice ??= JSON.parse(readFileSync(join(syntheticDir, 'latest.json'), 'utf8')).future
    .price;
  return synthFutPrice;
}
/** 表の最後の行 = 今の 2 分前（先物は毎分取り込む想定） */
export const SYNTH_FUT_LAST_AT = SYNTH_IV_NOW - 2 * 60;
/** 限月交代の跳び（新しい限月 / 古い限月 − 1。架空） */
export const SYNTH_FUT_ROLL_JUMP = 0.003;

/** t（UNIX 秒）の限月（取引日以後に取引最終日がある最初の四半期限月。YYYY-MM） */
const futContractMemo = new Map();
function futContractOf(t) {
  // 取引日の候補（JST + 7 時間の日付）ごとに 1 回だけ求める
  const memoKey = Math.floor((t + JST + 7 * 3600) / DAY);
  const hit = futContractMemo.get(memoKey);
  if (hit) return hit;
  const m = contractOfDay((tradingDayStart(t) + JST) / DAY);
  futContractMemo.set(memoKey, m);
  return m;
}

function contractOfDay(day) {
  const y0 = new Date(day * DAY * 1000).getUTCFullYear();
  for (let y = y0; y <= y0 + 1; y++) {
    for (const m of [3, 6, 9, 12]) {
      if (lastTradingDayOf(y, m) >= day) return `${y}-${String(m).padStart(2, '0')}`;
    }
  }
  return `${y0 + 1}-03`;
}

/** その分の先物の値（円。今の限月の値で今の値に終わる。古い限月は SYNTH_FUT_ROLL_JUMP だけ低い） */
function futAt(t, m, nowM) {
  const tau = 2 * Math.PI;
  const f = (x) =>
    0.045 * Math.sin((tau * x) / (DAY * 41)) +
    0.012 * Math.sin((tau * x) / (DAY * 3.7)) +
    0.0012 * Math.sin((tau * x) / 2400);
  const noise = 0.0006 * (hash01(Math.floor(t / 60) + 7) - 0.5);
  const level = futNowPrice() * Math.exp(f(t) - f(SYNTH_IV_NOW) + noise);
  const v = m === nowM ? level : level / (1 + SYNTH_FUT_ROLL_JUMP);
  return Math.round(v / 5) * 5;
}

/**
 * `/api/future_bars` と同じ形の合成の応答（架空の値）。足の作り・範囲・日足の規則は synthAtmIv と同じ（欠けは無い）。
 * 各足に限月 m（日足はその取引日の限月）
 */
const futCache = new Map();
export function synthFutureBars(tf, range = null, now = SYNTH_IV_NOW) {
  const key = `${tf} ${range?.start} ${range?.end} ${now}`;
  if (!futCache.has(key)) {
    if (futCache.size > 32) futCache.clear();
    futCache.set(key, buildSynthFutureBars(tf, range, now));
  }
  return futCache.get(key);
}

function buildSynthFutureBars(tf, range, now) {
  const spec = IV_TF[tf];
  if (!spec) return null;
  const [step, chunk] = spec;
  const end = range ? range.end : (Math.floor(now / DAY) + 1) * DAY;
  const start = range ? range.start : end - chunk * DAY;
  const readStart = tf === '1d' ? start - 10 * DAY : start;
  const readEnd = Math.min(tf === '1d' ? end + DAY : end, SYNTH_FUT_LAST_AT + 1);
  const nowM = futContractOf(SYNTH_IV_NOW);
  const bars = [];
  let lastAt = null;
  let cur = null;
  for (let t = Math.max(readStart, SYNTH_IV_FIRST); t < readEnd; t += 60) {
    if (!inSession(t)) continue;
    if (t >= start && t < end) lastAt = t;
    const m = futContractOf(t);
    const v = futAt(t, m, nowM);
    const k = tf === '1d' ? tradingDayStart(t) : Math.floor(t / step) * step;
    if (!cur || cur.key !== k) {
      cur = { key: k, o: v, h: v, l: v, c: v, m };
      bars.push(cur);
      continue;
    }
    cur.h = Math.max(cur.h, v);
    cur.l = Math.min(cur.l, v);
    cur.c = v;
  }
  let out = bars;
  if (tf === '1d') {
    const first = tradingDayStart(readStart - 1);
    out = out.filter((b) => b.key > first && b.key >= start && (end >= now || b.key < end));
  } else {
    out = out.filter((b) => b.key >= start && b.key < end);
  }
  return {
    schema_version: 1,
    tf,
    start: jstIso(start),
    end: jstIso(Math.min(end, Math.floor(now))),
    last_at: lastAt === null ? null : jstIso(lastAt),
    bars: out.map((b) => ({ t: jstIso(b.key), o: b.o, h: b.h, l: b.l, c: b.c, m: b.m })),
  };
}

// ---- 日次の値の合成の応答（#152。架空の値）
const ATM_DAILY_PATH = '/fixtures/atm_daily';
/** 合成の日次の値の始まり（JST の日付の通し番号 = UTC の 1970-01-01 からの日数） */
const DAILY_FIRST_DAY = Date.parse('2024-04-01T00:00:00Z') / 1000 / DAY;
const dayIso = (day) => new Date(day * DAY * 1000).toISOString().slice(0, 10);

/** その月の取引最終日（第 2 金曜 = SQ 日を取引日へ繰り上げた日の前の取引日。日の通し番号） */
function lastTradingDayOf(year, month) {
  const first = Date.UTC(year, month - 1, 1) / 1000 / DAY;
  const wd = (((first + 4) % 7) + 7) % 7;
  let sq = first + ((5 - wd + 7) % 7) + 7;
  while (!tradingDay(sq)) sq--;
  let ltd = sq - 1;
  while (!tradingDay(ltd)) ltd--;
  return ltd;
}

/** day 以後で最初の取引最終日と、その次の月の取引最終日（日の通し番号） */
function contractMonths(day) {
  const d = new Date(day * DAY * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  let l1 = lastTradingDayOf(y, m);
  if (l1 < day) {
    m = m === 12 ? 1 : m + 1;
    if (m === 1) y++;
    l1 = lastTradingDayOf(y, m);
  }
  const [y2, m2] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return [l1, lastTradingDayOf(y2, m2)];
}

/** 標準正規の決まった値（Box–Muller。2 つの hash01 から） */
function gauss(n) {
  const u = Math.max(hash01(n * 2 + 1), 1e-12);
  const v = hash01(n * 2 + 2);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * `/api/atm_daily` と同じ形の合成の応答（架空の値）。取引日だけ（土日・同梱のカレンダーの取引の無い日は行なし）、
 * 範囲の終わり = now の JST の日付（8:00 前は前日。含まない）。原資産は 1 日 1.1% 前後の種つきの酔歩、IV は下げで
 * 上がる架空の反応（1% の下げで約 1 pt）と平均への回帰。1 / 2 限月は毎月の取引最終日で切り替わる（2 限月 = 1 限月の
 * F の 0.02% 上の架空の値）。v1 / v2（1・2 限月の ATM IV。#307）は iv30 から近い限月ほど大きく離れる架空の値。
 */
let dailyCache = null;
export function synthAtmDaily(now = SYNTH_IV_NOW) {
  if (dailyCache && dailyCache.now === now) return dailyCache.body;
  const local = now + JST;
  let endDay = Math.floor(local / DAY);
  if (local - endDay * DAY < 8 * 3600) endDay--;
  const days = [];
  let s = 30000;
  let iv = 19;
  for (let day = DAILY_FIRST_DAY; day < endDay; day++) {
    if (!tradingDay(day)) continue;
    const r = 0.011 * gauss(day);
    s *= Math.exp(r);
    iv = Math.min(
      60,
      Math.max(
        10,
        iv + 0.12 * (19 - iv) - 100 * r * (r < 0 ? 1.2 : 0.6) + 0.4 * gauss(day + 100000),
      ),
    );
    const [l1, l2] = contractMonths(day);
    const f1 = Math.round(s * 100) / 100;
    days.push({
      d: dayIso(day),
      t: `${dayIso(day)}T15:00:00+09:00`,
      iv: Math.round(iv * 1e4) / 1e4,
      f1,
      l1: dayIso(l1),
      f2: Math.round(s * 1.0002 * 100) / 100,
      l2: dayIso(l2),
      // 1・2 限月の ATM IV（#307。架空: 近い限月ほど iv30 から大きく離れる）
      v1: Math.round((iv + 0.3 * (iv - 19)) * 1e4) / 1e4,
      v2: Math.round((iv - 0.1 * (iv - 19) - 0.3) * 1e4) / 1e4,
    });
  }
  const body = { schema_version: 1, start: '2010-01-01', end: dayIso(endDay), days };
  dailyCache = { now, body };
  return body;
}

// ---- AI の中継の偽の応答（#135。架空の文。dev サーバーだけ）
const AI_STATUS_PATH = '/fixtures/ai/status';
const AI_MESSAGES_PATH = '/fixtures/ai/messages';
export const SYNTH_AI_STATUS = {
  schema_version: 1,
  enabled: true,
  model: 'claude-opus-5-5',
  credential: 'fake',
  counted: true,
  limit_usd: 3,
  remaining_usd: 2.4,
  resets_at: '2026-10-14T00:00:00+09:00',
};
/** 偽の SSE の事象の間隔（ms） */
export const SYNTH_AI_STEP_MS = { thinking: 150, writing: 900, chunk: 120 };

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const thousand = (v) =>
  typeof v === 'number'
    ? `${v < 0 ? '−' : ''}${Math.round(Math.abs(v) / 1000).toLocaleString('en-US')} 千円`
    : '—';

const yenX = (v) =>
  typeof v === 'number'
    ? `${v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('en-US')} 円`
    : '—';
const pct = (v) =>
  typeof v === 'number' ? `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v)}%` : '—';

/** 偽の返答の組み立て（要求の本文 → 事象の列。純関数） */
export function synthAiReply(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs.at(-1);
  const blocks = Array.isArray(last?.content) ? last.content : [];
  const result = blocks.find((b) => b?.type === 'tool_result');
  const userText = blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');
  const pre = body?.context?.precomputed ?? {};
  if (result) {
    let r = {};
    try {
      r = JSON.parse(result.content?.[0]?.text ?? '{}');
    } catch {}
    if (Array.isArray(r?.frames)) {
      // technicals（#200）の結果: 日足の RSI と基準率の件数だけを引く（架空の値）
      const f = r.frames[0] ?? {};
      const br = f.base_rates?.rsi ?? f.base_rates?.all ?? {};
      const tf = { weekly: '週足', daily: '日足', '4h': '4 時間足' }[f.tf] ?? f.tf ?? '—';
      const text = `${tf}の RSI は ${f.rsi?.rsi ?? '—'} です。過去に同じ状態だった後の ${f.horizon_bars ?? '—'} 本先は、中央値 ${pct(br.median_pct)}・下位 10% ${pct(br.p10_pct)}・上位 10% ${pct(br.p90_pct)}（件数 ${br.n ?? '—'}${br.insufficient ? '・サンプル不足' : ''}）で、予想ではなく材料です。`;
      return { thinking: 'ツールの結果を読む', text, stop: 'end_turn' };
    }
    if (r?.data?.iv_now_pct !== undefined) {
      // iv_stats（#138・#158）の結果: 今の IV と 1 年の分位、半分戻しの日数の中央値だけを引く（架空の値）
      const y1 = (r.level?.windows ?? []).find((w) => w?.window === '1y') ?? {};
      const half = r.spikes?.summary?.days_to_half ?? {};
      const text = `今の IV は ${r.data.iv_now_pct}% で、過去 1 年の日次の終値の中で今以下の日は ${y1.percentile_pct ?? '—'}% です。過去のスパイクは山から半分戻すまで中央値 ${half.median_days ?? '—'} 日（${half.n ?? '—'} 回${half.insufficient ? '・サンプル不足' : ''}）で、予想ではなく材料です。`;
      return { thinking: 'ツールの結果を読む', text, stop: 'end_turn' };
    }
    if (Array.isArray(r?.rows) && r?.base) {
      // tail_table の結果（「表で」の見本。#234・#232）: 1 列目の長い 3 列の表（文脈の足の 2 本）と、列の多い表
      // （テール表の行）。数字はどれも文脈・ツールの結果の値なので照合で一致する（点線が付かない）
      const legs = (body?.context?.position?.legs ?? [])
        .filter((l) => l?.product === 'op')
        .slice(0, 2);
      const legRow = (l) => {
        const what = l.side === 'sell' ? 'IV が上がると損が膨らむ足' : '急落のときの損を抑える足';
        return `| ${l.type} ${l.k.toLocaleString('en-US')} の${l.side === 'sell' ? '売り' : '買い'}（期近。${what}） | ${l.price.toLocaleString('en-US')} 円 | ${l.qty} 枚 |`;
      };
      const rows = r.rows;
      const days = typeof r.days === 'number' ? Math.round(r.days * 10) / 10 : null;
      const text = [
        '足ごとに比べると次のとおりです。',
        '| 足 | 建値 | 枚数 |',
        '|---|---:|---:|',
        ...legs.map(legRow),
        '',
        '下げの幅ごとの損益です（Δσ と β は今のシナリオのまま）。',
        `| 条件 | ${rows.map((x) => pct(x.shock_pct)).join(' | ')} |`,
        `|---|${rows.map(() => '---').join('|')}|`,
        `| SQ の損益 | ${rows.map((x) => thousand(x.sq_pnl_yen)).join(' | ')} |`,
        `| ${days ?? '—'} 日後の損益 | ${rows.map((x) => thousand(x.scenario_pnl_yen)).join(' | ')} |`,
        '',
        '下げが深いほど必要証拠金も増え、追証の線に近づきます。',
      ].join('\n');
      return { thinking: 'テール表を表にまとめる', text, stop: 'end_turn' };
    }
    if (r?.after && Array.isArray(r?.diff)) {
      // propose_position（#139）の結果: 後の満期の最大損失と必要証拠金だけを引く（架空の値）
      const text = `カードの案を入れると、満期の最大損失は ${thousand(r.after.max_loss_yen)}、必要証拠金は ${thousand(r.after.margin_yen)} です。検討の材料にしてください。`;
      return { thinking: 'ツールの結果を読む', text, stop: 'end_turn' };
    }
    const text = `その条件（${pct(r?.scenario?.dx_pct)}・${r?.scenario?.days ?? '—'} 日・IV +${r?.scenario?.iv_shift_pt ?? '—'}pt）の損益は ${thousand(r?.pnl_yen)} です。満期なら ${thousand(r?.expiry_pnl_yen)} です。`;
    return { thinking: 'ツールの結果を読む', text, stop: 'end_turn' };
  }
  if (body?.kind === 'diagnose') {
    // 架空の文（合成の板からの事前計算の値だけを引く。README の画像にも使う）
    const s = pre.position_summary ?? {};
    const rows = pre.tail_table?.rows ?? [];
    const r10 = rows.find((x) => x?.shock_pct === -10) ?? rows[0] ?? {};
    const r20 = rows.find((x) => x?.shock_pct === -20) ?? rows[1] ?? {};
    const bes = Array.isArray(s?.expiry?.breakevens_x) ? s.expiry.breakevens_x : [];
    const sp = s?.scenario_point ?? {};
    const vega = s?.greeks_now?.vega_yen_per_pt;
    const theta = s?.greeks_now?.theta_yen_per_day;
    const calls = pre.margin_summary?.call_levels_x ?? [];
    const text = [
      '## 弱点 1: 急落で損が膨らむ',
      `下の BEP は ${yenX(bes[0])} です。SQ で −10% なら ${thousand(r10.sq_pnl_yen)}、−20% なら ${thousand(r20.sq_pnl_yen)} と、下げるほど損が加速します。`,
      '## 弱点 2: IV の上昇に弱い',
      `V は ${thousand(vega)} / pt で、IV が上がるほど損が出ます。今のシナリオの点（${sp.days ?? '—'} 日後・ΔX ${pct(sp.dx_pct)}）では ${thousand(sp.pnl_yen)} で、下げと IV の上昇が重なると時間の利益を打ち消します。`,
      calls.length > 0 ? '## 弱点 3: 追証の線までの距離' : '## 弱点 3: 時間の経過に頼る',
      calls.length > 0
        ? `余力（概算）が 0 になる原資産は ${calls.map(yenX).join('、')} です。下側の線を越えると、資金を足すか建玉を減らす必要があります。`
        : `Θ は ${thousand(theta)} / 日の受け取りで、利益は時間の経過に頼っています。`,
      '## 確かめるとよいこと',
      '- 急落のプリセットで、追証の線との距離を見る',
      '- 下側にプットの買いを足したヘッジ案をピンで重ねる',
    ].join('\n');
    return { thinking: '事前計算のテール表と格子を見る', text, stop: 'end_turn' };
  }
  if (body?.kind === 'ask') {
    // [AI に聞く]（#136）: 質問の文の見出しと説明の節を引くだけの架空の文（ツールを呼ばない）
    const title = /›「(.+?)」\n/.exec(userText)?.[1] ?? '—';
    const doc = /説明の節: ([^・\n]+)/.exec(userText)?.[1] ?? 'マニュアル';
    const text = [
      `「${title}」は、今のポジションとシナリオから simulator が計算した値です（${doc}）。`,
      'どの足・どの条件から来ているかは、指標 · テールの内訳とテール表で確かめられます。',
    ].join('\n');
    return { thinking: '説明の節を読む', text, stop: 'end_turn' };
  }
  if (userText.includes('表で')) {
    // 返答の表（#234）と用語のリンク（#232）の見本: tail_table を呼び、その結果と文脈の足の値で表を書く（下）
    return {
      thinking: '表にまとめる',
      text: '',
      stop: 'tool_use',
      tool: { id: `toolu_dev_${msgs.length}`, name: 'tail_table', input: {} },
    };
  }
  if (userText.includes('ヘッジ')) {
    // ポジションの提案（#139）: 行使価格は simulator に選ばせる（|Δ| 0.05 の put の買いを今のタブに足す）
    return {
      thinking: 'ヘッジの足を探す',
      text: '',
      stop: 'tool_use',
      tool: {
        id: `toolu_dev_${msgs.length}`,
        name: 'propose_position',
        input: {
          target: 'current',
          changes: [{ action: 'add', type: 'P', side: 'buy', abs_delta: 0.05 }],
        },
      },
    };
  }
  if (userText.includes('分位')) {
    // iv_stats（#138・#158）: 今の IV の分位とスパイクの萎み方
    return {
      thinking: 'IV の統計を読む',
      text: '',
      stop: 'tool_use',
      tool: {
        id: `toolu_dev_${msgs.length}`,
        name: 'iv_stats',
        input: { sections: ['level', 'spikes'] },
      },
    };
  }
  if (userText.includes('RSI')) {
    return {
      thinking: 'テクニカルを読む',
      text: '',
      stop: 'tool_use',
      tool: {
        id: `toolu_dev_${msgs.length}`,
        name: 'technicals',
        input: { timeframes: ['daily'] },
      },
    };
  }
  if (userText.includes('切断')) {
    return { thinking: '考える', text: '途中まで書いて', stop: null, cut: true };
  }
  return {
    thinking: '条件を決めてツールを呼ぶ',
    text: '',
    stop: 'tool_use',
    tool: {
      id: `toolu_dev_${msgs.length}`,
      name: 'evaluate_scenario',
      input: { dx_pct: -6, days: 3, iv_shift_pt: 5 },
    },
  };
}

function serveAiMessages(req, res) {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end('{"error":"bad_request"}');
      return;
    }
    const reply = synthAiReply(body);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const timers = [];
    let closed = false;
    res.on('close', () => {
      closed = true;
      for (const t of timers) clearTimeout(t);
    });
    const at = (ms, fn) =>
      timers.push(
        setTimeout(() => {
          if (!closed) fn();
        }, ms),
      );
    res.write(
      sse('accepted', {
        remaining_usd: SYNTH_AI_STATUS.remaining_usd,
        limit_usd: 3,
        counted: true,
      }),
    );
    const { thinking, writing, chunk } = SYNTH_AI_STEP_MS;
    at(thinking, () => res.write(sse('progress', { phase: 'thinking' })));
    at(thinking * 2, () => res.write(sse('thinking', { text: reply.thinking })));
    let t = writing;
    const content = [{ type: 'thinking', thinking: reply.thinking, signature: 'ZGV2LWZha2U=' }];
    if (reply.text) {
      at(t, () => res.write(sse('progress', { phase: 'writing' })));
      const parts = reply.text.match(/[\s\S]{1,24}/g) ?? [];
      for (const p of parts) {
        t += chunk;
        at(t, () => res.write(sse('text', { text: p })));
      }
      content.push({ type: 'text', text: reply.text });
    }
    if (reply.tool) {
      t += chunk;
      at(t, () => {
        res.write(sse('progress', { phase: 'tool' }));
        res.write(sse('tool_use', reply.tool));
      });
      content.push({ type: 'tool_use', ...reply.tool });
    }
    t += chunk;
    at(t, () => {
      if (!reply.cut) {
        res.write(
          sse('done', {
            stop_reason: reply.stop,
            content,
            remaining_usd: SYNTH_AI_STATUS.remaining_usd - 0.1,
          }),
        );
      }
      res.end();
    });
  });
}

/** @returns {import('vite').Plugin} */
export function serveSyntheticFixtures() {
  return {
    name: 'serve-synthetic-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (path === AI_STATUS_PATH) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(SYNTH_AI_STATUS));
          return;
        }
        if (path === AI_MESSAGES_PATH && req.method === 'POST') {
          serveAiMessages(req, res);
          return;
        }
        if (path === ATM_DAILY_PATH) {
          // パラメータは読まない（サーバーと同じ）
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(synthAtmDaily()));
          return;
        }
        if (path === ATM_IV_PATH || path === FUTURE_BARS_PATH) {
          // 検査はサーバーと同じ（/api/future_bars は /api/atm_iv と同じ parse_request）
          const q = atmIvQuery(req.url ?? '');
          const body =
            q &&
            (path === ATM_IV_PATH ? synthAtmIv(q.tf, q.range) : synthFutureBars(q.tf, q.range));
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
