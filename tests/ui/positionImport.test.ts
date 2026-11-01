import { describe, expect, it } from 'vitest';
import type { Chain, ReadResult, ReadRow } from '../../data';
import { evaluatePosition, ZERO_SCENARIO } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { serializeWorkspace } from '../../ui/persist';
import { type Action, initialState, MAX_TABS, reduce, type State } from '../../ui/state';
import { newTabUndoActions } from '../../ui/view/newTab';
import { positionModel } from '../../ui/view/position';
import {
  editRow,
  fillYear,
  IMPORT_NOTICE,
  type ImportRow,
  importEntryBlocked,
  importPlan,
  initialRows,
  openedAtOfDay,
  readBlocked,
  readBlockedReload,
  readErrorText,
  readReload,
  rowView,
} from '../../ui/view/positionImport';
import { TABS_FULL_TEXT } from '../../ui/view/tabs';
import { boardsT0AndLater } from '../support/laterChain';

/**
 * #318 AC3・AC8・AC11: 画像から読み取った結果 → 確認表 → 新しい保有のタブ（ui/view/positionImport.ts）。
 * 合成の板 t₀（latest。2026-10-13 21:31 JST・限月 2026-11 / 2026-12・先物 2026-12）と t₀ + 3 日の板。値は架空。
 */

const { t0, later } = boardsT0AndLater();
const holidays = initialState.calendar.holidays;
const load = (s: State, c: Chain) => reduce(s, { type: 'loaded', chain: c, label: 'x' });
const run = (s: State, ...acts: Action[]) => acts.reduce(reduce, s);
const S0 = load(initialState, t0);

const row = (p: Partial<ReadRow> = {}): ReadRow => ({
  product: 'op_large',
  expiry_year: 2026,
  expiry_month: 12,
  type: 'P',
  strike: 64000,
  side: 'sell',
  qty: 2,
  price: 1500,
  opened_on: '2026-10-01',
  ...p,
});
const result = (...rows: ReadRow[]): ReadResult => ({ kind: 'positions', rows, remaining_usd: 2 });
const jst0 = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - 9 * 3_600_000;

function planOk(rows: ImportRow[], st: State = S0, held = true, chain: Chain = t0) {
  const p = importPlan(rows, chain, holidays, st, held);
  if (!p.ok) throw new Error(`入れられない: ${p.reasons.join(' / ')}`);
  return p;
}

describe('openedAtOfDay（建てた日の 0:00 JST）', () => {
  it('YYYY-MM-DD → その日の 0:00 JST（前日の 15:00 UTC）', () => {
    expect(openedAtOfDay('2026-10-01')).toBe(Date.parse('2026-09-30T15:00:00Z'));
    expect(openedAtOfDay('2026-02-30')).toBeNull();
    expect(openedAtOfDay('2026/10/01')).toBeNull();
  });
});

