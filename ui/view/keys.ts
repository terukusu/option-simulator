/**
 * 新しい画面（`?ui=next`）の全体のキー（#89 段 A。docs/ui-redesign.md §4.6）。
 * 1〜5 = パネル・G = 描画域・T = テーマ・Ctrl / ⌘ + K = コマンドパレット（段 B）。
 * 純関数（Preact・DOM に依存しない）。document の keydown は ui/next/useGlobalKeys.ts だけが受ける。
 */
import type { ThemePref } from '../prefs';
import type { PanelId, ShellAction, Tier } from './shell';

/** keydown の要約（KeyboardEvent から作る。editable・blocked は画面が DOM を見て決める） */
export interface KeySummary {
  /** KeyboardEvent.key */
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  isComposing: boolean;
  keyCode: number;
  /** 押しっぱなしの自動繰り返し */
  repeat: boolean;
  /** 部品が既に処理した */
  defaultPrevented: boolean;
  /** 対象が入力欄（editableTarget） */
  editable: boolean;
  /** モーダルのダイアログが開いている（dialog[open]。コマンドパレットも <dialog>）。すべて止める */
  blocked: boolean;
  /** メニュー / ポップオーバーが開いている（overlay）。1〜5・G・T だけ止める（Ctrl / ⌘ + K はそれを閉じてパレット） */
  overlay: boolean;
}

export type GlobalKey =
  | { kind: 'panel'; panel: PanelId }
  | { kind: 'chart' }
  | { kind: 'theme' }
  | { kind: 'palette' };

/** 1〜5 → パネル（§4.6: 1 ポジ / 2 板 / 3 シナリオ / 4 指標 / 5 スマイル） */
export const PANEL_KEYS: Readonly<Record<string, PanelId>> = {
  '1': 'positions',
  '2': 'board',
  '3': 'scenario',
  '4': 'metrics',
  '5': 'smile',
};

/** パネル → キー（段 B のパレットの行のキーの表示） */
export const PANEL_KEY: Readonly<Record<PanelId, string>> = {
  positions: '1',
  board: '2',
  scenario: '3',
  metrics: '4',
  smile: '5',
};

/** 描画域にフォーカス・テーマ切替のキーの表示 */
export const CHART_KEY = 'G';
export const THEME_KEY = 'T';
/** パレットを開くキーの表示（段 B） */
export const PALETTE_KBD = 'Ctrl K';

/**
 * 対象が入力欄か（input・textarea・select・contenteditable）。DOM の型に依存しない構造的な型だけを見る。
 * input は type を問わない（checkbox・range なども止める = 安全側。§4.6）
 */
export function editableTarget(
  el: { tagName: string; isContentEditable?: boolean } | null,
): boolean {
  if (el === null) return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * keydown の要約から全体のキーの動作を決める（無ければ null）。見る順は §4.6:
 * IME の変換中 → defaultPrevented → repeat → 入力欄 → ダイアログ → Ctrl / ⌘ + K → メニュー / ポップオーバー →
 * 修飾 → 1〜5・G・T。
 */
export function globalKey(s: KeySummary): GlobalKey | null {
  if (s.isComposing || s.key === 'Process' || s.keyCode === 229) return null;
  if (s.defaultPrevented || s.repeat || s.editable || s.blocked) return null;
  const lower = s.key.toLowerCase();
  if ((s.ctrl || s.meta) && !s.alt && !s.shift && lower === 'k') return { kind: 'palette' };
  if (s.overlay) return null;
  if (s.ctrl || s.meta || s.alt) return null;
  const panel = Object.hasOwn(PANEL_KEYS, s.key) ? PANEL_KEYS[s.key] : undefined;
  if (panel !== undefined) return { kind: 'panel', panel };
  if (lower === 'g') return { kind: 'chart' };
  if (lower === 't') return { kind: 'theme' };
  return null;
}

/**
 * 1〜5 で送る画面の状態の action（§4.6 の表。openBoardActions と同じ形）。
 * スマホは全部 open、タブレットはシナリオ（常設）以外 open、PC は板 / スマイルだけ market。
 * どの幅でもこのあと画面がそのパネルのスクロールする枠（`.panel-body` / 板は `.board-wrap`）へフォーカスを移す。
 */
export function panelKeyActions(panel: PanelId, tier: Tier): ShellAction[] {
  if (tier === 'phone') return [{ type: 'open', panel, tier }];
  if (tier === 'tablet') return panel === 'scenario' ? [] : [{ type: 'open', panel, tier }];
  if (panel === 'board' || panel === 'smile') return [{ type: 'market', market: panel }];
  return [];
}

/** T: 解決済みのテーマの反対を明示の設定にする（「端末に合わせる」から抜ける） */
export function toggledTheme(resolved: 'dark' | 'light'): ThemePref {
  return resolved === 'dark' ? 'light' : 'dark';
}
