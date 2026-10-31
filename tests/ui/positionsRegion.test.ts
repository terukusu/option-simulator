import { describe, expect, it } from 'vitest';
import { type Chain, type ChainJson, normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings, premiumSummary, smileFairValue } from '../../model';
import { rebaseLegs } from '../../ui/legRebase';
import {
  type Action,
  initialState,
  MAX_TABS,
  parseContract,
  parseIvPct,
  parseQty,
  reduce,
  type State,
  type UiLeg,
} from '../../ui/state';
import { fairView } from '../../ui/view/fairValue';
import { fmtIv, fmtNum, fmtSigned } from '../../ui/view/format';
import { HEDGE_REASON_LABEL, hedgeModel } from '../../ui/view/hedge';
import { fmtAmount, metricsModel } from '../../ui/view/metrics';
import { newTabUndoActions } from '../../ui/view/newTab';
import { pnlDomains } from '../../ui/view/pnlChart';
import {
  fmtEntry,
  legBadges,
  legSummary,
  type PositionRow,
  positionModel,
  stepQty,
} from '../../ui/view/position';
import {
  addedToast,
  clearUndo,
  dropUndoToasts,
  EMPTY_LEGS_TEXT,
  flipToast,
  futureForm,
  futureFormDefault,
  HEDGE_AT_OPTIONS,
  headSub,
  hedgeSection,
  hedgeSummary,
  legDetail,
  legFairValue,
  legSpreadCosts,
  OPTION_FORM_DEFAULT,
  optionForm,
  PICK_LABEL,
  positionRows,
  qtySpec,
  REBASE_COPY_UNDO_TEXT,
  rebasePlan,
  removeUndo,
  revealScrollTop,
  SHAPES_LABEL,
  scenarioLegsByRow,
} from '../../ui/view/positionsRegion';
import { isHot, stepBy } from '../../ui/view/stepper';
import { TABS_FULL_TEXT } from '../../ui/view/tabs';
import { pushToast, type Toast } from '../../ui/view/toast';
import { rebaseBlockedText } from '../../ui/view/topMenu';
import { fixture } from '../support/fixtures';

/**
 * #84: 新しい画面のポジションの領域の表示モデル（ui/view/positionsRegion.ts）。
 * 固定の合成の板（fixtures/synthetic/latest.json。架空の値）。
 */

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が無い');
const k1 = (m1.atm.B.pick?.k as number) - 2000;
const k2 = (m2.atm.B.pick?.k as number) - 2000;

const loaded = (c: Chain = chain) => reduce(initialState, { type: 'loaded', chain: c, label: 'x' });
const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);

function nullPrice(): Chain {
  const j: ChainJson = fixture('latest');
  j.future.price = null;
  j.future.price_time = null;
  return normalizeChain(j);
}

function views(s: State) {
  const c = s.chain as Chain;
  const settings: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot };
  const pm = positionModel(c, s.legs, s.atmBasis, s.calendar, settings);
  const base = pnlDomains(c, pm.prepared, pm.ctx, settings);
  const metrics = metricsModel({ base, scenario: s.scenario, unit: s.metricsUnit });
  const hedge = hedgeModel({
    chain: c,
    ctx: pm.ctx,
    base,
    settings,
    scenario: s.scenario,
    hedge: s.hedge,
    holidays: s.calendar.holidays,
  });
  return { pm, base, metrics, hedge, settings };
}

const sellPut = (expiry: string, k: number): Action => ({
  type: 'addBoardLeg',
  expiry,
  k,
  optionType: 'put',
  side: 'sell',
});
const buyPut = (expiry: string, k: number): Action => ({
  type: 'addBoardLeg',
  expiry,
  k,
  optionType: 'put',
  side: 'buy',
});

/** 足 3 本（売り 2 本 + ミニ先物の買い 1 本） */
const three = () =>
  run(loaded(), sellPut(m1.id, k1), sellPut(m2.id, k2), {
    type: 'addFutureLeg',
    input: { side: 'buy', qty: 1 },
  });

/** 板に無い限月（エラーの足。板を読み直して限月が消えた足と同じ） */
const errorLeg = (id: number): UiLeg => ({
  id,
  leg: {
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: '2099-01',
    strike: 60000,
    side: 'sell',
    qty: 1,
    entry: 300,
    mid: 290,
  },
  marks: [],
});

describe('理論価格の項目（#264）', () => {
  it('板の OP の足は fairView（板の気配に対する位置）、先物・板に無い足は —', () => {
    const s = three();
    const v = views(s);
    const [r0, , rf] = v.pm.rows as [PositionRow, PositionRow, PositionRow];
    const q = m1.rows[m1.strikes.findIndex((x) => x.k === k1)]?.put;
    const fv = legFairValue(chain, r0);
    expect(fv).toEqual(fairView(m1, k1, 'put', chain.r, q?.bid ?? null, q?.ask ?? null));
    const want = smileFairValue(m1.smile, m1.F, m1.T, chain.r, k1, 'put');
    expect(fv?.price).toBe(fmtNum(want?.price, (want?.price as number) < 99.95 ? 1 : 0));
    const item = legDetail(r0, null, null, v.metrics.unit, fv).items.find((i) => i.key === 'fair');
    expect(item?.label).toBe('理論価格（周りの行から）');
    // `17.0 · 気配の中ほど · IV 57.3`（位置が無ければ価格と IV）
    expect(item?.value).toBe(
      [fv?.price, fv?.position, `IV ${fv?.iv}`].filter((t) => t !== null).join(' · '),
    );
    expect(item?.value).toContain(`IV ${fmtNum((want?.iv as number) * 100, 1)}`);
    expect(rf.kind).toBe('future');
    expect(legFairValue(chain, rf)).toBeNull();
    expect(legFairValue(null, r0)).toBeNull();
    expect(legFairValue(chain, { ...r0, month: '2099-01' })).toBeNull();
    expect(
      legDetail(rf, null, null, v.metrics.unit).items.find((i) => i.key === 'fair')?.value,
    ).toBe('—');
  });

  it('外挿の行は「外挿」の印（tag）', () => {
    const deep = m1.strikes.find(
      (x) => smileFairValue(m1.smile, m1.F, m1.T, chain.r, x.k, 'put')?.mark === 'extrapolated',
    );
    if (!deep) throw new Error('外挿の行が無い');
    const s = run(loaded(), sellPut(m1.id, deep.k));
    const v = views(s);
    const row = v.pm.rows[0] as PositionRow;
    const item = legDetail(row, null, null, v.metrics.unit, legFairValue(chain, row)).items.find(
      (i) => i.key === 'fair',
    );
    expect(item?.tag).toBe('外挿');
  });
});

