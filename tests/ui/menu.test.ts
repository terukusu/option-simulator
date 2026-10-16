import { describe, expect, it } from 'vitest';
import { menuMove } from '../../ui/view/menu';

/** #81: メニューのキー移動（↑↓ は端で回る・Home / End・無効な項目を飛ばす）。 */
describe('menuMove', () => {
  const none = [false, false, false];

  it('↓ / ↑ で 1 つずつ、端で回る', () => {
    expect(menuMove(none, 0, 'ArrowDown')).toBe(1);
    expect(menuMove(none, 2, 'ArrowDown')).toBe(0);
    expect(menuMove(none, 0, 'ArrowUp')).toBe(2);
    expect(menuMove(none, 1, 'ArrowUp')).toBe(0);
  });

  it('Home / End は最初 / 最後の有効な項目', () => {
    expect(menuMove(none, 1, 'Home')).toBe(0);
    expect(menuMove(none, 1, 'End')).toBe(2);
    expect(menuMove([true, false, false, true], 2, 'Home')).toBe(1);
    expect(menuMove([true, false, false, true], 1, 'End')).toBe(2);
  });

  it('無効な項目を飛ばす（回り込みも含む）', () => {
    const d = [false, true, false, true];
    expect(menuMove(d, 0, 'ArrowDown')).toBe(2);
    expect(menuMove(d, 2, 'ArrowDown')).toBe(0);
    expect(menuMove(d, 0, 'ArrowUp')).toBe(2);
    expect(menuMove(d, 2, 'ArrowUp')).toBe(0);
  });

  it('どこにもフォーカスが無い（-1）ときは ↓ で最初、↑ で最後', () => {
    expect(menuMove(none, -1, 'ArrowDown')).toBe(0);
    expect(menuMove(none, -1, 'ArrowUp')).toBe(2);
  });

  it('有効な項目が 1 つならそこに留まる、全部無効・空なら -1', () => {
    expect(menuMove([true, false, true], 1, 'ArrowDown')).toBe(1);
    expect(menuMove([true, false, true], 1, 'ArrowUp')).toBe(1);
    expect(menuMove([true, true], 0, 'ArrowDown')).toBe(-1);
    expect(menuMove([true, true], 0, 'Home')).toBe(-1);
    expect(menuMove([], -1, 'End')).toBe(-1);
  });
});
