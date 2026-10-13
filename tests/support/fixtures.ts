/** 合成の板 JSON（fixtures/synthetic/。架空の値）を検証済みの形で読む。 */

import { type ChainJson, validateChainJson } from '../../data/chainJson';
import latest from '../../fixtures/synthetic/latest.json';
import nightEarly from '../../fixtures/synthetic/night_early.json';
import preOpen from '../../fixtures/synthetic/pre_open.json';

export const RAW_FIXTURES: Record<string, unknown> = {
  'latest.json': latest,
  'night_early.json': nightEarly,
  'pre_open.json': preOpen,
};

/** 検証して返す（毎回新しいコピー。テストで書き換えてよい）。 */
export function fixture(name: 'latest' | 'night_early' | 'pre_open'): ChainJson {
  const res = validateChainJson(structuredClone(RAW_FIXTURES[`${name}.json`]));
  if (!res.ok) throw new Error(`fixture が不正: ${res.errors.join('; ')}`);
  return res.value;
}

/** 検証前の素の値のコピー（壊れた入力を作るのに使う）。 */
export function rawFixture(name: 'latest' | 'night_early' | 'pre_open'): Record<string, unknown> {
  return structuredClone(RAW_FIXTURES[`${name}.json`]) as Record<string, unknown>;
}
