import { type AiAsk, type AiAskTopic, ASK_BUTTON_TEXT } from '../../view/aiAsk';
import { askAi } from './aiAsk';
import { closeOverlay } from './overlay';

/**
 * [AI に聞く] のボタン（#136。docs/ui-redesign.md §5）。指標のタイル・読み取りの全文の吹き出しの末尾、テール表の見出しの
 * 行、IV 推移のツールの行に置く。質問の文（ui/view/aiAsk.ts）は押したときに make で作る（描くたびに作らない）。
 * 押すと開いている吹き出しを閉じ（./overlay.ts）、./aiAsk.ts の口へ渡す（NextApp が AI のパネルを開いて送る）。
 * short: 狭い枠では文字を「AI に」に縮める（.ask-long をコンテナクエリで隠す。読み上げ名は常に全文。#277: ドックの
 * [AI]（パネルを開く）と同じ字にしない）
 */
export function AskAi(p: {
  topic: AiAskTopic;
  /** 何を聞くか（読み上げ名「<label>を AI に聞く」） */
  label: string;
  make: () => AiAsk | null;
  short?: boolean;
}) {
  return (
    <button
      type="button"
      class={p.short ? 'btn sm ai-ask short' : 'btn sm ai-ask'}
      data-ai-ask={p.topic}
      aria-label={`「${p.label}」を${ASK_BUTTON_TEXT}`}
      title={`「${p.label}」を${ASK_BUTTON_TEXT}`}
      onClick={() => {
        const a = p.make();
        if (!a) return;
        closeOverlay();
        askAi(a);
      }}
    >
      {p.short ? (
        <>
          <span>AI に</span>
          <span class="ask-long">聞く</span>
        </>
      ) : (
        <span>{ASK_BUTTON_TEXT}</span>
      )}
    </button>
  );
}
