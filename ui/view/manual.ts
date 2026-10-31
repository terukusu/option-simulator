/**
 * マニュアル（docs/user-guide.md）の節の索引と描き方（#322。docs/adr-0008-manual-bundled-viewer.md）。純関数で
 * Preact・DOM に依存しない。画面は説明カード（ui/next/parts/TermCard.tsx）の列に節・目次を積んで、ここで作った木を
 * JSX のテキストで描く（HTML 文字列を作らない・`href` を作らない。CSP・P11）。
 *
 * - 節の番号は AI の索引（api/src/simulator_api/ai/docs.py の parse。ADR-0007 決定 5）と同じ規則（docSections）。
 *   番号の規則は TS（ここ）と Python の 2 か所にある。ずれたら AI の根拠の節は見出しで引き直す（manualRefs.ts）
 * - アンカーは GitHub の見出しのアンカーの規則（slug。重複は `-1`…）。マニュアルの中のリンク `](#…)` と用語集の
 *   guide.anchor・ⓘ の場所 → 節（HINT_GUIDE）はアンカーで引く（見出しを変えない限り変わらない）
 * - 描く記法: 見出し 2〜4・段落・箇条書き（入れ子 1 段）・番号つき・表・コードブロック・`---`、行の中は
 *   `**太字**`・`` `コード` ``・`[文字](#アンカー)`。知らない記法は文字のまま。外へのリンクと当たらないアンカーは文字だけ
 */

import { tableCells } from './aiText';
import { normTitle } from './manualRefs';

// ---------------------------------------------------------------- 見出しと番号

