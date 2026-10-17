import type { BigReadoutItem } from '../../view/stage';

/**
 * 読み取り（大きな数字。docs/ui-redesign.md §2・§5・§5.2。#82）。項目と文字列は ui/view/stage.ts の bigReadout。
 * 出す個数は舞台の幅のコンテナクエリ（< 480px は base の 3 つ、480〜599px は + x1、≥ 600px は + x2）。
 * 値は折り返さず切らない、見出し・副題は省略記号。ドラッグ中に読み上げが続くので aria-live は付けない。
 */
export function BigReadout({ items }: { items: readonly BigReadoutItem[] }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と grid の癖があるので div + role="group"
    <div class="readout" role="group" aria-label="シナリオ点の値">
      {items.map((it) => {
        // Δ はラージを値、括弧のミニを小さく（「+0.32 (+3.2)」→ +0.32 と (+3.2)）
        const cut = it.key === 'delta' ? it.value.indexOf(' (') : -1;
        const main = cut > 0 ? it.value.slice(0, cut) : it.value;
        const small = cut > 0 ? it.value.slice(cut + 1) : it.unit;
        const cls = `ro${it.hero ? ' hero' : ''}${it.tier === 'base' ? '' : ` ${it.tier}`}`;
        return (
          <div class={cls} data-ro={it.key} key={it.key}>
            <div class="k">{it.label}</div>
            <div class={it.tone ? `v ${it.tone}` : 'v'}>
              <span>{main}</span>
              {small && <small>{small}</small>}
            </div>
            <div class="s">{it.sub}</div>
          </div>
        );
      })}
    </div>
  );
}
