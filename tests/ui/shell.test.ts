import { describe, expect, it } from 'vitest';
import {
  dockPanels,
  INITIAL_SHELL,
  layoutTier,
  SHEET_SNAP_PX,
  SHEET_TAP_PX,
  type ShellState,
  shellReduce,
  visiblePanel,
} from '../../ui/view/shell';

/** #81: 新しい画面の見た目の状態（パネル・シート・市場）。保存しない。 */
const at = (s: Partial<ShellState>): ShellState => ({ ...INITIAL_SHELL, ...s });

describe('shellReduce', () => {
  it('既定は positions / peek / board', () => {
    expect(INITIAL_SHELL).toEqual({ panel: 'positions', sheet: 'peek', market: 'board' });
    expect(SHEET_SNAP_PX).toBe(40);
    expect(SHEET_TAP_PX).toBe(6);
  });

  it('ドック: 開いている同じボタン → hidden、別のボタン → そのパネル（開き具合はそのまま）、hidden から → peek', () => {
    expect(shellReduce(at({}), { type: 'dock', panel: 'positions', tier: 'phone' })).toEqual(
      at({ sheet: 'hidden' }),
    );
    expect(shellReduce(at({}), { type: 'dock', panel: 'board', tier: 'phone' })).toEqual(
      at({ panel: 'board', sheet: 'peek' }),
    );
    expect(
      shellReduce(at({ sheet: 'full' }), { type: 'dock', panel: 'metrics', tier: 'phone' }),
    ).toEqual(at({ panel: 'metrics', sheet: 'full' }));
    expect(
      shellReduce(at({ sheet: 'hidden' }), { type: 'dock', panel: 'positions', tier: 'phone' }),
    ).toEqual(at({ sheet: 'peek' }));
    expect(
      shellReduce(at({ sheet: 'hidden' }), { type: 'dock', panel: 'smile', tier: 'phone' }),
    ).toEqual(at({ panel: 'smile', sheet: 'peek' }));
    expect(
      shellReduce(at({ sheet: 'full' }), { type: 'dock', panel: 'positions', tier: 'phone' }),
    ).toEqual(at({ sheet: 'hidden' }));
  });

  it('つまみのタップ（|dy| < 6）: peek ⇄ full', () => {
    expect(shellReduce(at({}), { type: 'grab', dy: 0 }).sheet).toBe('full');
    expect(shellReduce(at({ sheet: 'full' }), { type: 'grab', dy: 5 }).sheet).toBe('peek');
    expect(shellReduce(at({}), { type: 'grab', dy: -5.9 }).sheet).toBe('full');
  });

  it('つまみのドラッグ: 下へ 40px 以上で full → peek → hidden、39px は変わらない', () => {
    expect(shellReduce(at({ sheet: 'full' }), { type: 'grab', dy: 40 }).sheet).toBe('peek');
    expect(shellReduce(at({ sheet: 'peek' }), { type: 'grab', dy: 40 }).sheet).toBe('hidden');
    expect(shellReduce(at({ sheet: 'full' }), { type: 'grab', dy: 39 }).sheet).toBe('full');
    expect(shellReduce(at({ sheet: 'peek' }), { type: 'grab', dy: 39 }).sheet).toBe('peek');
    expect(shellReduce(at({ sheet: 'peek' }), { type: 'grab', dy: 6 }).sheet).toBe('peek');
    // 1 回のドラッグで進むのは 1 段だけ
    expect(shellReduce(at({ sheet: 'full' }), { type: 'grab', dy: 400 }).sheet).toBe('peek');
  });

  it('つまみのドラッグ: 上へ 40px 以上で peek → full（full は full のまま）', () => {
    expect(shellReduce(at({ sheet: 'peek' }), { type: 'grab', dy: -40 }).sheet).toBe('full');
    expect(shellReduce(at({ sheet: 'peek' }), { type: 'grab', dy: -39 }).sheet).toBe('peek');
    expect(shellReduce(at({ sheet: 'full' }), { type: 'grab', dy: -40 }).sheet).toBe('full');
  });

  it('hidden ではつまみが出ないので grab は何もしない', () => {
    const s = at({ sheet: 'hidden' });
    expect(shellReduce(s, { type: 'grab', dy: 0 })).toBe(s);
    expect(shellReduce(s, { type: 'grab', dy: -40 })).toBe(s);
    expect(shellReduce(s, { type: 'grab', dy: 40 })).toBe(s);
  });

  it('変わらないときは同じ参照を返す（再描画しない）', () => {
    const s = at({ sheet: 'full' });
    expect(shellReduce(s, { type: 'grab', dy: 20 })).toBe(s);
    expect(shellReduce(s, { type: 'market', market: 'board' })).toBe(s);
  });

  it('市場のセグメント', () => {
    expect(shellReduce(at({}), { type: 'market', market: 'smile' })).toEqual(
      at({ market: 'smile' }),
    );
  });

  it('タブレットで scenario は選べない（positions に読み替える）', () => {
    expect(
      shellReduce(at({ panel: 'board' }), { type: 'dock', panel: 'scenario', tier: 'tablet' }),
    ).toEqual(at({ panel: 'positions' }));
    // スマホでは選べる
    expect(shellReduce(at({}), { type: 'dock', panel: 'scenario', tier: 'phone' })).toEqual(
      at({ panel: 'scenario' }),
    );
  });
});

