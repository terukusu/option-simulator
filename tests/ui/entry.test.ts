import { describe, expect, it } from 'vitest';
import { uiVariant } from '../../ui/entry';

/** #81: 新しい画面の入口（?ui=next）。ui がちょうど next のときだけ新しい画面。 */
describe('uiVariant', () => {
  it('ui=next で新しい画面（他のクエリと並んでもよい）', () => {
    expect(uiVariant('?ui=next')).toBe('next');
    expect(uiVariant('?a=1&ui=next')).toBe('next');
    expect(uiVariant('ui=next')).toBe('next');
  });

  it('無し・大文字・他の値・空・キーだけは旧画面', () => {
    for (const s of [
      '',
      '?',
      '?ui=NEXT',
      '?ui=old',
      '?ui=',
      '?uinext',
      '?ui',
      '?ui=next2',
      '?xui=next',
    ]) {
      expect(uiVariant(s), s).toBe('legacy');
    }
  });

  it('同じキーが複数あるときは最初の値で決める（URLSearchParams.get）', () => {
    expect(uiVariant('?ui=next&ui=old')).toBe('next');
    expect(uiVariant('?ui=old&ui=next')).toBe('legacy');
  });
});