describe('AC-2 行の表示モデル', () => {
  const s = three();
  const { pm } = views(s);
  const rows = positionRows(pm);

  it('(a) OP の足と先物の足の行: 売買バッジ・名前・@建値・限月・IV（1 桁）・Δ（2 桁）・印', () => {
    expect(rows).toHaveLength(pm.rows.length);
    const [op, , fut] = rows;
    const [opRow, , futRow] = pm.rows as [PositionRow, PositionRow, PositionRow];
    expect(op).toMatchObject({
      id: opRow.id,
      badge: '売',
      side: 'sell',
      title: `P ${fmtNum(k1)}`,
      entry: `@${fmtEntry(opRow.entry)}`,
      sub: {
        month: m1.id,
        iv: fmtIv(opRow.iv),
        delta: fmtSigned(opRow.greeks?.deltaLarge, 2),
      },
      badges: legBadges(opRow),
      summary: legSummary(opRow),
    });
    // 本文のボタンの aria-label は売買・枚数・@建値・印も含む（中身を上書きするので）
    expect(op?.aria).toBe(`${m1.id} P ${fmtNum(k1)} 売り ×1 @${fmtEntry(opRow.entry)} の詳細`);
    expect(fut?.aria).toBe(`ミニ先物 ${chain.future.id} 買い ×1 @${fmtEntry(futRow.entry)} の詳細`);
    expect(op?.sub.iv).toMatch(/^\d+\.\d$/);
    expect(op?.sub.delta).toMatch(/^[+−]?\d+\.\d{2}$/);
    expect(fut).toMatchObject({
      badge: '買',
      title: 'ミニ先物',
      entry: `@${fmtEntry(futRow.entry)}`,
      sub: { month: chain.future.id, iv: null },
      badges: legBadges(futRow),
    });
    // 印は legBadges と同じ並び（IV 編集・エラー）
    const edited = run(s, { type: 'editLeg', id: opRow.id, patch: { iv: 0.3 } });
    const withErr = { ...edited, legs: [...edited.legs, errorLeg(99)] };
    const er = views(withErr);
    const r2 = positionRows(er.pm);
    expect(r2[0]?.badges.map((b) => b.text)).toContain('IV 編集');
    expect(r2[0]?.aria.endsWith(' IV 編集 の詳細')).toBe(true);
    expect(r2[3]?.badges).toEqual(legBadges(er.pm.rows[3] as PositionRow));
    expect(r2[3]?.warn).toBe(true);
    expect(r2[0]?.warn).toBe(false);
  });

  it('(b) 枚数のステッパーは 1〜100,000・1 段で stepQty と一致、.hot にしない', () => {
    for (const q of [1, 2, 7, 99_999, 100_000]) {
      const spec = qtySpec(q);
      expect(spec).toMatchObject({ min: 1, max: 100_000, step: 1 });
      expect(isHot(spec, q)).toBe(false);
      for (const d of [1, -1] as const) {
        const want = stepQty(q, d);
        const got = stepBy(spec, q, d);
        // 範囲外は端の値 = 動かない（Stepper はその方向のボタンを disabled にする）
        expect(want === null ? got === q : got === want).toBe(true);
      }
    }
    // qty 1 で − が押せない・100,000 で ＋ が押せない（Stepper の disabled = value <= min / >= max）
    expect(1 <= qtySpec(1).min).toBe(true);
    expect(100_000 >= qtySpec(100_000).max).toBe(true);
    expect(stepQty(1, -1)).toBeNull();
    expect(stepQty(100_000, 1)).toBeNull();
  });

  it('(c) 見出しの副題（#274 AC4）: 受取超・支払超とも `N 本`（受取 / 掛け金はタイルだけ）、0 本 `足なし`', () => {
    const recv = run(loaded(), sellPut(m1.id, k1), sellPut(m2.id, k2));
    expect(views(recv).metrics.premium.net).toBeGreaterThan(0);
    expect(headSub(2)).toBe('2 本');
    const paid = run(loaded(), buyPut(m1.id, k1));
    expect(views(paid).metrics.premium.stake).not.toBeNull();
    expect(headSub(1)).toBe('1 本');
    expect(headSub(0)).toBe('足なし');
  });

  it('(d) 足別のシナリオ点: 真ん中がエラーの足なら 1 本目と 3 本目に legs[0]・[1]、真ん中は null', () => {
    const a = run(loaded(), sellPut(m1.id, k1), sellPut(m2.id, k2));
    const [l1, l2] = a.legs as [UiLeg, UiLeg];
    const s3 = run(
      { ...a, legs: [l1, errorLeg(9), { ...l2, id: 10 }], nextId: 11 },
      { type: 'setScenario', patch: { dX: -500, days: 3 } },
    );
    const v = views(s3);
    expect(v.pm.rows[1]?.error).not.toBeNull();
    const by = scenarioLegsByRow(v.pm, v.base, v.metrics);
    expect(by).toHaveLength(3);
    expect(by[0]).toBe(v.metrics.scenarioPoint.legs[0]);
    expect(by[1]).toBeNull();
    expect(by[2]).toBe(v.metrics.scenarioPoint.legs[1]);
    // base.legs は prepared と同じ参照（filter で残す）。対応はこの同一性に依存する
    for (const p of v.base?.legs ?? []) expect(v.pm.prepared).toContain(p);
    // 詳細の足別は null なら —
    const d = legDetail(v.pm.rows[1] as PositionRow, null, null, v.metrics.unit);
    expect(d.scenario.parts).toEqual(['IV —', 'Δ —', 'Γ —', 'Θ — / 日', 'V — / pt']);
  });

  it('(d) F が NaN の足（先物価格の無い板の、板に無い限月の手入力 OP）は base.legs に無いので null、後ろの足はずれない', () => {
    const c = nullPrice();
    const om = c.months[0] as (typeof c.months)[number];
    const s = run(
      loaded(c),
      sellPut(om.id, k1),
      {
        type: 'addManualLeg',
        input: {
          product: 'op_large',
          expiry: '2099-03',
          type: 'put',
          k: 60000,
          side: 'sell',
          qty: 1,
          entry: 300,
          iv: 0.3,
        },
      },
      sellPut(om.id, k1 - 500),
    );
    expect(s.legs).toHaveLength(3);
    const v = views(s);
    expect(v.pm.prepared).toHaveLength(3);
    expect(v.base?.legs).toHaveLength(2);
    const by = scenarioLegsByRow(v.pm, v.base, v.metrics);
    expect(by[0]).toBe(v.metrics.scenarioPoint.legs[0]);
    expect(by[1]).toBeNull();
    expect(by[2]).toBe(v.metrics.scenarioPoint.legs[1]);
  });

  it('(e) 足 1 本のスプレッドコスト = premiumSummary([prepared]).spreadCost、和 = metrics.premium.spreadCost、mid なし・先物は null', () => {
    const s = run(three(), buyPut(m1.id, k1 - 1000), {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2099-03',
        type: 'put',
        k: 60000,
        side: 'sell',
        qty: 2,
        entry: 300,
        iv: 0.3,
      },
    });
    const v = views(s);
    const sc = legSpreadCosts(v.pm, v.settings);
    expect(sc).toHaveLength(5);
    expect(sc[0]).toBe(premiumSummary([v.pm.prepared[0] as never], v.settings).spreadCost);
    expect(sc[2]).toBeNull(); // 先物
    expect(sc[4]).toBeNull(); // 手入力（mid なし）
    const sum = sc.reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(Math.abs(sum - v.metrics.premium.spreadCost)).toBeLessThanOrEqual(1e-9);
    // 詳細の文字列は fmtAmount（符号つき）
    const d = legDetail(v.pm.rows[0] as PositionRow, null, sc[0] ?? null, v.metrics.unit);
    expect(d.items.find((i) => i.key === 'spread')?.value).toBe(
      fmtAmount(sc[0], v.metrics.unit, true),
    );
    // エラーの足も null
    const withErr = { ...s, legs: [errorLeg(50), ...s.legs] };
    const ve = views(withErr);
    expect(legSpreadCosts(ve.pm, ve.settings)[0]).toBeNull();
  });

  it('詳細（#274 AC7）: 先頭に編集の 3 欄、グリーク（Δ 3 桁（ミニ 2 桁）・Γ 4 桁・Θ / V 0 桁）と足別のシナリオ点はそれぞれ 1 行', () => {
    const s = run(three(), { type: 'setScenario', patch: { dX: 300 } });
    const v = views(s);
    const row = v.pm.rows[0] as PositionRow;
    const scen = scenarioLegsByRow(v.pm, v.base, v.metrics)[0] ?? null;
    const d = legDetail(row, scen, null, v.metrics.unit);
    const val = (k: string) => d.items.find((i) => i.key === k)?.value;
    const g = row.greeks;
    expect(d.fields.map((i) => [i.key, i.field])).toEqual([
      ['qty', 'qty'],
      ['entry', 'entry'],
      ['iv', 'iv'],
    ]);
    expect(d.items.some((i) => i.field)).toBe(false);
    expect(d.items.map((i) => i.key)).toEqual([
      'product',
      'side',
      // 建てた日（#299。今の板で入れた足は「当日」だけ。今の値段・含み損益は前の板で建てた足だけ）
      'opened',
      'mismatch',
      'spread',
      'fair',
      'sq',
    ]);
    expect(val('product')).toBe(`ラージ OP ${m1.id} P ${fmtNum(k1)}`);
    expect(val('side')).toBe('売り');
    expect(val('opened')).toBe(`${row.openedDate}（当日）`);
    expect(val('sq')).toBe(row.sqDate);
    expect(d.greeks.head).toBe('グリーク（シナリオ 0）· 円');
    expect(d.greeks.parts.join(' · ')).toBe(
      `Δ ${fmtSigned(g?.deltaLarge, 3)}（ミニ ${fmtSigned(g?.deltaMini, 2)}） · Γ ${fmtSigned(g?.gammaPer100, 4)} / 100 円 · Θ ${fmtSigned(g?.thetaPerDay, 0)} / 日 · V ${fmtSigned(g?.vegaPerPt, 0)} / pt`,
    );
    expect(d.scenario.head).toBe(`シナリオ点（足別）· ${v.metrics.unit === 'yen' ? '円' : '千円'}`);
    expect(d.scenario.parts).toEqual([
      `IV ${fmtIv(scen?.sigma)}`,
      `Δ ${fmtSigned(scen?.display.deltaLarge, 3)}`,
      `Γ ${fmtSigned(scen?.display.gammaPer100, 4)}`,
      `Θ ${fmtAmount(scen?.display.thetaPerDay, v.metrics.unit, true)} / 日`,
      `V ${fmtAmount(scen?.display.vegaPerPt, v.metrics.unit, true)} / pt`,
    ]);
    expect(d.ivRequired).toBe(false);
    // 先物の IV は入力欄なし
    const fd = legDetail(v.pm.rows[2] as PositionRow, null, null, v.metrics.unit);
    expect(fd.fields.find((i) => i.key === 'iv')).toMatchObject({ value: '—' });
    expect(fd.fields.find((i) => i.key === 'iv')?.field).toBeUndefined();
  });
});

