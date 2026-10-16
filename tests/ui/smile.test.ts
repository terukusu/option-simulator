import { describe, expect, it } from 'vitest';
import { boardOptionLeg, type ChainMonth, normalizeChain } from '../../data';
import { type Domain, linear, zoom } from '../../ui/chart/scale';
import { initialState, reduce } from '../../ui/state';
import {
  axisTickLabel,
  axisValue,
  pickStrike,
  SCRUB_KEY_STEPS,
  type SmileAxis,
  type SmileModel,
  scrubStrike,
  smileModel,
  smilePickRow,
  stepStrike,
} from '../../ui/view/smile';
import { fixture } from '../support/fixtures';

/** AC-11: スマイル（AC14）。合成の板（架空の値）。 */
const AXES: SmileAxis[] = ['k', 'moneyness', 'delta'];

function finiteModel(m: SmileModel) {
  const nums = [
    ...m.points.flatMap((p) => [p.x, p.iv]),
    ...m.segments.flatMap((s) => [s.x1, s.y1, s.x2, s.y2]),
    ...m.unstable.flatMap((u) => [u.x, u.iv]),
    ...m.domain,
    ...m.yDomain,
  ];
  return nums.every(Number.isFinite);
}

function markOf(month: ChainMonth, k: number) {
  return month.strikes.find((s) => s.k === k)?.mark;
}

const chains = (['latest', 'night_early', 'pre_open'] as const).map((n) => ({
  name: n,
  chain: normalizeChain(fixture(n)),
}));

describe.each(
  chains.flatMap(({ name, chain }) => chain.months.map((m) => [`${name} ${m.id}`, m] as const)),
)('スマイル（%s）', (_name, month) => {
  it.each(AXES)('軸 %s: 座標は有限、線種 = StrikeInfo.mark（両端が節点なら実線）', (axis) => {
    const m = smileModel(month, 'B', axis);
    expect(m.empty).toBe(false);
    expect(finiteModel(m)).toBe(true);
    expect(m.points.length).toBeGreaterThan(0);
    expect(m.segments.length).toBeGreaterThan(0);
    for (const s of m.segments) {
      const solid = markOf(month, s.k1) === 'node' && markOf(month, s.k2) === 'node';
      expect(s.style).toBe(solid ? 'solid' : 'dotted');
    }
    expect(m.segments.some((s) => s.style === 'solid')).toBe(true);
    // 点は節点の bid / ask / mid の IV（%）
    for (const p of m.points) {
      const node = month.strikes.find((s) => s.k === p.k)?.node;
      const v = p.kind === 'bid' ? node?.bidIv : p.kind === 'ask' ? node?.askIv : node?.midIv;
      expect(p.iv).toBeCloseTo((v as number) * 100, 10);
    }
  });

  it('デルタ軸: K に対して増加。単調でない区間（IV の傾きが急な put の深い翼）があっても描く', () => {
    const m = smileModel(month, 'B', 'delta');
    // 合成の板では単調でない区間は put の深い翼（N(−d₁) < 0.05）だけ
    for (const s of m.segments) {
      if (s.x2 <= s.x1) expect(Math.max(s.x1, s.x2)).toBeLessThan(0.05);
    }
    expect(m.domain[0]).toBeGreaterThanOrEqual(0);
    expect(m.domain[1]).toBeLessThanOrEqual(1);
  });
});

it('latest・pre_open には点線（補間・外挿）の区間がある', () => {
  for (const { name, chain } of chains) {
    if (name === 'night_early') continue;
    for (const m of chain.months) {
      expect(smileModel(m, 'B', 'k').segments.some((s) => s.style === 'dotted')).toBe(true);
    }
  }
});

describe('横軸を絞っても線種と × が保たれる', () => {
  const chain = chains[0]?.chain;
  const month = chain?.months[0];
  if (!month) throw new Error('限月が無い');

  it.each(AXES)('軸 %s: 最遠の外挿区間だけに絞る', (axis) => {
    const full = smileModel(month, 'B', axis);
    // 最遠 = 行使価格の最も低い外挿区間（put の翼）
    const ext = full.segments.filter(
      (s) => markOf(month, s.k1) === 'extrapolated' || markOf(month, s.k2) === 'extrapolated',
    );
    expect(ext.length).toBeGreaterThan(0);
    const far = ext.reduce((a, b) => (b.k1 < a.k1 ? b : a));
    const vp = [Math.min(far.x1, far.x2), Math.max(far.x1, far.x2)] as const;
    const z = smileModel(month, 'B', axis, vp);
    expect(finiteModel(z)).toBe(true);
    expect(z.domain).toEqual(vp);
    const seg = z.segments.find((s) => s.k1 === far.k1 && s.k2 === far.k2);
    expect(seg?.style).toBe('dotted');
    for (const s of z.segments) {
      const orig = full.segments.find((o) => o.k1 === s.k1 && o.k2 === s.k2);
      expect(s.style).toBe(orig?.style);
    }
    // 範囲内の不安定行（×）は残る
    const inside = full.unstable.filter((u) => u.x >= vp[0] && u.x <= vp[1]);
    expect(z.unstable).toEqual(inside);
    expect(inside.length).toBeGreaterThan(0);
  });

  it('ボタンでの拡大（zoom）を繰り返しても有限で、全域を超えない', () => {
    const full = smileModel(month, 'B', 'k');
    let vp = full.fullDomain;
    for (let i = 0; i < 20; i++) {
      vp = zoom(vp, 0.5, full.fullDomain, full.minWidth);
      const z = smileModel(month, 'B', 'k', vp);
      expect(finiteModel(z)).toBe(true);
      expect(vp[1] - vp[0]).toBeGreaterThanOrEqual(full.minWidth - 1e-9);
    }
    for (let i = 0; i < 30; i++) vp = zoom(vp, 2, full.fullDomain, full.minWidth);
    expect(vp).toEqual(full.fullDomain);
  });
});

