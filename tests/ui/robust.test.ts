import { describe, expect, it } from 'vitest';
import { type ChainJson, normalizeChain } from '../../data';
import { sqInstant } from '../../model';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { boardModel } from '../../ui/view/board';
import { headerModel } from '../../ui/view/header';
import { positionModel } from '../../ui/view/position';
import { smileModel } from '../../ui/view/smile';
import { fixture } from '../support/fixtures';

/** AC-14: 壊れた板・少ない板・満期直前でも表示モデルが例外を出さない。 */
function blank(j: ChainJson): ChainJson {
  j.future.price = null;
  j.future.price_time = null;
  for (const m of j.months) {
    for (const r of m.rows) {
      for (const s of [r.call, r.put]) {
        s.bid = null;
        s.ask = null;
        s.price = null;
      }
    }
  }
  return j;
}

function allModels(state: State) {
  const chain = state.chain;
  if (!chain) throw new Error('板が無い');
  const header = headerModel(chain, 'B');
  const boards = chain.months.map((m) => boardModel(chain, m, 'B'));
  const smiles = chain.months.flatMap((m) =>
    (['k', 'moneyness', 'delta'] as const).map((a) => smileModel(m, 'B', a)),
  );
  const positions = positionModel(chain, state.legs, 'B');
  return { header, boards, smiles, positions };
}

function withLegs(json: ChainJson, evalTime?: number): State {
  const chain = normalizeChain(json, evalTime === undefined ? {} : { evalTime });
  const s0 = reduce(initialState, { type: 'loaded', chain, label: 'test' });
  const actions: Action[] = [];
  for (const m of chain.months) {
    const k = m.atm.B.pick?.k ?? m.rows[Math.floor(m.rows.length / 2)]?.k ?? 0;
    actions.push(
      { type: 'addBoardLeg', expiry: m.id, k, optionType: 'put', side: 'sell' },
      { type: 'addBoardLeg', expiry: m.id, k, optionType: 'call', side: 'buy' },
    );
  }
  actions.push(
    { type: 'addFutureLeg', input: { side: 'buy', entry: 67000 } },
    {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2027-01',
        type: 'put',
        k: 60000,
        side: 'sell',
        entry: 300,
        iv: 0.3,
      },
    },
  );
  return actions.reduce(reduce, s0);
}

describe('壊れた板・少ない板・満期直前', () => {
  it('気配も先物も消した板: 「F なし」「ATM なし」「スマイルなし」で例外を出さない', () => {
    const state = withLegs(blank(fixture('latest')));
    const { header, smiles, positions, boards } = allModels(state);
    for (const m of header.months) {
      expect(m.forward).toBe('F なし');
      expect(m.noForward).toBe(true);
      expect(m.atm).toBe('ATM なし');
      expect(m.refA.price).toBe('—');
    }
    for (const s of smiles) expect(s.empty).toBe(true);
    for (const b of boards) {
      expect(b.atmK).toBeNull();
      expect(b.rows.every((r) => r.call.delta === null && r.put.delta === null)).toBe(true);
    }
    expect(positions.rows.length).toBe(state.legs.length);
    expect(state.legs.length).toBeGreaterThan(0);
  });

  it('night_early（行使価格が少ない）: 板・スマイル・ポジションの表示モデルが作れる', () => {
    const state = withLegs(fixture('night_early'));
    const { boards, smiles, positions } = allModels(state);
    expect(boards.every((b) => b.rows.length > 0 && b.atmK !== null)).toBe(true);
    expect(smiles.every((s) => !s.empty)).toBe(true);
    for (const r of positions.rows) {
      expect(r.error).toBeNull();
      expect(r.greeks).not.toBeNull();
    }
  });

  it('評価時刻が 1 限月の SQ 日 9:00 の 1 分前: 1 限月の足のグリーク・建値ずれが有限', () => {
    const json = fixture('latest');
    const sq = sqInstant(json.months[0]?.sq_date as string);
    const state = withLegs(json, sq - 60_000);
    const { positions, smiles } = allModels(state);
    const id1 = state.chain?.months[0]?.id;
    const rows = positions.rows.filter((r) => r.month === id1);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.greeks).not.toBeNull();
      for (const v of Object.values(r.greeks ?? {})) expect(Number.isFinite(v)).toBe(true);
      expect(Number.isFinite(r.mismatchYen as number)).toBe(true);
    }
    expect(smiles.length).toBe(6);
  });
});
