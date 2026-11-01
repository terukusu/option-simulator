import { describe, expect, it, vi } from 'vitest';
import { RELOAD_PAGE_LABEL, RELOAD_PAGE_REF } from '../../ui/view/reloadPage';
import { pushToast, type Toast, type ToastInput, toastButtons } from '../../ui/view/toast';

/** #341: トーストのボタンの並び（toastButtons）。[元に戻す] / [ページを読み直す] / [閉じる] */
const at = (t: ToastInput, id = 7): Toast => ({ ...t, id, until: 1000 });

function handlers(withDismiss = true) {
  const h = { undo: vi.fn(), reload: vi.fn(), dismiss: vi.fn() };
  return {
    h,
    inject: withDismiss ? h : { undo: h.undo, reload: h.reload },
  };
}

describe('toastButtons（#341）', () => {
  it('ボタンの文字は [ページを読み直す]（銘柄の推移の ⟳ と区別）。文はこの形で指す', () => {
    expect(RELOAD_PAGE_LABEL).toBe('ページを読み直す');
    expect(RELOAD_PAGE_REF).toBe('[ページを読み直す]');
  });

  it('note なし: undo があれば [元に戻す] だけ。押すと undo(id) を 1 回', () => {
    const { h, inject } = handlers();
    const b = toastButtons(at({ kind: 'x', text: 't', undo: () => {} }), inject);
    expect(b.map((x) => [x.label, x.ariaLabel])).toEqual([['元に戻す', undefined]]);
    b[0]?.run();
    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith(7);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
    // undo の無いトーストはボタンなし。note なしの reload は無視
    expect(toastButtons(at({ kind: 'x', text: 't' }), inject)).toEqual([]);
    expect(toastButtons(at({ kind: 'x', text: 't', reload: true }), inject)).toEqual([]);
  });

  it('note あり: [閉じる]（aria-label「知らせを閉じる」）。押すと dismiss(id)', () => {
    const { h, inject } = handlers();
    const b = toastButtons(at({ kind: 'x', text: 't', note: 'warn' }), inject);
    expect(b.map((x) => [x.label, x.ariaLabel])).toEqual([['閉じる', '知らせを閉じる']]);
    b[0]?.run();
    expect(h.dismiss).toHaveBeenCalledWith(7);
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('note + reload: [ページを読み直す] → [閉じる] の順。[ページを読み直す] は reload() を引数なしで 1 回', () => {
    const { h, inject } = handlers();
    const b = toastButtons(at({ kind: 'x', text: 't', note: 'warn', reload: true }), inject);
    expect(b.map((x) => [x.label, x.ariaLabel])).toEqual([
      ['ページを読み直す', undefined],
      ['閉じる', '知らせを閉じる'],
    ]);
    b[0]?.run();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalledWith();
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
  });

  it('dismiss の無い note + reload: [ページを読み直す] だけ', () => {
    const { h, inject } = handlers(false);
    const b = toastButtons(at({ kind: 'x', text: 't', note: 'warn', reload: true }), inject);
    expect(b.map((x) => x.label)).toEqual(['ページを読み直す']);
    b[0]?.run();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(toastButtons(at({ kind: 'x', text: 't', note: 'info' }), inject)).toEqual([]);
  });

  it('reload 付きの警告も [閉じる] まで消えない（until = Infinity）', () => {
    const list = pushToast([], { kind: 'x', text: 't', note: 'warn', reload: true }, 1, 0);
    expect(list[0]?.until).toBe(Number.POSITIVE_INFINITY);
    expect(list[0]?.reload).toBe(true);
  });
});
