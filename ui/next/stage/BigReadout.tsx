import { askReadout, READOUT_TOPIC } from '../../view/aiAsk';
import type { BigReadoutItem } from '../../view/stage';
import { AskAi } from '../parts/AskAi';
import { FullText } from '../parts/FullText';
import { Popover } from '../parts/Popover';

/** 見出し・値・副題（ボタンの中は span、押せない項目は div。クラスは同じ） */
function Body({ it, inline }: { it: BigReadoutItem; inline: boolean }) {
  // Δ はラージを値、括弧のミニを小さく（「+0.32 (+3.2)」→ +0.32 と (+3.2)）
  const cut = it.key === 'delta' ? it.value.indexOf(' (') : -1;
  const main = cut > 0 ? it.value.slice(0, cut) : it.value;
  const small = cut > 0 ? it.value.slice(cut + 1) : it.unit;
  const vCls = it.tone ? `v ${it.tone}` : 'v';
  const value = (
    <>
      <span>{main}</span>
      {small && <small>{small}</small>}
    </>
  );
  return inline ? (
    <>
      <span class="k">{it.label}</span>
      <span class={vCls}>{value}</span>
      <span class="s">{it.sub}</span>
    </>
  ) : (
    <>
      <div class="k">{it.label}</div>
      <div class={vCls}>{value}</div>
      <div class="s">{it.sub}</div>
    </>
  );
}

/** 全文の末尾の [AI に聞く]（#136。場所の無い項目は出さない） */
function ReadoutAsk({ it }: { it: BigReadoutItem }) {
  const topic = READOUT_TOPIC[it.key];
  if (!topic) return null;
  return (
    <div class="pop-ask">
      <AskAi topic={topic} label={it.label} make={() => askReadout(it)} />
    </div>
  );
}

/**
 * 読み取り（大きな数字。docs/ui-redesign.md §2・§5・§5.2。#82）。項目と文字列は ui/view/stage.ts の bigReadout。
 * 出す個数は舞台の幅のコンテナクエリ（< 480px は base の 3 つ、480〜599px は + x1、≥ 600px は + x2）。
 * 値は折り返さず切らない、見出し・副題は省略記号。ドラッグ中に読み上げが続くので aria-live は付けない。
 * 全文（full）のある項目はタップ / Enter / Space で全文のポップオーバー（上に開く。#107）。
 * mini（スマホでシートを全開にした舞台）は押せない（§4.1「ミニは操作を受けない」）。全文の末尾に [AI に聞く]（#136）。
 */
export function BigReadout({
  items,
  mini = false,
}: {
  items: readonly BigReadoutItem[];
  mini?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と grid の癖があるので div + role="group"
    <div class="readout" role="group" aria-label="シナリオ点の値">
      {items.map((it) => {
        const cls = `ro${it.hero ? ' hero' : ''}${it.tier === 'base' ? '' : ` ${it.tier}`}`;
        return (
          <div class={cls} data-ro={it.key} key={it.key}>
            {it.full && !mini ? (
              <Popover
                buttonClass="ro-btn"
                up
                within=".panel-body"
                button={<Body it={it} inline />}
              >
                <FullText rows={it.full} />
                <ReadoutAsk it={it} />
              </Popover>
            ) : (
              <Body it={it} inline={false} />
            )}
          </div>
        );
      })}
    </div>
  );
}
