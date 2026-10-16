import { expect } from 'vitest';

/**
 * 性能テストの計測（tests/model/perf.test.ts・tests/ui/perf.test.ts で共用）。
 *
 * - 予算は環境変数 PERF_BUDGET_MS（未設定は 200 ms = `npm test`・CI。桁違いの悪化だけを落とす）。
 *   16 ms の判定は `npm run perf`（scripts/perf.mjs が PERF_BUDGET_MS=16 を入れ、2 ファイルだけを並列なしで走らせる）
 * - 判定は最小値（他の処理の割り込みを除く）。中央値は表示だけ
 * - 最小値が予算以上なら同じ回数をもう 1 巡測り、全回の最小値で判定し直す（最大 MAX_ROUNDS 巡）
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

/** 予算の既定（`npm test`・CI） */
export const DEFAULT_BUDGET_MS = 200;

/** 計測の巡の上限（初回 + やり直し 2 巡） */
export const MAX_ROUNDS = 3;

/** PERF_BUDGET_MS を読む。正の有限数でなければ throw（黙って既定に戻さない） */
export function parseBudget(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_BUDGET_MS;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`PERF_BUDGET_MS は正の数（ms）: ${JSON.stringify(raw)}`);
  }
  return v;
}

export const BUDGET_MS = parseBudget(env?.PERF_BUDGET_MS);

/**
 * 記録のみの計測の回数。`npm run perf`（PERF_FULL=1）は 5 回、`npm test`・CI は 1 回（記録のみの重い計測が
 * 他の負荷で既定の timeout に掛からないように。判定する計測の回数はこれに依らない）
 */
export const RECORD_RUNS = env?.PERF_FULL === '1' ? 5 : 1;

export interface MeasureOptions<T> {
  /** ウォームアップ（JIT）の回数。計測しない */
  warmup: number;
  /** 1 巡の計測の回数 */
  runs: number;
  /** 毎回の計測の前に走る準備（計測に入れない） */
  before?: () => void;
  /** 毎回の計測の後に走る検査（計測に入れない） */
  after?: (v: T) => void;
}

export interface Measured {
  /** 全回の最小値（ms） */
  min: number;
  /** 全回の中央値（ms。表示だけ） */
  median: number;
  /** 計測した回数（全巡の合計） */
  runs: number;
  /** やり直した巡の数（0 = 初回だけ） */
  retries: number;
}

function summarize(times: readonly number[], retries: number): Measured {
  const a = [...times].sort((p, q) => p - q);
  return {
    min: a[0] ?? Number.NaN,
    median: a[Math.floor(a.length / 2)] ?? Number.NaN,
    runs: a.length,
    retries,
  };
}

function round<T>(fn: () => T, opts: MeasureOptions<T>, times: number[]): void {
  for (let i = 0; i < opts.runs; i++) {
    opts.before?.();
    const t0 = performance.now();
    const v = fn();
    times.push(performance.now() - t0);
    opts.after?.(v);
  }
}

function warm<T>(fn: () => T, opts: MeasureOptions<T>): void {
  for (let i = 0; i < opts.warmup; i++) {
    opts.before?.();
    fn();
  }
}

/** ウォームアップの後に runs 回測る（1 巡。やり直しなし） */
export function measure<T>(fn: () => T, opts: MeasureOptions<T>): Measured {
  warm(fn, opts);
  const times: number[] = [];
  round(fn, opts, times);
  return summarize(times, 0);
}

/**
 * 予算で判定する計測。最小値が予算以上なら runs 回をもう 1 巡（最大 MAX_ROUNDS 巡）測り、
 * 全回の最小値 < BUDGET_MS を expect する。最小値・中央値・閾値・回数を表示する。
 */
export function expectWithinBudget<T>(
  label: string,
  fn: () => T,
  opts: MeasureOptions<T>,
): Measured {
  warm(fn, opts);
  const times: number[] = [];
  round(fn, opts, times);
  let rounds = 1;
  while (Math.min(...times) >= BUDGET_MS && rounds < MAX_ROUNDS) {
    round(fn, opts, times);
    rounds++;
  }
  const r = summarize(times, rounds - 1);
  console.info(
    `${label}: 最小 ${r.min.toFixed(2)} ms / 中央値 ${r.median.toFixed(2)} ms（閾値 ${BUDGET_MS} ms・${r.runs} 回・やり直し ${r.retries}）`,
  );
  expect(r.min, `${label}: 最小値が閾値 ${BUDGET_MS} ms 以上`).toBeLessThan(BUDGET_MS);
  return r;
}

/** 記録のみの計測（判定しない。最小値・中央値を表示する） */
export function record<T>(label: string, fn: () => T, opts: MeasureOptions<T>): Measured {
  const r = measure(fn, opts);
  console.info(
    `${label}: 最小 ${r.min.toFixed(2)} ms / 中央値 ${r.median.toFixed(2)} ms（${r.runs} 回・記録のみ）`,
  );
  return r;
}
