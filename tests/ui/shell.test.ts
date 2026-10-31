import { describe, expect, it } from 'vitest';
import { PANEL_KEY } from '../../ui/view/keys';
import {
  aiVisible,
  CHART_MODES,
  chartMode,
  DOCK_LABELS,
  dockPanels,
  futVisible,
  holdMapActive,
  INITIAL_SHELL,
  initialShell,
  ivVisible,
  layoutTier,
  leftView,
  MARKET_VIEWS,
  metricsVisible,
  replayActive,
  SHEET_SNAP_PX,
  SHEET_TAP_PX,
  type ShellState,
  SMILE_VIEWS,
  shellReduce,
  smileView,
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

  it('市場の見え方の一覧は 1 か所（#85。#79 で IV 推移、#190 で先物を足した）', () => {
    expect(MARKET_VIEWS.map((v) => [v.value, v.text])).toEqual([
      ['board', '板'],
      ['smile', 'スマイル'],
      ['iv', 'IV 推移'],
      ['fut', '先物'],
    ]);
    expect(shellReduce(at({}), { type: 'market', market: 'iv' })).toEqual(at({ market: 'iv' }));
  });

  it('#130: スマホ・タブレットの IV のパネルの [IV 推移 | スマイル]（PC 以外の既定 board は IV 推移、PC は市場が iv のときだけ iv）', () => {
    expect(SMILE_VIEWS.map((v) => [v.value, v.text])).toEqual([
      ['iv', 'IV 推移'],
      ['smile', 'スマイル'],
      ['fut', '先物'],
    ]);
    for (const tier of ['phone', 'tablet'] as const) {
      expect(smileView(INITIAL_SHELL, tier)).toBe('iv');
      expect(smileView(at({ market: 'board' }), tier)).toBe('iv');
      expect(smileView(at({ market: 'iv' }), tier)).toBe('iv');
      expect(smileView(at({ market: 'smile' }), tier)).toBe('smile');
    }
    expect(smileView(INITIAL_SHELL, 'pc')).toBe('smile');
    expect(smileView(at({ market: 'smile' }), 'pc')).toBe('smile');
    expect(smileView(at({ market: 'iv' }), 'pc')).toBe('iv');
    // パネルの中でスマイルを選ぶと、閉じて（別のパネル）開き直してもスマイルのまま（市場は保つ）
    let s = shellReduce(at({ panel: 'smile' }), { type: 'market', market: 'smile' });
    s = shellReduce(s, { type: 'dock', panel: 'board', tier: 'phone' });
    s = shellReduce(s, { type: 'dock', panel: 'smile', tier: 'phone' });
    expect(smileView(s, 'phone')).toBe('smile');
  });

  it('#130・#135: ドックのボタンの文字（smile = IV・ai = AI）と読み上げの名前、ボタンの数はスマホ 6・タブレット 5・PC 0', () => {
    expect(Object.entries(DOCK_LABELS).map(([id, d]) => [id, d.text])).toEqual([
      ['positions', 'ポジ'],
      ['board', '板'],
      ['scenario', 'シナリオ'],
      ['metrics', '指標'],
      ['smile', 'IV'],
      ['ai', 'AI'],
    ]);
    expect(DOCK_LABELS.smile.name).toBe('IV 推移 · スマイル');
    expect(dockPanels('phone').map((id) => DOCK_LABELS[id].text)).toEqual([
      '板',
      'IV',
      'ポジ',
      'シナリオ',
      '指標',
      'AI',
    ]);
    expect(dockPanels('tablet').map((id) => DOCK_LABELS[id].text)).toEqual([
      '板',
      'IV',
      'ポジ',
      '指標',
      'AI',
    ]);
    expect(dockPanels('pc')).toEqual([]);
  });

  it('#79・#130: IV 推移が見えているか（PC = 市場が iv、タブレット = IV のパネルで smileView が iv、スマホ = それに加えて hidden でない）', () => {
    const iv = (s: Partial<ShellState>) => at({ market: 'iv', ...s });
    expect(ivVisible(iv({}), 'pc')).toBe(true);
    expect(ivVisible(at({ market: 'smile' }), 'pc')).toBe(false);
    expect(ivVisible(at({ market: 'board' }), 'pc')).toBe(false);
    // 既定の状態（market = board）でパネルが smile
    expect(ivVisible(at({ panel: 'smile' }), 'tablet')).toBe(true);
    expect(ivVisible(at({ panel: 'smile', sheet: 'hidden' }), 'tablet')).toBe(true);
    expect(ivVisible(at({ panel: 'smile' }), 'phone')).toBe(true);
    expect(ivVisible(at({ panel: 'smile', sheet: 'full' }), 'phone')).toBe(true);
    expect(ivVisible(at({ panel: 'smile', sheet: 'hidden' }), 'phone')).toBe(false);
    // パネルの中でスマイルを選んでいる
    expect(ivVisible(at({ market: 'smile', panel: 'smile' }), 'tablet')).toBe(false);
    expect(ivVisible(at({ market: 'smile', panel: 'smile' }), 'phone')).toBe(false);
    expect(ivVisible(iv({ panel: 'smile' }), 'tablet')).toBe(true);
    expect(ivVisible(iv({ panel: 'board' }), 'tablet')).toBe(false);
    expect(ivVisible(iv({ panel: 'positions' }), 'phone')).toBe(false);
    expect(ivVisible(at({ panel: 'positions' }), 'tablet')).toBe(false);
  });

  it('#190: 先物推移が見えているか（条件は IV 推移と同じで市場が fut。IV 推移とは同時に見えない）', () => {
    const fut = (s: Partial<ShellState>) => at({ market: 'fut', ...s });
    for (const tier of ['phone', 'tablet', 'pc'] as const) {
      expect(smileView(fut({}), tier)).toBe('fut');
    }
    expect(futVisible(fut({}), 'pc')).toBe(true);
    expect(ivVisible(fut({}), 'pc')).toBe(false);
    expect(futVisible(at({ market: 'iv' }), 'pc')).toBe(false);
    expect(futVisible(fut({ panel: 'smile' }), 'tablet')).toBe(true);
    expect(ivVisible(fut({ panel: 'smile' }), 'tablet')).toBe(false);
    expect(futVisible(fut({ panel: 'smile' }), 'phone')).toBe(true);
    expect(futVisible(fut({ panel: 'smile', sheet: 'hidden' }), 'phone')).toBe(false);
    expect(futVisible(fut({ panel: 'board' }), 'tablet')).toBe(false);
    // 既定（board）では見えない
    expect(futVisible(at({ panel: 'smile' }), 'phone')).toBe(false);
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

  it('ドックのボタン: スマホ 6・タブレット 5（シナリオ無し）・PC 無し。#275: 並びは検討の流れの順でキー 1〜6 と同じ', () => {
    expect(dockPanels('phone')).toEqual([
      'board',
      'smile',
      'positions',
      'scenario',
      'metrics',
      'ai',
    ]);
    expect(dockPanels('tablet')).toEqual(['board', 'smile', 'positions', 'metrics', 'ai']);
    expect(dockPanels('pc')).toEqual([]);
    expect(dockPanels('phone').map((id) => PANEL_KEY[id])).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('#275: 開いたときの既定のパネルは足 0 本なら板、足があればポジ（ほかは INITIAL_SHELL のまま）', () => {
    expect(initialShell(0)).toEqual({ ...INITIAL_SHELL, panel: 'board' });
    expect(initialShell(1)).toBe(INITIAL_SHELL);
    expect(initialShell(4).panel).toBe('positions');
  });
});

describe('#135 AI のパネル（スマホ・タブレットはドックの 1 枚、PC は左の列（市場）の入れ替え。#280）', () => {
  it('left: 既定 market、入れ替え・指定・変わらなければ同じ参照', () => {
    const s = at({});
    expect(leftView(s)).toBe('market');
    const ai = shellReduce(s, { type: 'left' });
    expect(leftView(ai)).toBe('ai');
    expect(leftView(shellReduce(ai, { type: 'left' }))).toBe('market');
    expect(shellReduce(ai, { type: 'left', left: 'ai' })).toBe(ai);
    expect(leftView(shellReduce(ai, { type: 'left', left: 'market' }))).toBe('market');
  });

  it('#280 戻すと前の市場の見え方のまま（板 / スマイル / IV 推移 / 先物）', () => {
    for (const { value } of MARKET_VIEWS) {
      const ai = shellReduce(at({ market: value }), { type: 'left' });
      expect(ai.market).toBe(value);
      expect(shellReduce(ai, { type: 'left' }).market).toBe(value);
    }
  });

  it('#280 PC の open: ai → 左の列を ai、ポジション・シナリオ・指標は AI を閉じない（同じ参照）、板・スマイル → market', () => {
    const s = at({});
    const ai = shellReduce(s, { type: 'open', panel: 'ai', tier: 'pc' });
    expect(leftView(ai)).toBe('ai');
    for (const panel of ['positions', 'scenario', 'metrics'] as const)
      expect(shellReduce(ai, { type: 'open', panel, tier: 'pc' })).toBe(ai);
    for (const panel of ['board', 'smile'] as const)
      expect(leftView(shellReduce(ai, { type: 'open', panel, tier: 'pc' }))).toBe('market');
    expect(shellReduce(s, { type: 'open', panel: 'board', tier: 'pc' })).toBe(s);
  });

  it('#280 市場の見え方を選ぶ（キー 1・2・板から足す）と左の列を市場に戻す。同じ見え方でも戻す', () => {
    const ai = at({ left: 'ai', market: 'iv' });
    const board = shellReduce(ai, { type: 'market', market: 'board' });
    expect(board.market).toBe('board');
    expect(leftView(board)).toBe('market');
    const same = shellReduce(ai, { type: 'market', market: 'iv' });
    expect(same.market).toBe('iv');
    expect(leftView(same)).toBe('market');
    // 市場のままなら同じ見え方は同じ参照
    const s = at({ market: 'iv' });
    expect(shellReduce(s, { type: 'market', market: 'iv' })).toBe(s);
  });

  it('#280 スマホ・タブレットの open / dock は left を変えない', () => {
    const ai = at({ left: 'ai' });
    for (const tier of ['phone', 'tablet'] as const) {
      expect(leftView(shellReduce(ai, { type: 'open', panel: 'metrics', tier }))).toBe('ai');
      expect(leftView(shellReduce(ai, { type: 'dock', panel: 'board', tier }))).toBe('ai');
      expect(leftView(shellReduce(at({}), { type: 'open', panel: 'ai', tier }))).toBe('market');
    }
  });

  it('見えているか: PC = 左の列が ai、タブレット = パネルが ai、スマホ = それに加えて hidden でない', () => {
    expect(aiVisible(at({ left: 'ai' }), 'pc')).toBe(true);
    expect(aiVisible(at({}), 'pc')).toBe(false);
    expect(aiVisible(at({ left: 'ai' }), 'tablet')).toBe(false);
    expect(aiVisible(at({ panel: 'ai' }), 'tablet')).toBe(true);
    expect(aiVisible(at({ panel: 'ai', sheet: 'hidden' }), 'tablet')).toBe(true);
    expect(aiVisible(at({ panel: 'ai', sheet: 'peek' }), 'phone')).toBe(true);
    expect(aiVisible(at({ panel: 'ai', sheet: 'hidden' }), 'phone')).toBe(false);
    expect(aiVisible(at({ panel: 'board' }), 'phone')).toBe(false);
  });

  it('#280 PC で AI を出している間は IV 推移・先物推移は見えていない（市場に戻すと見える）', () => {
    expect(ivVisible(at({ market: 'iv' }), 'pc')).toBe(true);
    expect(ivVisible(at({ market: 'iv', left: 'ai' }), 'pc')).toBe(false);
    expect(futVisible(at({ market: 'fut' }), 'pc')).toBe(true);
    expect(futVisible(at({ market: 'fut', left: 'ai' }), 'pc')).toBe(false);
    // スマホ・タブレットは left を見ない
    expect(ivVisible(at({ panel: 'smile', left: 'ai' }), 'tablet')).toBe(true);
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

describe('グラフの表示（#88 AC-5）', () => {
  it('既定は line（INITIAL_SHELL は変えない）、選べるのは 線 / 面', () => {
    expect(chartMode(INITIAL_SHELL)).toBe('line');
    expect(CHART_MODES.map((m) => m.value)).toEqual(['line', 'surface']);
    expect(CHART_MODES.map((m) => m.text)).toEqual(['線', '面']);
  });

  it('chart の action で surface ⇄ line、同じ値なら同じ参照', () => {
    const s0 = at({});
    const s1 = shellReduce(s0, { type: 'chart', chart: 'surface' });
    expect(chartMode(s1)).toBe('surface');
    expect(s1).toEqual({ ...s0, chart: 'surface' });
    expect(shellReduce(s1, { type: 'chart', chart: 'surface' })).toBe(s1);
    const s2 = shellReduce(s1, { type: 'chart', chart: 'line' });
    expect(chartMode(s2)).toBe('line');
    expect(shellReduce(s2, { type: 'chart', chart: 'line' })).toBe(s2);
    // 既定（chart 無し）に line を入れても同じ参照
    expect(shellReduce(s0, { type: 'chart', chart: 'line' })).toBe(s0);
  });

  it('他の action（dock・open・grab・market）で chart が変わらない', () => {
    const s = at({ chart: 'surface' });
    const after = [
      shellReduce(s, { type: 'dock', panel: 'board', tier: 'phone' }),
      shellReduce(s, { type: 'dock', panel: 'positions', tier: 'phone' }),
      shellReduce(at({ chart: 'surface', sheet: 'hidden' }), {
        type: 'open',
        panel: 'metrics',
        tier: 'phone',
      }),
      shellReduce(s, { type: 'grab', dy: -60 }),
      shellReduce(s, { type: 'grab', dy: 2 }),
      shellReduce(s, { type: 'market', market: 'smile' }),
    ];
    for (const a of after) expect(chartMode(a)).toBe('surface');
    // 変わった action は他の欄だけが変わる
    expect(after[0]).toEqual({ ...s, panel: 'board' });
    expect(after[5]).toEqual({ ...s, market: 'smile' });
  });
});

describe('追証マップの開閉と見え方（#152）', () => {
  it('#274 マスを計算する = 指標のパネルが見えている（開閉によらない）、#280 PC は AI を開いても計算する', () => {
    for (const holdMap of [false, true]) {
      expect(holdMapActive(at({ holdMap, panel: 'positions' }), 'pc')).toBe(true);
      expect(holdMapActive(at({ holdMap, left: 'ai' }), 'pc')).toBe(true);
      expect(metricsVisible(at({ holdMap, left: 'ai' }), 'pc')).toBe(true);
      expect(holdMapActive(at({ holdMap, panel: 'metrics', sheet: 'peek' }), 'phone')).toBe(true);
      expect(holdMapActive(at({ holdMap, panel: 'metrics', sheet: 'hidden' }), 'phone')).toBe(
        false,
      );
      expect(holdMapActive(at({ holdMap, panel: 'board' }), 'tablet')).toBe(false);
    }
  });

  it('既定は閉、holdMap の action で開閉、同じ値なら同じ参照、他の欄は変わらない', () => {
    const s0 = at({});
    expect(s0.holdMap ?? false).toBe(false);
    const s1 = shellReduce(s0, { type: 'holdMap', open: true });
    expect(s1).toEqual({ ...s0, holdMap: true });
    expect(shellReduce(s1, { type: 'holdMap', open: true })).toBe(s1);
    expect(shellReduce(s0, { type: 'holdMap', open: false })).toBe(s0);
    expect(shellReduce(s1, { type: 'holdMap', open: false })).toEqual({ ...s0, holdMap: false });
    // パネルの切替で開閉は保つ
    expect(shellReduce(s1, { type: 'dock', panel: 'board', tier: 'phone' }).holdMap).toBe(true);
  });

  it('#307 過去の急落の再生: 既定は閉・出来事は未選択、action で開閉と選択、同じ値なら同じ参照。計算は開いて指標が見えているときだけ', () => {
    const s0 = at({});
    expect(s0.replay ?? false).toBe(false);
    expect(s0.replayEvent).toBeUndefined();
    const s1 = shellReduce(s0, { type: 'replay', open: true });
    expect(s1).toEqual({ ...s0, replay: true });
    expect(shellReduce(s1, { type: 'replay', open: true })).toBe(s1);
    expect(shellReduce(s0, { type: 'replay', open: false })).toBe(s0);
    const s2 = shellReduce(s1, { type: 'replayEvent', id: '2024-08' });
    expect(s2).toEqual({ ...s1, replayEvent: '2024-08' });
    expect(shellReduce(s2, { type: 'replayEvent', id: '2024-08' })).toBe(s2);
    // 追証マップの開閉とは別
    expect(shellReduce(s2, { type: 'holdMap', open: true }).replay).toBe(true);
    expect(replayActive(at({ replay: true, panel: 'metrics', sheet: 'peek' }), 'phone')).toBe(true);
    expect(replayActive(at({ replay: true, panel: 'board' }), 'phone')).toBe(false);
    expect(replayActive(at({ replay: false, panel: 'metrics' }), 'pc')).toBe(false);
    expect(replayActive(at({ replay: true }), 'pc')).toBe(true);
  });

  it('#176・#274 指標のパネルが見えている（過去の値の先読みと追証マップの計算。#274 で閉じていても計算 = 見出しの結論）: 開閉によらない', () => {
    for (const holdMap of [undefined, false, true]) {
      const s = (p: Partial<ShellState>) => at({ ...p, ...(holdMap !== undefined && { holdMap }) });
      expect(metricsVisible(s({ panel: 'positions' }), 'pc')).toBe(true);
      expect(metricsVisible(s({ panel: 'board', sheet: 'hidden' }), 'pc')).toBe(true);
      expect(metricsVisible(s({ panel: 'metrics' }), 'tablet')).toBe(true);
      expect(metricsVisible(s({ panel: 'metrics', sheet: 'hidden' }), 'tablet')).toBe(true);
      expect(metricsVisible(s({ panel: 'board' }), 'tablet')).toBe(false);
      expect(metricsVisible(s({ panel: 'metrics', sheet: 'peek' }), 'phone')).toBe(true);
      expect(metricsVisible(s({ panel: 'metrics', sheet: 'full' }), 'phone')).toBe(true);
      expect(metricsVisible(s({ panel: 'metrics', sheet: 'hidden' }), 'phone')).toBe(false);
      expect(metricsVisible(s({ panel: 'scenario' }), 'phone')).toBe(false);
    }
  });
});
