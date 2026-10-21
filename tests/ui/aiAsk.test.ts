import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { DEFAULT_MARGIN_PREFS } from '../../ui/prefs';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import {
  AI_ASK_TOPICS,
  ASK_DOCS,
  ASK_PREFIX,
  ASK_WHAT,
  askIvHistory,
  askMarginTail,
  askReadout,
  askTail,
  askTile,
  docsLine,
} from '../../ui/view/aiAsk';
import { MAX_USER_TEXT } from '../../ui/view/aiChat';
import { fmtIvPt, ivReadout } from '../../ui/view/ivHistory';
import {
  capitalOf,
  type MarginView,
  marginNow,
  marginParamsOf,
  marginPoint,
  marginPointAt,
  marginTail,
} from '../../ui/view/margin';
import { metricsModel } from '../../ui/view/metrics';
import { MARGIN_TAIL_TITLE, metricsPanel } from '../../ui/view/metricsPanel';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { readoutModel } from '../../ui/view/readout';
import { bigReadout } from '../../ui/view/stage';
import { fixture } from '../support/fixtures';

/**
 * #136 AC1: 数字・パネルから [AI に聞く] の質問の文（ui/view/aiAsk.ts）。合成の板・架空の値。
 * 説明の節は read_doc の索引（api/src/simulator_api/ai/docs.py の parse。ADR-0007 決定 5）と同じ規則で文書を解析して
 * 番号と見出しが在ることを確かめる（文書の改訂で番号がずれたら落ちる）。場所の ID は中継の許可リストと突き合わせる。
 */

/** Node の fs（@types/node を足さないため型はここで最小限に書く。tests/ui/glossary.test.ts と同じ） */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const chain = normalizeChain(fixture('latest'));
const [m1] = chain.months;
if (!m1) throw new Error('限月が無い');

const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const add = (k: number, optionType: 'put' | 'call', side: 'buy' | 'sell'): Action => ({
  type: 'addBoardLeg',
  expiry: m1.id,
  k,
  optionType,
  side,
});
const loaded = reduce(initialState, { type: 'loaded', chain, label: 'latest' });
/** ストラングル売り（架空の値）+ シナリオ */
const strangle = run(loaded, add(64_000, 'put', 'sell'), add(71_000, 'call', 'sell'), {
  type: 'setScenario',
  patch: { days: 1.5, dX: -400, dSigma: 2 },
});

function baseOf(s: State) {
  const settings: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot };
  const pm = positionModel(chain, s.legs, s.atmBasis, CALENDAR, settings);
  const base = pnlDomains(chain, pm.prepared, pm.ctx, settings);
  if (!base) throw new Error('基礎が作れない');
  return base;
}

function marginOf(s: State): MarginView {
  const base = baseOf(s);
  const prefs = { ...DEFAULT_MARGIN_PREFS, capitalYen: 50_000_000 };
  const params = marginParamsOf(prefs);
  const capital = capitalOf(prefs);
  const { holidays } = CALENDAR;
  return {
    capital,
    params,
    now: marginNow(base, s.scenario, params, capital, holidays),
    point: marginPoint(base, s.scenario, params, capital, holidays),
    at: marginPointAt(base, s.scenario),
    tail: marginTail(base, { ...s.scenario, dX: 0 }, params, capital, holidays),
  };
}

const base = baseOf(strangle);
const mm = metricsModel({ base, scenario: strangle.scenario, unit: 'auto' });
const view = metricsPanel(mm, strangle.feePerLot, marginOf(strangle));
const items = bigReadout(
  readoutModel({ base, metrics: mm, scenario: strangle.scenario }),
  mm.premium,
  base.ctx.evalTime,
  strangle.scenario.dSigma,
);

// ---------------------------------------------------------------- 文書の索引（docs.py の parse と同じ規則）

interface DocSection {
  id: string;
  title: string;
}