/** GitHub の見出しのアンカー: 小文字化 → 文字・結合文字・数字・連結符・空白・ハイフン以外を消す → 空白を `-` */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** AI の索引（docs.py の parse）と同じ形 */
const HEADING_RE = /^(#{2,4}) +(.+?) *#* *$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;
const NUM_RE = /^([0-9]+(?:\.[0-9]+)*)\.? +(.*)$/;
/**
 * 見出しの中の開発の経緯（docs.py の _HISTORY_RE）。Python の `\b` は Unicode の語の境（`\w` = 文字・数字・`_`）なので、
 * JS では `\b`（ASCII だけ）を使わず前後の \p{L}\p{N}_ で同じ境にする（「（オーナーK7）」は Python と同じく外さない）
 */
const HISTORY_RE =
  /[（(][^（）()]*(?:#[0-9]+|(?<![\p{L}\p{N}_])[KDQR][0-9]+(?![\p{L}\p{N}_]))[^（）()]*[）)]/gu;
/** アンカーを数える見出し（GitHub と同じく 1〜6） */
const ANY_HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** 見出しの中の開発の経緯（「（#131）」など）を外す（docs.py の clean_title） */
export const cleanTitle = (t: string): string =>
  t.replace(HISTORY_RE, '').replace(/ {2,}/g, ' ').trim();

export interface DocSection {
  id: string;
  title: string;
}

interface Head {
  /** 行の番号（0 から） */
  at: number;
  level: number;
  /** 見出しの文字（`#` の後ろ） */
  raw: string;
  anchor: string;
  /** AI の索引の番号の対象（docs.py の見出しの形） */
  numbered: { level: number; raw: string } | null;
}

/** コードブロックの外の見出し（アンカーは重複に `-1`… を付ける） */
function headsOf(lines: readonly string[]): Head[] {
  const out: Head[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  lines.forEach((line, at) => {
    if (FENCE_RE.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const m = ANY_HEADING_RE.exec(line);
    if (!m) return;
    const raw = m[2] ?? '';
    const base = slug(raw);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const h = HEADING_RE.exec(line);
    out.push({
      at,
      level: (m[1] ?? '').length,
      raw: raw.trim(),
      anchor: n === 0 ? base : `${base}-${n}`,
      numbered: h?.[1] && h[2] ? { level: h[1].length, raw: h[2] } : null,
    });
  });
  return out;
}

/**
 * 見出し → 節の番号（docs.py の parse と同じ規則）: 見出しの番号か、親の番号 + 兄弟の順。番号の無い章（目次・付録）は
 * 節にしない。chapters があればその章だけ。返すのは heads の添字 → 番号と見出し
 */
function numberHeads(
  heads: readonly Head[],
  chapters: readonly string[] | null,
): Map<number, DocSection> {
  const out = new Map<number, DocSection>();
  let stack: { level: number; id: string }[] = [];
  const count = new Map<string, number>();
  let chapterOk = false;
  heads.forEach((h, i) => {
    if (h.numbered === null) return;
    const { level, raw } = h.numbered;
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
    const m = NUM_RE.exec(raw);
    let id: string;
    let title: string;
    if (level === 2) {
      stack = [];
      if (!m?.[1] || m[1].includes('.')) {
        chapterOk = false;
        return;
      }
      id = m[1];
      title = m[2] ?? '';
      chapterOk = chapters === null || chapters.includes(id);
    } else {
      const parent = stack.at(-1)?.id;
      if (!chapterOk || parent === undefined) return;
      const n = (count.get(parent) ?? 0) + 1;
      count.set(parent, n);
      if (m?.[1]?.startsWith(`${parent}.`)) {
        id = m[1];
        title = m[2] ?? '';
      } else {
        id = `${parent}.${n}`;
        title = raw;
      }
    }
    if (!chapterOk) return;
    stack.push({ level, id });
    out.set(i, { id, title: cleanTitle(title) });
  });
  return out;
}

/** 文書の節（番号と見出し。AI の索引 = docs.py の parse と同じ）。chapters があればその章だけ */
export function docSections(md: string, chapters: readonly string[] | null): DocSection[] {
  const heads = headsOf(md.split('\n'));
  return [...numberHeads(heads, chapters).values()];
}

// ---------------------------------------------------------------- 索引

export interface ManualSection {
  anchor: string;
  /** AI の索引と同じ番号（番号の無い章 = 目次は null） */
  id: string | null;
  level: 2 | 3 | 4;
  /** 見出し（番号と開発の経緯を除く。番号の無い章は見出しのまま） */
  title: string;
  /** 見出しの次の行から、同じかより上の階層の次の見出しの前まで（子の節を含む = read_doc と同じ範囲） */
  body: string;
  /** body の中の見出し（コードブロックの外）のアンカー（文書の順。同じ見出しの 2 つ目以降は `-1`… = 本文の見出しの番号を正しい節で引く） */
  headAnchors: readonly string[];
}

export interface ManualIndex {
  /** 文書の順 */
  sections: readonly ManualSection[];
  byAnchor: ReadonlyMap<string, ManualSection>;
  byId: ReadonlyMap<string, ManualSection>;
  /** 見出し（normTitle）→ 節。同じ見出しが 2 つ以上あるものは入れない */
  byTitle: ReadonlyMap<string, ManualSection>;
}

/** Markdown → 見出し 2〜4 ごとの節の索引 */
export function manualIndex(md: string): ManualIndex {
  const lines = md.split('\n');
  const heads = headsOf(lines);
  const nums = numberHeads(heads, null);
  const sections: ManualSection[] = [];
  heads.forEach((h, i) => {
    if (h.level < 2 || h.level > 4) return;
    let end = lines.length;
    for (const next of heads.slice(i + 1)) {
      if (next.level <= h.level) {
        end = next.at;
        break;
      }
    }
    const num = nums.get(i);
    const headAnchors = heads
      .slice(i + 1)
      .filter((x) => x.at < end)
      .map((x) => x.anchor);
    sections.push({
      anchor: h.anchor,
      id: num?.id ?? null,
      level: h.level as 2 | 3 | 4,
      title: num?.title ?? cleanTitle(h.raw),
      body: lines.slice(h.at + 1, end).join('\n'),
      headAnchors,
    });
  });
  const byAnchor = new Map(sections.map((s) => [s.anchor, s]));
  const byId = new Map<string, ManualSection>();
  const byTitle = new Map<string, ManualSection>();
  const dup = new Set<string>();
  for (const s of sections) {
    if (s.id !== null) byId.set(s.id, s);
    const k = normTitle(s.title);
    if (dup.has(k)) continue;
    if (byTitle.has(k)) {
      byTitle.delete(k);
      dup.add(k);
    } else byTitle.set(k, s);
  }
  return { sections, byAnchor, byId, byTitle };
}

/** 節の見出しの文字（「8.5 追証マップ」。番号の無い章は見出しだけ） */
export const sectionLabel = (s: ManualSection): string =>
  s.id === null ? s.title : `${s.id} ${s.title}`;

/**
 * 節の道筋（「8 指標 · テール > 8.5 追証マップ」。章から節まで。カードの本文の先頭 = 1 行に収めた見出しの全文）。
 * 番号の無い章は見出しだけ
 */
export function sectionPath(s: ManualSection, index: ManualIndex): string {
  if (s.id === null) return s.title;
  const parts = s.id.split('.');
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const a = index.byId.get(parts.slice(0, i).join('.'));
    if (a) out.push(sectionLabel(a));
  }
  return out.join(' > ');
}

// ---------------------------------------------------------------- 行の中

export interface ManualSpan {
  text: string;
  bold: boolean;
  code: boolean;
}

/** 行の中の 1 片: 文字（太字・コード）か、索引にある節へのリンク */
export type ManualInline = ManualSpan | { anchor: string; label: ManualSpan[] };

/** `\` の後ろで記号だけにする ASCII の記号（CommonMark のエスケープ） */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** `[` から対応する `]` の位置（角括弧の入れ子は 1 段まで。コードの中は数えない）。無ければ -1 */
function closeBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
    } else if (c === '`') {
      const e = s.indexOf('`', i + 1);
      if (e < 0) continue;
      i = e;
    } else if (c === '[') {
      depth++;
      if (depth > 1) return -1;
    } else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    } else if (c === '\n' && s[i + 1] === '\n') return -1;
  }
  return -1;
}

