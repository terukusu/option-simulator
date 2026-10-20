/**
 * AI のチャットのフック（#135。docs/design.md 14 章）。会話の状態は ui/view/aiChat.ts の reducer（純関数）、ここは
 * fetch（data/aiStream.ts）・sessionStorage（1 キー）・道具の実行（ui/view/aiTools.ts）・描き直しのまとめ方だけ。
 *
 * - [このポジションを診断] / 送信: 押した瞬間に begin（「計算中」）を描いてから、次のタスクで文脈（事前計算 5 本）を
 *   作って送る（計算の前に進み具合を出す = 押して 1 秒以内）
 * - 流れの事象は状態の ref にすぐ入れ、描き直しは 1 フレームに 1 回（text の delta ごとに描かない）
 * - tool_use で止まったら道具を実行して tool_result を足し、次の要求（MAX_TOOL_ROUNDS まで）
 * - /api/ai/status は見えたとき（閉 → 開）と発言の後に読む（ポーリングしない）
 * - technicals（#200）の tool_use があるときだけ、道具を実行する前に先物の足を読む（tech。読めなければ道具は no_data）
 * - 保存は sessionStorage の AI_SESSION_KEY だけ（タブを閉じたら消える）。読めない・書けないときは保存せずに続ける
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AiRequestError, type AiStatus, getAiStatus, postAiMessages } from '../../data/aiStream';
import { readKey, removeKey, writeKey } from '../storage';
import {
  AI_SESSION_KEY,
  type AiChatAction,
  type AiChatState,
  aiChatReduce,
  DIAGNOSE_TEXT,
  decodeAiChat,
  encodeAiChat,
  INITIAL_AI_CHAT,
  pendingToolUses,
  requestOf,
  toolResultBlocks,
} from '../view/aiChat';
import { buildAiContext, contextKey } from '../view/aiContext';
import type { TechnicalsData } from '../view/aiTechnicals';
import { type AiToolEnv, runTool } from '../view/aiTools';

/** sessionStorage（使えなければ null。プライベートブラウズ・設定で拒否） */
function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export type AiStatusView = AiStatus | null | { error: string };

export interface AiChatController {
  state: AiChatState;
  status: AiStatusView;
  diagnose: () => void;
  send: (text: string) => void;
  retry: () => void;
  abort: () => void;
  reset: () => void;
}

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

/**
 * visible: パネルが見えている（ui/view/shell.ts の aiVisible）。base: 口（本番は /api/ai、dev の合成の板は
 * /fixtures/ai）。env: 送るときに読む道具の環境（足・板・シナリオ・証拠金の設定。ref で最新を読む）
 */