describe('layoutTier / visiblePanel / dockPanels', () => {
  it('幅の段階', () => {
    expect(layoutTier(true, false)).toBe('phone');
    expect(layoutTier(false, false)).toBe('tablet');
    expect(layoutTier(false, true)).toBe('pc');
  });

  it('タブレットで scenario を表示中なら positions を見せる（幅がタブレットになったとき）', () => {
    expect(visiblePanel(at({ panel: 'scenario' }), 'tablet')).toBe('positions');
    expect(visiblePanel(at({ panel: 'scenario' }), 'phone')).toBe('scenario');
    expect(visiblePanel(at({ panel: 'board' }), 'tablet')).toBe('board');
  });

  it('ドックのボタン: スマホ 5・タブレット 4（シナリオ無し）・PC 無し', () => {
    expect(dockPanels('phone')).toEqual(['positions', 'board', 'scenario', 'metrics', 'smile']);
    expect(dockPanels('tablet')).toEqual(['positions', 'board', 'metrics', 'smile']);
    expect(dockPanels('pc')).toEqual([]);
  });
});

describe('shellReduce の open（#82 AC-7: 舞台の足マーカーのタップ）', () => {
  it('開いている同じパネルでも閉じない（同じ参照）、hidden なら peek、full は full のまま', () => {
    const s = at({});
    expect(shellReduce(s, { type: 'open', panel: 'positions', tier: 'phone' })).toBe(s);
    const full = at({ sheet: 'full' });
    expect(shellReduce(full, { type: 'open', panel: 'positions', tier: 'phone' })).toBe(full);
    expect(
      shellReduce(at({ sheet: 'hidden' }), { type: 'open', panel: 'positions', tier: 'phone' }),
    ).toEqual(at({ sheet: 'peek' }));
    expect(
      shellReduce(at({ panel: 'board', sheet: 'hidden' }), {
        type: 'open',
        panel: 'positions',
        tier: 'phone',
      }),
    ).toEqual(at({ panel: 'positions', sheet: 'peek' }));
    expect(
      shellReduce(at({ panel: 'metrics', sheet: 'full' }), {
        type: 'open',
        panel: 'positions',
        tier: 'phone',
      }),
    ).toEqual(at({ panel: 'positions', sheet: 'full' }));
  });

  it('タブレットで scenario は positions、PC でも状態は変わる（見た目はパネルが常設）', () => {
    expect(
      shellReduce(at({ panel: 'board' }), { type: 'open', panel: 'scenario', tier: 'tablet' }),
    ).toEqual(at({ panel: 'positions' }));
    const pc = at({ panel: 'positions' });
    expect(shellReduce(pc, { type: 'open', panel: 'positions', tier: 'pc' })).toBe(pc);
  });
});
