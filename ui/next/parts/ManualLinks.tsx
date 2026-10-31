import { HINT_GUIDE, type HintPlace } from '../../view/manual';
import { openManual } from './termCard';

/**
 * ⓘ の吹き出しの末尾の「マニュアル:」と節のボタン（#322。./TermLinks.tsx と同じ形）。押すと説明カードにその節を開く
 * （初めてならマニュアルを読み込む）。場所 → 節の表は ui/view/manual.ts の HINT_GUIDE。文字は JSX のテキストだけ
 */
export function ManualLinks({ place }: { place: HintPlace }) {
  const g = HINT_GUIDE[place];
  return (
    <p class="term-links">
      <span class="term-links-k">マニュアル:</span>
      <button
        type="button"
        class="term-link"
        data-manual-link={place}
        aria-label={`マニュアル: ${g.title}`}
        aria-haspopup="dialog"
        onClick={() => openManual(g.anchor)}
      >
        {g.title}
      </button>
    </p>
  );
}
