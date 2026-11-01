/**
 * 画面の見た目の状態（#81。docs/ui-redesign.md §2・§10.1・§11-7）。
 * パネル・シートの開き具合・市場（板 / スマイル / IV 推移）。ui/state.ts には入れず、保存しない（再読み込みで既定に戻る）。
 * 純関数（Preact に依存しない）。部品は ui/next/Shell.tsx。
 */

import type { OptTarget } from './optHistory';

/** 幅の段階（ui/view/layout.ts の PHONE_QUERY・PC_QUERY） */
export type Tier = 'phone' | 'tablet' | 'pc';
/** ai = AI のチャット（#135。スマホ・タブレットはドックの 1 枚、PC は左の列（市場）を入れ替える = ShellState.left。#280） */
export type PanelId = 'positions' | 'board' | 'scenario' | 'metrics' | 'smile' | 'ai';
/**
 * PC の左の列（market = 市場（板 / スマイル / IV 推移 / 先物）、ai = AI のチャット。#280。#135 では作業台の列を入れ替えて
 * いたが、AI が引く数字（ポジション・指標）を横に置けるよう市場の列と入れ替える）
 */
export type LeftView = 'market' | 'ai';
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
/** opt = 銘柄の推移（#319。Seg の項目には無い。板の K・足の詳細から開く） */
export type SmileView = (typeof SMILE_VIEWS)[number]['value'] | 'opt';
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
  /** 指標 · テールの「過去の急落の再生」の折りたたみが開いている（#307。無い = 閉。保存しない） */
  replay?: boolean;
  /** 再生で選んだ出来事の id（#307。無い = 既定の出来事。保存しない） */
  replayEvent?: string;
  /** PC の左の列（#280。無い = market。保存しない） */
  left?: LeftView;
  /** スマイルに売りの効率の線を重ねる（#163。無い = 重ねない。保存しない） */
  smileEff?: boolean;
  /**
   * 板から追加の帯が出ている（#325。スマホ・タブレットだけ。無い = 帯なし。保存しない）。立っている間は panel = board
   * かつ sheet が hidden でない（shellReduce が保つ）
   */
  pick?: boolean;
  /**
   * 開いている銘柄の推移（#319。無い = 閉じている。保存しない）。開いている間は市場の列（PC）・スマイルのパネル（スマホ・
   * タブレット）に銘柄のチャートを描き、市場の Seg はどれも選ばない
   */
  opt?: OptTarget;
  /** 銘柄の推移を開く前の見え方（閉じたら戻す。#319） */
  optPrev?: { panel: PanelId; sheet: SheetStage; left: LeftView };
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
  /** 過去の急落の再生の開閉・出来事の選択（#307） */
  | { type: 'replay'; open: boolean }
  | { type: 'replayEvent'; id: string }
  /** PC の左の列（#280。left が無ければ入れ替え） */
  | { type: 'left'; left?: LeftView }
  /** スマイルの売りの効率の線の表示（#163） */
  | { type: 'smileEff'; on: boolean }
  /**
   * 板から追加を始める（#325）。スマホ・タブレット = 板のパネルを開いて帯を出す（hidden なら peek）、PC = 市場の列を
   * 板にする（AI の列なら市場に戻す。帯は出さない）
   */
  | { type: 'pick'; tier: Tier }
  /** 板の bid / ask を押した後（#325）。足が入った（ok）なら帯を消してポジションへ。入らなければ何もしない */
  | { type: 'picked'; ok: boolean }
  /** 戻る / Esc で帯を消す（#325）。ポジションへ戻る（足は変えない） */
  | { type: 'pickBack' }
  /** タブの切り替え・PC への幅の変化で帯だけを消す（#325。パネルはそのまま） */
  | { type: 'pickEnd' }
  /**
   * 銘柄の推移を開く（#319。板の K のポップオーバー・足の詳細）。PC = 左の列を市場に、スマホ・タブレット = スマイルの
   * パネル（hidden なら peek）。開く前の見え方を控える（開いたまま別の銘柄を開いたら最初の控えのまま）
   */
  | { type: 'opt'; target: OptTarget; tier: Tier }
  /** 銘柄の推移を閉じる（× / Esc / 戻る。#319）。開く前の見え方に戻す */
  | { type: 'optClose' };

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

/** PC の左の列（既定 market） */
export function leftView(s: ShellState): LeftView {
  return s.left ?? 'market';
}

/**
 * AI のパネルが見えているか（#135。見えている間だけ /api/ai/status を読む）: PC は左の列が ai（#280）、タブレットは
 * パネルが ai、スマホはそれに加えてシートが hidden でない
 */
