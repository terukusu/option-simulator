import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AiStatus } from '../../../data/aiStream';
import { pure } from '../../components/pure';
import { type AiChatController, useAiChat } from '../../components/useAiChat';
import {
  type AiGate,
  aiErrorText,
  type ChatItem,
  chatItems,
  diagnoseBlocked,
  MAX_USER_TEXT,
  nearLimit,
  numberSources,
  PHASE_LABEL,
  remainingText,
  sendBlocked,
} from '../../view/aiChat';
import { proposalCard } from '../../view/aiPropose';
import type { TechnicalsData } from '../../view/aiTechnicals';
import { answerModel, type MarkedInline } from '../../view/aiText';
import { type AiToolEnv, scenarioOfResult, toolCard } from '../../view/aiTools';
import { PANEL_FOCUS_LABEL } from '../../view/keys';
import { PanelHead } from '../PanelHead';

/** 免責の文（端末で最初の 1 回だけ。AI の返答には書かせない。#135） */
export const AI_DISCLAIMER =
  'AI の説明は、このシミュレーターの計算結果をもとにした検討材料です。投資の助言ではありません。売買の判断はご自身で行ってください。';
export const AI_EMPTY_TEXT =
  '今のポジションの弱点を、AI が simulator の計算の数字で説明します。[このポジションを診断] を押すか、質問を入れてください。';
const UNMATCHED_LABEL = '計算結果に無い数字';
/** 提案の差分の印の読み上げ（#139） */
const PROPOSAL_MARK_LABEL = { '+': '追加: ', '−': '削除: ', '±': '変更: ' } as const;

export interface AiApply {
  days: number;
  dX: number;
  dSigma: number;
  skew: number;
}

/** 提案のカードの [適用]（#139。ツールの入力と結果をそのまま渡す。反映の検査は NextApp） */
export type AiProposeApply = (input: Record<string, unknown>, result: unknown) => void;

/** パレット（NextApp）が読む口（AiPanel が描くたびに入れる） */
export interface AiPanelApi {
  diagnose: () => void;
  /** パレットの [このポジションを診断] が押せない理由（状態をまだ読んでいなければ押せる扱い = 開いてから読む） */
  paletteReason: string | null;
}

/** 状態をまだ読んでいないときのパレットの判定（押せる扱い。中継の 503 / 429 は返答の行に出る） */
const UNKNOWN_STATUS: AiStatus = {
  schema_version: 1,
  enabled: true,
  model: null,
  credential: null,
  counted: false,
  limit_usd: null,
  remaining_usd: null,
  resets_at: null,
};

/**
 * AI のパネル（#135）。会話の状態のフック（useAiChat）をここに置く = 流れの文で描き直すのはこの部品の中だけ
 * （舞台・指標は描き直さない）。pure: 入力は参照の変わらない関数と値だけ
 */
function AiPanelView(p: {
  visible: boolean;
  base: string;
  env: () => AiToolEnv | null;
  /** technicals の道具の先物の足の読み込み（#200。NextApp が口を決める） */
  tech?: () => Promise<TechnicalsData>;
  hasChain: boolean;
  legCount: number;
  x0: number;
  disclaimerSeen: boolean;
  onDisclaimerSeen: () => void;
  onApplyScenario: (s: AiApply) => void;
  onApplyProposal: AiProposeApply;
  apiRef: { current: AiPanelApi | null };
}) {
  const chat = useAiChat(p.visible, p.base, p.env, p.tech);
  const gate = { hasChain: p.hasChain, legCount: p.legCount };
  p.apiRef.current = {
    diagnose: chat.diagnose,
    paletteReason: diagnoseBlocked(chat.state, { ...gate, status: chat.status ?? UNKNOWN_STATUS }),
  };
  return (
    <AiChat
      chat={chat}
      gate={gate}
      x0={p.x0}
      disclaimerSeen={p.disclaimerSeen}
      onDisclaimerSeen={p.onDisclaimerSeen}
      onApplyScenario={p.onApplyScenario}
      onApplyProposal={p.onApplyProposal}
    />
  );
}

export const AiPanel = pure(AiPanelView);

/**
 * AI のチャット（#135。docs/ui-redesign.md 2 章・docs/design.md 14 章）。見出し行（残り・[新しい会話]）→ 免責の文
 * （初回だけ）→ 会話（user の吹き出し・考え中の要約（折りたたみ）・返答（aiText の木）・道具のカード）→ 進み具合・
 * 押せない理由 → [このポジションを診断] と入力欄。返答・入力は JSX のテキストだけ（HTML を入れない・style 属性を使わない）。
 * 照合できない数字（ui/view/aiNumbers.ts）は class の印（点線の下線）。
 */
