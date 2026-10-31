import { describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, TAP_MOVE_PX } from '../../ui/chart/gesture';
import { MAX_TABS } from '../../ui/state';
import {
  clickSwallowed,
  dropIndex,
  edgeScrollStep,
  initialTabDrag,
  previewOrder,
  TAB_CLICK_SWALLOW_MS,
  TAB_EDGE_PX,
  TAB_EDGE_STEP_MAX,
  type TabDragKind,
  type TabDragState,
  tabDragCancel,
  tabDragDown,
  tabDragEdge,
  tabDragLongPress,
  tabDragLostCapture,
  tabDragMove,
  tabDragSync,
  tabDragUp,
} from '../../ui/view/tabDrag';

/** #323 AC6: BOX タブのドラッグの並べ替えの状態機械（純関数） */

// チップ 3 個（id 1・4・7）の中心（帯の中身の座標）
const IDS = [1, 4, 7] as const;
const CENTERS = [50, 150, 250] as const;
const P = (x: number, y = 20, id = 1) => ({ id, x, y });

function down(kind: TabDragKind, from = 0, x = CENTERS[from] ?? 0): TabDragState {
  const r = tabDragDown(initialTabDrag(), P(x), 1000, kind, from, IDS, CENTERS);
  expect(r.state.mode).toBe('pending');
  return r.state;
}

describe('マウス: 6px 動けばつかむ', () => {
  it(`${TAP_MOVE_PX - 1}px では掴まない、${TAP_MOVE_PX}px で掴む`, () => {
    expect(TAP_MOVE_PX).toBe(6);
    const s = down('mouse');
    const five = tabDragMove(s, P(55), 55);
    expect(five.state.mode).toBe('pending');
    expect(five.grabbed).toBeUndefined();
    const six = tabDragMove(s, P(56), 56);
    expect(six.state.mode).toBe('grab');
    expect(six.grabbed).toBe(true);
    expect(six.block).toBe(true);
    expect(six.vibrate).toBeUndefined();
  });

  it('マウスは長押しでは掴まない。6px 未満で離せば何もしない（click は今のまま）', () => {
    const s = down('mouse');
    expect(tabDragLongPress(s, 1000 + LONG_PRESS_MS + 100).state).toBe(s);
    const up = tabDragUp(s, P(52));
    expect(up.state.mode).toBe('idle');
    expect(up.drop).toBeUndefined();
    expect(up.swallowClick).toBeUndefined();
  });

  it('別の pointer の移動・離すは無視する', () => {
    const s = down('mouse');
    expect(tabDragMove(s, P(200, 20, 9), 200).state).toBe(s);
    expect(tabDragUp(s, P(200, 20, 9)).state).toBe(s);
  });
});

describe('タッチ: 450ms の長押しでつかむ・その前に 6px 動けばスクロール', () => {
  it(`${LONG_PRESS_MS - 1}ms では掴まない、${LONG_PRESS_MS}ms・6px 未満で掴む（振動）`, () => {
    expect(LONG_PRESS_MS).toBe(450);
    const s = down('touch');
    expect(tabDragLongPress(s, 1000 + LONG_PRESS_MS - 1).state).toBe(s);
    const moved = tabDragMove(s, P(55), 55).state;
    expect(moved.mode).toBe('pending');
    const g = tabDragLongPress(moved, 1000 + LONG_PRESS_MS);
    expect(g.state.mode).toBe('grab');
    expect(g.grabbed).toBe(true);
    expect(g.vibrate).toBe(true);
    expect(g.state.to).toBe(0);
  });

  it('タッチは 6px 動いても掴まない（scroll）。以後この押下は長押しでも掴まない', () => {
    const s = down('touch');
    const sc = tabDragMove(s, P(56), 56);
    expect(sc.state.mode).toBe('scroll');
    expect(sc.grabbed).toBeUndefined();
    expect(sc.block).toBeUndefined();
    expect(tabDragLongPress(sc.state, 1000 + LONG_PRESS_MS + 10).state.mode).toBe('scroll');
    expect(tabDragMove(sc.state, P(200), 200).state.mode).toBe('scroll');
    const up = tabDragUp(sc.state, P(200));
    expect(up.state.mode).toBe('idle');
    expect(up.drop).toBeUndefined();
    expect(up.swallowClick).toBeUndefined();
  });

  it('縦に 6px でも scroll（距離は client 座標の 2 次元）', () => {
    expect(tabDragMove(down('touch'), P(50, 26), 50).state.mode).toBe('scroll');
  });
});