export function aiVisible(s: ShellState, tier: Tier): boolean {
  if (tier === 'pc') return leftView(s) === 'ai';
  if (visiblePanel(s, tier) !== 'ai') return false;
  return tier === 'tablet' || s.sheet !== 'hidden';
}

/** PC でパネルを開くときの左の列（ai → ai、板・スマイル → market、ポジション・シナリオ・指標は常に見えるのでそのまま） */
const leftFor = (panel: PanelId, cur: LeftView): LeftView =>
  panel === 'ai' ? 'ai' : panel === 'board' || panel === 'smile' ? 'market' : cur;

/**
 * スマイルのパネル（PC は市場の列の section.smile）に描くもの。PC は市場が iv / fut のときだけそれ、PC 以外は市場が
 * smile / fut のときだけそれ（既定の board は IV 推移。#130・#190）
 */
export function smileView(s: ShellState, tier: Tier): SmileView {
  if (s.opt) return 'opt';
  if (s.market === 'fut') return 'fut';
  if (tier === 'pc') return s.market === 'iv' ? 'iv' : 'smile';
  return s.market === 'smile' ? 'smile' : 'iv';
}

/**
 * スマイルのパネルの view が見えているか（PC は左の列が AI でない間（#280）、タブレットはパネルがスマイル、スマホは
 * それに加えてシート）
 */
function smileShown(s: ShellState, tier: Tier, view: SmileView): boolean {
  if (smileView(s, tier) !== view) return false;
  if (tier === 'pc') return leftView(s) === 'market';
  if (visiblePanel(s, tier) !== 'smile') return false;
  return tier === 'tablet' || s.sheet !== 'hidden';
}

/**
 * IV 推移が見えているか（#79。初めて true になったときに右端を読む）。PC は市場が iv で左の列が AI でない、タブレットはパネルがスマイルで
 * smileView が iv（既定）、スマホはそれに加えてシートが hidden でない
 */
export function ivVisible(s: ShellState, tier: Tier): boolean {
  return smileShown(s, tier, 'iv');
}

/** 先物推移が見えているか（#190。条件は ivVisible と同じで smileView が fut） */
export function futVisible(s: ShellState, tier: Tier): boolean {
  return smileShown(s, tier, 'fut');
}

/** 銘柄の推移が見えているか（#319。条件は ivVisible と同じで smileView が opt） */
export function optVisible(s: ShellState, tier: Tier): boolean {
  return smileShown(s, tier, 'opt');
}

/** 本体の data-market（#319: 銘柄の推移を開いている間は opt = PC は市場の列に section.smile を描く） */
export function marketAttr(s: ShellState): string {
  return s.opt ? 'opt' : s.market;
}

/**
 * 指標のパネルが見えているか（#176。初めて true になったときに追証マップの過去の値を先読みする）: PC は常に
 * （#280 で AI は左の列と入れ替わるので指標は隠れない）、タブレットはパネルが metrics、スマホはそれに加えてシートが
 * hidden でない
 */
export function metricsVisible(s: ShellState, tier: Tier): boolean {
  if (tier === 'pc') return true;
  if (visiblePanel(s, tier) !== 'metrics') return false;
  return tier === 'tablet' || s.sheet !== 'hidden';
}

/**
 * 追証マップのマスを計算するか（#274。折りたたみの開閉によらない = 見出しの結論のため）: 指標のパネルが実際に
 * 見えているとき（#280 で PC は AI を開いても指標が見えるので metricsVisible と同じ）
 */
export function holdMapActive(s: ShellState, tier: Tier): boolean {
  return metricsVisible(s, tier);
}

