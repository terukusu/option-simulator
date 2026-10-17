import type { MarketPillModel, PillFull, PillTag } from '../../view/marketPill';
import { visibleTags } from '../../view/marketPill';
import type { Tier } from '../../view/shell';
import { Popover } from '../parts/Popover';

/**
 * ピルに見せるタグの数（幅の段階で固定。残りは +N。docs/ui-redesign.md §2.1）。タブレットは BOX タブの帯を入れるため 1
 * （#87 (B)。最も混む作業で作業中のチップが帯に入る幅）
 */
const TAG_MAX: Record<Exclude<Tier, 'phone'>, number> = { pc: 3, tablet: 1 };

const Tag = ({ t }: { t: { label: string; warn: boolean } }) => (
  <span class={t.warn ? 'tag warn' : 'tag'}>{t.label}</span>
);

/** `F 67,810` → F <b>67,810</b>（値だけ太字） */
function Val({ s }: { s: string }) {
  const i = s.indexOf(' ');
  return i < 0 ? (
    <b>{s}</b>
  ) : (
    <>
      {s.slice(0, i)} <b>{s.slice(i + 1)}</b>
    </>
  );
}

function Summary({ m, tier, noTag }: { m: MarketPillModel; tier: Tier; noTag: boolean }) {
  const dot = <span class={m.warn ? 'dot warn' : 'dot'} aria-hidden="true" />;
  if (tier === 'phone') {
    return (
      <>
        {dot}
        <span class="when">{m.clock}</span>
        {m.shortTag && !noTag && <span class="tag warn">{m.shortTag.short}</span>}
      </>
    );
  }
  const { shown, more } = visibleTags(m.tags, TAG_MAX[tier]);
  const vals = m.values
    ? [m.values.f, m.values.atm, m.values.future].filter((s) => s !== null)
    : [];
  return (
    <>
      {dot}
      <span class="when">{m.time}</span>
      {shown.map((t: PillTag) => (
        <Tag key={t.key} t={t} />
      ))}
      {more > 0 && <span class="tag more">+{more}</span>}
      {vals.length > 0 && (
        <span class="vals">
          {vals.map((s, i) => (
            <span key={s}>
              {i > 0 && ' · '}
              <Val s={s} />
            </span>
          ))}
        </span>
      )}
    </>
  );
}

/** ポップオーバーの中身（旧 Header の全部 + 前提の ⓘ の文 + 表示中 + 失敗の詳細）。値はすべて JSX のテキスト */
function Full({ f }: { f: PillFull }) {
  return (
    <div class="pill-full">
      {f.notice && <p class={f.notice.warn ? 'pf-note warn' : 'pf-note'}>{f.notice.text}</p>}
      {f.rows.length > 0 && (
        <dl class="pf-rows">
          {f.rows.map((r) => (
            <div class="pf-row" key={r.k}>
              <dt>{r.k}</dt>
              <dd>
                <span class="v">{r.v}</span>
                {r.note && <span class="nt">{r.note}</span>}
                {r.tags.map((t) => (
                  <Tag key={t.label} t={t} />
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {f.reasonNote && <p class="pf-note">{f.reasonNote}</p>}
      {f.months.map((m) => (
        <section
          class={m.current ? 'pf-month cur' : 'pf-month'}
          key={m.id}
          aria-current={m.current ? 'true' : undefined}
          aria-label={m.title}
        >
          <p class="pf-mh">
            <b>{m.title}</b> <span class="nt">{m.dates}</span>
          </p>
          <p class="pf-line">
            <span class="v">{m.forward}</span> <Tag t={m.forwardKind} />
          </p>
          {m.refs.map((r) => (
            <p class={r.active ? 'pf-line act' : 'pf-line'} key={r.label}>
              {r.label} <span class="v">{r.price}</span>
              {r.time && <span class="nt">（{r.time}）</span>}
              {r.tags.map((t) => (
                <Tag key={t.label} t={t} />
              ))}
            </p>
          ))}
          <p class="pf-line">
            {m.atmLabel} <b class={m.noAtm ? 'v warn' : 'v'}>{m.atm}</b>
          </p>
        </section>
      ))}
      {f.assumptions.length > 0 && (
        <>
          <p class="pf-sub">前提</p>
          <ul class="pf-list">
            {f.assumptions.map((a) => (
              <li key={a.text} class={a.warn ? 'warn' : undefined}>
                {a.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {f.hint && <p class="pf-note">{f.hint}</p>}
      {f.loaderNote && <p class="pf-note">{f.loaderNote}</p>}
      {f.error && (
        <div class="pf-error" role="alert">
          <p>
            {f.error.message}
            {f.error.kept && `。${f.error.kept}`}
          </p>
          {f.error.errors.length > 0 && (
            <ul>
              {f.error.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 市場ピル（#87。docs/ui-redesign.md §2.1・§3）。要約をボタンに、全文をポップオーバーに。
 * 表示モデルは ui/view/marketPill.ts（NextApp の useMemo）。data-state は読み込みの状態（ui:check が待つ）。
 * noTag（#87 (B)）: スマホで警告のタグがあるときは短縮形のタグを出さない（`● HH:mm` だけ。BOX タブの帯を 360px に
 * 入れるため。● の色・aria-label・ポップオーバーの全文は変えない）。
 */
export function MarketPill({
  m,
  tier,
  noTag = false,
}: {
  m: MarketPillModel;
  tier: Tier;
  noTag?: boolean;
}) {
  return (
    <div class="pill" data-state={m.state}>
      <Popover
        label={m.summary}
        buttonClass={tier === 'phone' ? 'market-pill mini' : 'market-pill'}
        popClass="wide"
        button={<Summary m={m} tier={tier} noTag={noTag} />}
      >
        <Full f={m.full} />
      </Popover>
    </div>
  );
}