describe('AC-3 × と全クリアの [元に戻す]', () => {
  const apply = (s: State, actions: readonly Action[]) => actions.reduce(reduce, s);

  it('(a) 真ん中を removeLeg → [元に戻す] で legs・nextId が消す前と深く等しい', () => {
    const s = three();
    const row = views(s).pm.rows[1] as PositionRow;
    const u = removeUndo(s, row);
    expect(u).not.toBeNull();
    const removed = reduce(s, { type: 'removeLeg', id: row.id });
    expect(removed.legs).toHaveLength(2);
    const back = apply(removed, u?.undo ?? []);
    expect(back.legs).toEqual(s.legs);
    expect(back.nextId).toBe(s.nextId);
  });

  it('(b) 全クリア → 足ごとの restoreLeg を順に通すと legs が深く等しい', () => {
    const s = three();
    const u = clearUndo(s);
    expect(u?.undo).toHaveLength(3);
    const back = apply(reduce(s, { type: 'clearLegs' }), u?.undo ?? []);
    expect(back.legs).toEqual(s.legs);
    expect(back.nextId).toBe(s.nextId);
  });

  it('(c) 全クリアの後に足を 1 本足してから [元に戻す] → 元の 3 本が前、足した足が後ろ', () => {
    const s = three();
    const u = clearUndo(s);
    const added = run(reduce(s, { type: 'clearLegs' }), buyPut(m1.id, k1));
    expect(added.legs).toHaveLength(1);
    const back = apply(added, u?.undo ?? []);
    expect(back.legs.slice(0, 3)).toEqual(s.legs);
    expect(back.legs[3]).toEqual(added.legs[0]);
    expect(new Set(back.legs.map((l) => l.id)).size).toBe(4);
  });

  it('(d) 別のタブへ移ってから [元に戻す] → state は同じ参照', () => {
    const s = three();
    const row = views(s).pm.rows[0] as PositionRow;
    const u = removeUndo(s, row);
    const c = clearUndo(s);
    const other = run(s, { type: 'addTab', mode: 'empty' });
    expect(other.activeTab).not.toBe(s.activeTab);
    const moved = run(other, { type: 'removeLeg', id: row.id });
    for (const a of [...(u?.undo ?? []), ...(c?.undo ?? [])]) expect(reduce(moved, a)).toBe(moved);
    // 2 つのタブ: 作業中のタブで消してから switchTab で別のタブへ → [元に戻す] は何もしない
    const two = run(s, { type: 'addTab', mode: 'empty' }, { type: 'switchTab', id: s.activeTab });
    expect(two.activeTab).toBe(s.activeTab);
    const r0 = views(two).pm.rows[1] as PositionRow;
    const u2 = removeUndo(two, r0);
    const otherId = two.tabs.find((t) => t.id !== two.activeTab)?.id as number;
    const away = run(two, { type: 'removeLeg', id: r0.id }, { type: 'switchTab', id: otherId });
    expect(apply(away, u2?.undo ?? [])).toBe(away);
    // switchTab で戻る前の別のタブ（足 0 本）でも何もしない
    const sw = run(s, { type: 'clearLegs' }, { type: 'addTab', mode: 'empty' });
    expect(apply(sw, c?.undo ?? [])).toBe(sw);
  });

  it('(e) [元に戻す] を 2 回通しても 2 回目は何も変えない', () => {
    const s = three();
    const row = views(s).pm.rows[2] as PositionRow;
    const u = removeUndo(s, row)?.undo ?? [];
    const once = apply(reduce(s, { type: 'removeLeg', id: row.id }), u);
    expect(apply(once, u)).toBe(once);
    const c = clearUndo(s)?.undo ?? [];
    const once2 = apply(reduce(s, { type: 'clearLegs' }), c);
    expect(apply(once2, c)).toBe(once2);
  });

  it('(f) 作る action は restoreLeg だけ。足が無ければ null', () => {
    const s = three();
    const all = [
      ...(clearUndo(s)?.undo ?? []),
      ...views(s).pm.rows.flatMap((r) => removeUndo(s, r)?.undo ?? []),
    ];
    expect(all.length).toBe(6);
    expect(new Set(all.map((a) => a.type))).toEqual(new Set(['restoreLeg']));
    expect(clearUndo(loaded())).toBeNull();
    expect(removeUndo(loaded(), views(s).pm.rows[0] as PositionRow)).toBeNull();
  });

  it('(g) タブが変わったら [元に戻す] 付きのトーストを閉じる（無いものは残す。変わらなければ同じ参照）', () => {
    let list: Toast[] = [];
    list = pushToast(list, { kind: 'leg-flip', text: 'a' }, 1, 0);
    list = pushToast(list, { kind: 'leg-remove-1', text: 'b', undo: () => {} }, 2, 0);
    list = pushToast(list, { kind: 'strike', text: 'c', undo: () => {} }, 3, 0);
    const next = dropUndoToasts(list);
    expect(next.map((t) => t.id)).toEqual([1]);
    expect(dropUndoToasts(next)).toBe(next);
    const empty: Toast[] = [];
    expect(dropUndoToasts(empty)).toBe(empty);
  });
});

