import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { linear } from '../../ui/chart/scale';
import { crossTapAction } from '../../ui/view/crosshair';
import { IV_TAG_H } from '../../ui/view/ivHistory';
import {
  SMILE_MARGIN,
  type SmileAxis,
  smileCrosshair,
  smileCrossXText,
  smileCursorAt,
  smileCurveIv,
  smileDotCursor,
  smileModel,
} from '../../ui/view/smile';
import { fixture } from '../support/fixtures';

/** #217: スマイルの十字線（合成の板。架空の値） */
const chain = normalizeChain(fixture('latest'));
const month = chain.months[0];
if (!month) throw new Error('合成の板に限月が無い');
const AXES: SmileAxis[] = ['k', 'moneyness', 'delta'];
const SIZES = [
  [300, 220],
  [900, 320],
] as const;

describe('スマイルの十字線（#217）', () => {
  it.each(AXES)('曲線の IV は区間の線形補間（区間の端では節点の値、外は null）: 軸 %s', (axis) => {
    const m = smileModel(month, 'B', axis);
    const s = m.segments.find((q) => q.x2 > q.x1) ?? m.segments[0];
    if (!s) throw new Error('区間が無い');
    expect(smileCurveIv(m, s.x1)).toBeCloseTo(s.y1, 9);
    const mid = (s.x1 + s.x2) / 2;
    expect(smileCurveIv(m, mid)).toBeCloseTo((s.y1 + s.y2) / 2, 9);
    expect(smileCurveIv(m, Number.NaN)).toBeNull();
    expect(smileCurveIv(m, m.domain[1] + (m.domain[1] - m.domain[0]))).toBeNull();
  });

  it.each(AXES.flatMap((a) => SIZES.map(([w, h]) => [a, w, h] as const)))(
    '軸 %s・%dx%d: 縦線 = カーソルの横軸の値（吸着しない）、横線 = カーソルの IV、札は svg の内側',
    (axis, w, h) => {
      const m = smileModel(month, 'B', axis);
      const M = SMILE_MARGIN;
      for (const [fx, fy] of [
        [0.02, 0.02],
        [0.5, 0.5],
        [0.97, 0.9],
      ] as const) {
        const x = m.domain[0] + (m.domain[1] - m.domain[0]) * fx;
        const iv = m.yDomain[0] + (m.yDomain[1] - m.yDomain[0]) * fy;
        const c = smileCrosshair(m, { x, iv, touch: false }, w, h);
        if (!c) throw new Error('十字線が無い');
        expect(c.px).toBeCloseTo(linear(m.domain, [M.left, w - M.right])(x), 0);
        expect(c.py).toBeCloseTo(linear(m.yDomain, [h - M.bottom, M.top])(iv), 0);
        expect(c.xTag.text).toBe(smileCrossXText(axis, x));
        // 縦の札 = 横線の高さの IV（小数 2 桁）
        const level = linear([h - M.bottom, M.top], m.yDomain)(c.py);
        expect(Number(c.yTag.text)).toBeCloseTo(level, 2);
        for (const t of [c.xTag, c.yTag]) {
          expect(t.x).toBeGreaterThanOrEqual(0);
          expect(t.x + t.w).toBeLessThanOrEqual(w + 0.01);
          expect(t.y).toBeGreaterThanOrEqual(0);
          expect(t.y + t.h).toBeLessThanOrEqual(h + 0.01);
          expect(t.h).toBe(IV_TAG_H);
        }
        // 縦の札は目盛りの列（描画域の左 − 1 まで。列より広い札は左端 0 で止め、描画域へ少しはみ出してよい = #130 と同じ）
        if (c.yTag.x > 0) expect(c.yTag.x + c.yTag.w).toBeLessThanOrEqual(M.left - 1 + 0.01);
        // 読み取りは縦線と反対の側
        if (c.px > (M.left + w - M.right) / 2) expect(c.read.anchor).toBe('start');
        else expect(c.read.anchor).toBe('end');
        const cv = smileCurveIv(m, x);
        expect(c.curveIv).toBe(cv);
        expect(c.read.text).toContain(cv === null ? '曲線 —' : `曲線 ${cv.toFixed(2)}%`);
      }
    },
  );

  it('表示範囲の外・空のモデル・カーソルなしは null', () => {
    const m = smileModel(month, 'B', 'k');
    expect(smileCrosshair(m, null, 300, 200)).toBeNull();
    expect(smileCrosshair(m, { x: m.domain[1] + 1, iv: 20, touch: false }, 300, 200)).toBeNull();
    const zoomed = smileModel(month, 'B', 'k', [m.domain[0], (m.domain[0] + m.domain[1]) / 2]);
    expect(smileCrosshair(zoomed, { x: m.domain[1] - 1, iv: 20, touch: false }, 300, 200)).toBe(
      null,
    );
  });

  it('#227 AC3: タッチの交点をつかんでいる間だけ、指が上 40% なら読み取りは下端。離した後・マウスは上端', () => {
    const m = smileModel(month, 'B', 'k');
    const x = (m.domain[0] + m.domain[1]) / 2;
    const hi = m.yDomain[1] - (m.yDomain[1] - m.yDomain[0]) * 0.05;
    const lo = m.yDomain[0] + (m.yDomain[1] - m.yDomain[0]) * 0.05;
    const h = 220;
    const top = SMILE_MARGIN.top + 9;
    const bottom = h - SMILE_MARGIN.bottom - 9;
    // つかんで動かしている間
    expect(smileCrosshair(m, { x, iv: hi, touch: true }, 300, h, true)?.read.y).toBe(bottom);
    expect(smileCrosshair(m, { x, iv: lo, touch: true }, 300, h, true)?.read.y).toBe(top);
    // 離した後（置いたまま）は PC のホバーと同じ上端（指は離れている）。既定は離した後
    expect(smileCrosshair(m, { x, iv: hi, touch: true }, 300, h, false)?.read.y).toBe(top);
    expect(smileCrosshair(m, { x, iv: hi, touch: true }, 300, h)?.read.y).toBe(top);
    // マウスはつかんでいても（来ないが）上端
    expect(smileCrosshair(m, { x, iv: hi, touch: false }, 300, h, true)?.read.y).toBe(top);
    // 読み取りの位置のほかは同じ
    const held = smileCrosshair(m, { x, iv: hi, touch: true }, 300, h, true);
    const rel = smileCrosshair(m, { x, iv: hi, touch: true }, 300, h, false);
    expect({ ...held, read: null }).toEqual({ ...rel, read: null });
    expect(held?.read.text).toBe(rel?.read.text);
  });

  it('画素 → カーソル: 描画域の外は null（ホバー）、clamp なら端の値（長押しのドラッグ）', () => {
    const m = smileModel(month, 'B', 'k');
    const M = SMILE_MARGIN;
    const c = smileCursorAt(m, M.left, M.top, 300, 200, false, false);
    expect(c?.x).toBeCloseTo(m.domain[0], 6);
    expect(c?.iv).toBeCloseTo(m.yDomain[1], 6);
    expect(smileCursorAt(m, M.left - 5, 100, 300, 200, false, false)).toBeNull();
    const k = smileCursorAt(m, M.left - 5, 500, 300, 200, true, true);
    expect(k?.x).toBeCloseTo(m.domain[0], 6);
    expect(k?.iv).toBeCloseTo(m.yDomain[0], 6);
    expect(k?.touch).toBe(true);
  });

  it('札の文字: K は円の整数、moneyness は小数 2 桁の %、Δ は P / C と小数 3 桁', () => {
    expect(smileCrossXText('k', 64123.4)).toBe('64,123');
    expect(smileCrossXText('moneyness', 0.01234)).toBe('+1.23%');
    expect(smileCrossXText('moneyness', -0.05)).toBe('−5.00%');
    expect(smileCrossXText('delta', 0.2534)).toBe('P 0.253');
    expect(smileCrossXText('delta', 0.75)).toBe('C 0.250');
  });
});

describe('タッチのタップの十字線（#217 の共通の規則）', () => {
  it('crossTapAction: 出ていなければ置く、出ていれば消す（移さない）', () => {
    expect(crossTapAction(false)).toBe('place');
    expect(crossTapAction(true)).toBe('hide');
  });

  it('smileDotCursor: 点のタップは点に吸着（横軸 = その行使価格、IV = mid の点）、表示範囲に無い点は null', () => {
    const m = smileModel(month, 'B', 'k');
    const mid = m.points.find((q) => q.kind === 'mid');
    if (!mid) throw new Error('mid の点が無い');
    const c = smileDotCursor(m, mid.k, true);
    expect(c).toEqual({ x: mid.x, iv: mid.iv, touch: true });
    expect(smileDotCursor(m, -1, true)).toBeNull();
    const xh = smileCrosshair(m, c, 300, 220);
    expect(xh?.xTag.text).toBe(smileCrossXText('k', mid.x));
  });
});
