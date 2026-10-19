/**
 * AI の返答の文字列 → 段落・見出し・箇条書きの木（#135）。純関数。画面（ui/next/regions/AiChat.tsx）は JSX のテキストで
 * 描く（HTML を入れない・リンクを作らない。CSP と XSS）。扱う記法は `## ` / `### ` の見出し・`- ` / `* ` / `1. ` の
 * 箇条書き・空行の段落・`**太字**` だけ。それ以外はそのままの文字。
 *
 * 数字の印（照合できない数字）は inline の文字列ごとに ui/view/aiNumbers.ts の checkNumbers で付ける（markNumbers）。
 */

import { checkNumbers } from './aiNumbers';

export interface Inline {
  text: string;
  bold: boolean;
}

export type TextBlock =
  | { kind: 'h'; level: 2 | 3; inl: Inline[] }
  | { kind: 'p'; inl: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; items: Inline[][] };

/** `**太字**` だけを分ける（閉じていない `**` は文字のまま） */
export function inlineOf(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  for (;;) {
    const a = rest.indexOf('**');
    const b = a < 0 ? -1 : rest.indexOf('**', a + 2);
    if (a < 0 || b < 0) {
      if (rest !== '') out.push({ text: rest, bold: false });
      return out;
    }
    if (a > 0) out.push({ text: rest.slice(0, a), bold: false });
    if (b > a + 2) out.push({ text: rest.slice(a + 2, b), bold: true });
    rest = rest.slice(b + 2);
  }
}

/** 返答の文字列 → 木 */
export function parseAiText(text: string): TextBlock[] {
  const out: TextBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push({ kind: 'p', inl: inlineOf(para.join('\n')) });
    para = [];
  };
  for (const line of text.split('\n')) {
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*・]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ kind: 'h', level: (h[1] ?? '').length === 2 ? 2 : 3, inl: inlineOf(h[2] ?? '') });
    } else if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const item = inlineOf((ul ?? ol)?.[1] ?? '');
      const last = out.at(-1);
      if (last && last.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
    } else if (line.trim() === '') {
      flush();
    } else {
      // 1 行目の見出し記号 `#` だけ（`# `）も見出しにしない = 文字のまま
      para.push(line);
    }
  }
  flush();
  return out;
}

export interface MarkedText {
  text: string;
  /** 照合できない数字（道具の値に無い） */
  unmatched: boolean;
}

/** inline の文字列を、照合できない数字とそれ以外に分ける */
export function markNumbers(text: string, sources: readonly unknown[]): MarkedText[] {
  const r = checkNumbers(text, sources);
  const out: MarkedText[] = [];
  let at = 0;
  for (const t of r.tokens) {
    if (t.status !== 'unmatched') continue;
    if (t.start > at) out.push({ text: text.slice(at, t.start), unmatched: false });
    out.push({ text: text.slice(t.start, t.end), unmatched: true });
    at = t.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), unmatched: false });
  return out;
}

export type MarkedInline = { bold: boolean; parts: MarkedText[] };
export type MarkedBlock =
  | { kind: 'h'; level: 2 | 3; inl: MarkedInline[] }
  | { kind: 'p'; inl: MarkedInline[] }
  | { kind: 'ul' | 'ol'; items: MarkedInline[][] };

/**
 * 返答の木 + 照合の印（画面が描く形）。画面は返答ごとに (text, sources) で memo する = 流れの間に作り直すのは
 * 流れている返答だけ（終わった返答は text も sources も変わらない）
 */
export function answerModel(text: string, sources: readonly unknown[]): MarkedBlock[] {
  const mark = (xs: Inline[]): MarkedInline[] =>
    xs.map((x) => ({ bold: x.bold, parts: markNumbers(x.text, sources) }));
  return parseAiText(text).map((b): MarkedBlock => {
    if (b.kind === 'h') return { kind: 'h', level: b.level, inl: mark(b.inl) };
    if (b.kind === 'p') return { kind: 'p', inl: mark(b.inl) };
    return { kind: b.kind, items: b.items.map(mark) };
  });
}
