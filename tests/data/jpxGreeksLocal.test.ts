/// <reference types="vite/client" />
/**
 * AC7 の手元検証（設計 2.2 AC7・5.6「JPX グリークの単位」。#37）。
 * 実データの dump（fixtures/local/*.json のうち `source: "bigquery"`。gitignore 済み・コミットしない）があれば、
 * 限月ごとに JPX のグリークが新しい足（約定から 5 分以内）で組んだ 2 つの組（売買交互・すべて買い）の
 * 合計 Δ・V を閾値（AC7_TOLERANCE）で照合する。dump が無ければスキップ（CI）。
 * 出すのは件数と「差 / 許容差」の最大だけ（価格・グリークの値は出さない）。
 *
 * dump の作り方: api の `chain.parse_board` / `chain_json` で option_price_latest 等の行を板の JSON 版 1 にして置く
 * （読み取りのみ。bq は --dry_run → --maximum_bytes_billed → created_at で絞る）。
 */
import { describe, expect, it } from 'vitest';
import { validateChainJson } from '../../data/chainJson';
import { ac7Check } from '../../data/jpxGreeks';
import { buildMarketContext } from '../../data/legs';
import { normalizeChain } from '../../data/normalize';

const dumps = import.meta.glob('../../fixtures/local/*.json', { eager: true, import: 'default' });
const names = Object.keys(dumps).filter(
  (n) => (dumps[n] as { source?: unknown } | null)?.source === 'bigquery',
);

describe.skipIf(names.length === 0)('AC7: 実データの dump で合計 Δ・V が JPX 値と整合', () => {
  let books = 0;
  it.each(names)('%s', (name) => {
    const res = validateChainJson(dumps[name]);
    expect(res.ok ? [] : res.errors).toEqual([]);
    if (!res.ok) return;
    const chain = normalizeChain(res.value);
    const results = ac7Check(chain, buildMarketContext(chain));
    books += results.length;
    for (const r of results) {
      const c = r.comparison;
      console.log(
        `${r.month} ${r.book}: 足 ${c.legs}、Δ 差/許容 ${(Math.abs(c.delta.diff) / c.delta.limit).toFixed(2)}、` +
          `V 差/許容 ${(Math.abs(c.vega.diff) / c.vega.limit).toFixed(2)}`,
      );
      expect(c.ok, `${r.month} ${r.book}`).toBe(true);
    }
  });
  it('照合した組が 1 つ以上ある', () => {
    expect(books).toBeGreaterThan(0);
  });
});
