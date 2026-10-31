/**
 * AI の返答の根拠の節（#322。docs/design.md 14 章「根拠の節」）: 「マニュアル 8.5「追証マップ」」「マニュアル 8.1「タイル」・
 * 8.3「テール表」」「マニュアルの 10 章」を拾い（docRefs）、押したときにマニュアルの索引から節を引く（resolveManualRef）。
 * 純関数。返答を描くときにはマニュアルを読み込まない（押したときに初めて読む = docs/adr-0008-manual-bundled-viewer.md）
 * ので、画面はマニュアルの根拠の節をいつも押せる印にし、見つからなければカードの中に「マニュアルに見つからない」と出す。
 *
 * 形は ui/view/aiNumbers.ts の SECTION_BEFORE（数字の印から外す根拠の節）と同じ: 文書の名前 +「の」+ 番号（+「章」）
 * （+「見出し」）、並べた 2 つ目以降は `・、,/と` の後の番号。どれも小数点・「章」・「見出し」のどれかが要る（番号だけは数）。設計書の節は画面で読まない（文字のまま。印にしない）。
 */

import type { ManualIndex, ManualSection } from './manual';

/** 見出しの比べ方（全角・半角と空白の違いを無視する） */
export const normTitle = (t: string): string => t.normalize('NFKC').replace(/\s+/g, '');

export interface DocRef {
  /** 文字の範囲（1 つ目は文書の名前から、2 つ目以降は番号から） */
  start: number;
  end: number;
  doc: 'manual' | 'design';
  /** 節の番号（「10 章」は "10"） */
  id: string;
  /** 「」の中の見出し（無ければ null） */
  title: string | null;
}

/** 番号（+「章」）（+「見出し」。見出しの中の「」は 1 段まで = 10.7「「今」の点とシナリオの水準」） */
const ITEM = String.raw`(\d+(?:\.\d+)*)\s*(章)?\s*(?:「((?:[^「」\n]|「[^「」\n]*」)*)」)?`;
const LEAD_RE = new RegExp(String.raw`(マニュアル|設計書)\s*(?:の\s*)?${ITEM}`, 'g');
const NEXT_RE = new RegExp(String.raw`\s*[・、,/と]\s*${ITEM}`, 'y');

/** 節の番号と読める形か: 小数点を含む・「章」が付く・「見出し」が付く（番号だけの「3」は数かもしれないので外す） */
const isSection = (id: string | undefined, ch: string | undefined, title: string | undefined) =>
  (id?.includes('.') ?? false) || ch !== undefined || title !== undefined;

/** 文の中の根拠の節（文の順） */
export function docRefs(text: string): DocRef[] {
  const out: DocRef[] = [];
  LEAD_RE.lastIndex = 0;
  for (let m = LEAD_RE.exec(text); m !== null; m = LEAD_RE.exec(text)) {
    // 1 つ目も 2 つ目以降と同じく「8.5」「10 章」「8「…」」の形だけ（「マニュアルの 3 つの節」「マニュアル 2 か所」の
    // 数は節にしない = 押せる印にすると別の章へ誤って案内する）
    if (!isSection(m[2], m[3], m[4])) continue;
    const doc = m[1] === '設計書' ? 'design' : 'manual';
    out.push({
      start: m.index,
      end: m.index + m[0].trimEnd().length,
      doc,
      id: m[2] ?? '',
      title: m[4] ?? null,
    });
    let at = m.index + m[0].length;
    for (;;) {
      NEXT_RE.lastIndex = at;
      const n = NEXT_RE.exec(text);
      // 2 つ目以降は「8.3」「10 章」「8「…」」の形だけ（「と 3 日」のような値は節にしない）
      if (!n || !isSection(n[1], n[2], n[3])) break;
      const lead = /^\s*[・、,/と]\s*/.exec(n[0])?.[0].length ?? 0;
      out.push({
        start: at + lead,
        end: at + n[0].trimEnd().length,
        doc,
        id: n[1] ?? '',
        title: n[3] ?? null,
      });
      at += n[0].length;
    }
    LEAD_RE.lastIndex = at;
  }
  return out;
}

/**
 * 根拠の節 → マニュアルの節。見出しがあれば: 番号の節の見出しが同じならその節 → 見出しで引ける（一意）ならその節
 * （文書が変わって番号がずれた後の古い返答）→ 無ければ null。見出しが無い（「10 章」）なら番号だけで引く
 */
export function resolveManualRef(
  index: ManualIndex,
  ref: { id: string; title: string | null },
): ManualSection | null {
  const byNum = index.byId.get(ref.id) ?? null;
  if (ref.title === null) return byNum;
  const t = normTitle(ref.title);
  if (byNum && normTitle(byNum.title) === t) return byNum;
  return index.byTitle.get(t) ?? null;
}
