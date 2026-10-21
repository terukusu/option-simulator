/**
 * AI の返答の文字列 → 段落・見出し・箇条書き・表の木（#135・#234）。純関数。画面（ui/next/regions/AiChat.tsx）は JSX の
 * テキストで描く（HTML を入れない・外へのリンクを作らない。CSP と XSS）。扱う記法は `## ` / `### ` の見出し・`- ` /
 * `* ` / `1. ` の箇条書き・空行の段落・`**太字**`・`|` で始まる行の表（見出し + 区切り + 本文）だけ。それ以外はそのままの文字。
 *
 * 数字の印（照合できない数字）は inline の文字列ごとに ui/view/aiNumbers.ts の checkNumbers で付け（markNumbers）、
 * 用語集の用語の印（#232）は ui/view/aiTerms.ts の findTerms で返答ごとに最初の 1 回だけ付ける（answerModel）。
 */

import { checkNumbers } from './aiNumbers';
import { findTerms } from './aiTerms';
import type { TermId } from './glossary';

export interface Inline {
  text: string;
  bold: boolean;
}

export type TextBlock =
  | { kind: 'h'; level: 2 | 3; inl: Inline[] }
  | { kind: 'p'; inl: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; num: boolean[]; rows: Inline[][][] };

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

/** 表の行（`|` で始まる行） */
const ROW = /^\s*\|/;
/** 区切りのセル（`---`・`:--`・`--:`・`:-:`） */
const SEP_CELL = /^:?-+:?$/;
/** 数字の列のセル（符号・桁区切り・小数・全角 + 単位）。空・`—`・`-` は数えない */
const NUM_CELL =
  /^[+＋\-－−–▲△±]?\s*[\d０-９][\d０-９,，.．]*\s*(千円|万円|億円|円|%|％|pt|枚|倍|日)?$/;
const BLANK_CELL = /^(|—|-|－|−)$/;

/** 表の行 → セルの文字（先頭の `|` と末尾のエスケープでない `|` を外し、エスケープでない `|` で分ける。`\|` → `|`） */
export function tableCells(line: string): string[] {
  let s = line.trim().slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isSep = (line: string): boolean => {
  if (!ROW.test(line)) return false;
  const cs = tableCells(line);
  return cs.length > 0 && cs.every((c) => SEP_CELL.test(c));
};

/** 流れの途中（live）: 改行で終わらない最後の表の行と、区切りの来ていない見出しの行を除く */
function settledLines(text: string, live: boolean): string[] {
  const lines = text.split('\n');
  if (!live) return lines;
  const last = lines.at(-1) ?? '';
  if (last !== '' && ROW.test(last)) lines.pop();
  // 末尾の `|` の行の並び（最後の空の行 = 改行で終わった分は除いて数える）が 1 行だけ = 区切り待ちの見出し
  const e = lines.length - 1 - (lines.at(-1) === '' ? 1 : 0);
  let n = 0;
  while (e - n >= 0 && ROW.test(lines[e - n] ?? '')) n++;
  if (n === 1) lines.splice(e, 1);
  return lines;
}

/** 表の本文のセル（列ごと）が、すべて数か空で、数が 1 つ以上 */
function numericColumns(rows: Inline[][][], cols: number): boolean[] {
  return Array.from({ length: cols }, (_, j) => {
    let any = false;
    for (const r of rows) {
      const t = (r[j] ?? [])
        .map((x) => x.text)
        .join('')
        .trim();
      if (BLANK_CELL.test(t)) continue;
      if (!NUM_CELL.test(t)) return false;
      any = true;
    }
    return any;
  });
}

/**
 * 返答の文字列 → 木。live（流れの途中）は表の途中の行を出さない（settledLines）。崩れた表（区切りが無い・列数が
 * 合わない）の行は今までどおり段落の文字
 */
export function parseAiText(text: string, live = false): TextBlock[] {
  const out: TextBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push({ kind: 'p', inl: inlineOf(para.join('\n')) });
    para = [];
  };
  const lines = settledLines(text, live);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (ROW.test(line) && isSep(lines[i + 1] ?? '')) {
      // 表: 見出し + 区切り + 続く `|` の行。列数が合わなければ全部を段落の行に
      let j = i + 2;
      while (j < lines.length && ROW.test(lines[j] ?? '')) j++;
      const head = tableCells(line);
      const body = lines.slice(i + 2, j).map(tableCells);
      const cols = head.length;
      if (tableCells(lines[i + 1] ?? '').length === cols && body.every((r) => r.length === cols)) {
        flush();
        const rows = body.map((r) => r.map(inlineOf));
        out.push({
          kind: 'table',
          head: head.map(inlineOf),
          num: numericColumns(rows, cols),
          rows,
        });
      } else {
        para.push(...lines.slice(i, j));
      }
      i = j - 1;
      continue;
    }
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
  /** 照合できない数字（ツールの値に無い） */
  unmatched: boolean;
  /** 用語集の用語（#232。押すと説明カード。用語のときだけ） */
  term?: TermId;
}

