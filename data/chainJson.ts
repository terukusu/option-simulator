/**
 * 板の JSON（`GET /api/chain` の応答と `file` アダプタの入力。同じ形）。設計 docs/design.md 7.1。
 *
 * - 外から来るので実行時に検証する（validateChainJson）。依存は増やさず手書きの検証
 * - 欠損は null（キー自体の省略は、任意と書いたキーだけ許す）。知らないキーは無視（前方互換）
 * - 時刻は ISO 8601 の文字列で **オフセット付き**（例 `2026-10-13T21:31:00+09:00`）。
 *   optionchan の DATETIME（JST の壁時計）はサーバーが +09:00 を付けて返す
 * - 日付は `YYYY-MM-DD`（JST の暦日）、限月は `YYYY-MM`
 * - IV は **%**（optionchan / JPX の表示と同じ。例 25.31）。model/ に渡すときに小数（0.2531）にする
 * - 価格は円。オプションは整数円だが、検証は有限の非負数として受ける
 * - JPX グリーク（delta〜vega）は単位が未確定（縦切り 2 の作業項目。AC7）なので値をそのまま運ぶ
 */

import {
  type ChainJson as ChainJsonValue,
  type ChainRow,
  type ChainSide,
  SCHEMA_VERSION,
} from './chainTypes';

export * from './chainTypes';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const REASONS = ['latest', 'pre_open', 'after_close', 'closed'] as const;

/** 1 つの入力で報告するエラーの上限（巨大な壊れた入力で文字列を作りすぎない） */
const MAX_ERRORS = 50;

class Checker {
  readonly errors: string[] = [];

  fail(path: string, msg: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(`${path}: ${msg}`);
  }

  get full(): boolean {
    return this.errors.length >= MAX_ERRORS;
  }

  object(v: unknown, path: string): Record<string, unknown> | null {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail(path, 'オブジェクトでない');
      return null;
    }
    return v as Record<string, unknown>;
  }

  has(o: Record<string, unknown>, key: string, path: string): boolean {
    if (!Object.hasOwn(o, key)) {
      this.fail(`${path}.${key}`, 'キーが無い（欠損は null）');
      return false;
    }
    return true;
  }

  /** 有限の数（min 以上）か null。optional なら省略も null として受ける。 */
  num(
    o: Record<string, unknown>,
    key: string,
    path: string,
    opts: { nullable?: boolean; min?: number; integer?: boolean; optional?: boolean } = {},
  ): number | null {
    const p = `${path}.${key}`;
    if (!Object.hasOwn(o, key)) {
      if (opts.optional) return null;
      this.fail(p, 'キーが無い（欠損は null）');
      return null;
    }
    const v = o[key];
    if (v === null) {
      if (opts.nullable || opts.optional) return null;
      this.fail(p, 'null は不可');
      return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(p, '有限の数でない');
      return null;
    }
    if (opts.min !== undefined && v < opts.min) {
      this.fail(p, `${opts.min} 未満`);
      return null;
    }
    if (opts.integer && !Number.isInteger(v)) {
      this.fail(p, '整数でない');
      return null;
    }
    return v;
  }

  str(
    o: Record<string, unknown>,
    key: string,
    path: string,
    opts: { nullable?: boolean; optional?: boolean; pattern?: RegExp; what?: string } = {},
  ): string | null {
    const p = `${path}.${key}`;
    if (!Object.hasOwn(o, key)) {
      if (opts.optional) return null;
      this.fail(p, 'キーが無い（欠損は null）');
      return null;
    }
    const v = o[key];
    if (v === null) {
      if (opts.nullable || opts.optional) return null;
      this.fail(p, 'null は不可');
      return null;
    }
    if (typeof v !== 'string') {
      this.fail(p, '文字列でない');
      return null;
    }
    if (opts.pattern && !opts.pattern.test(v)) {
      this.fail(p, `${opts.what ?? '形式'}が不正`);
      return null;
    }
    return v;
  }

  instant(o: Record<string, unknown>, key: string, path: string, nullable: boolean) {
    const v = this.str(o, key, path, {
      nullable,
      pattern: ISO_INSTANT,
      what: 'ISO 8601（オフセット付き）の時刻',
    });
    if (v !== null && !Number.isFinite(Date.parse(v))) {
      this.fail(`${path}.${key}`, '存在しない時刻');
      return null;
    }
    return v;
  }

  date(o: Record<string, unknown>, key: string, path: string, nullable: boolean) {
    const v = this.str(o, key, path, { nullable, pattern: ISO_DATE, what: 'YYYY-MM-DD の日付' });
    if (v !== null && !isRealDate(v)) {
      this.fail(`${path}.${key}`, '存在しない日付');
      return null;
    }
    return v;
  }

  bool(o: Record<string, unknown>, key: string, path: string): boolean | null {
    const p = `${path}.${key}`;
    if (!Object.hasOwn(o, key)) return null; // is_atm は任意（参考値）
    const v = o[key];
    if (v === null) return null;
    if (typeof v !== 'boolean') {
      this.fail(p, '真偽値でない');
      return null;
    }
    return v;
  }
}

function isRealDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function isYearMonth(s: string): boolean {
  const m = YEAR_MONTH.exec(s);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

function side(c: Checker, v: unknown, path: string): ChainSide | null {
  const o = c.object(v, path);
  if (!o) return null;
  const price = { nullable: true, min: 0 } as const;
  const opt = { optional: true, min: 0 } as const;
  const s: ChainSide = {
    bid: c.num(o, 'bid', path, price),
    ask: c.num(o, 'ask', path, price),
    bid_iv: c.num(o, 'bid_iv', path, price),
    ask_iv: c.num(o, 'ask_iv', path, price),
    price: c.num(o, 'price', path, price),
    price_time: c.instant(o, 'price_time', path, true),
    iv: c.num(o, 'iv', path, price),
    volume: c.num(o, 'volume', path, { nullable: true, min: 0, integer: true }),
    positions: c.num(o, 'positions', path, { nullable: true, min: 0, integer: true }),
    quotation: c.num(o, 'quotation', path, opt),
    quotation_date: Object.hasOwn(o, 'quotation_date')
      ? c.date(o, 'quotation_date', path, true)
      : null,
    delta: c.num(o, 'delta', path, { nullable: true }),
    gamma: c.num(o, 'gamma', path, { nullable: true }),
    theta: c.num(o, 'theta', path, { nullable: true }),
    vega: c.num(o, 'vega', path, { nullable: true }),
    is_atm: c.bool(o, 'is_atm', path),
  };
  return s;
}

/**
 * 外から来た値（JSON.parse の結果）を板の JSON として検証する。
 * 構造・型・必須キー・時刻 / 日付の形式・行使価格の昇順（重複なし）・限月の整合を見る。
 * 気配の中身の矛盾（bid > ask など）は拒否せず、正規化で「両側気配なし」として扱う。
 */
export function validateChainJson(input: unknown): ValidationResult<ChainJsonValue> {
  const c = new Checker();
  const root = c.object(input, '$');
  if (!root) return { ok: false, errors: c.errors };

  const version = c.num(root, 'schema_version', '$', { integer: true });
  if (version !== null && version !== SCHEMA_VERSION) {
    c.fail('$.schema_version', `未対応の版（対応は ${SCHEMA_VERSION}）`);
  }
  const snapshotAt = c.instant(root, 'snapshot_at', '$', false);
  const delayed = c.num(root, 'delayed_minutes', '$', { min: 0 });
  const reason = c.str(root, 'reason', '$');
  if (reason !== null && !(REASONS as readonly string[]).includes(reason)) {
    c.fail('$.reason', `${REASONS.join(' / ')} のどれでもない`);
  }
  const source = c.str(root, 'source', '$', { optional: true });

  let spot: ChainJsonValue['spot'] | null = null;
  if (c.has(root, 'spot', '$')) {
    const o = c.object(root.spot, '$.spot');
    if (o) {
      spot = {
        price: c.num(o, 'price', '$.spot', { nullable: true, min: 0 }),
        price_time: c.instant(o, 'price_time', '$.spot', true),
      };
    }
  }

  let future: ChainJsonValue['future'] | null = null;
  if (c.has(root, 'future', '$')) {
    const o = c.object(root.future, '$.future');
    if (o) {
      const cm = c.str(o, 'contract_month', '$.future', { pattern: YEAR_MONTH, what: 'YYYY-MM' });
      if (cm !== null && !isYearMonth(cm)) c.fail('$.future.contract_month', '月が 1〜12 でない');
      future = {
        price: c.num(o, 'price', '$.future', { nullable: true, min: 0 }),
        price_time: c.instant(o, 'price_time', '$.future', true),
        contract_month: cm ?? '',
        last_trading_day: c.date(o, 'last_trading_day', '$.future', false) ?? '',
        sq_date: c.date(o, 'sq_date', '$.future', false) ?? '',
      };
      if (cm && future.sq_date && !future.sq_date.startsWith(cm)) {
        c.fail('$.future.sq_date', 'contract_month の月でない');
      }
      if (
        future.last_trading_day &&
        future.sq_date &&
        !(future.last_trading_day < future.sq_date)
      ) {
        c.fail('$.future.last_trading_day', 'SQ 日より前でない');
      }
    }
  }

  const months: ChainJsonValue['months'] = [];
  if (c.has(root, 'months', '$')) {
    const arr = root.months;
    if (!Array.isArray(arr)) c.fail('$.months', '配列でない');
    else if (arr.length === 0) c.fail('$.months', '限月が 0 本');
    else {
      const ids = new Set<string>();
      arr.forEach((mv, mi) => {
        if (c.full) return;
        const mp = `$.months[${mi}]`;
        const m = c.object(mv, mp);
        if (!m) return;
        const id = c.str(m, 'contract_month', mp, { pattern: YEAR_MONTH, what: 'YYYY-MM' });
        if (id !== null && !isYearMonth(id)) c.fail(`${mp}.contract_month`, '月が 1〜12 でない');
        if (id !== null && ids.has(id)) c.fail(`${mp}.contract_month`, `重複（${id}）`);
        if (id !== null) ids.add(id);
        const ltd = c.date(m, 'last_trading_day', mp, false);
        const sq = c.date(m, 'sq_date', mp, false);
        if (id && sq && !sq.startsWith(id)) c.fail(`${mp}.sq_date`, 'contract_month の月でない');
        if (ltd && sq && !(ltd < sq)) c.fail(`${mp}.last_trading_day`, 'SQ 日より前でない');
        const rows: ChainRow[] = [];
        if (c.has(m, 'rows', mp)) {
          if (!Array.isArray(m.rows)) c.fail(`${mp}.rows`, '配列でない');
          else {
            let prevK = Number.NEGATIVE_INFINITY;
            (m.rows as unknown[]).forEach((rv, ri) => {
              if (c.full) return;
              const rp = `${mp}.rows[${ri}]`;
              const r = c.object(rv, rp);
              if (!r) return;
              const k = c.num(r, 'k', rp, { min: 1, integer: true });
              if (k !== null) {
                if (k <= prevK) c.fail(`${rp}.k`, '行使価格が昇順でない（重複を含む）');
                prevK = k;
              }
              const call = c.has(r, 'call', rp) ? side(c, r.call, `${rp}.call`) : null;
              const put = c.has(r, 'put', rp) ? side(c, r.put, `${rp}.put`) : null;
              if (k !== null && call && put) rows.push({ k, call, put });
            });
          }
        }
        if (id !== null && ltd !== null && sq !== null) {
          months.push({ contract_month: id, last_trading_day: ltd, sq_date: sq, rows });
        }
      });
      for (let i = 1; i < months.length; i++) {
        const a = months[i - 1] as ChainJsonValue['months'][number];
        const b = months[i] as ChainJsonValue['months'][number];
        if (!(a.sq_date < b.sq_date)) c.fail(`$.months[${i}].sq_date`, '限月が SQ 日の昇順でない');
      }
    }
  }

  if (c.errors.length > 0 || !snapshotAt || delayed === null || !reason || !spot || !future) {
    if (c.errors.length === 0) c.fail('$', '検証に失敗');
    return { ok: false, errors: c.errors };
  }
  const value: ChainJsonValue = {
    schema_version: SCHEMA_VERSION,
    snapshot_at: snapshotAt,
    delayed_minutes: delayed,
    reason: reason as ChainJsonValue['reason'],
    spot,
    future,
    months,
  };
  if (source !== null) value.source = source;
  return { ok: true, value };
}

/** 文字列（ファイルの中身・応答の本文）を解析して検証する。 */
export function parseChainJson(text: string): ValidationResult<ChainJsonValue> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['$: JSON として解析できない'] };
  }
  return validateChainJson(v);
}
