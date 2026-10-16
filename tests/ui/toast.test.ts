import { describe, expect, it, vi } from 'vitest';
import {
  expireToasts,
  MAX_TOASTS,
  nextDeadline,
  pushToast,
  TOAST_MS,
  type Toast,
  takeUndo,
  UNDO_TOAST_MS,
} from '../../ui/view/toast';

/** #81: トースト（2.2 秒、[元に戻す] 付きは 5 秒。同じ種類は置き換え、最大 3 件）。時計は引数。 */
describe('toast', () => {
  it('時間と件数', () => {
    expect(TOAST_MS).toBe(2200);
    expect(UNDO_TOAST_MS).toBe(5000);
    expect(MAX_TOASTS).toBe(3);
  });

  it('2,200ms で消える（[元に戻す] 付きは 5,000ms）', () => {
    let list = pushToast([], { kind: 'a', text: '保存した' }, 1, 1000);
    list = pushToast(list, { kind: 'b', text: '足を削除した', undo: () => {} }, 2, 1000);
    expect(list.map((t) => t.until)).toEqual([3200, 6000]);
    expect(nextDeadline(list)).toBe(3200);
    expect(expireToasts(list, 3199).map((t) => t.id)).toEqual([1, 2]);
    expect(expireToasts(list, 3200).map((t) => t.id)).toEqual([2]);
    expect(nextDeadline(expireToasts(list, 3200))).toBe(6000);
    expect(expireToasts(list, 5999).map((t) => t.id)).toEqual([2]);
    expect(expireToasts(list, 6000)).toEqual([]);
    expect(nextDeadline([])).toBeNull();
  });

  it('消えるものが無ければ同じ参照を返す', () => {
    const list = pushToast([], { kind: 'a', text: 'x' }, 1, 0);
    expect(expireToasts(list, 100)).toBe(list);
  });

  it('同じ種類は置き換える（位置は末尾・時間は新しく）', () => {
    let list = pushToast([], { kind: 'a', text: '1' }, 1, 0);
    list = pushToast(list, { kind: 'b', text: '2' }, 2, 0);
    list = pushToast(list, { kind: 'a', text: '3' }, 3, 1000);
    expect(list.map((t) => [t.id, t.kind, t.text, t.until])).toEqual([
      [2, 'b', '2', 2200],
      [3, 'a', '3', 3200],
    ]);
  });

  it('4 件目で最も古いものが消える', () => {
    let list: Toast[] = [];
    for (let i = 1; i <= 4; i++) list = pushToast(list, { kind: `k${i}`, text: `${i}` }, i, i);
    expect(list.map((t) => t.id)).toEqual([2, 3, 4]);
  });

  it('[元に戻す] の関数は 2 回押しても 1 回だけ（押したトーストは消える）', () => {
    const undo = vi.fn();
    const list = pushToast([], { kind: 'del', text: '足を削除した', undo }, 7, 0);
    const first = takeUndo(list, 7);
    expect(first.list).toEqual([]);
    first.undo?.();
    const second = takeUndo(first.list, 7);
    expect(second.undo).toBeNull();
    second.undo?.();
    // 呼んだ側が古い一覧を持っていても 1 回だけ: 呼ぶのは返した関数だけで、一覧からは消える
    expect(undo).toHaveBeenCalledTimes(1);
    expect(takeUndo(list, 99)).toEqual({ list, undo: null });
  });

  it('[元に戻す] の無いトーストは undo が null（一覧からは消える）', () => {
    const list = pushToast([], { kind: 'a', text: 'x' }, 1, 0);
    expect(takeUndo(list, 1)).toEqual({ list: [], undo: null });
  });
});
