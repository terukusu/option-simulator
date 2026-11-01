import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AiStatus } from '../../../data/aiStream';
import { pure } from '../../components/pure';
import { type AiChatController, type AiStatusView, useAiChat } from '../../components/useAiChat';
import { downloadText } from '../../download';
import type { AiAsk } from '../../view/aiAsk';
import {
  type AiGate,
  aiErrorText,
  applyDraft,
  askPlan,
  type ChatItem,
  chatGroups,
  chatItems,
  DRAFT_KEPT_TEXT,
  diagnoseBlocked,
  diagnoseProminent,
  footReason,
  holdAfterDone,
  MAX_USER_TEXT,
  nearLimit,
  numberSources,
  PHASE_LABEL,
  remainingText,
  sendBlocked,
  sentShown,
} from '../../view/aiChat';
import { type AiCheck, aiCheckChips, CHECKS_LABEL } from '../../view/aiChecks';
import {
  AI_EVAL_KEEP_LABEL,
  AI_EVAL_NOTE_PROMPT,
  type AiEvalSource,
  aiEvalCase,
  aiEvalFileName,
  answerAt,
  keepFailText,
  keepKeys,
  usedTools,
} from '../../view/aiEvalCase';
import type { IvStatsData } from '../../view/aiIvStats';
import { AI_PRESETS, type AiPreset, presetBlocked } from '../../view/aiPresets';
import { proposalCard } from '../../view/aiPropose';
import type { TechnicalsData } from '../../view/aiTechnicals';
import { answerModel, type MarkedBlock, type MarkedInline } from '../../view/aiText';
import { type AiToolEnv, scenarioOfResult, toolCard } from '../../view/aiTools';
import { PANEL_FOCUS_LABEL } from '../../view/keys';
import { PanelHead } from '../PanelHead';
import { Chip, ChipRow } from '../parts/Chip';
import { Icon } from '../parts/Icon';
import { useScrollMore } from '../parts/scrollMore';
import { openManualRef, openTerm } from '../parts/termCard';

/** 免責の文（端末で最初の 1 回だけ。AI の返答には書かせない。#135） */
export const AI_DISCLAIMER =
  'AI の説明は、このシミュレーターの計算結果をもとにした検討材料です。投資の助言ではありません。売買の判断はご自身で行ってください。';
/** 空の AI パネルの見出しと手段（#277。A-07） */
export const AI_EMPTY_TITLE = 'このポジションの弱点を AI に聞く';
export const AI_EMPTY_TEXT =
  '[このポジションを診断]・下の定型の質問を押すか、質問を入れてください。数字はこのシミュレーターの計算から取ります。';
/** [このポジションを診断] の文字（会話が空のときの大きいボタン・以後の定型の質問の先頭のチップ。#277） */
const DIAGNOSE_LABEL = 'このポジションを診断';
/** 返答の ⋯ の読み上げ名（#277。中に [評価に残す]） */
const ANSWER_MENU_LABEL = '返答のその他の操作';
/** 定型の質問のチップの行の名前（#140） */
const PRESETS_LABEL = '定型の質問';
const UNMATCHED_LABEL = '計算結果に無い数字';
/** 用語のボタンの読み上げの補い（#232。押すと説明カード） */
const TERM_LABEL = '用語の説明';
/** マニュアルの根拠の節の読み上げ（#322） */
const MANUAL_REF_LABEL = 'マニュアルの節';
/** 横にスクロールする表の枠の名前（#234） */
const TABLE_SCROLL_LABEL = '表（横にスクロール）';
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

/** 返答の「確かめるとよいこと」のチップ（#278。振り分けは NextApp） */
export type AiCheckApply = (c: AiCheck) => void;

