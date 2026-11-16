/**
 * AI のチャットの添付の部品（#369 = docs/adr-0010-ai-chat-attachments.md。docs/ui-redesign.md 2 章）。送る前の添付の
 * チップの行（入力欄の上。横スクロール）・送る前の注意の 1 文・会話の吹き出しのチップ。規則は ui/view/aiAttach.ts。
 *
 * 画像の縮小は送る base64 → Blob → createImageBitmap → canvas に描いて bitmap を閉じる（<img>・blob / data URL を DOM に
 * 入れない = CSP の img-src 'self' のまま）。名前・字数は JSX のテキストだけ。style 属性を使わない
 */

import { useLayoutEffect, useRef } from 'preact/hooks';
import type { AiImageMediaType } from '../../../data/aiStream';
import {
  type AiAttachment,
  ATTACH_NOTE_TEXT,
  type AttachView,
  charsText,
  DETACHED_LABEL,
  textTypeLabel,
} from '../../view/aiAttach';
import { sizeText } from '../../view/imageScale';
import { Icon } from '../parts/Icon';

/** 縮小画像の箱（CSS px。.ai-att-thumb と同じ） */
const THUMB_W = 36;
const THUMB_H = 24;

function b64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 送る画像の縮小（canvas。描いたら bitmap を閉じる） */
export function AttachThumb(p: { mediaType: AiImageMediaType; data: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof createImageBitmap === 'undefined') return;
    let alive = true;
    let blob: Blob;
    try {
      blob = new Blob([b64Bytes(p.data) as BlobPart], { type: p.mediaType });
    } catch {
      return;
    }
    createImageBitmap(blob)
      .then((bmp) => {
        if (alive) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          el.width = Math.round(THUMB_W * dpr);
          el.height = Math.round(THUMB_H * dpr);
          const s = Math.min(el.width / bmp.width, el.height / bmp.height);
          const w = bmp.width * s;
          const h = bmp.height * s;
          const ctx = el.getContext('2d');
          ctx?.clearRect(0, 0, el.width, el.height);
          ctx?.drawImage(bmp, (el.width - w) / 2, (el.height - h) / 2, w, h);
        }
        bmp.close();
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [p.mediaType, p.data]);
  return (
    <canvas
      ref={ref}
      class="ai-att-thumb"
      width={THUMB_W}
      height={THUMB_H}
      role="img"
      aria-label="添付の画像"
    />
  );
}

/** 送る前の添付のチップの行（[外す] つき）と、断った理由・注意の 1 文 */
export function AttachPending(p: {
  items: readonly AiAttachment[];
  onRemove: (id: string) => void;
  /** 最後の 1 つを外したときにフォーカスを移す先（入力欄） */
  focusAfterEmpty?: () => void;
}) {
  // [外す] の後のフォーカス（WCAG 2.4.3）: 外したボタンがチップごと消えて body に落ちないよう、同じ位置（無ければ 1 つ前）の
  // [外す]、チップが 0 になったら入力欄へ移す。押したときにフォーカスがそのボタンにあったときだけ（マウスで押したときも同じ）
  const row = useRef<HTMLUListElement>(null);
  const removed = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = removed.current;
    if (at === null) return;
    removed.current = null;
    const btns = row.current?.querySelectorAll<HTMLButtonElement>(
      'button[data-ai="attach-remove"]',
    );
    const next = btns && btns.length > 0 ? btns[Math.min(at, btns.length - 1)] : undefined;
    if (next) next.focus();
    else p.focusAfterEmpty?.();
  }, [p.items]);
  if (p.items.length === 0) return null;
  return (
    <>
      <ul class="ai-att-row" data-ai="attach" aria-label="送る添付" ref={row}>
        {p.items.map((a, i) => (
          <li key={a.id} class="ai-att" data-kind={a.kind}>
            {a.kind === 'image' ? (
              <AttachThumb mediaType={a.mediaType} data={a.base64} />
            ) : (
              <span class="ai-att-type">{textTypeLabel(a.mediaType)}</span>
            )}
            <span class="ai-att-name" title={a.name}>
              {a.name}
            </span>
            <span class="ai-att-meta">
              {a.kind === 'image' ? sizeText(a.bytes) : charsText(a.text.length)}
            </span>
            <button
              type="button"
              class="btn ghost icon sm ai-att-remove"
              data-ai="attach-remove"
              aria-label={`${a.name} を外す`}
              title="外す"
              onClick={(e) => {
                if (document.activeElement === e.currentTarget) removed.current = i;
                p.onRemove(a.id);
              }}
            >
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ul>
      <p class="ai-att-note" data-ai="attach-note">
        {ATTACH_NOTE_TEXT}
      </p>
    </>
  );
}

/** 会話の吹き出しの添付のチップ（画像は縮小、テキストは名前・種類・字数、外れたものは印） */
export function AttachBubble(p: { views: readonly AttachView[] }) {
  if (p.views.length === 0) return null;
  return (
    <ul class="ai-att-row msg" aria-label="添付">
      {p.views.map((v) => (
        <li key={v.key} class="ai-att" data-kind={v.kind}>
          {v.kind === 'image' && (
            <>
              <AttachThumb mediaType={v.mediaType} data={v.data} />
              <span class="ai-att-name">画像</span>
            </>
          )}
          {v.kind === 'text' && (
            <>
              <span class="ai-att-type">{v.type}</span>
              <span class="ai-att-name" title={v.name}>
                {v.name}
              </span>
              <span class="ai-att-meta">{charsText(v.chars)}</span>
            </>
          )}
          {v.kind === 'detached' && <span class="ai-att-name">{DETACHED_LABEL}</span>}
        </li>
      ))}
    </ul>
  );
}
