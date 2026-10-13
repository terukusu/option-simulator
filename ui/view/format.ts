/** 表示用の書式（純関数）。欠損・非有限は「—」。 */

export const DASH = '—';

const JST_OFFSET_MS = 9 * 3_600_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch ミリ秒 → JST の `YYYY-MM-DD HH:mm`。 */
export function fmtDateTime(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return DASH;
  const d = new Date(t + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** epoch ミリ秒 → JST の `HH:mm`。 */
export function fmtTime(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return DASH;
  return fmtDateTime(t).slice(11);
}

/** epoch ミリ秒 → JST の `YYYY-MM-DD`。 */
export function fmtDate(t: number | null): string {
  if (t === null || !Number.isFinite(t)) return DASH;
  return fmtDateTime(t).slice(0, 10);
}

const formatters = new Map<number, Intl.NumberFormat>();
function nf(digits: number): Intl.NumberFormat {
  let f = formatters.get(digits);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatters.set(digits, f);
  }
  return f;
}

/** 桁区切りの数値（−0 は 0）。 */
export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const s = nf(digits).format(v);
  // 丸めて 0 になった負の値（-0.00）は符号を落とす
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s.replace('-', '−');
}

/** 符号つき（+1,234 / −1,234 / 0）。 */
export function fmtSigned(v: number | null | undefined, digits = 0): string {
  const s = fmtNum(v, digits);
  if (s === DASH || s.startsWith('−') || /^0(\.0+)?$/.test(s)) return s;
  return `+${s}`;
}

/** IV（小数）→ % の文字列（小数 1 桁）。 */
export function fmtIv(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return fmtNum(v * 100, 1);
}

/** JPX の IV（すでに %）→ 小数 1 桁。 */
export function fmtIvPct(v: number | null | undefined): string {
  return fmtNum(v, 1);
}
