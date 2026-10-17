/**
 * 新しい画面（`?ui=next`）の見た目の状態（#81。docs/ui-redesign.md §2・§10.1・§11-7）。
 * パネル・シートの開き具合・市場（板 / スマイル）。ui/state.ts には入れず、保存しない（再読み込みで既定に戻る）。
 * 純関数（Preact に依存しない）。部品は ui/next/Shell.tsx。
 */

/** 幅の段階（ui/view/layout.ts の PHONE_QUERY・PC_QUERY） */
export type Tier = 'phone' | 'tablet' | 'pc';
export type PanelId = 'positions' | 'board' | 'scenario' | 'metrics' | 'smile';
/** スマホのシート。hidden = 隠す（舞台が最大）/ peek = 覗く（42dvh）/ full = 全開（舞台はミニ 92px） */
export type SheetStage = 'hidden' | 'peek' | 'full';
/**
 * 市場の見え方の一覧（PC の見出しの Seg。#85。#79 の IV 推移はここに 1 行足す）。
 */
export const MARKET_VIEWS = [
  { value: 'board', text: '板' },
  { value: 'smile', text: 'スマイル' },
] as const;
export type MarketView = (typeof MARKET_VIEWS)[number]['value'];

export interface ShellState {
  panel: PanelId;
  sheet: SheetStage;
  market: MarketView;
}

export const INITIAL_SHELL: ShellState = { panel: 'positions', sheet: 'peek', market: 'board' };

/** つまみを離したとき、この距離（px）以上動いていれば 1 段動かす */
export const SHEET_SNAP_PX = 40;
/** この距離（px）未満ならタップ（peek ⇄ full） */
export const SHEET_TAP_PX = 6;

export type ShellAction =
  | { type: 'dock'; panel: PanelId; tier: Tier }
  /** そのパネルを開く（閉じない。hidden なら peek。舞台の足マーカーのタップなど。#82） */
  | { type: 'open'; panel: PanelId; tier: Tier }
  /** つまみの縦の移動量（下向き正。離したときの値） */
  | { type: 'grab'; dy: number }
  | { type: 'market'; market: MarketView };

const PHONE_DOCK: readonly PanelId[] = ['positions', 'board', 'scenario', 'metrics', 'smile'];
const TABLET_DOCK: readonly PanelId[] = ['positions', 'board', 'metrics', 'smile'];

/** 幅の段階（スマホとPCのメディアクエリの結果から） */
export function layoutTier(isPhone: boolean, isPc: boolean): Tier {
  if (isPhone) return 'phone';
  return isPc ? 'pc' : 'tablet';
}

/** ドックのボタン（スマホ 5・タブレット 4 = シナリオは常設なので無い・PC はドック無し） */
export function dockPanels(tier: Tier): readonly PanelId[] {
  if (tier === 'phone') return PHONE_DOCK;
  if (tier === 'tablet') return TABLET_DOCK;
  return [];
}

/** タブレットでシナリオは選べない（常設）。選んでいたら positions として扱う */
const forTier = (panel: PanelId, tier: Tier): PanelId =>
  tier === 'tablet' && panel === 'scenario' ? 'positions' : panel;

/** いま見せるパネル（幅がタブレットに変わったときの scenario → positions） */
export function visiblePanel(s: ShellState, tier: Tier): PanelId {
  return forTier(s.panel, tier);
}

function grab(sheet: SheetStage, dy: number): SheetStage {
  if (sheet === 'hidden') return sheet;
  const d = Math.abs(dy);
  if (d < SHEET_TAP_PX) return sheet === 'peek' ? 'full' : 'peek';
  if (d < SHEET_SNAP_PX) return sheet;
  if (dy > 0) return sheet === 'full' ? 'peek' : 'hidden';
  return 'full';
}

/** 変わらないときは同じ参照を返す（再描画しない）。 */
export function shellReduce(s: ShellState, a: ShellAction): ShellState {
  switch (a.type) {
    case 'dock': {
      const panel = forTier(a.panel, a.tier);
      const current = visiblePanel(s, a.tier);
      if (panel === current && s.sheet !== 'hidden') return { ...s, panel, sheet: 'hidden' };
      return { ...s, panel, sheet: s.sheet === 'hidden' ? 'peek' : s.sheet };
    }
    case 'open': {
      const panel = forTier(a.panel, a.tier);
      const sheet = s.sheet === 'hidden' ? 'peek' : s.sheet;
      return panel === s.panel && sheet === s.sheet ? s : { ...s, panel, sheet };
    }
    case 'grab': {
      const sheet = grab(s.sheet, a.dy);
      return sheet === s.sheet ? s : { ...s, sheet };
    }
    case 'market':
      return a.market === s.market ? s : { ...s, market: a.market };
  }
}
