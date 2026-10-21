/**
 * AI の返答の中の用語集の用語（#232）。純関数（DOM・Preact に依存しない）。画面（ui/next/regions/AiChat.tsx）は
 * 一致した語を押せる印にし、押すと説明カード（ui/next/parts/TermCard.tsx）を開く。
 *
 * - 語: 各用語の見出し・短い形・別名と、見出しの先頭のカタカナだけの語（「デルタ Δ」の「デルタ」）。語の中の空白は
 *   空白 0 個以上で一致、英字とギリシャ文字は大小を区別しない（δ も delta）。その位置で長い語を先に試す（「ΔX」を「Δ」より先）
 * - 誤リンクを避ける境界: 英数字で始まる / 終わる語は外側が英数字でない（「IVR」の「IV」に付けない）、カタカナで始まる /
 *   終わる語は外側がカタカナでない（「デルタヘッジ」に付けない）。1 文字の英字（V・F）は使わない。1 文字のギリシャ文字
 *   （σ・Δ・Γ・Θ・β・ν）は直前が英数字・ギリシャ文字でなく、直後が英字・ギリシャ文字でないときだけ（「1σ」に付けない）
 * - 数値トークン（照合の印を含む）に部分的に重なる一致は捨てる（トークンを丸ごと含む語「30 日固定」は一致）。漢字で
 *   終わる語の直後が漢字なら付けない（複合語の中）。全角の英数字は半角に寄せて照合する。同じ用語は seen にある間は
 *   付けない（語は消費する）
 */

import { GLOSSARY, type TermId } from './glossary';

export interface TermHit {
  start: number;
  end: number;
  id: TermId;
}

interface Cand {
  re: RegExp;
  id: TermId;
  len: number;
  /** 1 文字のギリシャ文字 */
  greek1: boolean;
}

const ASCII_ALNUM = /[A-Za-z0-9]/;
const ASCII_ALPHA = /[A-Za-z]/;
const KATAKANA = /[゠-ヿ]/;
const GREEK = /[Ͱ-Ͽ]/;
const KATAKANA_WORD = /^[゠-ヿ]{2,}$/;
const KANJI = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆]/u;

/** 全角の英数字 → 半角（1 文字 → 1 文字 = 位置は変わらない。照合にだけ使い、表示は元の文字） */
export function halfWidth(text: string): string {
  return text.replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 用語の語（重複なし。1 文字の英字を除く。試験が全語で使う） */
export function wordsOf(t: (typeof GLOSSARY)[number]): string[] {
  const head = t.title.split(/[\s（(]/)[0] ?? '';
  const ws = [t.title, t.short, ...t.aliases, ...(KATAKANA_WORD.test(head) ? [head] : [])];
  return [...new Set(ws.map((w) => w.trim()))].filter((w) => w !== '' && !/^[A-Za-z]$/.test(w));
}

/** 先頭の文字（小文字）→ 候補（長い順） */
let byFirst: Map<string, Cand[]> | null = null;

function candidates(): Map<string, Cand[]> {
  if (byFirst) return byFirst;
  const m = new Map<string, Cand[]>();
  for (const t of GLOSSARY) {
    for (const w of wordsOf(t)) {
      const src = w.split(/\s+/).map(escapeRe).join('\\s*');
      const c: Cand = {
        re: new RegExp(src, 'iy'),
        id: t.id,
        len: w.replace(/\s+/g, '').length,
        greek1: w.length === 1 && GREEK.test(w),
      };
      const k = (w[0] ?? '').toLowerCase();
      const xs = m.get(k) ?? [];
      xs.push(c);
      m.set(k, xs);
    }
  }
  for (const xs of m.values()) xs.sort((a, b) => b.len - a.len);
  byFirst = m;
  return m;
}

function boundaryOk(text: string, start: number, end: number, c: Cand): boolean {
  const prev = text[start - 1] ?? '';
  const next = text[end] ?? '';
  if (c.greek1) {
    return !(
      ASCII_ALNUM.test(prev) ||
      GREEK.test(prev) ||
      ASCII_ALPHA.test(next) ||
      GREEK.test(next)
    );
  }
  const first = text[start] ?? '';
  const last = text[end - 1] ?? '';
  if (ASCII_ALNUM.test(first) && ASCII_ALNUM.test(prev)) return false;
  if (ASCII_ALNUM.test(last) && ASCII_ALNUM.test(next)) return false;
  if (KATAKANA.test(first) && KATAKANA.test(prev)) return false;
  if (KATAKANA.test(last) && KATAKANA.test(next)) return false;
  // 漢字の複合語の中（「証拠金率」の「証拠金」・「原資産価格」の「原資産」）。助詞（「原資産の」）は一致
  if (KANJI.test(last) && KANJI.test(next)) return false;
  return true;
}

/**
 * 文の中の用語（読む順）。skip（数値トークンの範囲。start 順）に部分的に重なる一致は捨てる（数字の中に付けない）。
 * トークンを丸ごと含む語（「30 日固定」）は一致し、含んだトークンの範囲は consumed に入る（呼ぶ側が照合の印を外す）。
 * seen にある用語は付けず（語は消費する）、付けた用語は seen に足す（返答の中で最初の 1 回だけ = 呼ぶ側が返答ごとに
 * 1 つの seen を渡す）。全角の英数字は半角に寄せて照合する（位置・表示は元の文字）
 */
export function findTerms(
  text: string,
  seen: Set<TermId>,
  skip: readonly { start: number; end: number }[] = [],
  consumed?: { start: number; end: number }[],
): TermHit[] {
  const cands = candidates();
  const norm = halfWidth(text);
  const out: TermHit[] = [];
  let s = 0;
  /** [i, end) がトークンに部分的に重なる */
  const crosses = (i: number, end: number): boolean => {
    for (let k = s; k < skip.length; k++) {
      const t = skip[k];
      if (!t || t.start >= end) break;
      if (t.end > i && (t.start < i || t.end > end)) return true;
    }
    return false;
  };
  for (let i = 0; i < norm.length; i++) {
    while (s < skip.length && (skip[s]?.end ?? 0) <= i) s++;
    const sk = skip[s];
    // トークンの途中から始まる語は無い
    if (sk && sk.start < i) {
      i = sk.end - 1;
      continue;
    }
    const xs = cands.get((norm[i] ?? '').toLowerCase()) ?? [];
    let hit = false;
    for (const c of xs) {
      c.re.lastIndex = i;
      const m = c.re.exec(norm);
      if (!m) continue;
      const end = i + m[0].length;
      if (!boundaryOk(norm, i, end, c) || crosses(i, end)) continue;
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push({ start: i, end, id: c.id });
      }
      consumed?.push({ start: i, end });
      i = end - 1;
      hit = true;
      break;
    }
    // トークンの先頭で語が無ければトークンを飛ばす
    if (!hit && sk && sk.start === i) i = sk.end - 1;
  }
  return out;
}
