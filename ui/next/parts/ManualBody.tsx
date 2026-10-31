import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import {
  type ManualBlock,
  type ManualIndex,
  type ManualInline,
  type ManualSection,
  manualBlocks,
  sectionPath,
  tocModel,
} from '../../view/manual';
import { resolveManualRef } from '../../view/manualRefs';
import type { CardEntry } from '../../view/termChain';
import type { ManualState } from './manualDoc';
import { useScrollMore } from './scrollMore';
import { openManual, openToc } from './termCard';

/**
 * 説明カードの中のマニュアル（#322。docs/ui-redesign.md §5「説明カード」）: 節の本文・目次・AI の根拠の節。
 * 木は ui/view/manual.ts の純関数で作り、ここは JSX のテキストで描くだけ（HTML 文字列・style・href を使わない）。
 * 節の中のリンク・目次の行はボタン（押すと説明カードの列に積む）。表とコードブロックは枠の中だけ横にスクロールする。
 */

export const MANUAL_LOADING_TEXT = '読み込み中';
export const MANUAL_ERROR_TEXT = 'マニュアルを読み込めませんでした。ページを読み直してください';
export const MANUAL_NOT_FOUND_TEXT = 'マニュアルに見つからない';
const TABLE_SCROLL_LABEL = '表（横にスクロール）';
const CODE_SCROLL_LABEL = 'コード（横にスクロール）';

export function ManualContent({
  entry,
  manual,
}: {
  entry: Exclude<CardEntry, { kind: 'term' }>;
  manual: ManualState;
}) {
  if (manual.status === 'error')
    return (
      <p class="tc-status" role="alert">
        {MANUAL_ERROR_TEXT}
      </p>
    );
  if (manual.status !== 'ready')
    return (
      <p class="tc-status" role="status">
        {MANUAL_LOADING_TEXT}
      </p>
    );
  const { index } = manual;
  if (entry.kind === 'toc') return <ManualToc index={index} />;
  const sec =
    entry.kind === 'manual'
      ? (index.byAnchor.get(entry.anchor) ?? null)
      : resolveManualRef(index, entry);
  if (sec === null) {
    const what = entry.kind === 'ref' && entry.title !== null ? `「${entry.title}」` : '';
    return (
      <>
        <p class="tc-status" role="status">
          {MANUAL_NOT_FOUND_TEXT}
          {entry.kind === 'ref' ? `: ${entry.id}${what}` : ''}
        </p>
        <TocLink />
      </>
    );
  }
  // 節ごとに作り直す（key）: 同じ添字の表・コードの枠の横の位置・data-more・region を前の節から引き継がない
  return <ManualSectionBody key={sec.anchor} sec={sec} index={index} />;
}

/** 節の末尾の [目次] */
function TocLink() {
  return (
    <p class="tc-toc-link">
      <button type="button" class="term-link" onClick={openToc}>
        目次
      </button>
    </p>
  );
}

function ManualSectionBody({ sec, index }: { sec: ManualSection; index: ManualIndex }) {
  const blocks = useMemo(
    () => manualBlocks(sec.body, sec.level, index, sec.headAnchors),
    [sec, index],
  );
  return (
    <div class="tc-manual">
      <p class="tc-reading">{sectionPath(sec, index)}</p>
      {blocks.map((b, i) => (
        // ブロックは毎回同じ順（並べ替えない）
        <Block key={i} b={b} />
      ))}
      <TocLink />
    </div>
  );
}

function Inl({ xs }: { xs: readonly ManualInline[] }): ComponentChildren {
  return xs.map((x, i) => {
    if ('anchor' in x) {
      const { anchor } = x;
      return (
        <button
          key={i}
          type="button"
          class="tc-link"
          aria-haspopup="dialog"
          onClick={() => openManual(anchor)}
        >
          {x.label.map((l, j) => (
            <Span key={j} s={l} />
          ))}
        </button>
      );
    }
    return <Span key={i} s={x} />;
  });
}

function Span({ s }: { s: { text: string; bold: boolean; code: boolean } }) {
  const t = s.code ? <code>{s.text}</code> : s.text;
  return s.bold ? <strong>{t}</strong> : t;
}

function Block({ b }: { b: ManualBlock }) {
  switch (b.kind) {
    case 'h': {
      const H = `h${b.level}` as 'h3' | 'h4' | 'h5' | 'h6';
      return <H>{b.text}</H>;
    }
    case 'p':
      return (
        <p>
          <Inl xs={b.inl} />
        </p>
      );
    case 'ul':
    case 'ol': {
      const items = b.items.map((x, j) => (
        <li key={j}>
          <Inl xs={x.inl} />
          {x.sub !== null &&
            (x.sub.kind === 'ul' ? (
              <ul>
                {x.sub.items.map((y, k) => (
                  <li key={k}>
                    <Inl xs={y} />
                  </li>
                ))}
              </ul>
            ) : (
              <ol>
                {x.sub.items.map((y, k) => (
                  <li key={k}>
                    <Inl xs={y} />
                  </li>
                ))}
              </ol>
            ))}
        </li>
      ));
      return b.kind === 'ul' ? (
        <ul>{items}</ul>
      ) : (
        <ol {...(b.start !== 1 && { start: b.start })}>{items}</ol>
      );
    }
    case 'table':
      return (
        <Scroller cls="tc-table" label={TABLE_SCROLL_LABEL}>
          <table>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} scope="col">
                    <Inl xs={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>
                      <Inl xs={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      );
    case 'code':
      return (
        <Scroller cls="tc-code" label={CODE_SCROLL_LABEL}>
          <pre>{b.lines.join('\n')}</pre>
        </Scroller>
      );
    case 'hr':
      return <hr />;
  }
}

/**
 * 横にスクロールする枠（AI の返答の表 #234 と同じ ./scrollMore.ts の useScrollMore）: 続きのある側を data-more で示し、
 * はみ出しているときだけフォーカスできる名前つきの region にする
 */
function Scroller(p: { cls: string; label: string; children: ComponentChildren }) {
  const { ref, over, onScroll } = useScrollMore();
  return (
    <div
      class={p.cls}
      ref={ref}
      onScroll={onScroll}
      {...(over && { tabIndex: 0, role: 'region', 'aria-label': p.label })}
    >
      {p.children}
    </div>
  );
}

/** 目次: 章（太字のボタン）と、その中の節のボタン */
function ManualToc({ index }: { index: ManualIndex }) {
  const toc = useMemo(() => tocModel(index), [index]);
  return (
    <ul class="tc-toc">
      {toc.map((c) => (
        <li key={c.anchor} class="tc-toc-ch-row">
          <button
            type="button"
            class="tc-link tc-toc-ch"
            aria-haspopup="dialog"
            onClick={() => openManual(c.anchor)}
          >
            {c.label}
          </button>
          {c.items.length > 0 && (
            <ul class="tc-toc-sub">
              {c.items.map((s) => (
                <li key={s.anchor} class={s.level === 4 ? 'tc-toc-4' : undefined}>
                  <button
                    type="button"
                    class="tc-link"
                    aria-haspopup="dialog"
                    onClick={() => openManual(s.anchor)}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
