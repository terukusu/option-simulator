import { type TermId, termById } from '../../view/glossary';
import { openTerm } from './termCard';

/**
 * ⓘ の吹き出しの末尾の「用語:」と用語のボタン（#167）。押すと説明カード（TermCard）を開く。
 * ボタンの文字は用語の短い形（Δs など）、読み上げの名前は「用語: <見出し>」。文字は JSX のテキストだけ
 */
export function TermLinks({ ids }: { ids: readonly TermId[] }) {
  return (
    <p class="term-links">
      <span class="term-links-k">用語:</span>
      {ids.map((id) => {
        const t = termById(id);
        if (!t) return null;
        return (
          <button
            key={id}
            type="button"
            class="term-link"
            aria-label={`用語: ${t.title}`}
            aria-haspopup="dialog"
            onClick={() => openTerm(id)}
          >
            {t.short}
          </button>
        );
      })}
    </p>
  );
}
