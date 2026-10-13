import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { fmtNum } from '../../ui/view/format';
import { headerModel, STALE_MINUTES } from '../../ui/view/header';
import { fixture } from '../support/fixtures';

/** AC-6: ヘッダ（M1・5.9）。値は合成の板（架空）。 */
describe('ヘッダの表示モデル', () => {
  it('latest: 板の時刻・遅れ・先物・限月ごとの日付・F・A / B の基準価格・ATM', () => {
    const chain = normalizeChain(fixture('latest'));
    const h = headerModel(chain, 'B');
    expect(h.snapshot).toBe('2026-10-13 21:31');
    expect(h.delay).toBe('約 15 分遅れ');
    expect(h.reason).toBe('最新');
    expect(h.future.contract).toBe('2026-12');
    expect(h.future.time).toBe('21:25'); // 約定はスナップショットの 6 分前
    expect(h.future.price).toBe(fmtNum(chain.future.price, 0));
    expect(h.spot.time).toBe('15:45');
    expect(h.months.map((m) => [m.id, m.lastTradingDay, m.sqDate])).toEqual([
      ['2026-11', '2026-11-12', '2026-11-13'],
      ['2026-12', '2026-12-10', '2026-12-11'],
    ]);
    chain.months.forEach((m, i) => {
      const v = h.months[i];
      expect(v?.forward.startsWith(fmtNum(m.F, 0))).toBe(true);
      expect(v?.forwardKindLabel).toBe('合成先物');
      expect(v?.refA.price).toBe(fmtNum(m.atm.A.reference.price, 0));
      expect(v?.refB.price).toBe(fmtNum(m.atm.B.reference.price, 0));
      expect(v?.atmK).toBe(m.atm.B.pick?.k);
      expect(v?.atm).toBe(fmtNum(m.atm.B.pick?.k ?? null, 0));
      expect(v?.refA.stale).toBe(false);
      expect(v?.refB.stale).toBe(false);
    });
    const a = headerModel(chain, 'A');
    chain.months.forEach((m, i) => {
      expect(a.months[i]?.atmK).toBe(m.atm.A.pick?.k);
    });
    expect(h.assumptions).toContain('取引カレンダー: 休業日未反映');
    expect(h.assumptions[0]).toBe('金利 0.5%');
  });

  it('pre_open: reason が「板寄せ前」', () => {
    const h = headerModel(normalizeChain(fixture('pre_open')), 'B');
    expect(h.reason).toBe('板寄せ前');
    expect(h.snapshot).toBe('2026-10-13 15:40');
  });

  it.each([
    [STALE_MINUTES, true],
    [STALE_MINUTES - 1, false],
  ])('基準価格（先物の約定）がスナップショットの %i 分前 → 古い = %s', (minutes, stale) => {
    const json = fixture('latest');
    const snap = Date.parse(json.snapshot_at);
    json.future.price_time = new Date(snap - minutes * 60_000).toISOString();
    const h = headerModel(normalizeChain(json), 'A');
    for (const m of h.months) {
      expect(m.refA.stale).toBe(stale);
      // B は合成先物（スナップショット時刻）なので古くならない
      expect(m.refB.stale).toBe(false);
    }
  });

  it('B が A にフォールバックしたら先物の約定時刻で判定する', () => {
    const json = fixture('latest');
    const snap = Date.parse(json.snapshot_at);
    json.future.price_time = new Date(snap - 45 * 60_000).toISOString();
    for (const m of json.months) {
      for (const r of m.rows) {
        for (const s of [r.call, r.put]) {
          s.bid = null;
          s.ask = null;
          s.price = null;
        }
      }
    }
    const h = headerModel(normalizeChain(json), 'B');
    for (const m of h.months) {
      expect(m.refB.fellBack).toBe(true);
      expect(m.refB.stale).toBe(true);
      expect(m.forwardKind).not.toBe('synthetic');
    }
    expect(h.months[0]?.forwardKindLabel).toBe('先物で代用（限月違い）');
    expect(h.months[1]?.forwardKindLabel).toBe('先物で代用');
  });
});