describe('#298 建値を今の板に合わせる（rebasePlan）', () => {
  /** three() の建値を板と違う値にした state（売り 2 本 + ミニ先物の買い） */
  const stale = () =>
    run(
      three(),
      { type: 'editLeg', id: 1, patch: { entry: 123 } },
      { type: 'editLeg', id: 2, patch: { entry: 456, iv: 0.3 } },
      { type: 'editLeg', id: 3, patch: { entry: 60000 } },
    );

  it('板が無い・足 0 本は null（押せない）', () => {
    expect(rebasePlan(loaded())).toBeNull();
    expect(rebasePlan(initialState)).toBeNull();
  });

  it('AC6: 建値が 1 本も変わらなければ dispatch しない（apply / undo は null）', () => {
    const p = rebasePlan(three());
    expect(p).toEqual({
      kind: 'leg-rebase-same',
      text: '建値は今の板と同じ',
      apply: null,
      undo: null,
      copy: null,
    });
    // 全部の足が据え置き（先物価格の無い板の先物の足 1 本）
    const np = nullPrice();
    const s = run(loaded(np), { type: 'addFutureLeg', input: { side: 'buy', entry: 67000 } });
    expect(rebasePlan(s)).toMatchObject({
      kind: 'leg-rebase-same',
      text: '気配が無く建値を据え置き（1 本）',
      apply: null,
    });
  });

  it('変わった足があれば [元に戻す] 付き。据え置きがあれば本数を文に出す', () => {
    expect(rebasePlan(stale())?.text).toBe('建値を今の板に合わせた（3 本）');
    const np = nullPrice();
    const s = run(
      loaded(np),
      sellPut(m1.id, k1),
      { type: 'editLeg', id: 1, patch: { entry: 123 } },
      { type: 'addFutureLeg', input: { side: 'buy', entry: 67000 } },
    );
    const p = rebasePlan(s);
    expect(p?.kind).toBe('leg-rebase');
    expect(p?.text).toBe('建値を合わせた 1 本・据え置き 1 本');
    // 合わせた後にもう一度: 変わる足が無く、一部が据え置き
    if (!p?.apply) throw new Error('建て直しが無い');
    expect(rebasePlan(reduce(s, p.apply))).toMatchObject({
      kind: 'leg-rebase-same',
      text: '建値は今の板と同じ（据え置き 1 本）',
      apply: null,
    });
  });

  it('AC7: apply → undo の replaceLegs で足（建値・IV の編集・印・mid・id・並び）と nextId が元と等しい', () => {
    const s = stale();
    const p = rebasePlan(s);
    if (!p?.apply || !p.undo) throw new Error('建て直しが無い');
    const after = reduce(s, p.apply);
    expect(after.legs).not.toEqual(s.legs);
    expect(after.legs[1]?.leg).toMatchObject({ iv: 0.3 });
    expect(after.legs.map((l) => l.id)).toEqual(s.legs.map((l) => l.id));
    const back = reduce(after, p.undo);
    expect(back.legs).toEqual(s.legs);
    expect(back.nextId).toBe(s.nextId);
  });

  it('AC8: タブを替えた後・板を読み直して印が変わった後の [元に戻す] は何もしない', () => {
    const s = stale();
    const p = rebasePlan(s);
    if (!p?.apply || !p.undo) throw new Error('建て直しが無い');
    const after = reduce(s, p.apply);
    const other = run(after, { type: 'addTab', mode: 'empty' });
    expect(reduce(other, p.undo)).toBe(other);
    // 板を読み直して先物の足に「先物価格なし」の印が付いた
    const reloaded = reduce(after, { type: 'loaded', chain: nullPrice(), label: 'y' });
    expect(reloaded.legs[2]?.marks).toContain('no_price');
    expect(reduce(reloaded, p.undo)).toBe(reloaded);
  });
});