describe('AC3: 行の判定と足の組み立て', () => {
  it('板の限月・板の行使価格の行は板の足（建値 = 読んだ値、openedAt = 建てた日の 0:00 JST）', () => {
    const rows = initialRows(result(row()), t0, holidays);
    expect(rows[0]).toMatchObject({ expiry: '2026-12', type: 'P', k: 64000, include: true });
    const p = planOk(rows);
    const leg = p.legs[0];
    expect(leg?.leg).toMatchObject({
      kind: 'option',
      product: 'op_large',
      type: 'put',
      expiry: '2026-12',
      strike: 64000,
      side: 'sell',
      qty: 2,
      entry: 1500,
      openedAt: jst0(2026, 10, 1),
    });
    expect(leg?.leg.kind === 'option' && leg.leg.mid).not.toBeNull(); // 板の行の mid
    expect(leg?.optionMarket).toBeUndefined();
    expect(p.ivProvisional).toEqual([]);
    expect(p.ivNote).toBeNull();
  });

  it('板に無い行使価格の行は手入力の足（板の市場・その行使価格のスマイルの IV）', () => {
    const rows = initialRows(result(row({ type: 'C', strike: 92000, side: 'buy' })), t0, holidays);
    expect(rowView(rows[0] as ImportRow, t0, holidays).ivProvisional).toBe(false);
    const p = planOk(rows);
    const leg = p.legs[0];
    if (leg?.leg.kind !== 'option') throw new Error('OP でない');
    expect(leg.leg.strike).toBe(92000);
    expect(leg.leg.iv).toBeGreaterThan(0);
    const m = t0.months.find((x) => x.id === '2026-12');
    expect(leg.leg.iv).toBeCloseTo(m?.smile?.smile.sigma(Math.log(92000 / (m?.F ?? 1))) ?? 0, 12);
    expect(leg.optionMarket).toBeUndefined(); // 板の限月 = 板の市場
    expect(leg.marks).not.toContain('no_board');
  });

  it('板に無い限月の行は手入力の足（SQ が最も近い板の限月の ATM IV・IV 仮・板なしの印）', () => {
    const rows = initialRows(
      result(row({ expiry_year: 2027, expiry_month: 3, strike: 60000 })),
      t0,
      holidays,
    );
    expect(rowView(rows[0] as ImportRow, t0, holidays).ivProvisional).toBe(true);
    const p = planOk(rows);
    expect(p.ivProvisional).toEqual([1]);
    // 入れた後の知らせ（足の印には残らないので、どの行の IV を確かめるかを示す。#318 レビュー S1）
    expect(p.ivNote).toContain('IV 仮の行があります（1 行目');
    expect(p.ivNote).toContain('足の詳細で IV を確かめて');
    const leg = p.legs[0];
    if (leg?.leg.kind !== 'option') throw new Error('OP でない');
    const dec = t0.months.find((x) => x.id === '2026-12');
    const k = dec?.atm.B.pick?.k ?? 0;
    expect(leg.leg.iv).toBeCloseTo(dec?.smile?.smile.sigma(Math.log(k / (dec?.F ?? 1))) ?? 0, 12);
    expect(leg.marks).toContain('no_board');
    expect(leg.optionMarket?.expiry).toBe('2027-03');
    expect(leg.leg.openedAt).toBe(jst0(2026, 10, 1));
    // 確認表だけの印は足の marks に入れない（保存の形を変えない）
    expect(leg.marks.some((x) => String(x).includes('仮'))).toBe(false);
  });

  it('先物の行は先物の足（商品・限月・建値・建てた日）', () => {
    const rows = initialRows(
      result(
        row({ product: 'fut_mini', type: null, strike: null, side: 'buy', qty: 3, price: 66000 }),
      ),
      t0,
      holidays,
    );
    const p = planOk(rows);
    const leg = p.legs[0];
    expect(leg?.leg).toMatchObject({
      kind: 'future',
      product: 'fut_mini',
      contract: '2026-12',
      side: 'buy',
      qty: 3,
      entry: 66000,
      openedAt: jst0(2026, 10, 1),
    });
    expect(leg?.futureMarket?.contract).toBe('2026-12');
  });

  it('商品 unknown の行は対象外で足に入らない', () => {
    const rows = initialRows(result(row({ product: 'unknown' }), row()), t0, holidays);
    expect(rows[0]?.include).toBe(false);
    expect(rowView(rows[0] as ImportRow, t0, holidays).excluded).toBe('unknown');
    expect(planOk(rows).legs).toHaveLength(1);
  });

  it('年の無い限月は今の板の日付から最も近い未来の同じ月（年を補った）', () => {
    const rows = initialRows(
      result(
        row({ expiry_year: null, expiry_month: 12 }),
        row({ expiry_year: null, expiry_month: 10 }),
      ),
      t0,
      holidays,
    );
    expect(rows.map((r) => [r.expiry, r.yearFilled])).toEqual([
      ['2026-12', true],
      // 2026-10 の SQ（10/9）は板の日付（10/13）より前 → 翌年
      ['2027-10', true],
    ]);
    expect(fillYear(11, t0, holidays)).toBe('2026-11');
    // 限月を直したら「年を補った」は消える
    expect(editRow(rows[0] as ImportRow, { expiry: '2027-12' }).yearFilled).toBe(false);
  });

  it('SQ 済みの限月の行は SQ 済みで足に入らない', () => {
    const rows = initialRows(result(row({ expiry_month: 10 }), row()), t0, holidays);
    expect(rowView(rows[0] as ImportRow, t0, holidays).excluded).toBe('sq_done');
    expect(rows[0]?.include).toBe(false);
    expect(planOk(rows).legs).toHaveLength(1);
  });

  it('null の欄が残る・建てた日が空・範囲外（枚数 0・100,001、建値 < 0）なら入れられず、理由が返る', () => {
    const base = initialRows(result(row()), t0, holidays)[0] as ImportRow;
    const cases: [Partial<ImportRow>, RegExp][] = [
      [{ k: null }, /行使価格が空/],
      [{ type: null }, /C \/ P が空/],
      [{ side: null }, /売買が空/],
      [{ expiry: null }, /限月が空/],
      [{ openedOn: null }, /建てた日が空/],
      [{ qty: 0 }, /枚数は 1〜100,000/],
      [{ qty: 100_001 }, /枚数は 1〜100,000/],
      [{ qty: 1.5 }, /枚数は 1〜100,000/],
      [{ entry: -1 }, /建値は 0 以上/],
      [{ entry: null }, /建値が空/],
      [{ openedOn: '2026-10-14' }, /建てた日が今の板より後/],
      [{ openedOn: '2026-13-01' }, /建てた日の形/],
    ];
    for (const [patch, re] of cases) {
      const p = importPlan([{ ...base, ...patch }], t0, holidays, S0, true);
      expect(p.ok, JSON.stringify(patch)).toBe(false);
      if (!p.ok) expect(p.reasons.join(' / ')).toMatch(re);
    }
    // 読み取りで null だった欄は「読めない」の印
    const unread = initialRows(result(row({ strike: null, opened_on: null })), t0, holidays)[0];
    expect(unread?.unreadable).toEqual(['k', 'openedOn']);
    // 外した行はエラーにしない。入れる行が 0 なら理由
    const off = importPlan([{ ...base, k: null, include: false }], t0, holidays, S0, true);
    expect(off).toEqual({ ok: false, reasons: ['入れる行がありません'] });
  });

  it('タブが上限なら入れられない（理由）', () => {
    const full = run(
      S0,
      ...Array.from({ length: MAX_TABS - 1 }, () => ({ type: 'addTab', mode: 'empty' }) as Action),
    );
    expect(full.tabs).toHaveLength(MAX_TABS);
    const p = importPlan(initialRows(result(row()), t0, holidays), t0, holidays, full, true);
    expect(p).toEqual({ ok: false, reasons: [TABS_FULL_TEXT] });
  });

  it('分割の約定（同じ銘柄 2 行）はまとめず 2 本', () => {
    const p = planOk(initialRows(result(row(), row({ price: 1520, qty: 1 })), t0, holidays));
    expect(p.legs.map((l) => [l.leg.qty, l.leg.entry])).toEqual([
      [2, 1500],
      [1, 1520],
    ]);
  });
});