describe('入れ替わり先・確定', () => {
  it('dropIndex: 左端・右端・中心ちょうど（入れ替えない）・自分の位置', () => {
    // 先頭（from 0）をつかむ
    expect(dropIndex(CENTERS, 0, -100)).toBe(0);
    expect(dropIndex(CENTERS, 0, 50)).toBe(0);
    expect(dropIndex(CENTERS, 0, 150)).toBe(0);
    expect(dropIndex(CENTERS, 0, 151)).toBe(1);
    expect(dropIndex(CENTERS, 0, 251)).toBe(2);
    expect(dropIndex(CENTERS, 0, 9999)).toBe(2);
    // 真ん中（from 1）: 左右対称
    expect(dropIndex(CENTERS, 1, 150)).toBe(1);
    expect(dropIndex(CENTERS, 1, 50)).toBe(1);
    expect(dropIndex(CENTERS, 1, 49)).toBe(0);
    expect(dropIndex(CENTERS, 1, 250)).toBe(1);
    expect(dropIndex(CENTERS, 1, 251)).toBe(2);
    // 最後（from 2）
    expect(dropIndex(CENTERS, 2, 250)).toBe(2);
    expect(dropIndex(CENTERS, 2, 150)).toBe(2);
    expect(dropIndex(CENTERS, 2, 149)).toBe(1);
    expect(dropIndex(CENTERS, 2, -1)).toBe(0);
    expect(dropIndex(CENTERS, 2, Number.NaN)).toBe(2);
  });

  it('掴んで右端の先で離す → drop（id・to）と click を捨てる印', () => {
    const g = tabDragMove(down('mouse'), P(60), 60).state;
    const m = tabDragMove(g, P(300), 300);
    expect(m.state.to).toBe(2);
    expect(m.block).toBe(true);
    const up = tabDragUp(m.state, P(300));
    expect(up.state.mode).toBe('idle');
    expect(up.drop).toEqual({ id: 1, to: 2 });
    expect(up.swallowClick).toBe(true);
  });

  it('タッチ: 長押しで掴んで隣の中心の先へ → drop', () => {
    const s = down('touch', 1);
    const g = tabDragLongPress(s, 1000 + LONG_PRESS_MS).state;
    const m = tabDragMove(g, P(50 - 8), 42).state;
    expect(m.to).toBe(0);
    expect(tabDragUp(m, P(42)).drop).toEqual({ id: 4, to: 0 });
  });

  it('動かす前と同じ添字で離せば確定しない（click は捨てる）', () => {
    const g = tabDragMove(down('mouse', 1), P(160), 160).state;
    const back = tabDragMove(g, P(150), 150).state;
    expect(back.to).toBe(1);
    const up = tabDragUp(back, P(150));
    expect(up.drop).toBeUndefined();
    expect(up.swallowClick).toBe(true);
  });

  it('入れ替わり先が変わらない移動は同じ state（描き直さない）', () => {
    const g = tabDragMove(down('mouse'), P(60), 60).state;
    expect(tabDragMove(g, P(70), 70).state).toBe(g);
  });
});