describe('#301 保有のタブの建て直し（写し）', () => {
  const stale = () =>
    run(
      three(),
      { type: 'editLeg', id: 1, patch: { entry: 123 } },
      { type: 'editLeg', id: 2, patch: { entry: 456, iv: 0.3 } },
      { type: 'editLeg', id: 3, patch: { entry: 60000 } },
    );
  const HOLD: Action = { type: 'setTabHeld', held: true };
  const noId = (legs: readonly UiLeg[]) => legs.map(({ id: _id, ...rest }) => rest);

  it('AC4: 保有のタブの足は 1 つも変わらず、新しいタブ（印なし）に rebaseLegs と同じ足が入って作業中になる', () => {
    const s = run(stale(), HOLD);
    const p = rebasePlan(s);
    if (!p?.apply || !p.copy) throw new Error('写しが無い');
    expect(p.kind).toBe('leg-rebase');
    expect(p.undo).toBeNull();
    expect(p.apply.type).toBe('openPositionInNewTab');
    expect(p.text).toBe('写しを新しいタブで建て直した（3 本）');
    const next = reduce(s, p.apply);
    expect(next.tabs).toHaveLength(2);
    const orig = next.tabs.find((t) => t.id === s.activeTab);
    // 保有のタブ: 足（建値・建てた日時・mid・IV の編集・印）と保有の印がそのまま
    expect(orig?.held).toBe(true);
    expect(orig?.saved?.legs).toEqual(noId(s.legs));
    // 新しいタブ: 作業中・印なし・建て直した足
    expect(next.activeTab).not.toBe(s.activeTab);
    expect(next.tabs.find((t) => t.id === next.activeTab)?.held).toBeUndefined();
    const want = rebaseLegs(s.chain, s.legs, s.calendar.holidays).legs;
    expect(next.legs.map((l) => l.leg)).toEqual(want.map((l) => l.leg));
    expect(noId(next.legs)).toEqual(p.copy.legs);
  });

  it('AC4: [元に戻す]（newTabUndoActions）で足したタブが閉じて保有のタブに戻る', () => {
    const s = run(stale(), HOLD);
    const p = rebasePlan(s);
    if (!p?.apply || !p.copy) throw new Error('写しが無い');
    const next = reduce(s, p.apply);
    const acts = newTabUndoActions(next, p.copy);
    if (typeof acts === 'string') throw new Error(acts);
    const back = run(next, ...acts);
    expect(back.tabs.map((t) => [t.id, t.name, t.held === true])).toEqual(
      s.tabs.map((t) => [t.id, t.name, t.held === true]),
    );
    expect(back.activeTab).toBe(s.activeTab);
    expect(back.legs).toEqual(s.legs.map((l, i) => ({ ...l, id: i + 1 })));
    // 写しを編集した / 保有にした / 閉じたあとは戻さない
    const edited = reduce(next, { type: 'editLeg', id: 1, patch: { qty: 5 } });
    expect(newTabUndoActions(edited, p.copy)).toBe('edited');
    expect(newTabUndoActions(reduce(next, HOLD), p.copy)).toBe('edited');
    const gone = reduce(next, { type: 'closeTab', id: p.copy.tab });
    expect(newTabUndoActions(gone, p.copy)).toBe('gone');
    expect(REBASE_COPY_UNDO_TEXT.edited).toContain('写し');
  });

  it('AC4: 1 本も変わらなければ今と同じ「同じ」の知らせ（タブを足さない）', () => {
    expect(rebasePlan(run(three(), HOLD))).toEqual({
      kind: 'leg-rebase-same',
      text: '建値は今の板と同じ',
      apply: null,
      undo: null,
      copy: null,
    });
  });

  it(`AC4: タブが ${MAX_TABS} 個なら null（押せない）。理由は rebaseBlockedText のタブの上限`, () => {
    let s = stale();
    for (let i = 1; i < MAX_TABS; i++) s = reduce(s, { type: 'addTab', mode: 'copy' });
    s = run(s, HOLD);
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(rebasePlan(s)).toBeNull();
    expect(rebaseBlockedText(true, s.legs.length, true, false)).toBe(TABS_FULL_TEXT);
  });

  it('AC4: 検討中のタブは今の動き（replaceLegs・[元に戻す] は逆向き・copy は null）', () => {
    const p = rebasePlan(stale());
    expect(p?.apply?.type).toBe('replaceLegs');
    expect(p?.undo?.type).toBe('replaceLegs');
    expect(p?.copy).toBeNull();
  });
});

