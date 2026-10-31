/**
 * AI の返答の文字列 → 段落・見出し・箇条書き・表の木（#135・#234）。純関数。画面（ui/next/regions/AiChat.tsx）は JSX の
 * テキストで描く（HTML を入れない・外へのリンクを作らない。CSP と XSS）。扱う記法は `## ` / `### ` の見出し・`- ` /
 * `* ` / `1. ` の箇条書き・空行の段落・`**太字**`・`|` で始まる行の表（見出し + 区切り + 本文）だけ。それ以外はそのままの文字。
 *
 * 数字の印（照合できない数字）は inline の文字列ごとに ui/view/aiNumbers.ts の checkNumbers で付け（markNumbers）、
 * 用語集の用語の印（#232）は ui/view/aiTerms.ts の findTerms で返答ごとに最初の 1 回だけ付ける（answerModel）。
 * マニュアルの根拠の節の印（#322）は ui/view/manualRefs.ts の docRefs で付ける（answerModel。見出しにも付ける）。
 */

import { checkNumbers } from './aiNumbers';
import { findTerms } from './aiTerms';
import type { TermId } from './glossary';
import { docRefs } from './manualRefs';

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

/** 表の行（`|` で始まり、`|` のほかに文字のある行。`|` だけの行は表の行にしない） */
const ROW = /^\s*\|(?!\s*$)/;
/** 流れの途中の書きかけの表の行（`|` だけの行を含む） */
const ROW_START = /^\s*\|/;
/** 区切りのセル（`---`・`:--`・`--:`・`:-:`） */
const SEP_CELL = /^:?-+:?$/;
/** 数字の列のセル（符号・桁区切り・小数・全角 + 単位）。空・`—`・`-` は数えない */
const NUM_CELL =
  /^[+＋\-－−–▲△±]?\s*[\d０-９][\d０-９,，.．]*\s*(千円|万円|億円|円|%|％|pt|枚|倍|日)?$/;
const BLANK_CELL = /^(|—|-|－|−)$/;

/**
 * 表の行 → セルの文字。先頭の `|` を外し、エスケープでない・コード（`…`。閉じているときだけ）の外の `|` で分け、
 * 末尾がその `|` なら最後の空のセルを外す。`\|` はセルの `|`（コードの中も）
 */
export function tableCells(line: string): string[] {
  const s = line.trim().slice(1);
  const cells: string[] = [];
  let cur = '';
  let code = false;
  let endsWithSep = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    endsWithSep = false;
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`' && (code || s.indexOf('`', i + 1) >= 0)) {
      code = !code;
      cur += c;
    } else if (c === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
      endsWithSep = true;
    } else {
      cur += c;
    }
  }
  if (!endsWithSep) cells.push(cur.trim());
  return cells;
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
  if (last !== '' && ROW_START.test(last)) lines.pop();
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
 * 返答の文字列 → 木。live（流れの途中）は表の途中の行を出さない（settledLines）。崩れた表（区切りが無い・見出しと
 * 区切りの列数が合わない）の行は今までどおり段落の文字。本文の列数の合わない行から後は表の後の段落の文字
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
      // 表: 見出し + 区切り + 続く `|` の行。見出しと区切りの列数が合わなければ全部を段落の行に。本文は列数の
      // 合う行まで（合わない行 = 途中で切れた最後の行・崩れた行から後の `|` の行は表の後の段落の文字）
      let j = i + 2;
      while (j < lines.length && ROW.test(lines[j] ?? '')) j++;
      const head = tableCells(line);
      const cols = head.length;
      if (tableCells(lines[i + 1] ?? '').length === cols) {
        const body: string[][] = [];
        let k = i + 2;
        for (; k < j; k++) {
          const r = tableCells(lines[k] ?? '');
          if (r.length !== cols) break;
          body.push(r);
        }
        flush();
        const rows = body.map((r) => r.map(inlineOf));
        out.push({
          kind: 'table',
          head: head.map(inlineOf),
          num: numericColumns(rows, cols),
          rows,
        });
        para.push(...lines.slice(k, j));
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
  /**
   * マニュアルの根拠の節（#322。押すと説明カードにその節。番号と「」の中の見出し。節が在るかは押したときに引く）。
   * 設計書の節は付けない（文字のまま）
   */
  manual?: { id: string; title: string | null };
}

type Mark = { start: number; end: number; term?: TermId; manual?: MarkedText['manual'] };

/**
 * inline の文字列を、照合できない数字・用語（seen を渡したときだけ。seen に無い用語の最初の 1 回）・マニュアルの根拠の節
 * （refs のときだけ。ui/view/manualRefs.ts）とそれ以外に分ける。用語は数値トークン（照合の印を含む）・根拠の節と重ならない
 */
export function markInline(
  text: string,
  sources: readonly unknown[],
  seen: Set<TermId> | null,
  refs = false,
): MarkedText[] {
  const tokens = checkNumbers(text, sources).tokens;
  const docs = refs ? docRefs(text).filter((r) => r.doc === 'manual') : [];
  const inDoc = (t: { start: number; end: number }) =>
    docs.some((r) => t.start < r.end && r.start < t.end);
  // 根拠の節の範囲は用語の語の探索から外す（トークンと同じ扱い。ボタンの中にボタンを作らない）
  const skip =
    docs.length === 0
      ? tokens
      : [...tokens.filter((t) => !inDoc(t)), ...docs].sort((a, b) => a.start - b.start);
  const consumed: { start: number; end: number }[] = [];
  const terms = seen ? findTerms(text, seen, skip, consumed).filter((t) => !inDoc(t)) : [];
  // 用語の語が丸ごと含んだ数値トークン（「30 日固定」の「30 日」）は照合の印にしない
  const inTerm = (t: { start: number; end: number }) =>
    consumed.some((c) => c.start <= t.start && t.end <= c.end);
  const marks: Mark[] = [
    ...tokens
      .filter((t) => t.status === 'unmatched' && !inTerm(t) && !inDoc(t))
      .map((t) => ({ start: t.start, end: t.end })),
    ...terms.map((t) => ({ start: t.start, end: t.end, term: t.id })),
    ...docs.map((r) => ({ start: r.start, end: r.end, manual: { id: r.id, title: r.title } })),
  ].sort((a, b) => a.start - b.start);
  const out: MarkedText[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start > at) out.push({ text: text.slice(at, m.start), unmatched: false });
    const t = text.slice(m.start, m.end);
    if (m.term) out.push({ text: t, unmatched: false, term: m.term });
    else if (m.manual) out.push({ text: t, unmatched: false, manual: m.manual });
    else out.push({ text: t, unmatched: true });
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
 * 返答の木 + 照合の印 + 用語の印 + マニュアルの根拠の節の印（画面が描く形）。画面は返答ごとに (text, sources, live) で memo する = 流れの間に
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
    xs.map((x) => ({ bold: x.bold, parts: markInline(x.text, sources, link ? seen : null, true) }));
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