export function AiChat(p: {
  chat: AiChatController;
  gate: Omit<AiGate, 'status'>;
  x0: number;
  disclaimerSeen: boolean;
  onDisclaimerSeen: () => void;
  onApplyScenario: (s: AiApply) => void;
  onApplyProposal: AiProposeApply;
}) {
  const { chat } = p;
  const { state, status } = chat;
  const gate: AiGate = { ...p.gate, status };
  const diagnoseReason = diagnoseBlocked(state, gate);
  const sendReason = sendBlocked(state, gate);
  const items = useMemo(() => chatItems(state), [state]);
  const sources = useMemo(() => numberSources(state), [state.context, state.messages]);
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  // 新しい項目・流れの文で末尾へ（利用者が上へ戻して読んでいるときは動かさない）
  const stick = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const remaining = remainingText(
    status && !('error' in status) ? status : null,
    state.remainingUsd,
  );
  const turn = state.turn;
  const submit = () => {
    if (sendReason !== null || text.trim() === '') return;
    chat.send(text);
    setText('');
    stick.current = true;
  };
  const long = nearLimit(state);
  return (
    <>
      <PanelHead title="AI" {...(remaining !== null && { sub: remaining })}>
        <button
          type="button"
          class="btn ghost sm"
          data-ai="reset"
          disabled={state.messages.length === 0 && state.failed === null && !turn}
          onClick={chat.reset}
        >
          新しい会話
        </button>
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜6 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div
        class="panel-body ai-body"
        tabIndex={-1}
        role="group"
        aria-label={PANEL_FOCUS_LABEL.ai}
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!p.disclaimerSeen && (
          <div class="ai-disclaimer" data-ai="disclaimer">
            <p>{AI_DISCLAIMER}</p>
            <button type="button" class="btn sm" onClick={p.onDisclaimerSeen}>
              閉じる
            </button>
          </div>
        )}
        {items.length === 0 && <p class="ai-empty">{AI_EMPTY_TEXT}</p>}
        <div class="ai-log" role="log" aria-live="off">
          {items.map((it) => (
            <ChatRow
              key={it.key}
              item={it}
              sources={sources}
              x0={p.x0}
              onApply={p.onApplyScenario}
              onPropose={p.onApplyProposal}
              onRetry={chat.retry}
              canRetry={sendReason === null}
            />
          ))}
        </div>
        {state.stop !== null && <p class="ai-note">{aiErrorText(state.stop)}</p>}
        {long && (
          <p class="ai-note" data-ai="long">
            会話が長くなりました。[新しい会話] で始めると速く・安くなります
          </p>
        )}
      </div>
      <div class="ai-foot">
        {turn && <Progress phase={turn.phase} startedAt={turn.startedAt} onAbort={chat.abort} />}
        {!turn && diagnoseReason !== null && (
          <p class="ai-reason" data-ai="reason">
            {diagnoseReason}
          </p>
        )}
        <div class="ai-actions">
          <button
            type="button"
            class="btn primary"
            data-ai="diagnose"
            disabled={diagnoseReason !== null}
            title={diagnoseReason ?? undefined}
            onClick={() => {
              stick.current = true;
              chat.diagnose();
            }}
          >
            このポジションを診断
          </button>
        </div>
        <form
          class="ai-input"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            rows={2}
            maxLength={MAX_USER_TEXT}
            value={text}
            aria-label="AI への質問"
            placeholder="質問（Enter で送信・Shift+Enter で改行）"
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              submit();
            }}
          />
          <button
            type="submit"
            class="btn"
            data-ai="send"
            disabled={sendReason !== null || text.trim() === ''}
          >
            送信
          </button>
        </form>
      </div>
    </>
  );
}

/** 進み具合の行（経過秒は 1 秒ごと。描き直すのはこの行だけ） */
function Progress(p: { phase: keyof typeof PHASE_LABEL; startedAt: number; onAbort: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((now - p.startedAt) / 1000));
  return (
    <div class="ai-progress" data-ai-phase={p.phase} role="status">
      <span class="ai-spin" aria-hidden="true" />
      <span class="ai-phase">{PHASE_LABEL[p.phase]}…</span>
      <span class="ai-sec">{sec} 秒</span>
      <span class="spacer" />
      <button type="button" class="btn sm" data-ai="abort" onClick={p.onAbort}>
        中止
      </button>
    </div>
  );
}

