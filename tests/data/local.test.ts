/// <reference types="vite/client" />
/**
 * 実データの dump（fixtures/local/*.json。gitignore 済み・コミットしない）があれば、
 * 検証と正規化が通るかを手元で確かめる。無ければスキップ。出すのは件数だけ（値は出さない）。
 */
import { describe, expect, it } from 'vitest';
import { validateChainJson } from '../../data/chainJson';
import { normalizeChain } from '../../data/normalize';

const dumps = import.meta.glob('../../fixtures/local/*.json', { eager: true, import: 'default' });
const names = Object.keys(dumps);

describe.skipIf(names.length === 0)('実データの dump（fixtures/local/）', () => {
  it.each(names)('%s は検証・正規化が通る', (name) => {
    const res = validateChainJson(dumps[name]);
    expect(res.ok ? [] : res.errors).toEqual([]);
    if (!res.ok) return;
    const chain = normalizeChain(res.value);
    for (const m of chain.months) {
      const unstable = m.strikes.filter((s) => s.unstable).length;
      const nodes = m.strikes.filter((s) => s.mark === 'node').length;
      console.log(
        `${m.id}: 行 ${m.rows.length}、F ${m.forward.method}、節点 ${nodes}、不安定 ${unstable}、裁定の印 ${m.violations.length}`,
      );
    }
  });
});