describe('取りやめ（元の並び）', () => {
  const grabbed = () => tabDragMove(tabDragMove(down('mouse'), P(60), 60).state, P(300), 300);

  it('Esc / pointercancel: cancel、離しても drop しない', () => {
    const c = tabDragCancel(grabbed().state);
    expect(c.cancel).toBe(true);
    expect(c.swallowClick).toBe(true);
    expect(c.state.mode).toBe('idle');
    expect(tabDragUp(c.state, P(300)).drop).toBeUndefined();
    // pending の取りやめは click を捨てない
    const p = tabDragCancel(down('touch'));
    expect(p.cancel).toBe(true);
    expect(p.swallowClick).toBeUndefined();
    // idle は何もしない
    const idle = initialTabDrag();
    expect(tabDragCancel(idle).state).toBe(idle);
  });

  it('2 本目の指（idle でない押下）: cancel', () => {
    const r = tabDragDown(grabbed().state, P(100, 20, 2), 1100, 'touch', 1, IDS, CENTERS);
    expect(r.cancel).toBe(true);
    expect(r.state.mode).toBe('idle');
    const r2 = tabDragDown(down('touch'), P(100, 20, 2), 1100, 'touch', 1, IDS, CENTERS);
    expect(r2.cancel).toBe(true);
  });

  it('2 本目の指が帯の外（DOM は window の capture で受け、チップの添字を渡さない）: pending / grab / scroll とも取りやめ', () => {
    for (const s of [grabbed().state, down('touch'), tabDragMove(down('touch'), P(70), 70).state]) {
      const r = tabDragDown(s, P(500, 600, 2), 1100, 'touch', 0, [], []);
      expect(r.state.mode).toBe('idle');
      expect(tabDragUp(r.state, P(300)).drop).toBeUndefined();
    }
    // grab からの取りやめは click を捨てる（1 本目の指を離した位置のチップを押したことにしない）
    expect(tabDragDown(grabbed().state, P(500, 600, 2), 1100, 'touch', 0, [], []).cancel).toBe(
      true,
    );
  });

  it('tabDragLostCapture: 追っている pointer の grab だけ取りやめ。別の pointer・pending・idle は何もしない', () => {
    const g = grabbed().state;
    const r = tabDragLostCapture(g, 1);
    expect(r.cancel).toBe(true);
    expect(r.swallowClick).toBe(true);
    expect(r.state.mode).toBe('idle');
    expect(tabDragLostCapture(g, 9).state).toBe(g);
    const p = down('mouse');
    expect(tabDragLostCapture(p, 1).state).toBe(p);
    // 離した後（idle）の capture の解放
    const up = tabDragUp(g, P(300)).state;
    expect(tabDragLostCapture(up, 1).state).toBe(up);
  });

  it('ウィンドウの blur / 隠れた（DOM は tabDragCancel）: grab は取りやめ・離しても drop しない', () => {
    const c = tabDragCancel(grabbed().state);
    expect(c.state.mode).toBe('idle');
    expect(tabDragMove(c.state, P(400), 400).state.mode).toBe('idle');
    expect(tabDragUp(c.state, P(400)).drop).toBeUndefined();
  });

  it('tabDragSync: つかんでいる間に並び・数が変わったら cancel。同じなら state のまま', () => {
    const g = grabbed().state;
    expect(tabDragSync(g, [1, 4, 7]).state).toBe(g);
    expect(tabDragSync(g, [4, 1, 7]).cancel).toBe(true);
    expect(tabDragSync(g, [1, 4]).cancel).toBe(true);
    expect(tabDragSync(down('touch'), [1, 4, 7, 9]).cancel).toBe(true);
    const idle = initialTabDrag();
    expect(tabDragSync(idle, [1]).state).toBe(idle);
  });

  it('範囲外の添字・中心の数が合わない押下は始めない', () => {
    const idle = initialTabDrag();
    expect(tabDragDown(idle, P(0), 0, 'mouse', 3, IDS, CENTERS).state).toBe(idle);
    expect(tabDragDown(idle, P(0), 0, 'mouse', 0, IDS, [1, 2]).state).toBe(idle);
  });
});

describe('previewOrder・edgeScrollStep', () => {
  it('previewOrder: from を to へ（元の配列は変えない）', () => {
    const ids = [1, 4, 7];
    expect(previewOrder(ids, 0, 2)).toEqual([4, 7, 1]);
    expect(previewOrder(ids, 2, 0)).toEqual([7, 1, 4]);
    expect(previewOrder(ids, 1, 1)).toEqual([1, 4, 7]);
    expect(previewOrder(ids, 1, 99)).toEqual([1, 7, 4]);
    expect(previewOrder(ids, 5, 0)).toEqual([1, 4, 7]);
    expect(ids).toEqual([1, 4, 7]);
  });

  it('edgeScrollStep: 端の 24px 以内で ±（近いほど大きく最大 12）、内側 0、帯より外は最大', () => {
    expect(TAB_EDGE_PX).toBe(24);
    expect(TAB_EDGE_STEP_MAX).toBe(12);
    const L = 100;
    const W = 300;
    expect(edgeScrollStep(L + 150, L, W)).toBe(0);
    expect(edgeScrollStep(L + TAB_EDGE_PX, L, W)).toBe(0);
    expect(edgeScrollStep(L + W - TAB_EDGE_PX, L, W)).toBe(0);
    expect(edgeScrollStep(L + 23, L, W)).toBeLessThan(0);
    expect(edgeScrollStep(L + 23, L, W)).toBeGreaterThanOrEqual(-2);
    expect(edgeScrollStep(L, L, W)).toBe(-TAB_EDGE_STEP_MAX);
    expect(edgeScrollStep(L - 50, L, W)).toBe(-TAB_EDGE_STEP_MAX);
    expect(edgeScrollStep(L + W - 23, L, W)).toBeGreaterThan(0);
    expect(edgeScrollStep(L + W, L, W)).toBe(TAB_EDGE_STEP_MAX);
    expect(edgeScrollStep(L + W + 50, L, W)).toBe(TAB_EDGE_STEP_MAX);
    // 近いほど大きい
    expect(Math.abs(edgeScrollStep(L + 5, L, W))).toBeGreaterThan(
      Math.abs(edgeScrollStep(L + 20, L, W)),
    );
    expect(edgeScrollStep(Number.NaN, L, W)).toBe(0);
    expect(edgeScrollStep(L, L, 40)).toBe(0);
  });
});

