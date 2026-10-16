import { describe, expect, it } from 'vitest';
import { hintAlign, hintNext } from '../../ui/view/hint';

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