function ChatRow(p: {
  item: ChatItem;
  sources: readonly unknown[];
  x0: number;
  onApply: (s: AiApply) => void;
  onPropose: AiProposeApply;
  onRetry: () => void;
  canRetry: boolean;
}) {
  const it = p.item;
  switch (it.kind) {
    case 'user':
      return (
        <div class="ai-msg user">
          <p class="ai-bubble">{it.text}</p>
          {it.updated && <p class="ai-meta">画面の変更（板・ポジション・シナリオ）を送りました</p>}
        </div>
      );
    case 'thinking':
      return (
        <details class="ai-thinking">
          <summary>{it.live ? '考え中の要約' : '考えた要約'}</summary>
          <p>{it.text}</p>
        </details>
      );
    case 'answer':
      return (
        <div class="ai-msg answer" data-ai-live={it.live ? 'true' : undefined}>
          {it.text !== '' && <AnswerText text={it.text} sources={p.sources} />}
          {it.failed !== null && (
            <p class="ai-error" data-ai="error" data-code={it.failed}>
              {aiErrorText(it.failed, it.remainingUsd ?? null)}
              {it.failed !== 'session_expired' && (
                <button type="button" class="btn sm" disabled={!p.canRetry} onClick={p.onRetry}>
                  もう一度
                </button>
              )}
            </p>
          )}
        </div>
      );
    case 'tool': {
      const prop =
        it.name === 'propose_position' && !it.isError ? proposalCard(it.input, it.result) : null;
      if (prop) {
        return (
          <div class="ai-tool ai-prop" data-ai-tool={it.name} data-target={prop.target}>
            <p class="ai-tool-title">{prop.title}</p>
            {prop.lines.map((l, i) => (
              <p key={i} class="ai-prop-line">
                <span class="ai-prop-mark" data-mark={l.mark} aria-hidden="true">
                  {l.mark === '+' ? '＋' : l.mark === '−' ? '−' : '±'}
                </span>
                <span>
                  <span class="sr">{PROPOSAL_MARK_LABEL[l.mark]}</span>
                  {l.text}
                </span>
              </p>
            ))}
            {prop.metrics.map((m) => (
              <p key={m} class="ai-prop-metric">
                {m}
              </p>
            ))}
            <button
              type="button"
              class="btn sm primary"
              data-ai="propose"
              onClick={() => p.onPropose(it.input, it.result)}
            >
              {prop.button}
            </button>
          </div>
        );
      }
      const card = toolCard(it.name, it.input, it.result, it.isError);
      const sc = card.applicable ? scenarioOfResult(it.result, p.x0) : null;
      return (
        <div class="ai-tool" data-ai-tool={it.name}>
          <p class="ai-tool-title">{card.title}</p>
          {card.input && <p class="ai-tool-input">{card.input}</p>}
          {card.lines.map((l) => (
            <p key={l} class="ai-tool-line">
              {l}
            </p>
          ))}
          {sc && (
            <button type="button" class="btn sm" data-ai="apply" onClick={() => p.onApply(sc)}>
              シナリオに適用
            </button>
          )}
        </div>
      );
    }
  }
}

/**
 * 返答の文（木 + 照合の印）。(text, sources) で memo する = 流れの間にフレームごとに作り直すのは流れている返答だけ
 * （終わった返答の text と、会話の sources（messages が変わったときだけ作る）は変わらない）
 */
function AnswerText(p: { text: string; sources: readonly unknown[] }) {
  const blocks = useMemo(() => answerModel(p.text, p.sources), [p.text, p.sources]);
  const inl = (xs: MarkedInline[]): ComponentChildren =>
    xs.map((x, i) => {
      const parts = x.parts.map((m, j) =>
        m.unmatched ? (
          <span key={j} class="ai-unmatched" title={UNMATCHED_LABEL}>
            {m.text}
            <span class="sr">（{UNMATCHED_LABEL}）</span>
          </span>
        ) : (
          m.text
        ),
      );
      return x.bold ? <strong key={i}>{parts}</strong> : <span key={i}>{parts}</span>;
    });
  return (
    <div class="ai-answer">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h':
            return b.level === 2 ? <h3 key={i}>{inl(b.inl)}</h3> : <h4 key={i}>{inl(b.inl)}</h4>;
          case 'p':
            return <p key={i}>{inl(b.inl)}</p>;
          case 'ul':
          case 'ol': {
            const items = b.items.map((x, j) => <li key={j}>{inl(x)}</li>);
            return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
          }
        }
        return null;
      })}
    </div>
  );
}
