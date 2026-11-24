/**
 * JSCC の VaR パラメータ（`/api/jscc_scenarios`。#382・docs/design.md 5.10・7.1・ADR-0013）の応答の型と検証、要求の銘柄の
 * キー、基準日（純関数。DOM・通信に依存しない）。読み込みは data/adapter.ts の loadJsccScenarios。
 *
 * - 応答（ok）: `{ schema_version: 1, status: "ok", business_date, confidence_level, stress_scenario_number,
 *   scenario_types: "HH…S", instruments: [{ key, aggregation_group, contract_size, price, pnl: [int…] }], missing: [key…] }`
 * - 応答（unavailable）: `{ schema_version: 1, status: "unavailable", reason, business_date }`。reason = not_ready（基準日の
 *   取り込みが済んでいない）/ inconsistent（表の間で取り込みの ID が違う = 取り直しの途中）/ no_source（供給元に無い）
 * - 基準日 = 板の時刻の取引日の前営業日（証券会社の必要委託は前営業日の清算値で 1 日固定）。取引日 = 板の時刻の JST の
 *   日付、17:00 以降（夜間）か休業日なら次の営業日。休業日は取引カレンダーの版の全行（祝日取引の日は JSCC の営業日に
 *   数えない読み）
 * - サーバーは api/src/simulator_api/jscc.py
 */

import type { JsccData, JsccFactorRow, JsccFactors, JsccInstrument, Leg } from '../model';
import { jsccKeyOfLeg } from '../model';
import {
  type Holidays,
  isBusinessDay,
  nextBusinessDay,
  previousBusinessDay,
  sqDate,
} from '../model/time';
import { isIsoDate, jstDate } from './calendar';
import type { ValidationResult } from './chainJson';

export const JSCC_SCHEMA_VERSION = 1;
/** これより前の営業日のデータは無い（optionchan の取り込みの始まり。API の JSCC_MIN_DATE と同じ） */
export const JSCC_MIN_DATE = '2026-11-16';
/** 1 要求の銘柄の上限と限月の上限（API と同じ。超えたら分けて読む） */
export const JSCC_MAX_KEYS = 64;
export const JSCC_MAX_PERIODS = 4;
/** 失敗・未取り込み（not_ready）を同じ (日, 銘柄) で聞き直さない時間（ミリ秒） */
export const JSCC_RETRY_MS = 5 * 60_000;

/** 銘柄のキーの形（API の i= と同じ） */
export const JSCC_KEY_RE = /^(NK225E-\d{6}-[CP]-[1-9]\d{0,6}|NK225(F|MF|MCF)-\d{6})$/;

/** JSCC の計算にできない理由のうち、読み込みの側のもの */
/**
 * no_recent = 当て直しの r・g が、基準日から遡って JSCC_FACTOR_MAX_BACK 営業日に使える日が無い（#387。/api/jscc_factors だけ）
 */
export type JsccFetchReason = 'loading' | 'not_ready' | 'error' | 'no_source' | 'no_recent';

/** 画面が持つ JSCC の状態（今の必要証拠金の入力） */
export type JsccInput =
  | { status: 'ok'; data: JsccData }
  | { status: 'unavailable'; reason: JsccFetchReason };

const JST_HOUR_MS = 3_600_000;
/** 夜間の始まり（JST の時。17:00 以降は次の取引日） */
const NIGHT_FROM_HOUR = 17;

/** 板の時刻（epoch ミリ秒）の取引日（YYYY-MM-DD） */
export function tradingDayOf(t: number, holidays: Holidays): string {
  const d = jstDate(t);
  const hour = new Date(t + 9 * JST_HOUR_MS).getUTCHours();
  if (hour >= NIGHT_FROM_HOUR || !isBusinessDay(d, holidays)) return nextBusinessDay(d, holidays);
  return d;
}

/**
 * 基準日（JSCC の営業日）= 取引日の前営業日。minDate（既定はデータの始まり JSCC_MIN_DATE。dev の合成の応答は null =
 * 見ない）より前なら null。t が有限でなければ null
 */
