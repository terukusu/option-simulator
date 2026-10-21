/**
 * AI の評価（scripts/aiEval.mjs）の送り直し（#240）。中継の 1 分の回数の上限（429 rate_limited。
 * api の settings.AI_RATE_PER_MINUTE）に当たった問を、Retry-After（秒。無ければ既定）だけ待って同じ要求で送り直す。
 * 回数に上限があり、超えたらその問は rate_limited の FAIL。純関数（待たない・時計を読まない）。
 */

/** 送り直しの回数の上限（1 問・1 要求あたり） */
export const RATE_RETRY_MAX = 3;
/** Retry-After が無い・読めないときの待ち（秒。1 分の窓の半分） */
export const RATE_RETRY_DEFAULT_SEC = 30;
/** 待ちの上限（秒） */
export const RATE_RETRY_CAP_SEC = 120;

/**
 * 送り直すまでの待ち（ミリ秒）。送り直さないなら null。
 * @param code 失敗の code（AiRequestError の code）
 * @param attempt これまでに送り直した回数
 * @param retryAfter 応答の Retry-After の見出し（秒の整数だけ読む。日付の形は既定の待ち）
 */
export function rateLimitWaitMs(
  code: string | null | undefined,
  attempt: number,
  retryAfter: string | null | undefined,
): number | null {
  if (code !== 'rate_limited' || attempt >= RATE_RETRY_MAX) return null;
  const v = retryAfter?.trim() ?? '';
  const sec = /^[0-9]+$/.test(v) ? Number(v) : RATE_RETRY_DEFAULT_SEC;
  return Math.min(Math.max(sec, 1), RATE_RETRY_CAP_SEC) * 1000;
}
