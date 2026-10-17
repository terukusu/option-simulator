import type { WarnTagKind, WarnTagsModel } from '../../view/notices';
import type { Tier } from '../../view/shell';
import { Popover } from '../parts/Popover';

/**
 * トップバーの警告のタグ（#87。docs/ui-redesign.md §3「自動保存の知らせ」）: 保存できない / 別のタブ / 新しい版。
 * 押すと全文と [閉じる]（c.closeNote）。スマホは先頭の 1 つ + `+N`。表示モデルは ui/view/notices.ts の warnTagsModel。
 */
export function WarnTags({
  m,
  tier,
  onClose,
}: {
  m: WarnTagsModel;
  tier: Tier;
  onClose: (kind: WarnTagKind) => void;
}) {
  const shown = tier === 'phone' ? m.tags.slice(0, 1) : m.tags;
  const more = m.tags.length - shown.length;
  return (
    <div class="warn-tags">
      <Popover
        label={m.label}
        buttonClass="warn-btn"
        popClass="wide"
        button={
          <>
            {shown.map((t) => (
              <span class="tag warn" key={t.kind}>
                {t.label}
              </span>
            ))}
            {more > 0 && <span class="tag warn more">+{more}</span>}
          </>
        }
      >
        <div class="warn-full">
          {m.tags.map((t) => (
            <div class="warn-note" key={t.kind}>
              <p>
                <span class="tag warn">{t.label}</span> {t.text}
              </p>
              <button
                type="button"
                class="btn sm"
                aria-label={`${t.label}の知らせを閉じる`}
                onClick={() => onClose(t.kind)}
              >
                閉じる
              </button>
            </div>
          ))}
        </div>
      </Popover>
    </div>
  );
}