/** パレット（NextApp）が読む口（AiPanel が描くたびに入れる） */
export interface AiPanelApi {
  diagnose: () => void;
  /** [AI に聞く]（#136）: 送れるなら送る、送れない理由があれば入力欄に入れる（askPlan） */
  ask: (a: AiAsk) => void;
  /** パレットの [このポジションを診断] が押せない理由（状態をまだ読んでいなければ押せる扱い = 開いてから読む） */
  paletteReason: string | null;
  /**
   * 定型の質問を送る（#20 第 2 弾の形の相談。kind preset）: 送れるなら送る、状態を読んでいなければ読めてから判定する。
   * 送れない理由があれば送らない（理由は足元の行に出る。ボタンは presetReason で押せない）
   */
  preset: (p: AiPreset) => void;
  /** 足の要らない定型（形の相談）が押せない理由（自由な質問と同じ。状態をまだ読んでいなければ押せる扱い） */
  presetReason: string | null;
}

/** 入力欄に入れた [AI に聞く] の質問（#136。n が変わったら入れる。入れた文のまま送れば ask + topic） */
export interface AiDraft {
  text: string;
  topic: string;
  n: number;
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
  /** 評価に残す（#159）の文脈の作り直しの材料（板が無ければ null） */
  evalSource?: () => AiEvalSource | null;
  /** technicals のツールの先物の足の読み込み（#200。NextApp が口を決める） */
  tech?: () => Promise<TechnicalsData>;
  /** iv_stats のツールの日次の値と今の IV の読み込み（#138・#158。NextApp が口を決める） */
  ivStats?: () => Promise<IvStatsData>;
  hasChain: boolean;
  legCount: number;
  x0: number;
  disclaimerSeen: boolean;
  onDisclaimerSeen: () => void;
  onApplyScenario: (s: AiApply) => void;
  onApplyProposal: AiProposeApply;
  onCheck: AiCheckApply;
  /** 作業中のタブが保有（#301。今のタブ向けの提案のボタンを「新しいタブに入れる」に） */
  held?: boolean;
  apiRef: { current: AiPanelApi | null };
  /**
   * 足の要らない定型（形の相談）が押せない理由が変わったら知らせる（#20 レビュー N2。形の一覧を開いたまま送信中 →
   * 終わりなどで、カードのボタンの押せる / 押せないを追従させる。値が変わったときだけ呼ぶ）
   */
  onPresetReason?: (reason: string | null) => void;
  /** 読んだ AI の状態が変わったら知らせる（画像から建玉を読み取る #318 の入口の押せる / 押せない。null = まだ読んでいない） */
  onStatus?: (status: AiStatusView) => void;
}) {
  const chat = useAiChat(p.visible, p.base, p.env, p.tech, p.ivStats, p.evalSource);
  const gate = { hasChain: p.hasChain, legCount: p.legCount };
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const known = { ...gate, status: chat.status ?? UNKNOWN_STATUS };
  // AI の状態を読み終わるまで待っている [AI に聞く]（#136 レビュー指摘 1。読めたら判定し直す）
  // 形の相談（#20 第 2 弾）も同じく待つ（送れない理由が出たら送らない = 入力欄に入れない。kind preset の文を自由な
  // 質問として送り直させない）
  const pending = useRef<{ ask: AiAsk } | { preset: AiPreset } | null>(null);
  const decide = (a: AiAsk, plan: ReturnType<typeof askPlan>) => {
    if (plan === 'send') chat.ask(a.text, a.topic);
    else if (plan === 'wait') pending.current = { ask: a };
    else setDraft((d) => ({ text: a.text, topic: a.topic, n: (d?.n ?? 0) + 1 }));
  };
  const decidePreset = (pr: AiPreset, plan: ReturnType<typeof askPlan>) => {
    if (plan === 'send') chat.preset(pr);
    else if (plan === 'wait') pending.current = { preset: pr };
  };
  useEffect(() => {
    const w = pending.current;
    if (!w || chat.status === null) return;
    pending.current = null;
    const plan = askPlan(chat.state, { ...gate, status: chat.status });
    if ('ask' in w) decide(w.ask, plan);
    else decidePreset(w.preset, plan);
  }, [chat.status]);
  // 評価に残す（#159）: 押した返答までの会話を JSON ファイルに保存する（ダウンロードだけ。サーバーに送らない）。
  // 会話で technicals / iv_stats を呼んでいたら、その材料（読み込みの 10 分の覚え）も入れる
  // 材料は、その発言を送ったときの控え（useAiChat）。控えが無ければ（再読み込みで戻した会話）押した時点の画面。
  // 先物の足・IV の日次の値は、控えに無く会話で呼んでいたら読み直す。残せないときは理由を足元に短く出す
  const [keepNote, setKeepNote] = useState<string | null>(null);
  const keep = async (key: string) => {
    try {
      const st = chat.state;
      const at = answerAt(key);
      const src = (at ? chat.evalSourceAt(at.i) : null) ?? p.evalSource?.() ?? null;
      if (!src) {
        setKeepNote(keepFailText('板がありません'));
        return;
      }
      const log = chat.turnLog();
      const note = window.prompt(AI_EVAL_NOTE_PROMPT, '');
      if (note === null) return;
      const used = usedTools(st.messages.slice(0, (at?.i ?? -1) + 1));
      const [technicals, ivStats] = await Promise.all([
        used.has('technicals') && !src.technicals && p.tech ? p.tech().catch(() => null) : null,
        used.has('iv_stats') && !src.iv_stats && p.ivStats ? p.ivStats().catch(() => null) : null,
      ]);
      const now = Date.now();
      const doc = aiEvalCase({
        chat: st,
        answerKey: key,
        source: {
          ...src,
          ...(technicals && { technicals }),
          ...(ivStats && { iv_stats: ivStats }),
        },
        note: note.trim(),
        now,
        log,
      });
      if (!doc) {
        setKeepNote(keepFailText('この返答は残せません'));
        return;
      }
      downloadText(`${JSON.stringify(doc, null, 1)}\n`, aiEvalFileName(now));
      setKeepNote(null);
    } catch {
      setKeepNote(keepFailText('ファイルを作れませんでした'));
    }
  };
  const presetReason = sendBlocked(chat.state, known);
  useEffect(() => {
    p.onPresetReason?.(presetReason);
  }, [presetReason]);
  useEffect(() => {
    p.onStatus?.(chat.status);
  }, [chat.status]);
  p.apiRef.current = {
    diagnose: chat.diagnose,
    ask: (a) => decide(a, askPlan(chat.state, { ...gate, status: chat.status })),
    paletteReason: diagnoseBlocked(chat.state, known),
    preset: (pr) => decidePreset(pr, askPlan(chat.state, { ...gate, status: chat.status })),
    presetReason,
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
      onCheck={p.onCheck}
      held={p.held === true}
      draft={draft}
      {...(p.evalSource && { onKeep: (key: string) => void keep(key) })}
      keepNote={keepNote}
    />
  );
}

