import { describe, expect, it } from 'vitest';
import {
  GLOSSARY,
  HINT_TERMS,
  termById,
  termCardView,
  termSearchText,
} from '../../ui/view/glossary';

/** #167: 用語集のデータ（AC-2〜AC-4）と説明カードの表示モデル（AC-7） */

/** docs は Node の fs で読む（@types/node を足さないため型は最小限。cssTokens.test.ts と同じ） */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const guide = fs.readFileSync(new URL('../../docs/user-guide.md', import.meta.url), 'utf8');

const IDS = [
  'iv-shift',
  'skew',
  'dx',
  'iv',
  'hv',
  'iv30',
  'beta',
  'greeks',
  'delta',
  'gamma',
  'vega',
  'theta',
  'forward',
  'basis',
  'sticky',
  'nov',
  'pfe',
  'margin',
  'requirement',
  'room',
  'margin-line',
  'hold-map',
  'var-span',
  'jscc',
] as const;

/** GitHub の見出しのアンカー: 小文字化 → 文字・結合文字・数字・連結符・空白・ハイフン以外を消す → 空白を `-`。重複は `-1`… */
function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

interface Section {
  anchor: string;
  level: number;
  body: string;
}

/** 見出し（コードブロックの外）ごとのアンカーと本文（次の同じか上の階層の見出しまで） */
function sections(md: string): Section[] {
  const lines = md.split('\n');
  const heads: { at: number; level: number; anchor: string }[] = [];
  const seen = new Map<string, number>();
  let code = false;
  lines.forEach((line, at) => {
    if (line.startsWith('```')) code = !code;
    if (code) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) return;
    const base = slug(m[2] ?? '');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    heads.push({ at, level: (m[1] ?? '').length, anchor: n === 0 ? base : `${base}-${n}` });
  });
  return heads.map((h, i) => {
    let end = lines.length;
    for (const next of heads.slice(i + 1)) {
      if (next.level <= h.level) {
        end = next.at;
        break;
      }
    }
    return { anchor: h.anchor, level: h.level, body: lines.slice(h.at, end).join('\n') };
  });
}

const SECTIONS = sections(guide);
const ANCHORS = new Set(SECTIONS.map((s) => s.anchor));

/** 用語の全部の文字列（説明・例・式・出る場所・別名・マニュアルの節） */
function allStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v !== null && typeof v === 'object') return Object.values(v).flatMap(allStrings);
  return [];
}