/** 過去の急落の再生を計算するか（#307）: 折りたたみが開いていて、指標のパネルが見えているときだけ */
export function replayActive(s: ShellState, tier: Tier): boolean {
  return (s.replay ?? false) && metricsVisible(s, tier);
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

/** pick を外した状態（pick のキーを残さない = 既定の形と toEqual で等しい） */
function withoutPick(s: ShellState): ShellState {
  const { pick: _, ...rest } = s;
  return rest;
}

/** 銘柄の推移を外した状態（#319。戻さない = 押した先を優先） */
function withoutOpt(s: ShellState): ShellState {
  if (!s.opt && !s.optPrev) return s;
  const { opt: _, optPrev: __, ...rest } = s;
  return rest;
}

/**
 * 銘柄の推移（#319）を外す操作か: 市場の Seg・PC の左の列（AI）・板から追加・ドック。open は別のパネルを開くとき
 * （PC は AI を開くとき）だけ。つまみ・グラフの表示などは外さない
 */
function dropsOpt(a: ShellAction): boolean {
  switch (a.type) {
    case 'market':
    case 'left':
    case 'pick':
    case 'dock':
      return true;
    case 'open':
      return a.tier === 'pc' ? a.panel === 'ai' : forTier(a.panel, a.tier) !== 'smile';
    default:
      return false;
  }
}

/**
 * 変わらないときは同じ参照を返す（再描画しない）。板から追加の帯（#325）は、結果で panel が board でない・シートが
 * hidden になったら外す（ドックの別パネル・同じ [板] でシートを隠す・open で別パネル・つまみで隠す を 1 か所で。
 * 押した先を優先 = パネルはそのまま）。
 */
export function shellReduce(s: ShellState, a: ShellAction): ShellState {
  if (s.opt && dropsOpt(a)) {
    // 銘柄の推移を外してから操作する（市場の Seg で同じ見え方を押しても推移を閉じる）
    return shellReduce(withoutOpt(s), a);
  }
  const next = reduce(s, a);
  if (next.pick === true && (next.panel !== 'board' || next.sheet === 'hidden')) {
    return withoutPick(next);
  }
  return next;
}

function reduce(s: ShellState, a: ShellAction): ShellState {
  switch (a.type) {
    case 'pick': {
      if (a.tier === 'pc') {
        // PC は板とポジションが同時に見える: 市場の列を板に（market と同じ）。帯は出さない
        return reduce(s, { type: 'market', market: 'board' });
      }
      const sheet = s.sheet === 'hidden' ? 'peek' : s.sheet;
      if (s.panel === 'board' && s.sheet === sheet && s.pick === true) return s;
      return { ...s, panel: 'board', sheet, pick: true };
    }
    case 'picked':
      if (!a.ok || s.pick !== true) return s;
      return { ...withoutPick(s), panel: 'positions' };
    case 'pickBack':
      if (s.pick !== true) return s;
      return { ...withoutPick(s), panel: 'positions' };
    case 'pickEnd':
      return s.pick === true ? withoutPick(s) : s;
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
        // PC はドック・シートが無い: 左の列だけ（AI ⇄ 市場。#280）
        const left = leftFor(a.panel, leftView(s));
        return left === leftView(s) ? s : { ...s, left };
      }
      return panel === s.panel && sheet === s.sheet ? s : { ...s, panel, sheet };
    }
    case 'grab': {
      const sheet = grab(s.sheet, a.dy);
      return sheet === s.sheet ? s : { ...s, sheet };
    }
    case 'market':
      // 市場の見え方を選ぶ = PC は左の列を市場に戻す（#280。キー 1・2、板から足す、パレットの ATM）
      if (leftView(s) === 'ai') return { ...s, market: a.market, left: 'market' };
      return a.market === s.market ? s : { ...s, market: a.market };
    case 'chart':
      return a.chart === chartMode(s) ? s : { ...s, chart: a.chart };
    case 'holdMap':
      return a.open === (s.holdMap ?? false) ? s : { ...s, holdMap: a.open };
    case 'replay':
      return a.open === (s.replay ?? false) ? s : { ...s, replay: a.open };
    case 'replayEvent':
      return a.id === s.replayEvent ? s : { ...s, replayEvent: a.id };
    case 'smileEff':
      return a.on === (s.smileEff ?? false) ? s : { ...s, smileEff: a.on };
    case 'opt': {
      const optPrev = s.optPrev ?? { panel: s.panel, sheet: s.sheet, left: leftView(s) };
      if (a.tier === 'pc') {
        const base = { ...withoutPick(s), opt: a.target, optPrev };
        return leftView(s) === 'ai' ? { ...base, left: 'market' } : base;
      }
      const sheet = s.sheet === 'hidden' ? 'peek' : s.sheet;
      return { ...withoutPick(s), opt: a.target, optPrev, panel: 'smile', sheet };
    }
    case 'optClose': {
      if (!s.opt) return s;
      const prev = s.optPrev;
      const rest = withoutOpt(s);
      if (!prev) return rest;
      const back: ShellState = { ...rest, panel: prev.panel, sheet: prev.sheet };
      return prev.left === leftView(back) ? back : { ...back, left: prev.left };
    }
    case 'left': {
      const cur = leftView(s);
      const left = a.left ?? (cur === 'ai' ? 'market' : 'ai');
      return left === cur ? s : { ...s, left };
    }
  }
}
