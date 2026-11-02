import { describe, expect, it } from 'vitest';
import {
  crossTagX,
  crossTagY,
  TICK_TAG_GAP,
  TICK_TEXT_HALF_H,
  ticksClearX,
  ticksClearY,
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
