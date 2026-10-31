import { useEffect, useState } from 'preact/hooks';
import { type ManualIndex, manualIndex } from '../../view/manual';

/**
 * マニュアル（docs/user-guide.md）の索引を持つ小さな購読ストア（#322。docs/adr-0008-manual-bundled-viewer.md）。
 * マニュアルはビルドに同梱するが、最初の画面の読み込みには入れない: Vite の `?raw` の動的 import で別の chunk にし、
 * 説明カードにマニュアルの節・目次を初めて出したときだけ読む（useManual。AI の返答を描くときには読まない）。
 *
 * 状態は idle → loading → ready | error。失敗したら error のまま（ブラウザは失敗した動的 import を同じ URL で覚えて
 * いるので、再試行しない。デプロイの後の古いタブなど = カードに「ページを読み直して」の固定文）。例外は外へ出さない。
 */

export type ManualState =
  | { readonly status: 'idle' | 'loading' | 'error' }
  | { readonly status: 'ready'; readonly index: ManualIndex };

let state: ManualState = { status: 'idle' };
const listeners = new Set<() => void>();

function set(next: ManualState): void {
  state = next;
  for (const f of listeners) f();
}

/** 読み込みを始める（2 回目からは何もしない） */
export function loadManual(): void {
  if (state.status !== 'idle') return;
  set({ status: 'loading' });
  import('../../../docs/user-guide.md?raw')
    .then((m: { default: string }) => set({ status: 'ready', index: manualIndex(m.default) }))
    .catch(() => set({ status: 'error' }));
}

/** 読み込めていれば今の索引（無ければ null）。説明カードの列が同じ節を 2 段積まない判定に使う（./termCard.ts） */
export function manualIndexNow(): ManualIndex | null {
  return state.status === 'ready' ? state.index : null;
}

/** マニュアルの状態。load = true なら初めて要ったときに読み込みを始める（説明カードにマニュアルを出している間） */
export function useManual(load: boolean): ManualState {
  const [view, setLocal] = useState<ManualState>(state);
  useEffect(() => {
    const update = () => setLocal(state);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  useEffect(() => {
    if (load) loadManual();
  }, [load]);
  return view;
}