describe('AC-4 トーストの文', () => {
  const s = three();
  const rows = views(s).pm.rows as PositionRow[];
  const [op, , fut] = rows as [PositionRow, PositionRow, PositionRow];

  it('× → `<legSummary> を消した` で [元に戻す] 付き・kind は足ごと', () => {
    const u = removeUndo(s, op);
    expect(u?.text).toBe(`${legSummary(op)} を消した`);
    expect(u?.text).toMatch(/^売 P [\d,]+ ×1 @[\d,.]+ を消した$/);
    expect(u?.undo.length).toBeGreaterThan(0);
    const u2 = removeUndo(s, rows[1] as PositionRow);
    expect(u2?.kind).not.toBe(u?.kind);
    // 2 本続けて入れると 2 件残る
    let list: Toast[] = [];
    list = pushToast(list, { kind: u?.kind ?? '', text: u?.text ?? '', undo: () => {} }, 1, 0);
    list = pushToast(list, { kind: u2?.kind ?? '', text: u2?.text ?? '', undo: () => {} }, 2, 0);
    expect(list).toHaveLength(2);
  });

  it('#301: 保有のタブでは全クリアのトーストを作らない（null）。外せば今どおり', () => {
    const held = reduce(s, { type: 'setTabHeld', held: true });
    expect(clearUndo(held)).toBeNull();
    expect(clearUndo(reduce(held, { type: 'setTabHeld', held: false }))?.text).toBe(
      '足 3 本を消した',
    );
  });

  it('全クリア → `足 3 本を消した`', () => {
    expect(clearUndo(s)?.text).toBe('足 3 本を消した');
    expect(clearUndo(s)?.kind).toBe('leg-clear');
  });

  it('⇄ → `買 P 64,000 に切替（建値は保持）`（OP）・先物は名前 + 限月', () => {
    expect(flipToast(op)).toEqual({
      kind: 'leg-flip',
      text: `買 P ${fmtNum(k1)} に切替（建値は保持）`,
    });
    expect(flipToast(fut).text).toBe(`売 ミニ先物 ${chain.future.id} に切替（建値は保持）`);
  });

  it('足の追加 → `ミニ先物 2026-12 買 ×1 を追加`、手入力 OP `2027-03 売 P 66,000 ×1 を追加`', () => {
    const f = futureForm(chain, [], futureFormDefault(chain));
    expect(f.ok && f.toast).toBe(`ミニ先物 ${chain.future.id} 買 ×1 を追加`);
    expect(addedToast(s.legs[2]?.leg as never).text).toBe(
      `ミニ先物 ${chain.future.id} 買 ×1 を追加`,
    );
    const o = run(loaded(), {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2099-03',
        type: 'put',
        k: 66000,
        side: 'sell',
        qty: 1,
        entry: 300,
        iv: 0.3,
      },
    });
    expect(addedToast(o.legs[0]?.leg as never)).toEqual({
      kind: 'leg-add',
      text: '2099-03 売 P 66,000 ×1 を追加',
    });
  });
});