describe('自動スクロールはつかんだだけでは始めない（tabDragEdge）', () => {
  const L = 100;
  const W = 300;
  // 右端の 10px 内側を押してつかむ（マウス: 6px 動かす）
  const grabAt = (x: number) => {
    const s = tabDragDown(initialTabDrag(), P(x - TAP_MOVE_PX), 1000, 'mouse', 2, IDS, CENTERS);
    const g = tabDragMove(s.state, P(x), 250);
    expect(g.state.mode).toBe('grab');
    expect(g.state.gx).toBe(x);
    expect(g.state.armed).toBe(false);
    return g.state;
  };

  it('端の近くでつかんだ位置のままなら流さない', () => {
    const g = grabAt(L + W - 10);
    expect(edgeScrollStep(L + W - 10, L, W)).toBeGreaterThan(0);
    const e = tabDragEdge(g, L + W - 10, L, W);
    expect(e.step).toBe(0);
    expect(e.state).toBe(g);
    // 端の帯の中で少し動かしても（TAB_EDGE_PX 未満）流さない
    expect(tabDragEdge(g, L + W - 2, L, W).step).toBe(0);
  });

  it(`つかんだ位置から ${TAB_EDGE_PX}px 動けば流す（端の外へ出ても）`, () => {
    const g = grabAt(L + W - 10);
    const e = tabDragEdge(g, L + W - 10 + TAB_EDGE_PX, L, W);
    expect(e.step).toBe(TAB_EDGE_STEP_MAX);
    expect(e.state.armed).toBe(true);
    // 一度 armed になれば、戻っても流す
    expect(tabDragEdge(e.state, L + W - 10, L, W).step).toBeGreaterThan(0);
  });

  it('一度内側（端の帯の外）に入れば、その後は端で流す', () => {
    const g = grabAt(L + W - 10);
    const inner = tabDragEdge(g, L + W - TAB_EDGE_PX, L, W);
    expect(inner.step).toBe(0);
    expect(inner.state.armed).toBe(true);
    expect(tabDragEdge(inner.state, L + W - 10, L, W).step).toBeGreaterThan(0);
  });

  it('真ん中でつかめば端へ運んだときに流す。grab でなければ 0', () => {
    const g = grabAt(L + 150);
    const mid = tabDragEdge(g, L + 150, L, W);
    expect(mid.state.armed).toBe(true);
    expect(tabDragEdge(mid.state, L + W, L, W).step).toBe(TAB_EDGE_STEP_MAX);
    const p = down('mouse');
    expect(tabDragEdge(p, L + W, L, W)).toEqual({ state: p, step: 0 });
  });

  it('タッチの長押しでつかんだ位置（押した位置）も同じ', () => {
    const s = tabDragDown(initialTabDrag(), P(L + 5), 1000, 'touch', 0, IDS, CENTERS).state;
    const g = tabDragLongPress(s, 1000 + LONG_PRESS_MS).state;
    expect(g.gx).toBe(L + 5);
    expect(tabDragEdge(g, L + 5, L, W).step).toBe(0);
    expect(tabDragEdge(g, L + 5 - TAB_EDGE_PX, L, W).step).toBe(-TAB_EDGE_STEP_MAX);
  });
});

describe('click を捨てる印は時間で切れる（clickSwallowed）', () => {
  it(`印から ${TAB_CLICK_SWALLOW_MS}ms までは捨て、過ぎたら捨てない。印なし・時計が戻ったら捨てない`, () => {
    expect(TAB_CLICK_SWALLOW_MS).toBe(400);
    expect(clickSwallowed(1000, 1000)).toBe(true);
    expect(clickSwallowed(1000, 1000 + TAB_CLICK_SWALLOW_MS)).toBe(true);
    expect(clickSwallowed(1000, 1000 + TAB_CLICK_SWALLOW_MS + 1)).toBe(false);
    expect(clickSwallowed(null, 1000)).toBe(false);
    expect(clickSwallowed(1000, 999)).toBe(false);
  });
});

describe('CSS の order の規則（CSP: style を使わないプレビュー）', () => {
  const fs = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
    }
  ).process.getBuiltinModule('node:fs');
  const top = fs.readFileSync(new URL('../../ui/next/css/top.css', import.meta.url), 'utf8');

  it(`top.css に data-pos 0..${MAX_TABS - 1} の order の規則がそろい、それより先は無い`, () => {
    for (let i = 0; i < MAX_TABS; i++) {
      const re = new RegExp(
        `\\.boxtabs\\[data-dragging\\] > \\.boxtab\\[data-pos="${i}"\\] \\{\\s*order: ${i};\\s*\\}`,
      );
      expect(top, `data-pos="${i}"`).toMatch(re);
    }
    expect(top).not.toContain(`data-pos="${MAX_TABS}"`);
  });
});