export function useAiChat(
  visible: boolean,
  base: string,
  env: () => AiToolEnv | null,
  tech?: () => Promise<TechnicalsData>,
): AiChatController {
  const storage = useRef<Storage | null | undefined>(undefined);
  if (storage.current === undefined) storage.current = sessionStore();
  const stateRef = useRef<AiChatState | null>(null);
  if (stateRef.current === null) {
    const saved = decodeAiChat(readKey(storage.current, AI_SESSION_KEY));
    stateRef.current = saved
      ? aiChatReduce(INITIAL_AI_CHAT, { type: 'restore', saved })
      : INITIAL_AI_CHAT;
  }
  const [state, setState] = useState<AiChatState>(stateRef.current);
  const [status, setStatus] = useState<AiStatusView>(null);
  const envRef = useRef(env);
  envRef.current = env;
  const techRef = useRef(tech);
  techRef.current = tech;
  const baseRef = useRef(base);
  baseRef.current = base;
  const frame = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const savedMessages = useRef(stateRef.current.messages);

  const persist = useCallback((s: AiChatState) => {
    if (s.messages === savedMessages.current) return;
    savedMessages.current = s.messages;
    if (s.messages.length === 0) removeKey(storage.current ?? null, AI_SESSION_KEY);
    else if (writeKey(storage.current ?? null, AI_SESSION_KEY, encodeAiChat(s)) === 'quota') {
      removeKey(storage.current ?? null, AI_SESSION_KEY);
    }
  }, []);

  /** 状態を変える。defer なら描き直しを次のフレームにまとめる（流れの delta） */
  const apply = useCallback(
    (a: AiChatAction, defer = false) => {
      const prev = stateRef.current as AiChatState;
      const next = aiChatReduce(prev, a);
      if (next === prev) return;
      stateRef.current = next;
      persist(next);
      if (!defer) {
        if (frame.current !== null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }
        setState(next);
        return;
      }
      if (frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          setState(stateRef.current as AiChatState);
        });
      }
    },
    [persist],
  );

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getAiStatus(fetch, `${baseRef.current}/status`));
    } catch (e) {
      if (isAbort(e)) return;
      setStatus({ error: e instanceof AiRequestError ? e.code : 'network' });
    }
  }, []);

  // 見えたとき（閉 → 開）に読む
  useEffect(() => {
    if (visible) void loadStatus();
  }, [visible, loadStatus]);

  /** 今の turn の要求を送り、道具の往復が要れば続ける */
  const request = useCallback(async () => {
    for (;;) {
      const body = requestOf(stateRef.current as AiChatState);
      if (!body) return;
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await postAiMessages(
          body,
          (event) =>
            apply({ type: 'event', event }, event.type === 'text' || event.type === 'thinking'),
          ac.signal,
          fetch,
          `${baseRef.current}/messages`,
        );
      } catch (e) {
        if (isAbort(e)) apply({ type: 'fail', code: 'aborted' });
        else if (e instanceof AiRequestError) {
          apply({ type: 'fail', code: e.code, remainingUsd: e.remainingUsd });
        } else apply({ type: 'fail', code: 'network' });
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
      const s0 = stateRef.current as AiChatState;
      if (!s0.turn?.awaitingTools) break;
      let technicals: TechnicalsData | null = null;
      const load = techRef.current;
      if (load && pendingToolUses(s0).some((u) => u.name === 'technicals')) {
        try {
          technicals = await load();
        } catch {
          technicals = null;
        }
      }
      // 読んでいる間に中止・新しい会話になったら道具を返さない
      const s = stateRef.current as AiChatState;
      if (s !== s0 && !s.turn?.awaitingTools) break;
      const e = envRef.current();
      const blocks = toolResultBlocks(s, (name, input) =>
        e ? runTool(name, input, { ...e, technicals }) : { error: 'no_legs' },
      );
      apply({ type: 'toolResults', blocks });
    }
    // 描き直しを残さない・残りを読み直す
    setState(stateRef.current as AiChatState);
    void loadStatus();
  }, [apply, loadStatus]);

  const start = useCallback(
    (kind: 'chat' | 'diagnose', text: string) => {
      apply({ type: 'begin', kind, text, now: Date.now() });
      if (!(stateRef.current as AiChatState).turn) return;
      // 「計算中」を描いてから計算する（同じタスクで計算すると表示が計算の後になる）
      setTimeout(() => {
        const e = envRef.current();
        if (!e) {
          apply({ type: 'fail', code: 'no_board' });
          return;
        }
        const context = buildAiContext(e);
        apply({ type: 'send', context, key: contextKey(context) });
        void request();
      }, 0);
    },
    [apply, request],
  );

  const diagnose = useCallback(() => start('diagnose', DIAGNOSE_TEXT), [start]);
  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (t !== '') start('chat', t);
    },
    [start],
  );
  const retry = useCallback(() => {
    const f = (stateRef.current as AiChatState).failed;
    if (f) start(f.kind, f.userText);
  }, [start]);
  const abort = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => {
    abortRef.current?.abort();
    apply({ type: 'reset' });
  }, [apply]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      abortRef.current?.abort();
    },
    [],
  );

  return { state, status, diagnose, send, retry, abort, reset };
}
