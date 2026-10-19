/**
 * AI の返答の数字の照合（#135。EPIC #141 終了条件 2・docs/design.md 14 章）。純関数（DOM・通信に依存しない）。
 *
 * 返答の文字列から数値トークン（符号・桁区切り・小数・全角 + 直後の単位）を取り出し、その会話の context・
 * context_update・道具の結果（照合の値）と丸めの規則で照合する。画面は照合できない数字に印を付け
 * （ui/next/regions/AiChat.tsx）、評価用スクリプト（scripts/aiEval.mjs）は不一致を数える。
 *
 * - 照合の値の単位はキーの名前で決める（api/src/simulator_api/ai/tools.py の規則と同じ）: `yen` を含む → 金額、
 *   `pct` → %、`_pt` → pt、`delta`・`gamma`・`qty` → 枚、`days` → 日、`ratio`・`multiple` → 倍、
 *   `x`・`k`・`x0`・`forward`・`atm_k`・`price`・`*_x` → 水準（円）、`iv`・`atm_iv` → %。配列の要素は親のキー
 * - 一致: 単位が合う値を、トークンの単位（円・千円・万円・億円）で割ってトークンの小数の桁に四捨五入したものが、
 *   トークンの値と絶対値で等しい。符号を書いたトークン（− / ▲ / △ / +）は向きも合うこと（言葉の「損失 617 千円」は
 *   絶対値だけ）。単位の無いトークンはどの単位の値とも照合する
 * - ignored（数えない）: 日付・時刻（2026-11-13・11/13・9:00・2026 年・2 週間）、限月（11 月限）、番号（弱点 1・行頭の 1.）、
 *   数の言葉（3 つ・2 本）、「100 円あたり」「/ 原資産 100 円」のような単位の言い方。「- 29.5 日」の空白の前の - は
 *   箇条書きの印（符号にしない）。スマイルの m（ln(K/F)）は ×100 の % としても照合する
 */

export type ValueClass = 'money' | 'level' | 'pct' | 'pt' | 'lots' | 'days' | 'ratio' | 'other';
export type TokenUnit =
  | 'yen'
  | 'thousand_yen'
  | 'man_yen'
  | 'oku_yen'
  | 'lots'
  | 'pt'
  | 'pct'
  | 'ratio'
  | 'days'
  | 'none';
export type IgnoreReason = 'date' | 'time' | 'month' | 'number' | 'count' | 'per_unit';

export interface SourceValue {
  value: number;
  cls: ValueClass;
}

export interface NumberToken {
  /** 元の文字列の部分（符号・単位を含む） */
  raw: string;
  start: number;
  end: number;
  /** 符号つきの値（トークンの単位のまま。例「−617 千円」は −617） */
  value: number;
  decimals: number;
  unit: TokenUnit;
  status: 'matched' | 'unmatched' | 'ignored';
  reason?: IgnoreReason;
}

export interface NumberCheck {
  tokens: NumberToken[];
  unmatched: number;
  matched: number;
}

const LEVEL_KEYS = new Set(['x', 'k', 'x0', 'forward', 'atm_k', 'price', 'strike']);

/** キーの名前 → 単位の種類 */
export function classOfKey(key: string): ValueClass {
  const k = key.toLowerCase();
  if (k.includes('yen')) return 'money';
  if (k.includes('pct')) return 'pct';
  if (k.endsWith('_pt') || k.includes('_pt_')) return 'pt';
  if (k.includes('delta') || k.includes('gamma') || k === 'qty' || k.includes('lots'))
    return 'lots';
  if (k.includes('days')) return 'days';
  if (k.includes('ratio') || k === 'multiple') return 'ratio';
  if (LEVEL_KEYS.has(k) || k.endsWith('_x') || k.endsWith('_k')) return 'level';
  if (k === 'iv' || k === 'atm_iv') return 'pct';
  return 'other';
}

/** 照合の値（数値の葉）を集める。配列の要素は親のキーの単位 */
export function collectValues(sources: readonly unknown[]): SourceValue[] {
  const out: SourceValue[] = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return;
      out.push({ value: v, cls: classOfKey(key) });
      // スマイルの点の m（= ln(K/F)。±0.05 など）は返答では「+5% の位置」と書かれる
      if (key === 'm') out.push({ value: v * 100, cls: 'pct' });
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
      return;
    }
    if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  for (const s of sources) walk(s, '');
  return out;
}