/**
 * 行の中の文字 → 片。has は索引にあるアンカーか（当たらないアンカー・外へのリンクは表示する文字だけ）。
 * bold は外側の太字（`**[線 \| 面]**` のリンクの中）
 */
function inlineSpans(
  s: string,
  has: (anchor: string) => boolean,
  outerBold = false,
): ManualInline[] {
  const out: ManualInline[] = [];
  let bold = outerBold;
  let buf = '';
  const push = (x: ManualInline) => {
    const last = out.at(-1);
    if (
      !('anchor' in x) &&
      last !== undefined &&
      !('anchor' in last) &&
      last.bold === x.bold &&
      last.code === x.code
    ) {
      last.text += x.text;
    } else out.push(x);
  };
  const flush = () => {
    if (buf !== '') push({ text: buf, bold, code: false });
    buf = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c === '\\' && ESCAPABLE.test(s[i + 1] ?? '')) {
      buf += s[i + 1];
      i++;
      continue;
    }
    if (c === '`') {
      const e = s.indexOf('`', i + 1);
      if (e > i) {
        flush();
        push({ text: s.slice(i + 1, e), bold, code: true });
        i = e;
        continue;
      }
    }
    if (c === '*' && s[i + 1] === '*') {
      if (bold && !outerBold) {
        flush();
        bold = false;
        i++;
        continue;
      }
      if (!bold && s.indexOf('**', i + 2) > i + 2) {
        flush();
        bold = true;
        i++;
        continue;
      }
    }
    if (c === '[') {
      const close = closeBracket(s, i);
      if (close > i && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2);
        const target = end > close ? s.slice(close + 2, end) : '';
        if (end > close && !/\s/.test(target)) {
          flush();
          const label = inlineSpans(s.slice(i + 1, close), () => false, bold).filter(
            (x): x is ManualSpan => !('anchor' in x),
          );
          const anchor = target.startsWith('#') ? target.slice(1) : null;
          if (anchor !== null && has(anchor)) out.push({ anchor, label });
          else for (const x of label) push(x);
          i = end;
          continue;
        }
      }
    }
    buf += c;
  }
  flush();
  return out;
}

/** 行の中の文字 → 片（太字・コード・節へのリンク） */
export function manualInline(s: string, index: ManualIndex): ManualInline[] {
  return inlineSpans(s, (a) => index.byAnchor.has(a));
}

/** 片の文字をつなげた文（読み上げの名前・テスト） */
export const inlineText = (xs: readonly ManualInline[]): string =>
  xs.map((x) => ('anchor' in x ? x.label.map((l) => l.text).join('') : x.text)).join('');