describe('軸の目盛りの文言', () => {
  it('K・moneyness・デルタ', () => {
    expect(axisTickLabel('k', 64000)).toBe('64,000');
    expect(axisTickLabel('moneyness', -0.1)).toBe('−10%');
    expect(axisTickLabel('moneyness', 0.05)).toBe('+5%');
    expect(axisTickLabel('delta', 0.1)).toBe('P 0.10');
    expect(axisTickLabel('delta', 0.8)).toBe('C 0.20');
    expect(axisTickLabel('delta', 0.5)).toBe('0.50');
  });
});

describe('スマイルからの足の追加（#11 AC-10・M3）', () => {
  const chain = chains[0]?.chain;
  const month = chain?.months[0];
  if (!chain || !month) throw new Error('限月が無い');
  const range: Domain = [40, 468];

  it.each(AXES)('軸 %s: K の点の画素で K が選ばれ、12px 超離れた画素では選ばれない', (axis) => {
    // 点の間隔が 24px 以上ある範囲に絞る（隣の点と取り違えない）
    const full = smileModel(month, 'B', axis);
    const atm = month.atm.B.pick?.k as number;
    const info = month.strikes.find((s) => s.k === atm);
    if (!info) throw new Error('ATM が無い');
    const ax = axisValue(month, 'B', axis, info) as number;
    const near = full.strikeXs.filter((s) => Math.abs(s.k - atm) <= 1000);
    const xs = near.map((s) => s.x);
    const vp: Domain = [Math.min(...xs), Math.max(...xs)];
    const m = smileModel(month, 'B', axis, vp);
    const sx = linear(m.domain, range);
    expect(m.strikeXs.length).toBeGreaterThan(2);
    for (const s of m.strikeXs) {
      expect(pickStrike(m, sx(s.x), range)).toBe(s.k);
      expect(pickStrike(m, sx(s.x) + 3, range)).toBe(s.k);
    }
    expect(pickStrike(m, sx(ax), range)).toBe(atm);
    // どの点からも 12px 超離れた画素
    const pxs = m.strikeXs.map((s) => sx(s.x));
    const far = Math.max(...pxs) + 12.5;
    expect(pickStrike(m, far, range)).toBeNull();
    expect(pickStrike(m, Math.min(...pxs) - 12.5, range)).toBeNull();
    expect(pickStrike(full, Number.NaN, range)).toBeNull();
  });

  describe('長押し・ドラッグ・キーでの選択（#57）', () => {
    /** ATM ±1,000 円に絞った表示範囲のモデルと、表示範囲の中の点（画面の左から） */
    const setup = (axis: SmileAxis) => {
      const full = smileModel(month, 'B', axis);
      const atm = month.atm.B.pick?.k as number;
      const xs = full.strikeXs.filter((s) => Math.abs(s.k - atm) <= 1000).map((s) => s.x);
      const m = smileModel(month, 'B', axis, [Math.min(...xs), Math.max(...xs)]);
      const vis = m.strikeXs
        .filter((s) => s.x >= m.domain[0] && s.x <= m.domain[1])
        .sort((a, b) => a.x - b.x);
      return { m, vis, sx: linear(m.domain, range), atm };
    };

    it.each(AXES)('軸 %s: 点の画素でその K、点の間でも最寄り、描画域の外は端の点', (axis) => {
      const { m, vis, sx } = setup(axis);
      expect(vis.length).toBeGreaterThan(2);
      for (const s of vis) expect(scrubStrike(m, sx(s.x), range)).toBe(s.k);
      // 隣り合う点の間（左の点寄り 1/3）は左の点。12px の制限はない
      for (let i = 0; i + 1 < vis.length; i++) {
        const a = vis[i] as { k: number; x: number };
        const b = vis[i + 1] as { k: number; x: number };
        const px = sx(a.x) + (sx(b.x) - sx(a.x)) / 3;
        expect(scrubStrike(m, px, range)).toBe(a.k);
      }
      // 描画域の外の画素は端の点（表示範囲の外の点ではない）
      expect(scrubStrike(m, range[0] - 200, range)).toBe(vis[0]?.k);
      expect(scrubStrike(m, range[1] + 200, range)).toBe(vis[vis.length - 1]?.k);
      expect(scrubStrike(m, Number.NaN, range)).toBeNull();
    });

    it.each(AXES)('軸 %s: キーで左右へ 1 本 / 5 本、端で止まる、始点は ATM', (axis) => {
      const { m, vis, atm } = setup(axis);
      const ks = vis.map((s) => s.k);
      const i = ks.indexOf(atm);
      expect(i).toBeGreaterThan(0);
      expect(stepStrike(m, null, 1)).toBe(atm);
      expect(stepStrike(m, 999_999, -1)).toBe(atm);
      expect(stepStrike(m, atm, SCRUB_KEY_STEPS['.'] as number)).toBe(ks[i + 1]);
      expect(stepStrike(m, atm, SCRUB_KEY_STEPS[','] as number)).toBe(ks[i - 1]);
      expect(stepStrike(m, atm, SCRUB_KEY_STEPS['>'] as number)).toBe(
        ks[Math.min(i + 5, ks.length - 1)],
      );
      expect(stepStrike(m, ks[0] as number, -5)).toBe(ks[0]);
      expect(stepStrike(m, ks[ks.length - 1] as number, 1)).toBe(ks[ks.length - 1]);
    });

    it.each(AXES)('軸 %s: ATM が表示範囲の外なら、範囲の中央に最も近い点から始める', (axis) => {
      const full = smileModel(month, 'B', axis);
      const atm = month.atm.B.pick?.k as number;
      // ATM より 2,000〜4,000 円下の点だけを表示する
      const xs = full.strikeXs
        .filter((s) => s.k <= atm - 2000 && s.k >= atm - 4000)
        .map((s) => s.x);
      const m = smileModel(month, 'B', axis, [Math.min(...xs), Math.max(...xs)]);
      expect(m.strikeXs.some((s) => s.k === atm)).toBe(false);
      const mid = (m.domain[0] + m.domain[1]) / 2;
      const nearest = [...m.strikeXs].sort((a, b) => Math.abs(a.x - mid) - Math.abs(b.x - mid))[0];
      expect(stepStrike(m, null, 1)).toBe(nearest?.k);
      // 表示範囲の外の選択（ATM）からも中央の点へ
      expect(stepStrike(m, atm, -1)).toBe(nearest?.k);
    });
  });

  it('選択 → 売り = boardOptionLeg と同じ足（OTM 側・建値 bid）、買い = 建値 ask', () => {
    const k = month.strikes.find((s) => s.otmType === 'put' && s.node && !s.unstable)?.k as number;
    const row = smilePickRow(month, k);
    expect(row?.type).toBe('put');
    const s0 = reduce(initialState, { type: 'loaded', chain, label: 'latest' });
    const s1 = reduce(s0, { type: 'pickSmile', pick: { monthId: month.id, k } });
    expect(s1.smilePick).toEqual({ monthId: month.id, k });
    const sell = reduce(s1, {
      type: 'addBoardLeg',
      expiry: month.id,
      k,
      optionType: row?.type ?? 'put',
      side: 'sell',
    });
    expect(sell.legs).toHaveLength(1);
    const want = boardOptionLeg(chain, { expiry: month.id, k, type: 'put', side: 'sell' });
    expect(sell.legs[0]?.leg).toEqual(want.leg);
    expect(sell.legs[0]?.marks).toEqual(want.marks);
    expect(sell.legs[0]?.leg.entry).toBe(row?.bid);
    const buy = reduce(sell, {
      type: 'addBoardLeg',
      expiry: month.id,
      k,
      optionType: 'put',
      side: 'buy',
    });
    expect(buy.legs).toHaveLength(2);
    expect(buy.legs[1]?.leg.entry).toBe(row?.ask);
  });

  it('IV 不安定の行の足には「IV 不安定」の印', () => {
    const info = month.strikes.find((s) => s.unstable && s.node);
    if (!info) throw new Error('不安定の行が無い');
    const m = smileModel(month, 'B', 'k');
    expect(m.strikeXs.map((s) => s.k)).toContain(info.k);
    const row = smilePickRow(month, info.k);
    expect(row?.unstable).toBe(true);
    const s = reduce(reduce(initialState, { type: 'loaded', chain, label: 'latest' }), {
      type: 'addBoardLeg',
      expiry: month.id,
      k: info.k,
      optionType: row?.type ?? info.otmType,
      side: 'sell',
    });
    expect(s.legs[0]?.marks).toContain('unstable_iv');
  });

  it('限月の切替・板の読み直しで選択が消える', () => {
    const s0 = reduce(initialState, { type: 'loaded', chain, label: 'latest' });
    const picked = reduce(s0, { type: 'pickSmile', pick: { monthId: month.id, k: 60_000 } });
    const other = chain.months[1]?.id as string;
    expect(reduce(picked, { type: 'setMonth', monthId: other }).smilePick).toBeNull();
    expect(reduce(picked, { type: 'loaded', chain, label: 'again' }).smilePick).toBeNull();
    // 同じ限月の再選択・軸の切替では消えない
    expect(reduce(picked, { type: 'setMonth', monthId: month.id }).smilePick).not.toBeNull();
    expect(smilePickRow(month, 123)).toBeNull();
  });
});