describe('AC3: 新しいタブ・保有の印', () => {
  const work = run(S0, {
    type: 'addBoardLeg',
    expiry: '2026-11',
    k: 70000,
    optionType: 'call',
    side: 'buy',
  });

  it('「保有の印を付ける」オンで openPositionInNewTab の held: true。作業中のタブの足と印は変わらない', () => {
    const rows = initialRows(
      result(row(), row({ type: 'C', strike: 70000, side: 'buy' })),
      t0,
      holidays,
    );
    const p = planOk(rows, work, true);
    expect(p.action).toMatchObject({ type: 'openPositionInNewTab', held: true });
    const next = reduce(work, p.action);
    expect(next.tabs).toHaveLength(work.tabs.length + 1);
    const added = next.tabs.find((t) => t.id === next.activeTab);
    expect(added?.held).toBe(true);
    expect(next.legs).toHaveLength(2);
    const prev = next.tabs.find((t) => t.id === work.activeTab);
    expect(prev?.held).toBeUndefined();
    expect(prev?.saved?.legs).toEqual(work.legs.map(({ id: _id, ...rest }) => rest));
    expect(p.text).toBe('建玉 2 本を新しいタブに入れた');
    // [元に戻す]: 印を付けて入れたタブはそのまま戻せる（印を外したら変えた扱い）
    const undo = newTabUndoActions(next, p.undo);
    expect(Array.isArray(undo)).toBe(true);
    const back = (undo as Action[]).reduce(reduce, next);
    expect(back.tabs).toHaveLength(work.tabs.length);
    expect(back.activeTab).toBe(work.activeTab);
    const unheld = reduce(next, { type: 'setTabHeld', held: false });
    expect(newTabUndoActions(unheld, p.undo)).toBe('edited');
  });

  it('オフなら印なし', () => {
    const p = planOk(initialRows(result(row()), t0, holidays), work, false);
    expect('held' in p.action).toBe(false);
    const next = reduce(work, p.action);
    expect(next.tabs.find((t) => t.id === next.activeTab)?.held).toBeUndefined();
  });

  it('前の板の日付で建てた足は時価評価（シナリオ 0 の損益 = 符号 × 枚数 × 1,000 ×（今の値段 − 建値））', () => {
    // t₀ + 3 日の板を読んだ画面に、t₀ の日付で建てた売り P 2 枚・建値 1,500 円を取り込む
    const S3 = load(initialState, later);
    const rows = initialRows(result(row({ opened_on: '2026-10-13' })), later, holidays);
    const p = planOk(rows, S3, true, later);
    const st = reduce(S3, p.action);
    const leg = st.legs[0];
    if (leg?.leg.kind !== 'option' || leg.leg.mid == null) throw new Error('板の足でない');
    expect(leg.leg.openedAt).toBe(jst0(2026, 10, 13));
    expect(leg.leg.openedAt).toBeLessThan(later.snapshotAt);
    const m = positionModel(later, st.legs, 'B', CALENDAR);
    const ev = evaluatePosition(m.prepared, ZERO_SCENARIO, m.ctx);
    const want = -1 * 2 * 1000 * (leg.leg.mid - 1500);
    expect(ev.legs[0]?.pnl).toBeCloseTo(want, 6);
    expect(m.heldDays).toBeGreaterThan(0);
  });
});

