import { describe, expect, it } from 'vitest';
import {
  crossTagX,
  crossTagY,
  TICK_TAG_GAP,
  TICK_TEXT_HALF_H,
  ticksClearX,
  ticksClearY,
  ticksSpacedY,
} from '../../ui/view/crosshair';
import { IV_TAG_H, labelPx } from '../../ui/view/ivHistory';

/** #349: 十字線の札と重なる目盛りの文字だけを描かない（架空の値） */
describe('札と目盛りの文字の重なり（#349）', () => {
  const at = (t: { y: number }) => t.y;
  // 札の中心 = 100（y = 92.5、高さ 15）
  const tagY = { y: 100 - IV_TAG_H / 2, h: IV_TAG_H };
  const limit = IV_TAG_H / 2 + TICK_TEXT_HALF_H + TICK_TAG_GAP;

  it('境界は 札の半分 + 文字の半分 + 隙間 = 15.5px', () => {
    expect(limit).toBe(15.5);
  });

  it('縦: 中心が同じ・差 13.4 は除き、差 15.5 以上は残す（元の順を保つ）', () => {
    const ticks = [
      { y: 40 },
      { y: 100 - 15.5 },
      { y: 100 - 13.4 },
      { y: 100 },
      { y: 100 + 13.4 },
      { y: 100 + 15.4 },
      { y: 100 + 15.5 },
      { y: 160 },
    ];
    expect(ticksClearY(ticks, tagY, at).map(at)).toEqual([40, 84.5, 115.5, 160]);
  });

  it('縦: 札が無ければ全部残す（同じ配列）', () => {
    const ticks = [{ y: 1 }, { y: 2 }];
    expect(ticksClearY(ticks, null, at)).toBe(ticks);
  });

  it('縦: crossTagY の矩形（端へ寄せた後）で判定する', () => {
    // 横線が上端の外（py = −20）でも札は 0 に寄る → 寄せた後の中心 7.5 で判定
    const tag = crossTagY('−4,816', -20, 50, 300, 200);
    expect(tag.y).toBe(0);
    const ticks = [{ y: 2 }, { y: 22 }, { y: 24 }];
    expect(ticksClearY(ticks, tag, at).map(at)).toEqual([24]);
  });

  describe('横', () => {
    const atX = (t: { x: number; label: string }) => t.x;
    const lab = (t: { x: number; label: string }) => t.label;
    // 札 [100, 160]、文字 "30,000" の幅 = 6 × 6.3 = 37.8 → 半分 18.9
    const tagX = { x: 100, w: 60 };
    const half = labelPx('30,000') / 2;

    it('札の矩形と文字の区間が交わるものだけを除く（ちょうど隙間なら残す）', () => {
      const ticks = [
        { x: 100 - TICK_TAG_GAP - half, label: '30,000' }, // 右端 = 札の左 − 隙間（ちょうど）
        { x: 100 - TICK_TAG_GAP - half + 0.5, label: '30,000' }, // 0.5 だけ食い込む
        { x: 130, label: '30,000' }, // 中
        { x: 160 + TICK_TAG_GAP + half - 0.5, label: '30,000' },
        { x: 160 + TICK_TAG_GAP + half, label: '30,000' }, // ちょうど
        { x: 260, label: '30,000' },
      ];
      expect(ticksClearX(ticks, tagX, atX, lab).map(atX)).toEqual([ticks[0]?.x, ticks[4]?.x, 260]);
    });

    it('文字の幅で判定する（短い文字は近くても残る）', () => {
      const ticks = [{ x: 90, label: '5' }];
      // "5" の幅 6.3 → 右端 93.15 < 98
      expect(ticksClearX(ticks, tagX, atX, lab)).toHaveLength(1);
      expect(ticksClearX([{ x: 90, label: '35,000' }], tagX, atX, lab)).toHaveLength(0);
    });

    it('札が無ければ全部残す（同じ配列）', () => {
      const ticks = [{ x: 1, label: 'a' }];
      expect(ticksClearX(ticks, null, atX, lab)).toBe(ticks);
    });

    it('crossTagX の矩形（端へ寄せた後）で判定する', () => {
      const tag = crossTagX('29,875', 2, 180, 400, 200); // 左端 0 へ寄る
      expect(tag.x).toBe(0);
      const ticks = [
        { x: 10, label: '29,500' },
        { x: tag.w + TICK_TAG_GAP + labelPx('30,000') / 2, label: '30,000' },
      ];
      expect(ticksClearX(ticks, tag, atX, lab).map(lab)).toEqual(['30,000']);
    });
  });
});

/** #365: 低い描画域で縦軸の目盛りの文字が互いに・単位と重ならない（架空の値。格子の線は呼び出し側で全部描く） */
describe('目盛りの文字の間引き（#365）', () => {
  const at = (t: { v: number; px: number }) => t.px;
  const isZero = (t: { v: number }) => t.v === 0;
  const gap = 2 * TICK_TEXT_HALF_H + TICK_TAG_GAP;

  it('文字の中心の差の下限は 文字の高さ + 隙間 = 14px', () => {
    expect(gap).toBe(14);
  });

  it('間隔が足りていれば全部残す（同じ配列）', () => {
    const ticks = [
      { v: 0, px: 10 },
      { v: -2000, px: 24 },
      { v: -4000, px: 38 },
    ];
    expect(ticksSpacedY(ticks, at, isZero)).toBe(ticks);
  });

  it('10px 間隔の 5 本は 0 と 1 つおきを残す（元の順を保つ）', () => {
    const ticks = [
      { v: 0, px: 10 },
      { v: -1000, px: 20 },
      { v: -2000, px: 30 },
      { v: -3000, px: 40 },
      { v: -4000, px: 50 },
    ];
    expect(ticksSpacedY(ticks, at, isZero).map((t) => t.v)).toEqual([0, -2000, -4000]);
  });

  it('0 を先に残す（元の順で前にある目盛りと近くても）', () => {
    const ticks = [
      { v: 2000, px: 10 },
      { v: 0, px: 20 },
      { v: -2000, px: 30 },
    ];
    expect(ticksSpacedY(ticks, at, isZero).map((t) => t.v)).toEqual([0]);
    // prefer なしなら元の順の貪欲
    expect(ticksSpacedY(ticks, at).map((t) => t.v)).toEqual([2000, -2000]);
  });

  it('避ける箱（単位）と重なる文字を落とす（ちょうど境界は残す）', () => {
    // 単位の箱: 中心 2・高さ 10 → 境界 = 5 + 6 + 2 = 13
    const unit = { y: -3, h: 10 };
    const ticks = [
      { v: 0, px: 14.9 },
      { v: -2000, px: 30 },
    ];
    expect(ticksSpacedY(ticks, at, isZero, [unit]).map((t) => t.v)).toEqual([-2000]);
    const edge = [{ v: 0, px: 15 }];
    expect(ticksSpacedY(edge, at, isZero, [unit])).toBe(edge);
  });

  it('空の配列', () => {
    expect(ticksSpacedY([], at, isZero)).toEqual([]);
  });
});