const HEADING_RE = /^(#{2,4}) +(.+?) *#* *$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;
const NUM_RE = /^([0-9]+(?:\.[0-9]+)*)\.? +(.*)$/;
const HISTORY_RE = /[（(][^（）()]*(?:#[0-9]+|\b[KDQR][0-9]+\b)[^（）()]*[）)]/g;
const cleanTitle = (t: string) => t.replace(HISTORY_RE, '').replace(/ {2,}/g, ' ').trim();

/** 見出しの番号か、親の番号 + 兄弟の順。番号の無い章（目次・付録）は節にしない。chapters があればその章だけ */
function sections(text: string, chapters: readonly string[] | null): DocSection[] {
  const heads: { level: number; raw: string }[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = HEADING_RE.exec(line);
    if (m?.[1] && m[2]) heads.push({ level: m[1].length, raw: m[2] });
  }
  const out: DocSection[] = [];
  let stack: { level: number; id: string }[] = [];
  const count = new Map<string, number>();
  let chapterOk = false;
  for (const { level, raw } of heads) {
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
    const m = NUM_RE.exec(raw);
    let id: string;
    let title: string;
    if (level === 2) {
      stack = [];
      if (!m?.[1] || m[1].includes('.')) {
        chapterOk = false;
        continue;
      }
      id = m[1];
      title = m[2] ?? '';
      chapterOk = chapters === null || chapters.includes(id);
    } else {
      const parent = stack.at(-1)?.id;
      if (!chapterOk || parent === undefined) continue;
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
    if (!chapterOk) continue;
    stack.push({ level, id });
    out.push({ id, title: cleanTitle(title) });
  }
  return out;
}

const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const DOCS = {
  'user-guide': sections(read('docs/user-guide.md'), null),
  design: sections(read('docs/design.md'), ['3', '5']),
} as const;

describe('#136 AC1 [AI に聞く] の説明の節', () => {
  it('索引の規則が read_doc の例と同じ（マニュアル 8.5「追証マップ」・設計書 5.6.1「JPX グリークの単位」）', () => {
    expect(DOCS['user-guide']).toContainEqual({ id: '8.5', title: '追証マップ' });
    expect(DOCS.design).toContainEqual({ id: '5.6.1', title: 'JPX グリークの単位' });
    // design は 3 章・5 章だけ
    expect(DOCS.design.every((s) => /^[35](\.|$)/.test(s.id))).toBe(true);
  });

  it('全部の場所の説明の節が文書に同じ番号・同じ見出しで在り、先頭はマニュアル', () => {
    for (const topic of AI_ASK_TOPICS) {
      const docs = ASK_DOCS[topic];
      expect(docs.length, topic).toBeGreaterThan(0);
      expect(docs[0]?.file, topic).toBe('user-guide');
      for (const d of docs) {
        expect(DOCS[d.file], `${topic} ${d.file} ${d.section}`).toContainEqual({
          id: d.section,
          title: d.title,
        });
      }
    }
  });

  it('説明の節の行は「マニュアル N.N「見出し」」の形', () => {
    expect(docsLine('tile.maxLoss')).toBe(
      '説明の節: マニュアル 8.1「タイル」・設計書 5.6「損益・指標・グリーク」',
    );
    expect(docsLine('iv.history')).toBe(
      '説明の節: マニュアル 10.4「IV 推移（ATM IV の 30 日固定）」・マニュアル 10.7「「今」の点とシナリオの水準」',
    );
  });
});

describe('#136 AC1 場所の ID は中継の許可リストと同じ', () => {
  it('allowlist.py の ASK_TOPICS と同じ並び', () => {
    const py = read('api/src/simulator_api/ai/allowlist.py');
    const m = /^ASK_TOPICS = \(([^)]*)\)/m.exec(py);
    expect(m, 'ASK_TOPICS が無い').not.toBeNull();
    const ids = [...(m?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(ids).toEqual([...AI_ASK_TOPICS]);
  });

  it('kind の列挙に ask がある（data/aiStream.ts の AiKind と allowlist.py の KINDS）', () => {
    const py = read('api/src/simulator_api/ai/allowlist.py');
    expect(py).toMatch(/^KINDS = \("chat", "diagnose", "ask", "preset"\)/m);
  });
});

/** 文の共通の形: 先頭・パネルと見出し・聞くこと・説明の節（最後の行）・上限 */
function expectShape(
  text: string,
  panel: string,
  title: string,
  topic: (typeof AI_ASK_TOPICS)[number],
) {
  const lines = text.split('\n');
  expect(lines[0]).toBe(`${ASK_PREFIX}${panel} ›「${title}」`);
  expect(lines).toContain(ASK_WHAT);
  expect(lines.at(-1)).toBe(docsLine(topic));
  expect(text.length).toBeLessThanOrEqual(MAX_USER_TEXT);
}

describe('#136 AC1 質問の文（表示モデルの文字列のまま）', () => {
  it('タイル 8 枚: 見出し・全文の全部の行（値は表示のまま）・金額の単位・説明の節', () => {
    expect(view.tiles.map((t) => t.key)).toEqual([
      'maxProfit',
      'maxLoss',
      'bep',
      'premium',
      'scenario',
      'greeks',
      'margin',
      'room',
    ]);
    for (const t of view.tiles) {
      const a = askTile(t, view.unitSub);
      expect(a.topic).toBe(`tile.${t.key}`);
      expect(a.title).toBe(t.k);
      expectShape(a.text, '指標 · テール', t.k, a.topic);
      expect(a.text).toContain(`金額の単位: ${view.unitSub}`);
      for (const r of t.full) expect(a.text).toContain(r.k === '' ? r.v : `- ${r.k}: ${r.v}`);
    }
  });

  it('必要証拠金・余力は値の点（見出しの横の印）を添える', () => {
    const t = view.tiles.find((x) => x.key === 'margin');
    if (!t) throw new Error('margin が無い');
    expect(t.at).not.toBe('');
    const a = askTile(t, view.unitSub);
    expect(a.text).toContain(`値の点: ${t.at.replace(/^·\s*/, '')}`);
    expect(a.text).toContain('マニュアル 8.4「証拠金（概算）」');
  });

  it('合計グリークの全文の Δ・Γ・Θ・V が入る', () => {
    const t = view.tiles.find((x) => x.key === 'greeks');
    if (!t) throw new Error('greeks が無い');
    const a = askTile(t, view.unitSub);
    for (const k of ['Γ', 'Θ', 'V']) expect(a.text).toMatch(new RegExp(`- ${k}: `));
  });

  it('読み取り: 全文のある 4 項目だけ（Θ・V は null）', () => {
    const asks = items.map((it) => ({ key: it.key, a: askReadout(it) }));
    expect(asks.filter((x) => x.a !== null).map((x) => x.key)).toEqual([
      'date',
      'expiry',
      'delta',
      'premium',
    ]);
    for (const it of items) {
      const a = askReadout(it);
      if (!a || !it.full) continue;
      expect(a.topic).toBe(`readout.${it.key}`);
      expectShape(a.text, '損益グラフの読み取り（シナリオ点）', it.label, a.topic);
      for (const r of it.full) expect(a.text).toContain(r.v);
    }
  });

  it('テール表: 5 行の原資産・SQ・指定日 + シナリオと倍率、表の注記', () => {
    const a = askTail(view);
    if (!a) throw new Error('テール表が無い');
    expect(a.topic).toBe('tail.pnl');
    expectShape(a.text, '指標 · テール', 'テール表', 'tail.pnl');
    expect(a.text).toContain(view.tailCaption);
    expect(view.tail.length).toBe(5);
    for (const r of view.tail) {
      const u = view.unitSub.replace(/（.*$/, '');
      expect(a.text).toContain(
        `- 原資産 ${r.pct}（${r.x} 円）: SQ ${r.sq.pnl} ${u}（${r.sq.ratio}）・指定日 + シナリオ ${r.scenario.pnl} ${u}（${r.scenario.ratio}）`,
      );
    }
  });

  it('証拠金のテール表: 必要証拠金・余力（追証の印）', () => {
    const a = askMarginTail(view, MARGIN_TAIL_TITLE);
    if (!a) throw new Error('証拠金のテール表が無い');
    expect(a.topic).toBe('tail.margin');
    expectShape(a.text, '指標 · テール', MARGIN_TAIL_TITLE, 'tail.margin');
    const u = view.unitSub.replace(/（.*$/, '');
    for (const r of view.marginTail)
      expect(a.text).toContain(`必要証拠金 ${r.margin} ${u}・余力 ${r.room} ${u}`);
  });

  it('足が無い（empty）ならテール表・証拠金のテール表は null', () => {
    const empty = metricsPanel(
      metricsModel({ base: null, scenario: strangle.scenario, unit: 'auto' }),
      100,
    );
    expect(askTail(empty)).toBeNull();
    expect(askMarginTail(empty, MARGIN_TAIL_TITLE)).toBeNull();
  });

  it('IV 推移: 足の名前・読み取りの 1 行・今・シナリオの水準（読み取りの文字列のまま）', () => {
    // 架空の足（%）
    const bars = [
      { t: 1_760_000_000, o: 20.1, h: 21.5, l: 19.8, c: 21.2 },
      { t: 1_760_003_600, o: 21.2, h: 22.4, l: 20.9, c: 22.03 },
    ];
    const ro = ivReadout(bars, '1h', null, true);
    const a = askIvHistory({
      tfLabel: '1 時間足',
      readout: ro,
      cursor: false,
      now: fmtIvPt(22.11),
      scenario: fmtIvPt(27.11),
    });
    if (!a) throw new Error('IV が無い');
    expect(a.topic).toBe('iv.history');
    expectShape(a.text, 'IV 推移', 'ATM IV（30 日固定）', 'iv.history');
    expect(a.text).toContain(
      `- 最新の足（1 時間足）: ${ro.time} 始 ${ro.o} · 高 ${ro.h} · 安 ${ro.l} · 終 ${ro.c}（確定前）`,
    );
    expect(a.text).toContain('- 今（今の板から計算）: 22.11');
    expect(a.text).toContain('- シナリオの水準: 27.11');
    // カーソルの足・今とシナリオが無い
    const b = askIvHistory({
      tfLabel: '日足',
      readout: ivReadout(bars, '1d', 0, false),
      cursor: true,
      now: null,
      scenario: null,
    });
    expect(b?.text).toContain('- カーソルの足（日足）: ');
    expect(b?.text).not.toContain('今（今の板から計算）');
    // 足が無い
    expect(
      askIvHistory({
        tfLabel: '日足',
        readout: ivReadout([], '1d', null, false),
        cursor: false,
        now: null,
        scenario: null,
      }),
    ).toBeNull();
  });
});