describe('押せる / 押せない', () => {
  const st = {
    schema_version: 1,
    enabled: true,
    model: null,
    credential: null,
    counted: true,
    limit_usd: 3,
    remaining_usd: 2,
    resets_at: null,
  } as const;

  it('入口: 板なし → 理由、AI 無効・今日の上限 → 理由、状態を読んでいなければ押せる', () => {
    expect(importEntryBlocked(false, st)).toBe('板が無い');
    expect(importEntryBlocked(true, null)).toBeNull();
    expect(importEntryBlocked(true, { error: 'network' })).toBeNull();
    expect(importEntryBlocked(true, st)).toBeNull();
    expect(importEntryBlocked(true, { ...st, enabled: false })).toMatch(/無効/);
    expect(importEntryBlocked(true, { ...st, remaining_usd: 0 })).toMatch(/上限/);
  });

  it('[読み取る]: 板・状態・上限・読み取り中・画像の順', () => {
    const base = { hasChain: true, status: st, hasImage: true, reading: false };
    expect(readBlocked(base)).toBeNull();
    expect(readBlocked({ ...base, hasChain: false })).toMatch(/板/);
    expect(readBlocked({ ...base, status: null })).toMatch(/読んでいます/);
    expect(readBlocked({ ...base, status: { ...st, enabled: false } })).toMatch(/無効/);
    expect(readBlocked({ ...base, status: { ...st, remaining_usd: 0 } })).toMatch(/上限/);
    expect(readBlocked({ ...base, reading: true })).toMatch(/読み取り中/);
    expect(readBlocked({ ...base, hasImage: false })).toMatch(/画像を選んで/);
  });

  it('#341: session_expired の知らせ・押せない理由だけ [ページを読み直す]', () => {
    expect(readErrorText('session_expired')).toContain('[ページを読み直す]');
    expect(readReload('session_expired')).toBe(true);
    for (const c of ['network', 'timeout', 'too_large', 'bad_result', 'aborted', 'unavailable']) {
      expect(readReload(c)).toBe(false);
      expect(readErrorText(c)).not.toContain('[ページを読み直す]');
    }
    const expired = { error: 'session_expired' };
    expect(
      readBlocked({ hasChain: true, status: expired, hasImage: true, reading: false }),
    ).toContain('[ページを読み直す]');
    expect(readBlockedReload({ hasChain: true, status: expired })).toBe(true);
    expect(readBlockedReload({ hasChain: false, status: expired })).toBe(false);
    expect(readBlockedReload({ hasChain: true, status: { error: 'network' } })).toBe(false);
    expect(readBlockedReload({ hasChain: true, status: null })).toBe(false);
    expect(readBlockedReload({ hasChain: true, status: st })).toBe(false);
  });
});

describe('AC11・AC8: 送る前の注意・保存しない', () => {
  it('注意の文に「Anthropic」「保存しません」「切り取って」が入る', () => {
    const all = IMPORT_NOTICE.join('\n');
    for (const w of ['Anthropic', '保存しません', '切り取って']) expect(all).toContain(w);
  });

  it('取り込みの後の作業の保存に画像（base64）・確認表だけの印が入らない', () => {
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4';
    const rows = initialRows(
      result(row({ expiry_year: 2027, expiry_month: 3, strike: 60000 }), row()),
      t0,
      holidays,
    );
    const st = reduce(S0, planOk(rows).action);
    const saved = serializeWorkspace(st, Date.parse('2026-10-13T13:00:00Z'));
    expect(saved).not.toContain(image.slice(0, 32));
    expect(saved).not.toContain('data:image');
    for (const w of ['IV 仮', '年を補った', '読めない', 'yearFilled', 'unreadable']) {
      expect(saved).not.toContain(w);
    }
  });
});
