import { useEffect, useRef } from 'preact/hooks';
import type { ThemePref } from '../prefs';
import {
  editableTarget,
  type GlobalKey,
  globalKey,
  panelKeyActions,
  panelKeyFocus,
  toggledTheme,
} from '../view/keys';
import type { PanelId, ShellAction, ShellState, Tier } from '../view/shell';
import { openOverlayId } from './parts/overlay';

export interface GlobalKeysCtx {
  tier: Tier;
  /** 今の画面の状態（キー 6 で PC の AI を閉じたときのフォーカスの行き先。#280） */
  shell: ShellState;
  send: (a: ShellAction) => void;
  resolvedTheme: 'dark' | 'light';
  chooseTheme: (t: ThemePref) => void;
  /** Ctrl / ⌘ + K（段 B のパレット）。渡したときだけ Ctrl / ⌘ + K を preventDefault して呼ぶ */
  onPalette?: () => void;
}

/**
 * 1〜5 のフォーカスの行き先 = そのパネルのスクロールする枠（tabindex=-1。スマイルの .panel-body はスクロールしないが
 * 行き先として同じ枠）。section にしないのは、フォーカスできる
 * 祖先があるとクリックでそこへフォーカスが移り、↓・PageDown が子孫の枠を動かさなくなるため（#89 のレビュー R1）。
 * 板は表示中の限月・種別の表の枠 .board-wrap（.panel-body はスクロールしない）。
 */
export const PANEL_FOCUS: Readonly<Record<PanelId, string>> = {
  positions: 'main.layout > section.panel.positions > .panel-body',
  board:
    'main.layout > section.panel.board .board-month:not(.inactive) .board-wrap:not(.side-hidden)',
  scenario: 'main.layout > section.panel.scenario > .panel-body',
  metrics: 'main.layout > section.panel.metrics > .panel-body',
  smile: 'main.layout > section.panel.smile > .panel-body',
  ai: 'main.layout > section.panel.ai > .panel-body',
};

/** 行き先を待つフレームの上限（板は初めて見せたとき幅を測ってから表を作るので 1 フレームでは無い） */
const FOCUS_FRAMES = 10;

/** focusLater の通し番号（同じフレームで続けて押したら最後の要求だけを生かす。#124） */
let focusSeq = 0;

/**
 * 次のフレームから行き先へ focus（PC で市場を切り替えた直後は描き直しの前で display: none）。無ければ
 * FOCUS_FRAMES まで待ち、それでも無い・その間にフォーカスが他の要素へ動いたら何もしない。後から別の要求が来たら
 * 前の要求は何もしない（1 → 2 を同じフレームで押すと 2 の行き先へ。#124）。
 */
function focusLater(sel: string): void {
  const from = document.activeElement;
  const seq = ++focusSeq;
  let n = 0;
  const tick = () => {
    if (seq !== focusSeq) return;
    // 前のパネルを隠すとフォーカスは body に落ちる（利用者が動かしたのではない）
    const now = document.activeElement;
    if (now !== from && now !== null && now !== document.body) return;
    const el = document.querySelector<HTMLElement>(sel);
    if (el !== null) el.focus({ preventScroll: true });
    else if (++n < FOCUS_FRAMES) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * 次のフレームから、フォーカスが落ちていれば（body・外れた要素）行き先へ focus（#20 レビュー N3）。ダイアログを開いた
 * ボタンが閉じる前に消えた（足 0 本の空の欄から足を入れた・タブが替わった）とき、Dialog の「開く前の要素へ戻す」が
 * 外れた要素に当たって body に落ちるのを拾う。フォーカスが残っていれば（⋯ へ戻った）何もしない
 */
export function focusIfLost(sel: string): void {
  let n = 0;
  const tick = () => {
    const now = document.activeElement;
    if (now !== null && now !== document.body && now.isConnected) return;
    const el = document.querySelector<HTMLElement>(sel);
    if (el !== null) el.focus({ preventScroll: true });
    else if (++n < FOCUS_FRAMES) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * 次のフレームから、その要素が描かれていれば focus（#319 銘柄の推移を閉じたら開いたボタンへ。閉じて見え方を戻した
 * 描き直しの後）。要素が無い・外れた・見えないまま FOCUS_FRAMES を過ぎたら何もしない
 */
export function focusElementLater(el: HTMLElement | null): void {
  if (el === null) return;
  let n = 0;
  const tick = () => {
    if (el.isConnected && el.getClientRects().length > 0) el.focus({ preventScroll: false });
    else if (el.isConnected && ++n < FOCUS_FRAMES) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** そのパネルの行き先へ次のフレームから focus（#136 の [AI に聞く] の後に AI のパネルへ。キー 1〜6 と同じ行き先） */
export function focusPanelLater(panel: PanelId): void {
  focusLater(PANEL_FOCUS[panel]);
}

/** モーダルのダイアログ（コマンドパレットも <dialog>）が開いている = すべて止める */
function dialogNow(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

/**
 * 全体のキーの動作を実行する（段 B のパレットの行も同じ動きにするため export）。動作したら true
 * （呼び出し側が preventDefault する）。DOM に値を入れない（focus だけ）。
 */
export function runGlobalKey(action: GlobalKey, ctx: GlobalKeysCtx): boolean {
  switch (action.kind) {
    case 'panel': {
      for (const a of panelKeyActions(action.panel, ctx.tier)) ctx.send(a);
      focusLater(PANEL_FOCUS[panelKeyFocus(action.panel, ctx.tier, ctx.shell)]);
      return true;
    }
    case 'chart': {
      // PnlPlot の tabIndex（足 0 本・スマホのミニは -1）を正とする
      const el = document.querySelector<HTMLElement>('section.stage .chart');
      if (el === null || el.tabIndex !== 0) return false;
      el.focus({ preventScroll: true });
      return true;
    }
    case 'theme':
      ctx.chooseTheme(toggledTheme(ctx.resolvedTheme));
      return true;
    case 'palette':
      if (ctx.onPalette === undefined) return false;
      ctx.onPalette();
      return true;
  }
}

/**
 * 全体のキー（#89 段 A。docs/ui-redesign.md §4.6）。document の keydown（バブル）を 1 回だけ受け、
 * 部品が先に処理したキー（defaultPrevented）・入力欄・ふさがっているときは何もしない（判定は ui/view/keys.ts）。
 * 最新の props は ref で読む（tier・テーマが変わっても付け直さない）。NextApp で 1 回だけ使う。
 */
export function useGlobalKeys(ctx: GlobalKeysCtx): void {
  const ref = useRef(ctx);
  ref.current = ctx;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const action = globalKey({
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
        isComposing: e.isComposing,
        keyCode: e.keyCode,
        repeat: e.repeat,
        defaultPrevented: e.defaultPrevented,
        editable: editableTarget(
          t === null
            ? null
            : {
                tagName: t.tagName,
                isContentEditable: t instanceof HTMLElement && t.isContentEditable,
              },
        ),
        blocked: dialogNow(),
        overlay: openOverlayId() !== null,
      });
      if (action !== null && runGlobalKey(action, ref.current)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
