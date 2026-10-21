import { useEffect, useRef } from 'preact/hooks';
import type { AiAsk } from '../../view/aiAsk';

/**
 * [AI に聞く]（#136）の口: 押したボタン（./AskAi.tsx）から NextApp へ質問を渡す小さなストア（./termCard.ts と同じ考え。
 * 吹き出しの中身・pure の部品へ props を通さない）。受け手は NextApp の 1 つだけ（AI のパネルを開いて送る）。
 * 状態は持たない（保存しない）。受け手が居なければ何もしない（部品の見本 ?parts）
 */

let handler: ((a: AiAsk) => void) | null = null;

/** 質問を渡す（受け手が無ければ何もしない） */
export function askAi(a: AiAsk): void {
  handler?.(a);
}

/** 受け手を登録する（NextApp で 1 回。最新の関数を ref で読む） */
export function useAiAskHandler(fn: (a: AiAsk) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (a: AiAsk) => ref.current(a);
    handler = h;
    return () => {
      if (handler === h) handler = null;
    };
  }, []);
}
