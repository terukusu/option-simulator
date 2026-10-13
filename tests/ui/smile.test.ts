import { describe, expect, it } from 'vitest';
import { type ChainMonth, normalizeChain } from '../../data';
import { zoom } from '../../ui/chart/scale';
import { axisTickLabel, type SmileAxis, type SmileModel, smileModel } from '../../ui/view/smile';
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