// ---------------------------------------------------------------- ブロック

export interface ManualListItem {
  inl: ManualInline[];
  /** 入れ子 1 段（無ければ null） */
  sub: { kind: 'ul' | 'ol'; items: ManualInline[][] } | null;
}

export type ManualBlock =
  /** 見出し（カードの中の h3〜h6。節の見出しの h2 の下） */
  | { kind: 'h'; level: 3 | 4 | 5 | 6; text: string }
  | { kind: 'p'; inl: ManualInline[] }
  | { kind: 'ul'; items: ManualListItem[] }
  | { kind: 'ol'; start: number; items: ManualListItem[] }
  | { kind: 'table'; head: ManualInline[][]; rows: ManualInline[][][] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'hr' };

const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const ITEM_RE = /^( *)([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const ROW_RE = /^\s*\|(?!\s*$)/;
const SEP_CELL = /^:?-+:?$/;

const isSepRow = (line: string): boolean => {
  if (!ROW_RE.test(line)) return false;
  const cs = tableCells(line);
  return cs.length > 0 && cs.every((c) => SEP_CELL.test(c));
};

/**
 * 節の本文 → ブロックの木。level は節の見出しの階層（本文の中の見出しを、カードの見出し h2 から数えた h3〜 にする）。
 * 本文の中の見出しは索引の番号を付けた文字（「8.5 追証マップ」）。anchors は本文の中の見出しのアンカー（文書の順。
 * ManualSection.headAnchors）で、あれば k 番目の見出しをそのアンカーで引く（同じ見出しが 2 つあっても取り違えない）。
 * 無ければ見出しの文字のアンカー（重複の `-1` を数えない）
 */
export function manualBlocks(
  body: string,
  level: number,
  index: ManualIndex,
  anchors: readonly string[] | null = null,
): ManualBlock[] {
  const lines = body.split('\n');
  let headAt = 0;
  const out: ManualBlock[] = [];
  const inl = (s: string) => manualInline(s, index);
  let para: string[] = [];
  /** 直前の行が空行か（字下げした続きの行を項目に足すのは空行の無いときだけ） */
  let blank = true;
  const flush = () => {
    if (para.length > 0) out.push({ kind: 'p', inl: inl(para.join('\n')) });
    para = [];
  };
  /** 箇条書きの項目の文（続きの行を足す。最後に inline にする） */
  const itemText = new Map<ManualInline[], string>();
  const lastList = (): Extract<ManualBlock, { kind: 'ul' | 'ol' }> | null => {
    const b = out.at(-1);
    return b && (b.kind === 'ul' || b.kind === 'ol') && para.length === 0 ? b : null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FENCE_RE.test(line)) {
      flush();
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j] ?? '')) code.push(lines[j++] ?? '');
      out.push({ kind: 'code', lines: code });
      i = j;
      blank = false;
      continue;
    }
    if (line.trim() === '') {
      flush();
      blank = true;
      continue;
    }
    const h = ANY_HEADING_RE.exec(line);
    if (h) {
      flush();
      const raw = (h[2] ?? '').trim();
      const anchor = anchors?.[headAt] ?? slug(raw);
      headAt++;
      const sec = index.byAnchor.get(anchor);
      const text = sec ? sectionLabel(sec) : cleanTitle(raw);
      const lv = Math.min(6, Math.max(3, 2 + (h[1] ?? '').length - level)) as 3 | 4 | 5 | 6;
      out.push({ kind: 'h', level: lv, text });
      blank = false;
      continue;
    }
    if (HR_RE.test(line) && para.length === 0) {
      out.push({ kind: 'hr' });
      blank = false;
      continue;
    }
    if (ROW_RE.test(line) && isSepRow(lines[i + 1] ?? '')) {
      flush();
      const head = tableCells(line);
      const cols = head.length;
      const rows: ManualInline[][][] = [];
      let j = i + 2;
      for (; j < lines.length && ROW_RE.test(lines[j] ?? ''); j++) {
        const cells = tableCells(lines[j] ?? '').slice(0, cols);
        while (cells.length < cols) cells.push('');
        rows.push(cells.map(inl));
      }
      out.push({ kind: 'table', head: head.map(inl), rows });
      i = j - 1;
      blank = false;
      continue;
    }
    const it = ITEM_RE.exec(line);
    if (it) {
      const indent = (it[1] ?? '').length;
      const kind = it[3] === undefined ? 'ul' : 'ol';
      const text = it[4] ?? '';
      const list = lastList();
      const top = list?.items.at(-1);
      if (indent >= 2 && list && top) {
        // 入れ子 1 段（さらに深い字下げも同じ段）
        const sub = top.sub ?? { kind, items: [] };
        top.sub = sub;
        const x: ManualInline[] = [];
        itemText.set(x, text);
        sub.items.push(x);
      } else {
        flush();
        const x: ManualListItem = { inl: [], sub: null };
        itemText.set(x.inl, text);
        if (list && list.kind === kind) list.items.push(x);
        else if (kind === 'ol') out.push({ kind, start: Number(it[3]), items: [x] });
        else out.push({ kind, items: [x] });
      }
      blank = false;
      continue;
    }
    const list = lastList();
    if (list && !blank && /^\s+\S/.test(line)) {
      // 字下げした続きの行は直前の項目（入れ子があればその最後）の文に足す
      const top = list.items.at(-1);
      const target = top?.sub?.items.at(-1) ?? top?.inl;
      if (target) {
        itemText.set(target, `${itemText.get(target) ?? ''}\n${line.trim()}`);
        continue;
      }
    }
    para.push(line.replace(/^\s+/, ''));
    blank = false;
  }
  flush();
  // 項目の文を inline にする（続きの行を足し終えてから）
  for (const [x, text] of itemText) x.push(...inl(text));
  return out;
}

