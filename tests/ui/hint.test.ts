import { describe, expect, it } from 'vitest';
import { hintAlign, hintNext, revealDelta } from '../../ui/view/hint';

/** #63: 説明の吹き出し（ⓘ）の開閉と寄せ。 */
describe('hintNext（開閉）', () => {
  it('toggle で開く・もう一度で閉じる', () => {
    expect(hintNext(false, 'toggle')).toBe(true);
    expect(hintNext(true, 'toggle')).toBe(false);
  });

  it('外側のタップ・Esc で閉じる（閉じているときは閉じたまま）', () => {
    expect(hintNext(true, 'outside')).toBe(false);
    expect(hintNext(true, 'escape')).toBe(false);
    expect(hintNext(false, 'outside')).toBe(false);
    expect(hintNext(false, 'escape')).toBe(false);
  });

  it('ほかの出来事（他の ⓘ が開いた）で閉じる', () => {
    expect(hintNext(true, 'other')).toBe(false);
    expect(hintNext(false, 'other')).toBe(false);
  });
});

describe('hintAlign（左右の寄せ）', () => {
  it('ボタンの中心が行の左半分なら start、右半分なら end', () => {
    expect(hintAlign(20, 0, 360)).toBe('start');
    expect(hintAlign(179, 0, 360)).toBe('start');
    expect(hintAlign(181, 0, 360)).toBe('end');
    expect(hintAlign(350, 0, 360)).toBe('end');
  });

  it('行が画面の途中から始まっても行の中で判定する', () => {
    expect(hintAlign(900, 800, 1200)).toBe('start');
    expect(hintAlign(1100, 800, 1200)).toBe('end');
  });

  it('幅 0 の行（測れない）は start', () => {
    expect(hintAlign(10, 0, 0)).toBe('start');
  });
});

/** #107: 開いた全文のポップオーバーをスクロールする祖先（.panel-body）の中で見せる量。 */
describe('revealDelta（祖先の scrollTop の増分）', () => {
  it('入っていれば 0', () => {
    expect(revealDelta(120, 300, 100, 500)).toBe(0);
    expect(revealDelta(120, 500, 100, 500)).toBe(0);
  });

  it('下にはみ出す量だけ正', () => {
    expect(revealDelta(300, 560, 100, 500)).toBe(60);
  });

  it('上端を越えて動かさない（host の高さが足りないときは上端を揃える）', () => {
    expect(revealDelta(150, 700, 100, 400)).toBe(50);
    expect(revealDelta(100, 700, 100, 400)).toBe(0);
  });

  it('負にならない・NaN は 0', () => {
    expect(revealDelta(50, 700, 100, 400)).toBe(0);
    expect(revealDelta(Number.NaN, 700, 100, 400)).toBe(0);
    expect(revealDelta(150, Number.NaN, 100, 400)).toBe(0);
    expect(revealDelta(150, 700, 100, Number.NaN)).toBe(0);
  });
});