describe('AC-5 足の追加フォームの検証', () => {
  const s = loaded();
  const holidays = s.calendar.holidays;
  const ok = (r: ReturnType<typeof futureForm>) => {
    if (!r.ok) throw new Error(r.message);
    return r;
  };

  it('先物の既定値: 旧 LegForms と同じ入力の addFutureLeg、reduce で足が 1 本増える', () => {
    const r = ok(futureForm(chain, holidays, futureFormDefault(chain)));
    expect(r.action).toEqual({
      type: 'addFutureLeg',
      input: { product: 'fut_mini', contract: chain.future.id, side: 'buy', qty: 1 },
    });
    const after = reduce(s, r.action);
    expect(after.legError).toBeNull();
    expect(after.legs).toHaveLength(1);
    // 建値を入れたときだけ entry
    const r2 = ok(
      futureForm(chain, holidays, { ...futureFormDefault(chain), entry: '67,000', qty: '3' }),
    );
    expect(r2.action).toMatchObject({ input: { entry: 67000, qty: 3 } });
  });

  it('先物: 枚数 0 → parseQty と同じ文言、限月 2026-13 → parseContract と同じ文言（action なし）', () => {
    const q = futureForm(chain, holidays, { ...futureFormDefault(chain), qty: '0' });
    expect(q).toEqual({ ok: false, message: (parseQty('0') as { message: string }).message });
    const c = futureForm(chain, holidays, { ...futureFormDefault(chain), contract: '2026-13' });
    expect(c).toEqual({
      ok: false,
      message: (parseContract('2026-13') as { message: string }).message,
    });
  });

  it('先物価格の無い板で建値が空欄 → 「先物価格が無いので建値の入力が要る」で action なし（reducer と同じ文言）', () => {
    const c = nullPrice();
    const r = futureForm(c, holidays, futureFormDefault(c));
    expect(r).toEqual({ ok: false, message: '先物価格が無いので建値の入力が要る' });
    const st = reduce(loaded(c), {
      type: 'addFutureLeg',
      input: { product: 'fut_mini', contract: c.future.id, side: 'buy', qty: 1 },
    });
    expect(st.legError).toBe('先物価格が無いので建値の入力が要る');
  });

  const opt = {
    ...OPTION_FORM_DEFAULT,
    expiry: '2099-03',
    k: '66,000',
    entry: '300',
    iv: '30',
  };

  it('手入力 OP: 板に無い限月・K・建値・IV が正しければ addManualLeg { product: op_large }、reduce で印「手入力」', () => {
    const o = ok(optionForm(chain, holidays, opt));
    expect(o.action).toEqual({
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2099-03',
        type: 'put',
        k: 66000,
        side: 'sell',
        qty: 1,
        entry: 300,
        iv: 0.3,
      },
    });
    const after = reduce(s, o.action);
    expect(after.legError).toBeNull();
    expect(after.legs[0]?.marks).toContain('no_board');
  });

  it('手入力 OP: IV 空欄 → parseIvPct(…, false) と同じ文言、K が不正 → parseStrike の文言', () => {
    expect(optionForm(chain, holidays, { ...opt, iv: '' })).toEqual({
      ok: false,
      message: (parseIvPct('', false) as { message: string }).message,
    });
    expect(optionForm(chain, holidays, { ...opt, k: '-1' })).toEqual({
      ok: false,
      message: '行使価格は正の整数',
    });
    // 順は限月 → K → 枚数 → 建値 → IV（最初の失敗）
    expect(optionForm(chain, holidays, { ...opt, expiry: 'x', iv: '' })).toEqual({
      ok: false,
      message: '限月は YYYY-MM',
    });
  });

  it('手入力 OP: manualOptionLeg が投げる → その文言で action なし（reducer の legError と同じ）', () => {
    // 板の限月の参照で投げる板（manualOptionLeg が monthOf で読む）
    const broken = Object.defineProperty({ ...chain }, 'months', {
      get() {
        throw new Error('板の限月を読めない');
      },
    }) as Chain;
    expect(optionForm(broken, holidays, opt)).toEqual({ ok: false, message: '板の限月を読めない' });
    const st = reduce(
      { ...s, chain: broken },
      {
        type: 'addManualLeg',
        input: {
          product: 'op_large',
          expiry: '2099-03',
          type: 'put',
          k: 66000,
          side: 'sell',
          qty: 1,
          entry: 300,
          iv: 0.3,
        },
      },
    );
    expect(st.legError).toBe('板の限月を読めない');
  });

  it('性質: ok のとき、その action を reduce に通すと legError が null で足が 1 本増える', () => {
    const cases = [
      futureForm(chain, holidays, futureFormDefault(chain)),
      futureForm(chain, holidays, {
        ...futureFormDefault(chain),
        product: 'fut_large',
        side: 'sell',
      }),
      futureForm(chain, holidays, { ...futureFormDefault(chain), contract: m1.id }),
      futureForm(chain, holidays, { ...futureFormDefault(chain), contract: '2099-06' }),
      futureForm(nullPrice(), holidays, { ...futureFormDefault(nullPrice()), entry: '67000' }),
      optionForm(chain, holidays, opt),
      optionForm(chain, holidays, { ...opt, expiry: m1.id, type: 'call', side: 'buy' }),
    ];
    for (const r of cases) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const base =
        r.action.type === 'addFutureLeg' && r.action.input.entry === 67000
          ? loaded(nullPrice())
          : s;
      const after = reduce(base, r.action);
      expect(after.legError).toBeNull();
      expect(after.legs).toHaveLength(base.legs.length + 1);
    }
  });
});

describe('#274 AC3 デルタヘッジの常設の行（EPIC #281 終了条件 2）', () => {
  it('足 0 本は 0 行（null）、足 2 本は 1 行（要約の文・ミニの [追加]）', () => {
    expect(hedgeSummary(views(loaded()).hedge, 0)).toBeNull();
    const s = run(loaded(), sellPut(m1.id, k1), sellPut(m2.id, k2));
    const { hedge } = views(s);
    const v = hedgeSummary(hedge, 2);
    if (!v) throw new Error('行が無い');
    const cur = hedge.current as { large: number; mini: number };
    const mini = hedgeSection(hedge).lines.find((l) => l.product === 'fut_mini');
    expect(v.text).toBe(
      `現在 Δ ${fmtSigned(cur.large, 2)}（ミニ ${fmtSigned(cur.mini, 1)}） → ミニ ${mini?.lots}`,
    );
    expect(v.text).toMatch(
      /^現在 Δ [+−]?\d+\.\d{2}（ミニ [+−]?\d+\.\d） → ミニ ([+−]?[\d,]+ 枚|—)$/,
    );
    // #274 再レビュー R5: 結論（縮めない）と前半（省略記号）を分けて返す。全文 = 前半 + 結論 + 理由
    expect(v.delta).toBe(`現在 Δ ${fmtSigned(cur.large, 2)}（ミニ ${fmtSigned(cur.mini, 1)}）`);
    expect(v.action).toBe(`→ ミニ ${mini?.lots}`);
    expect(v.why).toBe('');
    expect(v.text).toBe(`${v.delta} ${v.action}${v.why}`);
    expect(v.line?.product).toBe('fut_mini');
    expect(v.line?.input).toBe(mini?.input);
    expect(v.line?.canAdd).toBe(mini?.canAdd);
    expect(v.warn).toBe(false);
  });

  it('評価点がシナリオ時点・目標 ≠ 0・全行に共通の理由の文', () => {
    const s = run(loaded(), sellPut(m1.id, k1), sellPut(m2.id, k2));
    const sc = views(reduce(s, { type: 'setHedge', patch: { at: 'scenario', target: 0.5 } })).hedge;
    expect(hedgeSummary(sc, 2)?.text).toMatch(
      /^シナリオ時点 Δ [+−]?\d+\.\d{2}（ミニ [+−]?\d+\.\d） → 目標 0\.5 · ミニ ([+−]?[\d,]+ 枚|—)$/,
    );
    const c = nullPrice();
    const np = run(loaded(c), sellPut(c.months[0]?.id as string, k1));
    const v = hedgeSummary(views(np).hedge, 1);
    expect(v?.text).toMatch(
      new RegExp(`^現在 Δ .+ · ${HEDGE_REASON_LABEL.no_price.replace(/[()（）]/g, '.')}$`),
    );
    expect(v?.line).toBeNull();
    expect(v?.warn).toBe(true);
    expect(v?.action).toBe('');
    expect(v?.delta).toBe(v?.text);
  });

  it('ミニの段に理由（上限超え）があれば文の末尾に理由・warn', () => {
    const s = reduce(loaded(), {
      type: 'addFutureLeg',
      input: { product: 'fut_large', side: 'buy', qty: 100_000 },
    });
    const v = hedgeSummary(views(s).hedge, 1);
    expect(v?.text.endsWith(` · ${HEDGE_REASON_LABEL.over_limit}`)).toBe(true);
    expect(v?.why).toBe(` · ${HEDGE_REASON_LABEL.over_limit}`);
    expect(v?.action).toMatch(/^→ ミニ /);
    expect(v?.warn).toBe(true);
    expect(v?.line?.canAdd).toBe(false);
  });
});