describe('用語集のデータ（#167 AC-2）', () => {
  it('(a) 24 語の id がすべてあり一意', () => {
    expect(GLOSSARY.map((t) => t.id).sort()).toEqual([...IDS].sort());
    expect(new Set(GLOSSARY.map((t) => t.id)).size).toBe(GLOSSARY.length);
    expect(GLOSSARY.length).toBe(24);
  });

  it('(b) 見出し・読み・一言・説明（1〜4 段落）・出る場所・マニュアルの節が空でない', () => {
    for (const t of GLOSSARY) {
      for (const s of [t.title, t.short, t.reading, t.summary, t.guide.anchor, t.guide.title]) {
        expect(s.trim(), t.id).not.toBe('');
      }
      expect(t.body.length, t.id).toBeGreaterThanOrEqual(1);
      expect(t.body.length, t.id).toBeLessThanOrEqual(4);
      for (const p of t.body) expect(p.trim(), t.id).not.toBe('');
      expect(t.where.length, t.id).toBeGreaterThanOrEqual(1);
      for (const w of t.where) expect(w.trim(), t.id).not.toBe('');
      // 読みはひらがなと空白だけ（パレットの正規化でカナと同一視する）
      expect(t.reading, t.id).toMatch(/^[\p{Script=Hiragana}ー ]+$/u);
    }
  });

  it('(c) 関連する用語の id がすべて存在し、自分を指さない・重複しない', () => {
    for (const t of GLOSSARY) {
      expect(t.related.length, t.id).toBeGreaterThan(0);
      expect(new Set(t.related).size, t.id).toBe(t.related.length);
      for (const r of t.related) {
        expect(termById(r), `${t.id} → ${r}`).not.toBeNull();
        expect(r, t.id).not.toBe(t.id);
      }
    }
  });

  it('(d) 例のある用語は例の文に「架空」を含む', () => {
    const withExample = GLOSSARY.filter((t) => t.example !== undefined);
    expect(withExample.length).toBeGreaterThan(10);
    for (const t of withExample) expect(t.example, t.id).toContain('架空');
  });

  it('(e) どの文字列にも http:// https:// が無い（外部 URL を置かない）', () => {
    for (const s of allStrings(GLOSSARY)) {
      expect(s).not.toMatch(/https?:\/\//);
    }
  });

  it('(f) JSON の往復で同じ（関数・undefined を持たない）', () => {
    expect(JSON.parse(JSON.stringify(GLOSSARY))).toEqual(GLOSSARY);
    for (const t of GLOSSARY) {
      for (const [k, v] of Object.entries(t)) expect(v, `${t.id}.${k}`).not.toBeUndefined();
    }
  });

  it('別名に括弧を含めない（パレットの「(」の検索がラベルだけで決まる）', () => {
    for (const t of GLOSSARY) {
      for (const a of t.aliases) expect(a, t.id).not.toMatch(/[()（）]/);
    }
  });
});

describe('マニュアルの節（#167 AC-3）', () => {
  it('slug 関数: マニュアルの目次のリンクがすべて見出しのアンカーに一致する', () => {
    const toc = guide.slice(guide.indexOf('## 目次'), guide.indexOf('## 1. はじめに'));
    const links = [...toc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(links.length).toBeGreaterThanOrEqual(19);
    for (const l of links) expect(ANCHORS.has(l), l).toBe(true);
    // 本文の中のリンク（[N 章](#…)）もすべて見出しにある
    const inner = [...guide.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] ?? '');
    for (const l of inner) expect(ANCHORS.has(l), l).toBe(true);
  });

  it('各用語のアンカーが見出しにあり、その節の本文に用語の見出しか別名のどれかが含まれる', () => {
    for (const t of GLOSSARY) {
      const sec = SECTIONS.find((s) => s.anchor === t.guide.anchor);
      expect(sec, `${t.id}: #${t.guide.anchor}`).toBeDefined();
      const words = [t.title, t.short, ...t.aliases];
      expect(
        words.some((w) => sec?.body.includes(w)),
        `${t.id}: #${t.guide.anchor}`,
      ).toBe(true);
    }
  });

  it('マニュアルに用語集の節がある', () => {
    expect(guide).toContain('用語集');
    expect(ANCHORS.has('用語集説明カード')).toBe(true);
  });
});

describe('説明の語（#167 AC-4）', () => {
  const text = (id: string) => {
    const t = termById(id);
    if (!t) throw new Error(id);
    return [t.summary, ...t.body, t.formula ?? ''].join('\n');
  };

  it('IV は価格から逆算、HV は実際の値動き、σ はグリークではない', () => {
    expect(text('iv')).toContain('価格');
    expect(text('iv')).toContain('逆算');
    expect(text('hv')).toContain('実際');
    expect(text('hv')).toMatch(/値動き|変動/);
    expect(text('iv')).toContain('グリークではない');
    expect(text('greeks')).toContain('グリークではない');
    expect(text('vega')).toContain('グリークではない');
  });

  it('Δ・Γ・Θ・ベガの単位（docs/design.md 5.6）', () => {
    expect(text('delta')).toContain('ラージ換算');
    expect(text('delta')).toContain('ミニ換算');
    expect(text('gamma')).toContain('/ 100 円');
    expect(text('theta')).toContain('円 / 暦日');
    expect(text('vega')).toContain('円 / IV 1pt');
  });

  it('検索語は見出し・読み・別名を改行で区切った文字', () => {
    const t = termById('skew');
    expect(t && termSearchText(t).split('\n')).toEqual([
      'スキュー Δs',
      'すきゅー でるたえす',
      ...(t?.aliases ?? []),
    ]);
  });

  it('#179 追証マップ: 見出し・短い形は新しい名前、旧名「持ちこたえマップ」は別名で引ける、追証の側は概算・引けの清算値', () => {
    const t = termById('hold-map');
    expect(t?.title).toBe('追証マップ');
    expect(t?.short).toBe('追証マップ');
    expect(t?.reading).toBe('おいしょうまっぷ');
    expect(t?.aliases).toContain('持ちこたえマップ');
    expect(t && termSearchText(t)).toContain('持ちこたえ');
    expect(t?.guide).toEqual({
      anchor: '追証マップ',
      title: '8 章 作業台: 指標 · テール > 追証マップ',
    });
    expect(text('hold-map')).toContain('原資産と IV が同時に動いたときの余力');
    expect(text('hold-map')).toContain('概算');
    expect(text('hold-map')).toContain('引けの清算値');
    // 旧名は別名の 1 か所だけ（見出し・説明・出る場所・関連する用語の文に残さない）
    for (const u of GLOSSARY) {
      const strs = [u.title, u.short, u.reading, u.summary, ...u.body, ...u.where, u.guide.title];
      for (const x of strs) expect(x, u.id).not.toContain('持ちこたえ');
    }
  });
});

describe('説明カードの表示モデル（#167 AC-7）', () => {
  it('存在する id で見出し・読み・別名・説明・式・例・出る場所・マニュアルの節・関連する用語', () => {
    const v = termCardView('iv');
    const t = termById('iv');
    if (!v || !t) throw new Error('iv が無い');
    expect(v.id).toBe('iv');
    expect(v.title).toBe(t.title);
    expect(v.reading).toBe(t.reading);
    expect(v.aliases).toBe(t.aliases.join(' · '));
    expect(v.summary).toBe(t.summary);
    expect(v.body).toEqual(t.body);
    expect(v.formula).toBe(t.formula);
    expect(v.example).toBe(t.example);
    expect(v.where).toEqual(t.where);
    expect(v.guide).toBe(t.guide.title);
    expect(v.related.map((r) => r.id)).toEqual(t.related);
    for (const r of v.related) {
      expect(r.title).toBe(termById(r.id)?.title);
      expect(r.short).toBe(termById(r.id)?.short);
    }
    // 関連にベガ（AC-10 の手順）
    expect(v.related.some((r) => r.id === 'vega')).toBe(true);
  });

  it('式・例の無い用語は null', () => {
    const v = termCardView('jscc');
    expect(v?.formula).toBeNull();
    expect(v?.example).toBeNull();
  });

  it('存在しない id で null', () => {
    expect(termCardView('nope')).toBeNull();
    expect(termCardView('')).toBeNull();
    expect(termById('__proto__')).toBeNull();
  });

  it('ⓘ の 6 か所の用語の並びの id がすべて存在し、重複しない', () => {
    expect(Object.keys(HINT_TERMS).sort()).toEqual(
      ['futHistory', 'ivHistory', 'metrics', 'positions', 'scenario', 'stage'].sort(),
    );
    for (const [k, ids] of Object.entries(HINT_TERMS)) {
      expect(ids.length, k).toBeGreaterThan(0);
      expect(new Set(ids).size, k).toBe(ids.length);
      for (const id of ids) expect(termById(id), `${k}: ${id}`).not.toBeNull();
    }
    // AC-11: シナリオの ⓘ に Δs
    expect(HINT_TERMS.scenario).toContain('skew');
  });

  it('全部の用語でカードが作れる（決定的）', () => {
    for (const t of GLOSSARY) {
      expect(termCardView(t.id)).toEqual(termCardView(t.id));
      expect(termCardView(t.id)?.related.length).toBe(t.related.length);
    }
  });
});
