import { describe, expect, it } from 'vitest';
import { dropUndoToasts } from '../../ui/view/positionsRegion';
import {
  dropToastKind,
  expireToasts,
  MAX_TOASTS,
  NOTE_TOAST_MS,
  nextDeadline,
  pushToast,
  type Toast,
  UNDO_TOAST_MS,
} from '../../ui/view/toast';

/** #87 AC-4: 知らせのトースト（情報 6 秒・警告は閉じるまで）・keep・dropToastKind。時計は引数。 */
describe('知らせのトースト', () => {
  it('情報は 6,000ms で消える（5,999 で残る）', () => {
    expect(NOTE_TOAST_MS).toBe(6000);
    const list = pushToast([], { kind: 'note-restored', text: '復元した', note: 'info' }, 1, 1000);
    expect(list[0]?.until).toBe(7000);
    expect(nextDeadline(list)).toBe(7000);
    expect(expireToasts(list, 6999).map((t) => t.id)).toEqual([1]);
    expect(expireToasts(list, 7000)).toEqual([]);
  });

  it('警告は時刻が進んでも消えず、[閉じる]（dismiss = id で外す）か dropToastKind で消える', () => {
    const list = pushToast([], { kind: 'note-invalid', text: '読めなかった', note: 'warn' }, 1, 0);
    expect(list[0]?.until).toBe(Number.POSITIVE_INFINITY);
    expect(expireToasts(list, 1e12)).toBe(list);
    expect(nextDeadline(list)).toBeNull();
    // dismiss（useToasts の dismiss と同じ規則）
    expect(list.filter((t) => t.id !== 1)).toEqual([]);
    expect(dropToastKind(list, 'note-invalid')).toEqual([]);
    expect(dropToastKind(list, 'load-failed')).toBe(list);
  });

  it('nextDeadline は消えないものを無視して有限の期限の最小を返す', () => {
    let list = pushToast([], { kind: 'w', text: '警告', note: 'warn' }, 1, 0);
    list = pushToast(list, { kind: 'i', text: '情報', note: 'info' }, 2, 100);
    list = pushToast(list, { kind: 'u', text: '削除した', undo: () => {} }, 3, 200);
    expect(nextDeadline(list)).toBe(200 + UNDO_TOAST_MS);
    expect(nextDeadline(expireToasts(list, 200 + UNDO_TOAST_MS))).toBe(100 + NOTE_TOAST_MS);
  });

  it('dropUndoToasts: 知らせのトーストと keep 付きの [元に戻す] は残り、ほかの [元に戻す] は消える', () => {
    let list: Toast[] = pushToast([], { kind: 'note-restored', text: '復元', note: 'info' }, 1, 0);
    list = pushToast(
      list,
      { kind: 'tab-closed', text: 'タブ A を閉じた', undo: () => {}, keep: true },
      2,
      0,
    );
    list = pushToast(list, { kind: 'remove', text: '足を削除した', undo: () => {} }, 3, 0);
    expect(dropUndoToasts(list).map((t) => t.id)).toEqual([1, 2]);
    const kept = dropUndoToasts(list);
    expect(dropUndoToasts(kept)).toBe(kept);
  });

  it('最大 3 件: 4 件目で最も古いもの（消えない警告でも）を押し出す', () => {
    let list = pushToast([], { kind: 'note-invalid', text: '警告', note: 'warn' }, 1, 0);
    list = pushToast(list, { kind: 'a', text: 'a' }, 2, 1);
    list = pushToast(list, { kind: 'b', text: 'b' }, 3, 2);
    list = pushToast(list, { kind: 'c', text: 'c' }, 4, 3);
    expect(MAX_TOASTS).toBe(3);
    expect(list.map((t) => t.id)).toEqual([2, 3, 4]);
  });

  it('同じ種類の知らせは置き換える', () => {
    let list = pushToast([], { kind: 'note-shared', text: '1', note: 'warn' }, 1, 0);
    list = pushToast(list, { kind: 'note-shared', text: '2', note: 'info' }, 2, 10);
    expect(list.map((t) => [t.id, t.text, t.until])).toEqual([[2, '2', 10 + NOTE_TOAST_MS]]);
  });
});
