/**
 * 画面の見た目の状態（#81。docs/ui-redesign.md §2・§10.1・§11-7）。
 * パネル・シートの開き具合・市場（板 / スマイル / IV 推移）。ui/state.ts には入れず、保存しない（再読み込みで既定に戻る）。
 * 純関数（Preact に依存しない）。部品は ui/next/Shell.tsx。
 */

/** 幅の段階（ui/view/layout.ts の PHONE_QUERY・PC_QUERY） */
export type Tier = 'phone' | 'tablet' | 'pc';
/** ai = AI のチャット（#135。スマホ・タブレットはドックの 1 枚、PC は作業台の列を入れ替える = ShellState.bench） */
export type PanelId = 'positions' | 'board' | 'scenario' | 'metrics' | 'smile' | 'ai';
/** PC の作業台の列（work = ポジション + 指標、ai = AI のチャット。#135） */
export type BenchView = 'work' | 'ai';
/** スマホのシート。hidden = 隠す（舞台が最大）/ peek = 覗く（42dvh）/ full = 全開（舞台はミニ 92px） */
export type SheetStage = 'hidden' | 'peek' | 'full';
/**
 * 市場の見え方の一覧（PC の見出しの Seg。#85。#79 で IV 推移、#190 で先物推移を足した）。IV 推移・先物推移は PC では
 * 市場の列の section.smile の領域に描く（板と同じく市場の列を入れ替える）。
 */
export const MARKET_VIEWS = [
  { value: 'board', text: '板' },
  { value: 'smile', text: 'スマイル' },
  { value: 'iv', text: 'IV 推移' },
  { value: 'fut', text: '先物' },
] as const;
export type MarketView = (typeof MARKET_VIEWS)[number]['value'];
/**
 * スマホ・タブレットのスマイル（ドックの「IV」）のパネルの見出しの Seg（#79。オーナー判断 4: ドックを増やさず、パネルの
 * 中で切り替える。#130 で IV 推移を左に。#190 で先物推移を右端に）。送るのは同じ { type: 'market' }（PC 以外では board は
 * 「IV 推移」と同じ = 既定）
 */
export const SMILE_VIEWS = [
  { value: 'iv', text: 'IV 推移' },
  { value: 'smile', text: 'スマイル' },
  { value: 'fut', text: '先物' },
] as const;
export type SmileView = (typeof SMILE_VIEWS)[number]['value'];
/** 舞台のグラフの表示（凡例行の [線 | 面]。#88） */
export const CHART_MODES = [
  { value: 'line', text: '線' },
  { value: 'surface', text: '面' },
] as const;
export type ChartMode = (typeof CHART_MODES)[number]['value'];

export interface ShellState {
  panel: PanelId;
  sheet: SheetStage;
  market: MarketView;
  /** 舞台のグラフの表示（#88。無い = line。読むのは chartMode） */
  chart?: ChartMode;
  /** 指標 · テールの「追証マップ」の折りたたみが開いている（#152。無い = 閉。保存しない） */
  holdMap?: boolean;
  /** PC の作業台の列（#135。無い = work。保存しない） */
  bench?: BenchView;
  /** スマイルに売りの効率の線を重ねる（#163。無い = 重ねない。保存しない） */
  smileEff?: boolean;
}

export const INITIAL_SHELL: ShellState = { panel: 'positions', sheet: 'peek', market: 'board' };

/**
 * 開いたときの画面の状態（#275）: 足 0 本ならドックの既定を「板」（流れの最初。空のポジションのシートを飛ばす）、
 * 足があれば INITIAL_SHELL（ポジ）。PC はパネルを使わない（同じ値のまま）
 */
export function initialShell(legCount: number): ShellState {
  return legCount > 0 ? INITIAL_SHELL : { ...INITIAL_SHELL, panel: 'board' };
}

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
  | { type: 'market'; market: MarketView }
  | { type: 'chart'; chart: ChartMode }
  /** 追証マップの開閉（#152） */
  | { type: 'holdMap'; open: boolean }
  /** PC の作業台の列（#135。bench が無ければ入れ替え） */
  | { type: 'bench'; bench?: BenchView }
  /** スマイルの売りの効率の線の表示（#163） */
  | { type: 'smileEff'; on: boolean };

/**
 * ドックのボタンの文字と読み上げの名前（#130。smile のパネルは IV 推移とスマイル。ラベルは「IV」）。アイコンは
 * ui/next/Shell.tsx（JSX）。PANEL_NAMES（パレット）の smile もこの name
 */
export const DOCK_LABELS: Readonly<Record<PanelId, { text: string; name: string }>> = {
  positions: { text: 'ポジ', name: 'ポジション' },
  board: { text: '板', name: '板' },
  scenario: { text: 'シナリオ', name: 'シナリオ' },
  metrics: { text: '指標', name: '指標' },
  smile: { text: 'IV', name: 'IV 推移 · スマイル' },
  ai: { text: 'AI', name: 'AI に相談' },
};

