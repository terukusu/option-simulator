// AI の評価の送り直し（#240）: 中継の 1 分の上限（429 rate_limited）は Retry-After（無ければ既定）だけ待って送り直し、
// 回数の上限を超えたら送り直さない（その問は rate_limited の FAIL）
import { describe, expect, it } from 'vitest';
import {
  RATE_RETRY_CAP_SEC,
  RATE_RETRY_DEFAULT_SEC,
  RATE_RETRY_MAX,
  rateLimitWaitMs,
} from '../../scripts/aiEvalRetry';

describe('rateLimitWaitMs', () => {
  it('rate_limited だけを送り直す', () => {
    for (const code of ['busy', 'budget_exceeded', 'network', 'unavailable', null, undefined]) {
      expect(rateLimitWaitMs(code, 0, '5')).toBeNull();
    }
  });
  it('Retry-After の秒を使い、無い・読めないときは既定、1 秒〜上限に収める', () => {
    expect(rateLimitWaitMs('rate_limited', 0, '12')).toBe(12_000);
    expect(rateLimitWaitMs('rate_limited', 0, null)).toBe(RATE_RETRY_DEFAULT_SEC * 1000);
    expect(rateLimitWaitMs('rate_limited', 0, 'Wed, 21 Oct 2026 07:28:00 GMT')).toBe(
      RATE_RETRY_DEFAULT_SEC * 1000,
    );
    expect(rateLimitWaitMs('rate_limited', 0, '0')).toBe(1000);
    expect(rateLimitWaitMs('rate_limited', 0, '9999')).toBe(RATE_RETRY_CAP_SEC * 1000);
  });
  it('回数の上限を超えたら null（FAIL の理由は rate_limited のまま）', () => {
    expect(rateLimitWaitMs('rate_limited', RATE_RETRY_MAX - 1, null)).not.toBeNull();
    expect(rateLimitWaitMs('rate_limited', RATE_RETRY_MAX, null)).toBeNull();
  });
});