// ---------------------------------------------------------------- 目次

export interface TocChapter {
  anchor: string;
  /** 「8 指標 · テール」 */
  label: string;
  items: readonly { anchor: string; label: string; level: 3 | 4 }[];
}

/** 目次: 番号のある章と、その中の節（3・4）。番号の無い章（目次）は出さない */
export function tocModel(index: ManualIndex): TocChapter[] {
  const out: { anchor: string; label: string; items: TocChapter['items'][number][] }[] = [];
  for (const s of index.sections) {
    if (s.id === null) continue;
    if (s.level === 2) out.push({ anchor: s.anchor, label: sectionLabel(s), items: [] });
    else out.at(-1)?.items.push({ anchor: s.anchor, label: sectionLabel(s), level: s.level });
  }
  return out;
}

// ---------------------------------------------------------------- ⓘ の場所 → 節

export type HintPlace =
  | 'stage'
  | 'scenario'
  | 'positions'
  | 'metrics'
  | 'holdMap'
  | 'replay'
  | 'board'
  | 'smile'
  | 'ivHistory'
  | 'futHistory'
  | 'book'
  | 'holdings';

/**
 * ⓘ の吹き出しの末尾の「マニュアル:」の節（12 か所。場所 → 節の表はここ 1 か所）。title は番号を含まない見出し
 * （節を足すと番号がずれるので持たない。ボタンの文字）。アンカーと見出しは tests/ui/manual.test.ts が索引と突き合わせる
 */
export const HINT_GUIDE: Readonly<Record<HintPlace, { anchor: string; title: string }>> = {
  stage: { anchor: '線と印', title: '線と印' },
  scenario: { anchor: '6-シナリオ', title: 'シナリオ' },
  positions: { anchor: '7-ポジション', title: 'ポジション' },
  metrics: { anchor: '8-指標--テール', title: '指標 · テール' },
  holdMap: { anchor: '追証マップ', title: '追証マップ' },
  replay: { anchor: '過去の急落の再生', title: '過去の急落の再生' },
  board: { anchor: '9-市場-板', title: '市場: 板' },
  smile: { anchor: '点と線', title: '点と線' },
  ivHistory: { anchor: 'iv-推移atm-iv-の-30-日固定', title: 'IV 推移（ATM IV の 30 日固定）' },
  futHistory: { anchor: '先物推移日経225-先物', title: '先物推移（日経225 先物）' },
  book: { anchor: '保存一覧名前を付けて保存', title: '保存一覧（名前を付けて保存）' },
  holdings: { anchor: '保有ポジションの一覧', title: '保有ポジションの一覧' },
};