/** 並びは検討の流れの順（#275: 板 → IV（市場の情報なので板の隣）→ ポジ → シナリオ → 指標 → AI。キー 1〜6 も同じ順） */
const PHONE_DOCK: readonly PanelId[] = ['board', 'smile', 'positions', 'scenario', 'metrics', 'ai'];
const TABLET_DOCK: readonly PanelId[] = ['board', 'smile', 'positions', 'metrics', 'ai'];

/** PC の作業台の列（既定 work） */
export function benchView(s: ShellState): BenchView {
  return s.bench ?? 'work';
}

/**
 * AI のパネルが見えているか（#135。見えている間だけ /api/ai/status を読む）: PC は作業台が ai、タブレットはパネルが ai、
 * スマホはそれに加えてシートが hidden でない
 */
export function aiVisible(s: ShellState, tier: Tier): boolean {
  if (tier === 'pc') return benchView(s) === 'ai';
  if (visiblePanel(s, tier) !== 'ai') return false;
  return tier === 'tablet' || s.sheet !== 'hidden';
}

/** PC でパネルを開くときの作業台（ai → ai、ポジション・指標 → work、それ以外はそのまま） */
const benchFor = (panel: PanelId, cur: BenchView): BenchView =>
  panel === 'ai' ? 'ai' : panel === 'positions' || panel === 'metrics' ? 'work' : cur;

/**
 * スマイルのパネル（PC は市場の列の section.smile）に描くもの。PC は市場が iv / fut のときだけそれ、PC 以外は市場が
 * smile / fut のときだけそれ（既定の board は IV 推移。#130・#190）
 */
export function smileView(s: ShellState, tier: Tier): SmileView {
  if (s.market === 'fut') return 'fut';
  if (tier === 'pc') return s.market === 'iv' ? 'iv' : 'smile';
  return s.market === 'smile' ? 'smile' : 'iv';
}

/** スマイルのパネルの view が見えているか（PC は常に、タブレットはパネルがスマイル、スマホはそれに加えてシート） */
function smileShown(s: ShellState, tier: Tier, view: SmileView): boolean {
  if (smileView(s, tier) !== view) return false;
  if (tier === 'pc') return true;
  if (visiblePanel(s, tier) !== 'smile') return false;
  return tier === 'tablet' || s.sheet !== 'hidden';
}

/**
 * IV 推移が見えているか（#79。初めて true になったときに右端を読む）。PC は市場が iv、タブレットはパネルがスマイルで
 * smileView が iv（既定）、スマホはそれに加えてシートが hidden でない
 */
export function ivVisible(s: ShellState, tier: Tier): boolean {
  return smileShown(s, tier, 'iv');
}

/** 先物推移が見えているか（#190。条件は ivVisible と同じで smileView が fut） */
export function futVisible(s: ShellState, tier: Tier): boolean {
  return smileShown(s, tier, 'fut');
}

/**
 * 指標のパネルが見えているか（#176。初めて true になったときに追証マップの過去の値を先読みする）: PC は常に
 * （作業台が AI = 指標の列が隠れているときも true。起動したときに読む）、タブレットはパネルが metrics、スマホは
 * それに加えてシートが hidden でない
 */
export function metricsVisible(s: ShellState, tier: Tier): boolean {
  if (tier === 'pc') return true;
  if (visiblePanel(s, tier) !== 'metrics') return false;
  return tier === 'tablet' || s.sheet !== 'hidden';
}

/** 追証マップが見えているか（#152。見えている間だけ計算する）: 開いていて、指標のパネルが見えている */
export function holdMapVisible(s: ShellState, tier: Tier): boolean {
  return !!s.holdMap && metricsVisible(s, tier);
}

/** 舞台のグラフの表示（既定 line） */
export function chartMode(s: ShellState): ChartMode {
  return s.chart ?? 'line';
}

/** 幅の段階（スマホとPCのメディアクエリの結果から） */
export function layoutTier(isPhone: boolean, isPc: boolean): Tier {
  if (isPhone) return 'phone';
  return isPc ? 'pc' : 'tablet';
}

/** ドックのボタン（スマホ 6・タブレット 5 = シナリオは常設なので無い・PC はドック無し。#135 で AI を足した） */
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
      if (a.tier === 'pc') {
        // PC はドック・シートが無い: 作業台の列だけ（AI ⇄ ポジション・指標）
        const bench = benchFor(a.panel, benchView(s));
        return bench === benchView(s) ? s : { ...s, bench };
      }
      return panel === s.panel && sheet === s.sheet ? s : { ...s, panel, sheet };
    }
    case 'grab': {
      const sheet = grab(s.sheet, a.dy);
      return sheet === s.sheet ? s : { ...s, sheet };
    }
    case 'market':
      return a.market === s.market ? s : { ...s, market: a.market };
    case 'chart':
      return a.chart === chartMode(s) ? s : { ...s, chart: a.chart };
    case 'holdMap':
      return a.open === (s.holdMap ?? false) ? s : { ...s, holdMap: a.open };
    case 'smileEff':
      return a.on === (s.smileEff ?? false) ? s : { ...s, smileEff: a.on };
    case 'bench': {
      const cur = benchView(s);
      const bench = a.bench ?? (cur === 'ai' ? 'work' : 'ai');
      return bench === cur ? s : { ...s, bench };
    }
  }
}