const FULL_WIDTH: Record<string, string> = {
  '，': ',',
  '．': '.',
  '％': '%',
  '－': '-',
  '＋': '+',
  '：': ':',
  '／': '/',
};

/** 全角の数字・記号を半角に（1 文字 → 1 文字。添字はそのまま） */
function normalize(text: string): string {
  return text.replace(/[０-９，．％－＋：／]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(code - 0xff10 + 48);
    return FULL_WIDTH[c] ?? c;
  });
}

const UNIT_RE =
  /^\s?(千円|万円|億円|円|万|枚|pt|ポイント|%|倍|営業日|日|年|月限|月|週間|週|か月|ヶ月|つ|個|点|回|件|本|行|字|秒|分|時)/;
const UNIT_OF: Record<string, TokenUnit | IgnoreReason> = {
  千円: 'thousand_yen',
  万円: 'man_yen',
  万: 'man_yen',
  億円: 'oku_yen',
  円: 'yen',
  枚: 'lots',
  pt: 'pt',
  ポイント: 'pt',
  '%': 'pct',
  倍: 'ratio',
  営業日: 'days',
  日: 'days',
  年: 'date',
  月限: 'month',
  月: 'month',
  週間: 'time',
  週: 'time',
  か月: 'time',
  ヶ月: 'time',
  つ: 'count',
  個: 'count',
  点: 'count',
  回: 'count',
  件: 'count',
  本: 'count',
  行: 'count',
  字: 'count',
  秒: 'time',
  分: 'time',
  時: 'time',
};
const SCALE: Partial<Record<TokenUnit, number>> = {
  yen: 1,
  thousand_yen: 1e3,
  man_yen: 1e4,
  oku_yen: 1e8,
};
const COMPAT: Record<TokenUnit, readonly ValueClass[] | null> = {
  yen: ['money', 'level'],
  thousand_yen: ['money', 'level'],
  man_yen: ['money', 'level'],
  oku_yen: ['money', 'level'],
  lots: ['lots'],
  pt: ['pt', 'pct'],
  pct: ['pct', 'pt'],
  ratio: ['ratio'],
  days: ['days'],
  none: null,
};
const NEGATIVE = new Set(['-', '−', '–', '▲', '△']);
const DATE_RE =
  /\d{4}-\d{1,2}(?:-\d{1,2})?|\d{4}\/\d{1,2}(?:\/\d{1,2})?|\d{1,2}\/\d{1,2}|\d{1,2}\s?月\s?\d{1,2}\s?日/g;