/**
 * inline の文字列を、照合できない数字・用語（seen を渡したときだけ。seen に無い用語の最初の 1 回）とそれ以外に分ける。
 * 用語は数値トークン（照合の印を含む）と重ならない
 */
export function markInline(
  text: string,
  sources: readonly unknown[],
  seen: Set<TermId> | null,
): MarkedText[] {
  const tokens = checkNumbers(text, sources).tokens;
  const terms = seen ? findTerms(text, seen, tokens) : [];
  const marks = [
    ...tokens
      .filter((t) => t.status === 'unmatched')
      .map((t) => ({ start: t.start, end: t.end, term: undefined as TermId | undefined })),
    ...terms.map((t) => ({ start: t.start, end: t.end, term: t.id as TermId | undefined })),
  ].sort((a, b) => a.start - b.start);
  const out: MarkedText[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start > at) out.push({ text: text.slice(at, m.start), unmatched: false });
    const t = text.slice(m.start, m.end);
    out.push(m.term ? { text: t, unmatched: false, term: m.term } : { text: t, unmatched: true });
    at = m.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), unmatched: false });
  return out;
}

/** inline の文字列を、照合できない数字とそれ以外に分ける */
export function markNumbers(text: string, sources: readonly unknown[]): MarkedText[] {
  return markInline(text, sources, null);
}

export type MarkedInline = { bold: boolean; parts: MarkedText[] };
export type MarkedBlock =
  | { kind: 'h'; level: 2 | 3; inl: MarkedInline[] }
  | { kind: 'p'; inl: MarkedInline[] }
  | { kind: 'ul' | 'ol'; items: MarkedInline[][] }
  | { kind: 'table'; head: MarkedInline[][]; num: boolean[]; rows: MarkedInline[][][] };

/**
 * 返答の木 + 照合の印 + 用語の印（画面が描く形）。画面は返答ごとに (text, sources, live) で memo する = 流れの間に
 * 作り直すのは流れている返答だけ（終わった返答は text も sources も変わらない）。用語は返答の中で読む順に最初の 1 回
 * だけ（見出しには付けない。表は見出しの行 → 本文の行）
 */
export function answerModel(
  text: string,
  sources: readonly unknown[],
  live = false,
): MarkedBlock[] {
  const seen = new Set<TermId>();
  const mark = (xs: Inline[], link = true): MarkedInline[] =>
    xs.map((x) => ({ bold: x.bold, parts: markInline(x.text, sources, link ? seen : null) }));
  return parseAiText(text, live).map((b): MarkedBlock => {
    if (b.kind === 'h') return { kind: 'h', level: b.level, inl: mark(b.inl, false) };
    if (b.kind === 'p') return { kind: 'p', inl: mark(b.inl) };
    if (b.kind === 'table') {
      const head = b.head.map((c) => mark(c));
      return { kind: 'table', head, num: b.num, rows: b.rows.map((r) => r.map((c) => mark(c))) };
    }
    return { kind: b.kind, items: b.items.map((x) => mark(x)) };
  });
}