export const AiPanel = pure(AiPanelView);

/**
 * AI のチャット（#135。docs/ui-redesign.md 2 章・docs/design.md 14 章）。見出し行（残り・[新しい会話]）→ 会話が空なら
 * 見出しと手段・免責の文（初回だけ。薄いバー）→ 会話（user の吹き出し・考え中の要約（折りたたみ。1 返答に 1 つ）・返答
 * （aiText の木。末尾の ⋯ に [評価に残す]）・ツールのカード）→ 進み具合・押せない理由 → [このポジションを診断]（会話が
 * 空のときだけ大きいボタン、以後は定型の質問の先頭のチップ。#277）・定型の質問のチップ（#140。狭い幅は 2 行に折る）と入力欄。返答・入力は JSX のテキストだけ（HTML を入れない・style 属性を使わない）。
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
  onCheck: AiCheckApply;
  /** 作業中のタブが保有（#301） */
  held?: boolean;
  /** [AI に聞く] で送れなかった質問（#136。入力欄に入れる。フォーカスは動かさない = スマホでキーボードを出さない） */
  draft?: AiDraft | null;
  /** 返答の行の [評価に残す]（#159。返答の行の key） */
  onKeep?: (key: string) => void;
  /** 評価に残せなかった理由（#159） */
  keepNote?: string | null;
}) {
  const { chat } = p;
  const { state, status } = chat;
  const gate: AiGate = { ...p.gate, status };
  const diagnoseReason = diagnoseBlocked(state, gate);
  const sendReason = sendBlocked(state, gate);
  const reason = footReason(state, gate);
  const items = useMemo(() => chatItems(state), [state]);
  const sources = useMemo(() => numberSources(state), [state.context, state.messages]);
  const keepable = useMemo(() => keepKeys(state), [state.messages, state.turn === null]);
  const [text, setText] = useState('');
  const textRef = useRef(text);
  textRef.current = text;
  // 入力欄に入れた [AI に聞く] の質問（#136）。入れた文のまま送れば ask + topic、書き換えたら chat。
  // 書きかけの文があれば上書きせずに知らせる（レビュー指摘 2）
  const draftRef = useRef<AiDraft | null>(null);
  const [kept, setKept] = useState(false);
  const draft = p.draft ?? null;
  useEffect(() => {
    if (!draft) return;
    if (applyDraft(textRef.current, draftRef.current?.text ?? null, draft.text) === 'keep') {
      setKept(true);
      return;
    }
    draftRef.current = draft;
    setKept(false);
    setText(draft.text);
  }, [draft]);
  const logRef = useRef<HTMLDivElement>(null);
  // 送った発言を見せる（#263）: 新しい発言（入力欄・診断・定型・[AI に聞く]・パレット・[もう一度]）を始めたら、
  // その吹き出しが会話に出た描き直し（sentShown。送る前の失敗の行を含む）で 1 回だけ、最後の発言の塊（.ai-tail）の
  // 上端を枠の内側の上端に合わせる。
  // 以後は自動で動かさない（返答・ツールのカード・失敗の行は下に伸びる。利用者のスクロールを戻さない）。
  // sent: この表示で発言を送った（塊に枠の高さの min-height = 上端まで上げられる）。[新しい会話] で戻す
  const sent = useRef(false);
  const anchor = useRef(false);
  // 返答が終わった後の下詰め（#277。holdAfterDone）: 縮めた発言の startedAt（次の発言を始めたら外れる = 'true'）
  const [endFor, setEndFor] = useState<number | null>(null);
  const lastStart = useRef<number | null>(null);
  const measured = useRef(false);
  // 送る前（戻した会話・開き直し）は今までどおり末尾へ（利用者が上へ戻して読んでいるときは動かさない）
  const stick = useRef(true);
  // 描く前に決める（吹き出しが入る描き直しで塊に min-height が付いている = 上端まで上げられる）
  const startedAt = state.turn?.startedAt;
  const seenAt = useRef(startedAt);
  if (startedAt !== undefined && startedAt !== seenAt.current) {
    sent.current = true;
    anchor.current = true;
    measured.current = false;
    lastStart.current = startedAt;
  }
  seenAt.current = startedAt;
  const hold = endFor !== null && endFor === lastStart.current ? 'end' : 'true';
  const ready = sentShown(state);
  useLayoutEffect(() => {
    const el = logRef.current;
    const tail = el?.querySelector<HTMLElement>('.ai-tail[data-last]');
    // 枠が見えていない（display: none）間は合わせずに待つ（見えた後の描き直しで合わせる）
    if (!anchor.current || !ready || !el || !tail || el.clientHeight === 0) return;
    anchor.current = false;
    // 位置は画面の座標の差で求める（offsetParent に頼らない）
    const pad = Number.parseFloat(getComputedStyle(el).paddingTop) || 0;
    const top = el.getBoundingClientRect().top + el.clientTop + pad;
    el.scrollTop += tail.getBoundingClientRect().top - top;
  });
  // 返答が終わったら塊の中身の高さを測り、低ければ下詰めを縮める（#277。流れの間・合わせる前は測らない）。
  // 終わった直後に 1 回（描く前）、以後は次の発言まで枠の大きさが変わるたびに測り直す（シートの段・窓の大きさ）
  const done = sent.current && state.turn === null;
  const decideHold = () => {
    const el = logRef.current;
    if (!sent.current || anchor.current) return false;
    const tail = el?.querySelector<HTMLElement>('.ai-tail[data-last]');
    const end = tail?.lastElementChild;
    if (!el || !tail || !end || el.clientHeight === 0) return false;
    const cs = getComputedStyle(el);
    const frame =
      el.clientHeight -
      (Number.parseFloat(cs.paddingTop) || 0) -
      (Number.parseFloat(cs.paddingBottom) || 0);
    const content = end.getBoundingClientRect().bottom - tail.getBoundingClientRect().top;
    setEndFor(holdAfterDone(content, frame) === 'end' ? lastStart.current : null);
    return true;
  };
  useLayoutEffect(() => {
    if (!done || measured.current) return;
    measured.current = decideHold();
  });
  useEffect(() => {
    const el = logRef.current;
    if (!done || !el || typeof ResizeObserver === 'undefined') return;
    // 始めたときの 1 回目は上の測りと同じ結果（同じ値の setState は描き直さない）。隠れていた枠が見えたときも測る
    const ro = new ResizeObserver(() => {
      measured.current = decideHold() || measured.current;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [done]);
  useEffect(() => {
    const el = logRef.current;
    if (el && !sent.current && stick.current) el.scrollTop = el.scrollHeight;
  });
  const groups = useMemo(() => chatGroups(items), [items]);
  const row = (it: ChatItem) => (
    <ChatRow
      key={it.key}
      item={it}
      sources={sources}
      x0={p.x0}
      onApply={p.onApplyScenario}
      onPropose={p.onApplyProposal}
      held={p.held === true}
      onCheck={p.onCheck}
      onRetry={chat.retry}
      canRetry={sendReason === null}
      {...(p.onKeep && keepable.has(it.key) && { onKeep: p.onKeep })}
    />
  );
  const remaining = remainingText(
    status && !('error' in status) ? status : null,
    state.remainingUsd,
  );
  const turn = state.turn;
  const submit = () => {
    if (sendReason !== null || text.trim() === '') return;
    const d = draftRef.current;
    if (d && text === d.text) chat.ask(text, d.topic);
    else chat.send(text);
    draftRef.current = null;
    setKept(false);
    setText('');
  };
  const long = nearLimit(state);
  const prominent = diagnoseProminent(items);
  return (
    <>
      <PanelHead title="AI" {...(remaining !== null && { sub: remaining })}>
        <button
          type="button"
          class="btn ghost sm"
          data-ai="reset"
          disabled={state.messages.length === 0 && state.failed === null && !turn}
          onClick={() => {
            sent.current = false;
            anchor.current = false;
            stick.current = true;
            measured.current = false;
            setEndFor(null);
            chat.reset();
          }}
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
        {items.length === 0 && (
          <div class="ai-empty">
            <h3>{AI_EMPTY_TITLE}</h3>
            <p>{AI_EMPTY_TEXT}</p>
          </div>
        )}
        {!p.disclaimerSeen && (
          <div class="ai-disclaimer" data-ai="disclaimer">
            <p>{AI_DISCLAIMER}</p>
            <button
              type="button"
              class="ai-disclaimer-close"
              aria-label="免責の文を閉じる"
              title="閉じる"
              onClick={p.onDisclaimerSeen}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        <div class="ai-log" role="log" aria-live="off">
          {groups.map((g, i) => {
            const last = i === groups.length - 1;
            return (
              <div
                key={g.key}
                class="ai-tail"
                data-last={last ? 'true' : undefined}
                data-hold={last && sent.current ? hold : undefined}
              >
                {g.items.map(row)}
              </div>
            );
          })}
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
        {reason !== null && (
          <p class="ai-reason" data-ai="reason">
            {reason}
          </p>
        )}
        {p.keepNote && (
          <p class="ai-reason" data-ai="keep-note">
            {p.keepNote}
          </p>
        )}
        {kept && (
          <p class="ai-reason" data-ai="kept">
            {DRAFT_KEPT_TEXT}
          </p>
        )}
        {prominent && (
          <div class="ai-actions">
            <button
              type="button"
              class="btn primary"
              data-ai="diagnose"
              disabled={diagnoseReason !== null}
              title={diagnoseReason ?? undefined}
              onClick={chat.diagnose}
            >
              {DIAGNOSE_LABEL}
            </button>
          </div>
        )}
        <div class="ai-presets" data-ai="presets">
          <ChipRow label={PRESETS_LABEL}>
            {!prominent && (
              <button
                type="button"
                class="chip"
                data-ai="diagnose"
                disabled={diagnoseReason !== null}
                title={diagnoseReason ?? undefined}
                onClick={chat.diagnose}
              >
                {DIAGNOSE_LABEL}
              </button>
            )}
            {AI_PRESETS.map((pr) => {
              const why = presetBlocked(state, gate, pr);
              return (
                <Chip
                  key={pr.id}
                  text={pr.label}
                  disabled={why !== null}
                  {...(why !== null && { title: why })}
                  onClick={() => chat.preset(pr)}
                />
              );
            })}
          </ChipRow>
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
            onInput={(e) => {
              setText(e.currentTarget.value);
              if (e.currentTarget.value.trim() === '') setKept(false);
            }}
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
  /** 作業中のタブが保有（#301） */
  held: boolean;
  onCheck: AiCheckApply;
  onRetry: () => void;
  canRetry: boolean;
  onKeep?: (key: string) => void;
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
          <summary>
            <Icon name="chevron" />
            <span>{it.live ? '考え中の要約' : '考えた要約'}</span>
          </summary>
          <p>{it.text}</p>
        </details>
      );
    case 'answer':
      return (
        <div class="ai-msg answer" data-ai-live={it.live ? 'true' : undefined}>
          {it.text !== '' && <AnswerText text={it.text} sources={p.sources} live={it.live} />}
          {!it.live && it.failed === null && <AnswerChecks text={it.text} onCheck={p.onCheck} />}
          {p.onKeep && (
            <details class="ai-more">
              <summary aria-label={ANSWER_MENU_LABEL} title={ANSWER_MENU_LABEL}>
                <Icon name="more" />
              </summary>
              <button
                type="button"
                class="ai-keep"
                data-ai="keep"
                onClick={() => p.onKeep?.(it.key)}
              >
                {AI_EVAL_KEEP_LABEL}
              </button>
            </details>
          )}
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
        it.name === 'propose_position' && it.status === 'ok'
          ? proposalCard(it.input, it.result, p.held)
          : null;
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
      const card = toolCard(it.name, it.input, it.result, it.status);
      const sc = card.applicable ? scenarioOfResult(it.result, p.x0) : null;
      return (
        <div
          class="ai-tool"
          data-ai-tool={it.name}
          data-status={it.status}
          aria-busy={card.pending ? 'true' : undefined}
        >
          <p class="ai-tool-title">{card.title}</p>
          {card.input && <p class="ai-tool-input">{card.input}</p>}
          {card.lines.map((l) => (
            <p key={l} class="ai-tool-line">
              {card.pending && <span class="ai-spin" aria-hidden="true" />}
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
 * 返答の文（木 + 照合の印 + 用語の印）。(text, sources, live) で memo する = 流れの間にフレームごとに作り直すのは
 * 流れている返答だけ（終わった返答の text と、会話の sources（messages が変わったときだけ作る）は変わらない）。
 * 用語（#232）は押すと説明カード（openTerm）。マニュアルの根拠の節（#322）は押すと説明カードにその節（openManualRef）。
 * 表（#234）は AiTable
 */
function AnswerText(p: { text: string; sources: readonly unknown[]; live: boolean }) {
  const blocks = useMemo(() => answerModel(p.text, p.sources, p.live), [p.text, p.sources, p.live]);
  const inl = (xs: MarkedInline[]): ComponentChildren =>
    xs.map((x, i) => {
      const parts = x.parts.map((m, j) => {
        const term = m.term;
        const ref = m.manual;
        if (ref)
          // マニュアルの根拠の節（#322）: 押したときにマニュアルを読み込み、カードで節を引く（無ければカードに「見つからない」）
          return (
            <button
              key={j}
              type="button"
              class="ai-term"
              data-manual={ref.id}
              aria-haspopup="dialog"
              onClick={() => openManualRef(ref.id, ref.title)}
            >
              {m.text}
              <span class="sr">（{MANUAL_REF_LABEL}）</span>
            </button>
          );
        if (term)
          return (
            <button
              key={j}
              type="button"
              class="ai-term"
              data-term={term}
              aria-haspopup="dialog"
              onClick={() => openTerm(term)}
            >
              {m.text}
              <span class="sr">（{TERM_LABEL}）</span>
            </button>
          );
        return m.unmatched ? (
          <span key={j} class="ai-unmatched" title={UNMATCHED_LABEL}>
            {m.text}
            <span class="sr">（{UNMATCHED_LABEL}）</span>
          </span>
        ) : (
          m.text
        );
      });
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
          case 'table':
            return <AiTable key={i} table={b} inl={inl} />;
        }
        return null;
      })}
    </div>
  );
}

/**
 * 返答の「確かめるとよいこと」のチップ（#278。ui/view/aiChecks.ts）。終わった返答だけ（流れている間・失敗は出さない）。
 * 文から作るのは text が変わったときだけ
 */
function AnswerChecks(p: { text: string; onCheck: AiCheckApply }) {
  const chips = useMemo(() => aiCheckChips(p.text), [p.text]);
  if (chips.length === 0) return null;
  return (
    <div class="ai-checks" data-ai="checks">
      <ChipRow label={CHECKS_LABEL}>
        {chips.map((c) => (
          <Chip key={c.key} text={c.label} onClick={() => p.onCheck(c.check)} />
        ))}
      </ChipRow>
    </div>
  );
}

/**
 * 返答の表（#234）。数字の列（class num）は右揃え・折り返さない、文字の列はセルの中で折り返す。入らなければ枠
 * （.ai-table）の中だけ横にスクロールし、続きのある側を data-more（start / end / both）で示す（CSS が端をぼかす）。
 * data-more は DOM の属性を直接書く（描き直しを起こさない。style 属性は使わない）。測るのは scroll と ResizeObserver
 * （枠と表。流れで行が増えたときも表の大きさの変化で届く）のときだけ（描画のたびに読まない）。はみ出しているときだけ
 * 枠をフォーカスできる名前つきの region にする（キーボードで横に動かせる）
 */
function AiTable(p: {
  table: Extract<MarkedBlock, { kind: 'table' }>;
  inl: (xs: MarkedInline[]) => ComponentChildren;
}) {
  const { ref, over, onScroll } = useScrollMore();
  const { table: t } = p;
  const cls = (j: number) => (t.num[j] ? 'num' : undefined);
  return (
    <div
      class="ai-table"
      ref={ref}
      onScroll={onScroll}
      {...(over && { tabIndex: 0, role: 'region', 'aria-label': TABLE_SCROLL_LABEL })}
    >
      <table>
        <thead>
          <tr>
            {t.head.map((c, j) => (
              <th key={j} scope="col" class={cls(j)}>
                {p.inl(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} class={cls(j)}>
                  {p.inl(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