describe('AC-6 ヘッジの節', () => {
  it('1 段目 `現在 Δ +0.32（ミニ +3.2）→ 目標 0`、段の枚数・残り・押せるか・理由が HedgeLine と一致', () => {
    const s = run(loaded(), sellPut(m1.id, k1), sellPut(m2.id, k2));
    const { hedge } = views(s);
    const v = hedgeSection(hedge);
    const cur = hedge.current as { large: number; mini: number };
    expect(v.head).toBe(
      `現在 Δ ${fmtSigned(cur.large, 2)}（ミニ ${fmtSigned(cur.mini, 1)}）→ 目標 0`,
    );
    expect(v.head).toMatch(/^現在 Δ [+−]?\d+\.\d{2}（ミニ [+−]?\d+\.\d）→ 目標 0$/);
    expect(v.common).toBeNull();
    expect(v.lines.map((l) => l.product)).toEqual(hedge.lines.map((l) => l.product));
    v.lines.forEach((l, i) => {
      const h = hedge.lines[i];
      if (!h) throw new Error('段が無い');
      expect(l.lots).toBe(h.lots === null ? '—' : `${fmtSigned(h.lots)} 枚`);
      expect(l.residual).toBe(h.residual === null ? null : `残り ${fmtSigned(h.residual, 3)}`);
      expect(l.canAdd).toBe(h.canAdd);
      expect(l.input).toBe(h.input);
    });
    const ln = v.lines.find((l) => l.canAdd);
    expect(ln?.toast).toMatch(/^(ミニ|ラージ)先物 \d{4}-\d{2} [売買] ×[\d,]+ を追加$/);
    // 目標を変えると 1 段目が変わる
    const t = hedgeSection(views(reduce(s, { type: 'setHedge', patch: { target: 1 } })).hedge);
    expect(t.head.endsWith('→ 目標 1')).toBe(true);
    const t2 = hedgeSection(views(reduce(s, { type: 'setHedge', patch: { target: -0.5 } })).hedge);
    expect(t2.head.endsWith('→ 目標 −0.5')).toBe(true);
    // 指数表記になる極小の目標は 3 桁（0.0 にしない）
    const t3 = hedgeSection(views(reduce(s, { type: 'setHedge', patch: { target: 1e-7 } })).hedge);
    expect(t3.head.endsWith('→ 目標 0.000')).toBe(true);
    // 先物の限月と建値の注記
    expect(v.notes).toContain(`先物 ${chain.future.id} 限 @${fmtNum(hedge.entry)}`);
  });

  it('枚数が上限を超える段は段の中に理由', () => {
    const s = reduce(loaded(), {
      type: 'addFutureLeg',
      input: { product: 'fut_large', side: 'buy', qty: 100_000 },
    });
    const v = hedgeSection(views(s).hedge);
    const mini = v.lines.find((l) => l.product === 'fut_mini');
    expect(mini?.canAdd).toBe(false);
    expect(mini?.reason).toBe(HEDGE_REASON_LABEL.over_limit);
  });

  it('reason が no_price のとき段を出さずに理由の文', () => {
    const c = nullPrice();
    const s = run(loaded(c), sellPut(c.months[0]?.id as string, k1));
    const v = hedgeSection(views(s).hedge);
    expect(v.lines).toEqual([]);
    expect(v.common).toBe(HEDGE_REASON_LABEL.no_price);
  });

  it('micro があるときマイクロ換算の注記', () => {
    const s = reduce(loaded(), { type: 'setHedge', patch: { target: 0.03 } });
    const h = views(s).hedge;
    expect(h.micro?.lots).toBe(3);
    const v = hedgeSection(h);
    expect(v.notes).toContain(
      `ミニは 0 枚。マイクロ換算 +3 枚（残り ${fmtSigned(h.micro?.residual, 3)}。マイクロは足の追加フォームから）`,
    );
  });

  it('評価点の Seg は短い文字と HEDGE_AT_LABEL の全文', () => {
    expect(HEDGE_AT_OPTIONS.map((o) => [o.value, o.text, o.label])).toEqual([
      ['base', '適用前', 'シナリオ適用前'],
      ['scenario', 'シナリオ時点', 'シナリオ時点'],
    ]);
  });
});

describe('空の状態と選んだ足のスクロール', () => {
  // 空の状態の [板を開く] は #325 で [板から追加] に置き換えた（規則は tests/ui/shell.test.ts の「#325 板から追加」）
  it('#325・#20 足を入れる入口の文言', () => {
    expect(PICK_LABEL).toBe('板から追加');
    expect(SHAPES_LABEL).toBe('形から組む…');
    expect(EMPTY_LEGS_TEXT).toBe(
      '[板から追加] で板の bid（売り）/ ask（買い）を押すか、[形から組む…] で形を選ぶか、[手入力…] で足を入れる',
    );
  });

  it('revealScrollTop: 見えていれば同じ、上にはみ出せば上端、下なら下端、高い行は上端', () => {
    // ビュー 100〜300、scrollTop 50
    expect(revealScrollTop(120, 160, 100, 300, 50)).toBe(50);
    expect(revealScrollTop(80, 120, 100, 300, 50)).toBe(30);
    expect(revealScrollTop(280, 330, 100, 300, 50)).toBe(80);
    expect(revealScrollTop(150, 500, 100, 300, 50)).toBe(100);
  });
});
