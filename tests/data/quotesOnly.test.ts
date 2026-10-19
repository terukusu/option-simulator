/**
 * 気配だけの板（#154。docs/data-sources.md「板の契約」）: 供給元によって欠けうる項目（気配の IV・約定・約定 IV・
 * グリーク・取引高・建玉・清算値・ATM の表示・日経平均）がすべて null でも、検証・正規化・スマイル・足・板の表示が動く。
 * 板は合成の latest.json（架空の値）から欠けうる項目を消して作る。
 */

import { describe, expect, it } from 'vitest';
import { type ChainJson, type ChainSide, validateChainJson } from '../../data/chainJson';
import { boardOptionLeg, buildMarketContext } from '../../data/legs';
import { normalizeChain } from '../../data/normalize';
import { evaluatePosition, preparePosition } from '../../model/position';
import { ZERO_SCENARIO } from '../../model/scenario';
import { sqInstant, yearFraction } from '../../model/time';
import { buildChainJson, SPECS } from '../../scripts/synthBoard';
import { boardRows, sideMarkLabels } from '../../ui/view/board';
import { boardRowTexts } from '../../ui/view/boardPanel';
import { fixture } from '../support/fixtures';
import { makeSvi, sviTotalVariance } from '../support/synthChain';

const OPTIONAL_SIDE_KEYS = [
  'bid_iv',
  'ask_iv',
  'price',
  'price_time',
  'iv',
  'volume',
  'positions',
  'quotation',
  'quotation_date',
  'delta',
  'gamma',
  'theta',
  'vega',
  'is_atm',
] as const satisfies readonly (keyof ChainSide)[];

/** 欠けうる項目をすべて null にした板（気配 bid / ask と限月・先物だけが残る） */
function quotesOnly(json: ChainJson): ChainJson {
  const out = structuredClone(json);
  out.source = 'quotes-only';
  out.spot = { price: null, price_time: null };
  for (const m of out.months) {
    for (const row of m.rows) {
      for (const side of [row.call, row.put]) {
        for (const k of OPTIONAL_SIDE_KEYS) (side as unknown as Record<string, null>)[k] = null;
      }
    }
  }
  return out;
}

const spec = SPECS.find((s) => s.name === 'latest');
if (!spec) throw new Error('latest の spec が無い');
const json = quotesOnly(fixture('latest'));

describe('気配だけの板（#154）', () => {
  it('(a) 板の JSON 版 1 の検証を通る', () => {
    const res = validateChainJson(structuredClone(json));
    expect(res.ok).toBe(true);
  });

  const chain = normalizeChain(json);

  it('(b) 1 限月の F を生成時の F* から ±10 円で回復し、スマイルが作れる', () => {
    const m1 = chain.months[0];
    if (!m1) throw new Error();
    expect(m1.syntheticOk).toBe(true);
    expect(Math.abs(m1.F - (spec.months[0]?.F as number))).toBeLessThanOrEqual(10);
    chain.months.forEach((m) => {
      expect(m.smile).not.toBeNull();
    });
  });

  it('気配の IV の提供なしと判定し、元の板（提供あり）とは区別する', () => {
    expect(chain.quoteIvProvided).toBe(false);
    expect(normalizeChain(fixture('latest')).quoteIvProvided).toBe(true);
  });

  it('(c) どのセルにも「JPX の IV 欠損」の印が無い', () => {
    for (const m of chain.months) {
      for (const row of boardRows(chain, m)) {
        for (const cell of [row.call, row.put]) {
          expect(cell.jpxIvMissing).toBe(false);
          expect(sideMarkLabels(cell)).not.toContain('JPX の IV 欠損');
        }
      }
    }
  });

  it('(d) 1 限月の F ±5% の両側気配の行で、板の IV 列は気配から求めた IV（真の IV を bid / ask の IV ±0.5pt で挟む）', () => {
    const m1 = chain.months[0];
    const ms = spec.months[0];
    if (!m1 || !ms) throw new Error();
    // 合成の真の IV（scripts/synthBoard.ts の buildMonth と同じ式）
    const T = yearFraction(Date.parse(json.snapshot_at), sqInstant(ms.sqDate));
    const svi = makeSvi(T, ms.atmVol, ms.leftVol, Math.log(0.6), ms.rho ?? -0.7);
    const truePct = (k: number) => Math.sqrt(sviTotalVariance(svi, Math.log(k / ms.F)) / T) * 100;
    let n = 0;
    for (const row of boardRows(chain, m1)) {
      if (Math.abs(row.k / m1.F - 1) > 0.05) continue;
      for (const cell of [row.call, row.put]) {
        if (cell.quote !== 'two_sided') continue;
        n += 1;
        expect(cell.bidIv).not.toBeNull();
        expect(cell.askIv).not.toBeNull();
        const t = truePct(row.k);
        expect(cell.bidIv as number).toBeLessThanOrEqual(t + 0.5);
        expect(cell.askIv as number).toBeGreaterThanOrEqual(t - 0.5);
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it('板のパネルの文字列: IV 列に数字が出て、IV 欠損の印が無い', () => {
    const m1 = chain.months[0];
    if (!m1) throw new Error();
    const texts = boardRowTexts(chain, m1, boardRows(chain, m1));
    const atm = m1.atm.B.pick?.k as number;
    const t = texts.get(atm);
    expect(t?.call.iv).toMatch(/^\d+\.\d\/\d+\.\d$/);
    for (const v of texts.values()) {
      for (const side of [v.call, v.put]) {
        expect(side.marks.some((m) => m.kind === 'ivMissing')).toBe(false);
      }
    }
  });

  it('提供ありの板の IV 列は JSON の値のまま（気配から計算しない）', () => {
    const orig = normalizeChain(fixture('latest'));
    const m1 = orig.months[0];
    if (!m1) throw new Error();
    boardRows(orig, m1).forEach((row, i) => {
      expect(row.call.bidIv).toBe(m1.source[i]?.call.bid_iv);
      expect(row.put.askIv).toBe(m1.source[i]?.put.ask_iv);
    });
  });

  it('板から足を入れて評価できる（建値 = ask、Δ・V が有限）', () => {
    const m1 = chain.months[0];
    if (!m1) throw new Error();
    const row = m1.strikes.find(
      (s) => s.otmType === 'put' && s.put.quote === 'two_sided' && s.k < m1.F * 0.97,
    );
    if (!row) throw new Error('両側気配の OTM put が無い');
    const built = boardOptionLeg(chain, { expiry: m1.id, k: row.k, type: 'put', side: 'buy' });
    expect(built.leg.entry).toBe(m1.rows.find((r) => r.k === row.k)?.put.ask);
    const ctx = buildMarketContext(chain);
    const total = evaluatePosition(preparePosition([built.leg], ctx), ZERO_SCENARIO, ctx).total;
    expect(Number.isFinite(total.deltaLarge)).toBe(true);
    expect(total.deltaLarge).toBeLessThan(0);
    expect(total.vegaPerPt).toBeGreaterThan(0);
  });

  it('生成器の板（buildChainJson）でも同じ（fixture に依らない）', () => {
    const c = normalizeChain(quotesOnly(buildChainJson(spec)));
    expect(c.quoteIvProvided).toBe(false);
    expect(c.months.every((m) => m.smile !== null)).toBe(true);
  });
});
