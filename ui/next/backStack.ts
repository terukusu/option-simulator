import { useLayoutEffect, useRef } from 'preact/hooks';
import {
  BACK_INITIAL,
  type BackEffect,
  type BackEvent,
  type BackState,
  backReduce,
  backTop,
} from '../view/backStack';

/**
 * 戻る（スマホの戻るジェスチャー・ブラウザの戻る）で開いているものを一番上から 1 つ閉じる糊（#320。
 * 規則は ui/view/backStack.ts の純関数。docs/ui-redesign.md §4.6・§5）。./parts/overlay.ts と同じ小さなストア。
 *
 * - 開いたもの（メニュー・吹き出し・パレット・説明カード = ./parts/overlay.ts、ダイアログ = ./parts/Dialog.tsx）が
 *   openLayer / closeLayer で層を出し入れし、戻るで閉じるときの閉じ方（Esc と同じ）を渡す
 * - 履歴の操作は後始末（setTimeout 0 で 1 回）にまとめる。pushState / replaceState は 2 引数（URL を変えない。
 *   3 つ目に '' を渡すと # の断片が消える）
 * - popstate はここで 1 か所だけ受ける。モジュールの読み込みでは window に触らない（初期化は initBackHistory）
 */

let state: BackState = BACK_INITIAL;
const closers = new Map<string, () => void>();
let inited = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let unstickTimer: ReturnType<typeof setTimeout> | null = null;

/** go の popstate が来ないときに保留を解くまでの時間（ms） */
const UNSTICK_MS = 1000;

function baseState(): Record<string, unknown> {
  const s: unknown = history.state;
  return typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
}

function dispatch(e: BackEvent): void {
  const r = backReduce(state, e);
  state = r.state;
  apply(r.effects);
}

function apply(effects: readonly BackEffect[]): void {
  for (const ef of effects) {
    if (ef.kind === 'push') {
      try {
        history.pushState({ ...baseState(), back: ef.back }, '');
      } catch {
        // Safari の回数の上限など: その段から上を積まない層にする（例外を外へ出さない）
        dispatch({ type: 'pushFailed', back: ef.back });
        return;
      }
    } else if (ef.kind === 'go') {
      history.go(ef.n);
      if (unstickTimer !== null) clearTimeout(unstickTimer);
      unstickTimer = setTimeout(() => {
        unstickTimer = null;
        if (state.awaiting !== null) dispatch({ type: 'unstick' });
      }, UNSTICK_MS);
    } else {
      for (const id of ef.ids) {
        const f = closers.get(id);
        closers.delete(id);
        f?.();
      }
    }
  }
}

function scheduleSettle(): void {
  if (settleTimer !== null) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    dispatch({ type: 'settle' });
  }, 0);
}

function onPopState(e: PopStateEvent): void {
  const s: unknown = e.state;
  const raw = typeof s === 'object' && s !== null ? (s as { back?: unknown }).back : undefined;
  const back = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  if (unstickTimer !== null && state.awaiting !== null && back === state.awaiting) {
    clearTimeout(unstickTimer);
    unstickTimer = null;
  }
  dispatch({ type: 'popstate', back });
  scheduleSettle();
}

/**
 * 1 回だけ（冪等）: 今の項目を back = 0 にし（URL・ほかの state はそのまま）、popstate を受ける。
 * 再読み込みの後も 0 から数え直す（前の段の項目へ戻ると何も閉じずに戻す / 空振りになる）
 */
export function initBackHistory(): void {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  try {
    history.replaceState({ ...baseState(), back: 0 }, '');
  } catch {
    // 置き換えられなくても popstate の back が無い項目は 0 として扱う
  }
  window.addEventListener('popstate', onPopState);
}

/** 層を開く（同じ id が開いていれば閉じ方だけ替える）。利用者の操作の中でなければ履歴に積まない */
export function openLayer(id: string, onClose: () => void): void {
  initBackHistory();
  closers.set(id, onClose);
  const activation =
    typeof navigator !== 'undefined' && navigator.userActivation !== undefined
      ? navigator.userActivation.isActive
      : false;
  dispatch({ type: 'open', id, activation });
  scheduleSettle();
}

/** 層を閉じる（UI で閉じた・アンマウント）。戻るで既に外れていれば何もしない */
export function closeLayer(id: string): void {
  if (!closers.has(id) && !state.layers.some((l) => l.id === id)) return;
  closers.delete(id);
  dispatch({ type: 'close', id });
  scheduleSettle();
}

/** 一番上の層の id（無ければ null） */
export function topLayerId(): string | null {
  return backTop(state);
}

/**
 * open の間だけ層を積む。onClose は戻るで閉じるとき（Esc と同じ閉じ方）。最新の onClose を呼ぶ
 */
export function useBackLayer(id: string, open: boolean, onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    openLayer(id, () => ref.current());
    return () => closeLayer(id);
  }, [id, open]);
}