const TIME_RE = /\d{1,2}:\d{2}/g;
const NUM_RE = /(?<![0-9A-Za-z_.,])([+\-−–▲△±×]\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
const PER_UNIT_RE = /^\s?(あたり|当たり|につき)/;
const NUMBERING_BEFORE = /(弱点|第|No\.?)\s?$/;
/** 「Γ（… / 原資産 100 円）」のような単位の言い方（直前が / ） */
const PER_BEFORE = /\/\s*(原資産\s*)?$/;

function matches(
  t: { value: number; decimals: number; unit: TokenUnit; signed: number },
  values: readonly SourceValue[],
): boolean {
  const compat = COMPAT[t.unit];
  const scale = SCALE[t.unit] ?? 1;
  const f = 10 ** t.decimals;
  const target = Math.round(Math.abs(t.value) * f);
  for (const v of values) {
    if (compat !== null && !compat.includes(v.cls)) continue;
    if (Math.round(Math.abs(v.value / scale) * f) !== target) continue;
    if (t.signed < 0 && v.value > 0) continue;
    if (t.signed > 0 && v.value < 0) continue;
    return true;
  }
  return false;
}

/** 返答の文字列の数字を照合する（同じ入力 → 同じ出力） */
export function checkNumbers(text: string, sources: readonly unknown[]): NumberCheck {
  if (text === '') return { tokens: [], unmatched: 0, matched: 0 };
  const n = normalize(text);
  const values = collectValues(sources);
  const tokens: NumberToken[] = [];
  const taken: Array<[number, number]> = [];
  const ignoreSpan = (re: RegExp, reason: IgnoreReason) => {
    for (const m of n.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      tokens.push({
        raw: text.slice(start, end),
        start,
        end,
        value: Number.NaN,
        decimals: 0,
        unit: 'none',
        status: 'ignored',
        reason,
      });
    }
  };
  ignoreSpan(DATE_RE, 'date');
  ignoreSpan(TIME_RE, 'time');
  for (const m of n.matchAll(NUM_RE)) {
    const start = m.index ?? 0;
    const numText = m[2] ?? '';
    const numEnd = start + m[0].length;
    if (taken.some(([a, b]) => start < b && numEnd > a)) continue;
    // 「- 29.5 日」の「- 」は箇条書きの印か区切り（符号は数字に続けて書く）
    const rawSign = m[1] ?? '';
    const signText = /\s$/.test(rawSign) && rawSign.trim() !== '×' ? '' : rawSign.trim();
    const rest = n.slice(numEnd);
    const u = UNIT_RE.exec(rest);
    const unitKey = u?.[1];
    const unitOf = unitKey !== undefined ? UNIT_OF[unitKey] : undefined;
    let end = numEnd;
    let unit: TokenUnit = signText === '×' ? 'ratio' : 'none';
    let reason: IgnoreReason | undefined;
    if (u && unitOf !== undefined) {
      if (unitOf === 'date' || unitOf === 'month' || unitOf === 'count' || unitOf === 'time') {
        reason = unitOf;
      } else {
        unit = unitOf as TokenUnit;
        end = numEnd + u[0].length;
        if (PER_UNIT_RE.test(n.slice(end))) reason = 'per_unit';
      }
    }
    if (reason === undefined) {
      const lineStart = n.lastIndexOf('\n', start - 1) + 1;
      const before = n.slice(lineStart, start);
      if (NUMBERING_BEFORE.test(before)) reason = 'number';
      else if (PER_BEFORE.test(before)) reason = 'per_unit';
      else if (/^\s*(#+\s*)?([-*]\s*)?$/.test(before) && /^[.)）:]/.test(rest)) reason = 'number';
    }
    const decimalPart = numText.split('.')[1];
    const decimals = decimalPart === undefined ? 0 : decimalPart.length;
    const abs = Number(numText.replace(/,/g, ''));
    const signed = NEGATIVE.has(signText) ? -1 : signText === '+' ? 1 : 0;
    const value = signed < 0 ? -abs : abs;
    const rawStart =
      (reason === undefined || reason === 'per_unit') && signText !== ''
        ? start
        : start + rawSign.length;
    const tok: NumberToken = {
      raw: text.slice(rawStart, end),
      start: rawStart,
      end,
      value,
      decimals,
      unit,
      status: 'unmatched',
    };
    if (reason !== undefined) {
      tok.status = 'ignored';
      tok.reason = reason;
    } else if (matches({ value, decimals, unit, signed }, values)) {
      tok.status = 'matched';
    }
    taken.push([start, end]);
    tokens.push(tok);
  }
  tokens.sort((a, b) => a.start - b.start);
  let unmatched = 0;
  let matched = 0;
  for (const t of tokens) {
    if (t.status === 'unmatched') unmatched++;
    else if (t.status === 'matched') matched++;
  }
  return { tokens, unmatched, matched };
}

export interface AnswerSection {
  /** 見出し（`## ` を除く。見出しの前の文は ''） */
  title: string;
  /** 「弱点」で始まる見出し */
  weakness: boolean;
  matched: number;
  unmatched: number;
}

/** 返答を `## ` の見出しで節に分け、節ごとの照合の数（評価用。見出しの前に文が無ければ節にしない） */
export function sectionsOf(text: string, sources: readonly unknown[]): AnswerSection[] {
  const out: AnswerSection[] = [];
  let title = '';
  let body: string[] = [];
  const flush = () => {
    const b = body.join('\n');
    if (title === '' && b.trim() === '') return;
    const r = checkNumbers(b, sources);
    out.push({
      title,
      weakness: /^弱点/.test(title),
      matched: r.matched,
      unmatched: r.unmatched,
    });
  };
  for (const line of text.split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      flush();
      title = (h[1] ?? '').trim();
      body = [];
    } else body.push(line);
  }
  flush();
  return out;
}