export function jsccBaseDate(
  t: number,
  holidays: Holidays,
  minDate: string | null = JSCC_MIN_DATE,
): string | null {
  if (!Number.isFinite(t)) return null;
  const base = previousBusinessDay(tradingDayOf(t, holidays), holidays);
  return minDate === null || base >= minDate ? base : null;
}

/**
 * 要求する銘柄のキー（足から。重複なし・昇順）。限月が基準日の月より前の足（SQ を過ぎた）は入れない。
 * キーにできない足（限月・行使価格の形が外れた）は入れない（計算の側で missing になる）
 */
export function jsccRequestKeys(legs: readonly Leg[], baseDate: string): string[] {
  const minPeriod = baseDate.slice(0, 4) + baseDate.slice(5, 7);
  const out = new Set<string>();
  for (const leg of legs) {
    const key = jsccKeyOfLeg(leg);
    if (key === null) continue;
    const period = key.split('-')[1] as string;
    if (period >= minPeriod) out.add(key);
  }
  return [...out].sort();
}

/** キーの限月（YYYYMM） */
export const jsccPeriodOf = (key: string): string => key.split('-')[1] as string;

/** 要求を API の上限（銘柄 64・限月 4）で分ける（限月の塊は分けない。1 限月で 64 を超えたらその限月を分ける） */
export function jsccChunks(keys: readonly string[]): string[][] {
  const byPeriod = new Map<string, string[]>();
  for (const k of keys) {
    const p = jsccPeriodOf(k);
    const list = byPeriod.get(p);
    if (list) list.push(k);
    else byPeriod.set(p, [k]);
  }
  const out: string[][] = [];
  let cur: string[] = [];
  let periods = new Set<string>();
  for (const [p, list] of [...byPeriod].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const k of list) {
      if (cur.length >= JSCC_MAX_KEYS || (!periods.has(p) && periods.size >= JSCC_MAX_PERIODS)) {
        out.push(cur);
        cur = [];
        periods = new Set();
      }
      cur.push(k);
      periods.add(p);
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** 検証した応答 */
export type JsccResponse =
  | { status: 'ok'; data: JsccData; missing: string[] }
  | { status: 'unavailable'; reason: 'not_ready' | 'no_source' };

const MAX_ERRORS = 50;

/**
 * `/api/jscc_scenarios` の JSON の検査。date は要求した基準日、keys は要求したキー（応答の銘柄は要求した中にあること）。
 * 余分なキーは見ない
 */
export function validateJsccJson(
  v: unknown,
  date: string,
  keys: readonly string[],
): ValidationResult<JsccResponse> {
  const errors: string[] = [];
  const add = (path: string, msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path}: ${msg}`);
  };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, errors: ['$: オブジェクトでない'] };
  }
  const o = v as Record<string, unknown>;
  if (o.schema_version !== JSCC_SCHEMA_VERSION) {
    add('$.schema_version', `${JSCC_SCHEMA_VERSION} でない`);
  }
  if (o.business_date !== date || !isIsoDate(o.business_date)) {
    add('$.business_date', '要求した基準日でない');
  }
  if (o.status === 'unavailable') {
    if (errors.length > 0) return { ok: false, errors };
    // inconsistent（取り直しの途中）も画面では「基準日のデータがまだ無い」と同じ扱い
    const reason = o.reason === 'no_source' ? 'no_source' : 'not_ready';
    return { ok: true, value: { status: 'unavailable', reason } };
  }
  if (o.status !== 'ok') {
    add('$.status', 'ok / unavailable でない');
    return { ok: false, errors };
  }
  const conf = o.confidence_level;
  if (typeof conf !== 'number' || !(conf > 0 && conf < 100)) {
    add('$.confidence_level', '0 より大きく 100 より小さい数でない');
  }
  const types = o.scenario_types;
  let isHist: boolean[] = [];
  if (typeof types !== 'string' || !/^[HS]+$/.test(types)) {
    add('$.scenario_types', 'H と S の並びでない');
  } else {
    isHist = [...types].map((c) => c === 'H');
  }
  const nh = isHist.filter(Boolean).length;
  const ns = isHist.length - nh;
  const nStress = o.stress_scenario_number;
  if (typeof nStress !== 'number' || !Number.isInteger(nStress) || nStress < 0 || nStress > ns) {
    add('$.stress_scenario_number', '0〜S の本数の整数でない');
  }
  if (isHist.length > 0 && nh === 0) add('$.scenario_types', 'H が無い');
  const want = new Set(keys);
  const instruments = new Map<string, JsccInstrument>();
  if (!Array.isArray(o.instruments)) add('$.instruments', '配列でない');
  else {
    o.instruments.forEach((x, i) => {
      const p = `$.instruments[${i}]`;
      if (typeof x !== 'object' || x === null || Array.isArray(x)) {
        add(p, 'オブジェクトでない');
        return;
      }
      const r = x as Record<string, unknown>;
      const key = r.key;
      if (typeof key !== 'string' || !want.has(key) || instruments.has(key)) {
        add(`${p}.key`, '要求した銘柄でない・重複');
        return;
      }
      if (typeof r.aggregation_group !== 'string' || r.aggregation_group === '') {
        add(`${p}.aggregation_group`, '文字列でない');
        return;
      }
      const cs = r.contract_size;
      if (typeof cs !== 'number' || !Number.isInteger(cs) || cs <= 0) {
        add(`${p}.contract_size`, '正の整数でない');
        return;
      }
      const price = r.price;
      if (price !== null && (typeof price !== 'number' || !Number.isFinite(price))) {
        add(`${p}.price`, '数か null でない');
        return;
      }
      const pnl = r.pnl;
      if (!Array.isArray(pnl) || pnl.length !== isHist.length) {
        add(`${p}.pnl`, 'シナリオの本数の配列でない');
        return;
      }
      const arr = new Float64Array(pnl.length);
      for (let j = 0; j < pnl.length; j++) {
        const y = pnl[j];
        if (typeof y !== 'number' || !Number.isSafeInteger(y)) {
          add(`${p}.pnl[${j}]`, '整数でない');
          return;
        }
        arr[j] = y;
      }
      instruments.set(key, {
        aggregationGroup: r.aggregation_group,
        contractSize: cs,
        price: price as number | null,
        pnl: arr,
      });
    });
  }
  const missing: string[] = [];
  if (!Array.isArray(o.missing)) add('$.missing', '配列でない');
  else {
    for (const m of o.missing) {
      if (typeof m !== 'string' || !want.has(m) || instruments.has(m)) {
        add('$.missing', '要求した銘柄でない・行のある銘柄');
        break;
      }
      missing.push(m);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      status: 'ok',
      data: {
        businessDate: date,
        set: { isHist, confidence: conf as number, nStress: nStress as number },
        instruments,
      },
      missing,
    },
  };
}

/**
 * 分けて読んだ応答を 1 つに（どれかが unavailable ならそれ。シナリオの並び・パラメータが違えば null = 読めない扱い）
 */
export function mergeJsccResponses(rs: readonly JsccResponse[]): JsccResponse | null {
  const first = rs[0];
  if (!first) return null;
  for (const r of rs) if (r.status === 'unavailable') return r;
  if (first.status !== 'ok') return first;
  const instruments = new Map(first.data.instruments);
  const missing = [...first.missing];
  const s0 = first.data.set;
  for (const r of rs.slice(1)) {
    if (r.status !== 'ok') return r;
    const s = r.data.set;
    if (
      s.confidence !== s0.confidence ||
      s.nStress !== s0.nStress ||
      s.isHist.length !== s0.isHist.length ||
      s.isHist.some((h, i) => h !== s0.isHist[i])
    ) {
      return null;
    }
    for (const [k, v] of r.data.instruments) instruments.set(k, v);
    missing.push(...r.missing);
  }
  return { status: 'ok', data: { ...first.data, instruments }, missing };
}

/** 要求の URL（?date=&i=…。キーは昇順のまま） */
export function jsccUrl(endpoint: string, date: string, keys: readonly string[]): string {
  const q = new URLSearchParams();
  q.set('date', date);
  for (const k of keys) q.append('i', k);
  return `${endpoint}?${q.toString()}`;
}

// ---------------------------------------------------------------- 当て直しの r・g（#387）

/** 遡る範囲の暦日の上限（API の JSCC_FACTOR_RANGE_DAYS と同じ。応答の business_date の検査） */
export const JSCC_FACTOR_MAX_BACK_DAYS = 21;
/** `/api/jscc_factors` の 1 要求の限月の上限（API と同じ。超えたら分けて読む） */
export const JSCC_FACTOR_MAX_PERIODS = 24;
/** r・g の整数の刻み（API の scale と同じでなければ不正） */
export const JSCC_FACTOR_SCALE = { r: 1_000_000, g: 10_000 } as const;
/** 行のキー（`商品-YYYYMM`） */
export const JSCC_FACTOR_KEY_RE = /^(NK225E|NK225F|NK225MF|NK225MCF)-(\d{6})$/;
const NODE_COUNT = 13;

/** 画面が持つ当て直しの r・g の状態（シナリオの点・テール・追証の線の入力） */
export type JsccFactorsInput =
  | { status: 'ok'; data: JsccFactors }
  | { status: 'unavailable'; reason: JsccFetchReason };

/** 検証した応答 */
export type JsccFactorsResponse =
  | { status: 'ok'; data: JsccFactors; missing: string[] }
  | { status: 'unavailable'; reason: 'not_ready' | 'no_source' | 'no_recent' };

/**
 * 要求する限月（YYYYMM。足の OP の限月・先物の限月。昇順・重複なし）。基準日の月より前（SQ を過ぎた）は入れない
 */
export function jsccFactorPeriods(
  legs: readonly Leg[],
  baseDate: string,
  holidays: Holidays,
): string[] {
  const minPeriod = baseDate.slice(0, 4) + baseDate.slice(5, 7);
  const out = new Set<string>();
  for (const leg of legs) {
    const id = leg.kind === 'option' ? leg.expiry : leg.contract;
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(id);
    if (!m) continue;
    const p = `${m[1]}${m[2]}`;
    if (p < minPeriod) continue;
    // SQ が基準日以前の限月（満了。SQ 当日の表に載るかは未確認なので SQ 当日も入れない = 保守的に）は要求しない。
    // 満了の限月が混じると API が「限月がすべてある日」を探して基準日を捨ててしまう（#387 レビュー B1）
    if (p === minPeriod && sqDate(Number(m[1]), Number(m[2]), holidays) <= baseDate) continue;
    out.add(p);
  }
  return [...out].sort();
}

/** 限月を API の上限で分ける */
export function jsccFactorChunks(periods: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < periods.length; i += JSCC_FACTOR_MAX_PERIODS) {
    out.push(periods.slice(i, i + JSCC_FACTOR_MAX_PERIODS));
  }
  return out;
}

/** 要求の URL（?date=&p=…。at = 使う日をそろえる = 分けて読む 2 回目以降。#387 レビュー N3） */
export function jsccFactorsUrl(
  endpoint: string,
  date: string,
  periods: readonly string[],
  at: string | null = null,
): string {
  const q = new URLSearchParams();
  q.set('date', date);
  for (const p of periods) q.append('p', p);
  if (at !== null) q.set('at', at);
  return `${endpoint}?${q.toString()}`;
}

/**
 * `/api/jscc_factors` の JSON の検査（#387）。date は要求した基準日、periods は要求した限月。行は要求した限月だけ、
 * r は本数の整数（|r| ≤ 1 = 1e6）、g は 13 × 本数の整数（|g| ≤ 3 = 3e4）か null。節点は 13 個の昇順。
 * forward（基準日の F。#395）は正の数か、無い・null（古い応答 = 急変の係数を使わない）
 */
export function validateJsccFactorsJson(
  v: unknown,
  date: string,
  periods: readonly string[],
): ValidationResult<JsccFactorsResponse> {
  const errors: string[] = [];
  const add = (path: string, msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path}: ${msg}`);
  };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, errors: ['$: オブジェクトでない'] };
  }
  const o = v as Record<string, unknown>;
  if (o.schema_version !== JSCC_SCHEMA_VERSION)
    add('$.schema_version', `${JSCC_SCHEMA_VERSION} でない`);
  // 使った日（business_date）は基準日か、それより前で直近の使える日（遡る = #387。JSCC_FACTOR_MAX_BACK_DAYS 暦日まで）
  const used = o.business_date;
  if (
    !isIsoDate(used) ||
    used > date ||
    Date.parse(`${date}T00:00:00Z`) - Date.parse(`${used}T00:00:00Z`) >
      JSCC_FACTOR_MAX_BACK_DAYS * 86_400_000
  ) {
    add('$.business_date', '基準日か遡る範囲の日でない');
  }
  if (o.status === 'unavailable') {
    if (o.business_date !== date) add('$.business_date', '要求した基準日でない');
    if (errors.length > 0) return { ok: false, errors };
    const reason =
      o.reason === 'no_source' ? 'no_source' : o.reason === 'no_recent' ? 'no_recent' : 'not_ready';
    return { ok: true, value: { status: 'unavailable', reason } };
  }
  if (o.requested_date !== date) add('$.requested_date', '要求した基準日でない');
  if (o.status !== 'ok') {
    add('$.status', 'ok / unavailable でない');
    return { ok: false, errors };
  }
  const conf = o.confidence_level;
  if (typeof conf !== 'number' || !(conf > 0 && conf < 100)) {
    add('$.confidence_level', '0 より大きく 100 より小さい数でない');
  }
  const types = o.scenario_types;
  let isHist: boolean[] = [];
  if (typeof types !== 'string' || !/^[HS]+$/.test(types))
    add('$.scenario_types', 'H と S の並びでない');
  else isHist = [...types].map((c) => c === 'H');
  const n = isHist.length;
  const nh = isHist.filter(Boolean).length;
  if (n > 0 && nh === 0) add('$.scenario_types', 'H が無い');
  const nStress = o.stress_scenario_number;
  if (
    typeof nStress !== 'number' ||
    !Number.isInteger(nStress) ||
    nStress < 0 ||
    nStress > n - nh
  ) {
    add('$.stress_scenario_number', '0〜S の本数の整数でない');
  }
  const scale = o.scale as Record<string, unknown> | null;
  if (
    typeof scale !== 'object' ||
    scale === null ||
    scale.r !== JSCC_FACTOR_SCALE.r ||
    scale.g !== JSCC_FACTOR_SCALE.g
  ) {
    add('$.scale', '刻みが違う');
  }
  const nodes = o.nodes;
  if (
    !Array.isArray(nodes) ||
    nodes.length !== NODE_COUNT ||
    !nodes.every(
      (x, i) =>
        typeof x === 'number' && Number.isFinite(x) && (i === 0 || x > (nodes[i - 1] as number)),
    )
  ) {
    add('$.nodes', '13 個の昇順の数でない');
  }
  const want = new Set(periods);
  const rows = new Map<string, JsccFactorRow>();
  const ints = (a: unknown, len: number, max: number, div: number): Float64Array | null => {
    if (!Array.isArray(a) || a.length !== len) return null;
    const out = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      const y = a[j];
      if (typeof y !== 'number' || !Number.isInteger(y) || Math.abs(y) > max) return null;
      out[j] = y / div;
    }
    return out;
  };
  if (!Array.isArray(o.rows)) add('$.rows', '配列でない');
  else {
    o.rows.forEach((x, i) => {
      const p = `$.rows[${i}]`;
      if (typeof x !== 'object' || x === null || Array.isArray(x)) {
        add(p, 'オブジェクトでない');
        return;
      }
      const r = x as Record<string, unknown>;
      const key = r.key;
      const km = typeof key === 'string' ? JSCC_FACTOR_KEY_RE.exec(key) : null;
      if (!km || !want.has(km[2] as string) || rows.has(key as string)) {
        add(`${p}.key`, '要求した限月の行でない・重複');
        return;
      }
      const rr = ints(r.r, n, JSCC_FACTOR_SCALE.r, JSCC_FACTOR_SCALE.r);
      if (!rr) {
        add(`${p}.r`, '本数の整数（|r| ≤ 1）の配列でない');
        return;
      }
      const rel = (x: unknown, name: string): number | null | undefined => {
        if (x === undefined || x === null) return null;
        if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) {
          add(`${p}.${name}`, '0 以上の数か null でない');
          return undefined;
        }
        return x;
      };
      const med = rel(r.check_median_rel, 'check_median_rel');
      const p90 = rel(r.check_p90_rel, 'check_p90_rel');
      if (med === undefined || p90 === undefined) return;
      // 基準日の F（#395。急変の係数の x）。無い・null = forward を返す前の応答（古いキャッシュ）= 係数を使わない
      let forward: number | null = null;
      if (r.forward !== undefined && r.forward !== null) {
        if (typeof r.forward !== 'number' || !Number.isFinite(r.forward) || !(r.forward > 0)) {
          add(`${p}.forward`, '正の数か null でない');
          return;
        }
        forward = r.forward;
      }
      let g: Float64Array | null = null;
      if (r.g !== null) {
        g = ints(r.g, n * NODE_COUNT, 3 * JSCC_FACTOR_SCALE.g, JSCC_FACTOR_SCALE.g);
        if (!g) {
          add(`${p}.g`, '13 × 本数の整数（|g| ≤ 3）の配列か null でない');
          return;
        }
      }
      rows.set(key as string, { r: rr, g, checkMedianRel: med, checkP90Rel: p90, forward });
    });
  }
  const missing: string[] = [];
  if (!Array.isArray(o.missing)) add('$.missing', '配列でない');
  else {
    for (const m of o.missing) {
      if (typeof m !== 'string' || !want.has(m)) {
        add('$.missing', '要求した限月でない');
        break;
      }
      missing.push(m);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      status: 'ok',
      data: {
        businessDate: used as string,
        set: { isHist, confidence: conf as number, nStress: nStress as number },
        nodes: nodes as number[],
        rows,
      },
      missing,
    },
  };
}

/** 分けて読んだ応答を 1 つに（どれかが unavailable ならそれ。並び・節点が違えば null = 読めない扱い） */
export function mergeJsccFactors(rs: readonly JsccFactorsResponse[]): JsccFactorsResponse | null {
  const first = rs[0];
  if (!first) return null;
  for (const r of rs) if (r.status === 'unavailable') return r;
  if (first.status !== 'ok') return first;
  const rows = new Map(first.data.rows);
  const missing = [...first.missing];
  const s0 = first.data.set;
  for (const r of rs.slice(1)) {
    if (r.status !== 'ok') return r;
    const s = r.data.set;
    if (
      s.confidence !== s0.confidence ||
      s.nStress !== s0.nStress ||
      s.isHist.length !== s0.isHist.length ||
      s.isHist.some((h, i) => h !== s0.isHist[i]) ||
      r.data.nodes.some((x, i) => x !== first.data.nodes[i]) ||
      r.data.businessDate !== first.data.businessDate
    ) {
      return null;
    }
    for (const [k, v] of r.data.rows) rows.set(k, v);
    missing.push(...r.missing);
  }
  return { status: 'ok', data: { ...first.data, rows }, missing };
}
