import { describe, expect, it } from 'vitest';
import { type Chain, monthOf, normalizeChain } from '../../data';
import {
  black76Price,
  DEFAULT_SETTINGS,
  evaluatePosition,
  type Leg,
  premiumSummary,
  ZERO_SCENARIO,
} from '../../model';
import {
  addEntry,
  type Book,
  type BookRead,
  bookKey,
  EMPTY_BOOK,
  type OkEntry,
  readBook,
} from '../../ui/book';
import { CALENDAR } from '../../ui/calendar';
import { toSaved } from '../../ui/persist';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import {
  BOOK_FAIL_TEXT,
  bookListModel,
  confirmText,
  entryMonths,
  entryPremium,
  entrySummary,
  exportDoneText,
  INVALID_ROW_TEXT,
  importDoneText,
  markPrice,
  markToBoard,
  NEWER_ROW_TEXT,
  requestOpen,
} from '../../ui/view/bookList';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';
import bookV1 from './saved/book-v1.json';

const NOW = Date.parse('2026-10-16T03:00:00.000Z');
const chain: Chain = normalizeChain(fixture('latest'));

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

const op = (
  type: 'put' | 'call',
  strike: number,
  side: 'buy' | 'sell',
  entry: number,
  expiry = '2026-11',
  qty = 1,
): Leg => ({ kind: 'option', product: 'op_large', type, expiry, strike, side, qty, entry });

function strangle(fee = 50): State {
  return run(
    { ...initialState, feePerLot: fee },
    { type: 'loaded', chain, label: 'latest' },
    { type: 'addBoardLeg', expiry: '2026-11', k: 64000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: '2026-11', k: 70500, optionType: 'call', side: 'sell' },
  );
}

function entryOf(state: State, name = 'a', id = 'a'): OkEntry {
  const r = addEntry(EMPTY_BOOK, toSaved(state, NOW), name, NOW, id);
  if (!r.ok) throw new Error(r.reason);
  const e = r.book.entries[0];
  if (e?.status !== 'ok') throw new Error('読めない');
  return e;
}

function readOf(...entries: OkEntry[]): BookRead {
  const book: Book = { entries };
  return { kind: 'ok', book, chars: 1234 };
}

function sideOf(expiry: string, k: number, type: 'put' | 'call') {
  const s = monthOf(chain, expiry)?.strikes.find((x) => x.k === k)?.[type];
  if (!s) throw new Error('板に無い');
  return s;
}

describe('今の板での評価価格（AC5）', () => {
  it('両側気配なら mid', () => {
    expect(markPrice(chain, op('put', 64000, 'sell', 780))).toEqual({
      price: 792.5,
      theoretical: false,
    });
    expect(sideOf('2026-11', 64000, 'put').mid).toBe(792.5);
  });

  it('片側気配・行使価格が板に無い足はスマイルの理論価格（理論値の印）', () => {
    const month = monthOf(chain, '2026-11');
    if (!month?.smile) throw new Error('スマイルが無い');
    const smile = month.smile.smile;
    // 30,000 の put は ask だけ（片側）
    expect(sideOf('2026-11', 30000, 'put').quote).not.toBe('two_sided');
    for (const k of [30000, 64010]) {
      const m = markPrice(chain, op('put', k, 'buy', 1));
      const sigma = smile.sigma(Math.log(k / month.F));
      expect(m?.theoretical).toBe(true);
      expect(m?.price).toBeCloseTo(black76Price('put', month.F, k, month.T, sigma, chain.r), 9);
    }
  });

  it('先物: 板の先物と同じ限月は板の価格、限月違いは合成先物（理論値の印）、無ければ評価できない', () => {
    const fut = (contract: string): Leg => ({
      kind: 'future',
      product: 'fut_mini',
      contract,
      side: 'buy',
      qty: 1,
      entry: 67000,
    });
    expect(markPrice(chain, fut('2026-12'))).toEqual({ price: 67880, theoretical: false });
    const m11 = monthOf(chain, '2026-11');
    expect(markPrice(chain, fut('2026-11'))).toEqual({ price: m11?.F, theoretical: true });
    expect(markPrice(chain, fut('2027-03'))).toBeNull();
  });

  it('限月が板に無い OP の足は評価できない', () => {
    expect(markPrice(chain, op('call', 70000, 'buy', 500, '2027-01'))).toBeNull();
  });
});

describe('今の板での評価損益（markToBoard。AC5）', () => {
  it('同じ板で建てた直後は −スプレッドコスト − 手数料（指標の定義と一致）', () => {
    const s = strangle(50);
    const legs = s.legs.map((l) => l.leg);
    // 売り P64,000 @780（mid 792.5）・売り C70,500 @840（mid 850）
    const r = markToBoard(chain, legs, 50);
    expect(r).toEqual({ pnl: -12_500 - 10_000 - 100, theoretical: false, missing: 0 });
    const pm = positionModel(chain, s.legs, 'B', CALENDAR, { ...DEFAULT_SETTINGS, feePerLot: 50 });
    const prem = premiumSummary(pm.prepared, { ...DEFAULT_SETTINGS, feePerLot: 50 });
    expect(r.pnl).toBeCloseTo(-prem.spreadCost - prem.fees, 9);
  });

  it('売買の符号: 売りは評価価格が建値より下がると利益、買いは上がると利益。乗数・枚数を掛ける', () => {
    // 売り 2 枚 @1,000 → mid 792.5: +2 × 1,000 × 207.5
    expect(markToBoard(chain, [op('put', 64000, 'sell', 1000, '2026-11', 2)], 0).pnl).toBe(415_000);
    // 買い 1 枚 @700 → mid 792.5: +92.5 × 1,000
    expect(markToBoard(chain, [op('put', 64000, 'buy', 700)], 0).pnl).toBe(92_500);
    // 買い @350（ask）→ mid 340: −10,000
    expect(markToBoard(chain, [op('put', 60000, 'buy', 350)], 0).pnl).toBe(-10_000);
    // ミニ先物 買い 2 枚 @67,500 → 67,880: 2 × 100 × 380、手数料 30 × 2
    const fut: Leg = {
      kind: 'future',
      product: 'fut_mini',
      contract: '2026-12',
      side: 'buy',
      qty: 2,
      entry: 67500,
    };
    expect(markToBoard(chain, [fut], 30).pnl).toBe(76_000 - 60);
    const micro: Leg = { ...fut, product: 'fut_micro', side: 'sell', qty: 1 };
    expect(markToBoard(chain, [micro], 0).pnl).toBe(-3_800);
  });

  it('評価できない足が 1 本でもあれば合計を出さない（部分和を出さない）', () => {
    const r = markToBoard(
      chain,
      [op('put', 64000, 'sell', 780), op('call', 70000, 'buy', 500, '2027-01')],
      0,
    );
    expect(r).toEqual({ pnl: null, theoretical: false, missing: 1 });
  });
});

describe('1 項目の要約（AC4）', () => {
  it('受取 / 掛け金: 受取超は受取 − 支払、支払超は支払 − 受取 + 手数料（全足）', () => {
    expect(entryPremium([op('put', 64000, 'sell', 780), op('put', 60000, 'buy', 350)], 50)).toEqual(
      { received: 780_000, paid: 350_000, kind: 'received', amount: 430_000 },
    );
    const fut: Leg = {
      kind: 'future',
      product: 'fut_mini',
      contract: '2026-12',
      side: 'buy',
      qty: 2,
      entry: 67500,
    };
    expect(entryPremium([op('put', 60000, 'buy', 350, '2026-11', 2), fut], 50)).toEqual({
      received: 0,
      paid: 700_000,
      kind: 'stake',
      amount: 700_000 + 50 * 4,
    });
  });

  it('限月: OP・先物の限月を重複なしで昇順。3 つ以上は「ほか」', () => {
    expect(
      entryMonths([op('put', 1, 'sell', 1, '2026-12'), op('put', 1, 'sell', 1, '2026-11')]),
    ).toBe('2026-11・2026-12');
    expect(
      entryMonths([
        op('put', 1, 'sell', 1, '2026-12'),
        op('put', 1, 'sell', 1, '2026-11'),
        op('put', 1, 'sell', 1, '2027-01'),
      ]),
    ).toBe('2026-11 ほか 2');
  });

  it('満期の最大損失・Δ は損益グラフ・画面の「今日」と同じ値', () => {
    const s = strangle(50);
    const e = entryOf(s);
    const sum = entrySummary(chain, e, 'B', CALENDAR);
    const settings = { ...DEFAULT_SETTINGS, feePerLot: 50 };
    const pm = positionModel(chain, s.legs, 'B', CALENDAR, settings);
    const base = pnlDomains(chain, pm.prepared, pm.ctx, settings);
    expect(sum.maxLoss).toBe(base?.profile.maxLoss.value);
    expect(sum.maxLoss).toBe(Number.NEGATIVE_INFINITY);
    expect(sum.delta).toBeCloseTo(
      evaluatePosition(pm.prepared, ZERO_SCENARIO, pm.ctx, settings).total.deltaLarge,
      12,
    );
    expect(sum.excluded).toBe(0);
    expect(sum.offBoard).toBe(0);
    expect(sum.legCount).toBe(2);
    expect(sum.months).toBe('2026-11');
    expect(sum.mark?.pnl).toBe(-22_600);
  });

  it('板に無い限月の足は「板に無い足」・評価から除く（AC9）', () => {
    const s = strangle(0);
    const legs = [...s.legs, { id: 3, leg: op('put', 60000, 'buy', 300, '2026-09'), marks: [] }];
    const e = entryOf({ ...s, legs });
    const sum = entrySummary(chain, e, 'B', CALENDAR);
    expect(sum.offBoard).toBe(1);
    expect(sum.excluded).toBe(1);
    expect(sum.mark).toEqual({ pnl: null, theoretical: false, missing: 1 });
    const view = bookListModel({
      chain,
      read: readOf(e),
      atmBasis: 'B',
      calendar: CALENDAR,
      unitSetting: 'auto',
      currentKey: '',
      legCount: 0,
    });
    const row = view.rows[0];
    expect(row?.tags).toEqual([{ text: '板に無い足 1', warn: true }]);
    expect(row?.note).toBe('一部の足を除く（1 本）');
    expect(row?.markText).toBe('—');
    expect(row?.markNote).toBe('今の板で値の無い足 1 本');
  });

  it('手入力の足（板に無い限月・保存した市場）は満期の最大損失・Δ に入り、評価損益は出さない', () => {
    const { book } = (() => {
      const r = readBook(JSON.stringify(bookV1));
      if (r.kind !== 'ok') throw new Error('読めない');
      return r;
    })();
    const e = book.entries[1] as OkEntry;
    const sum = entrySummary(chain, e, 'B', CALENDAR);
    expect(sum.excluded).toBe(0);
    expect(sum.offBoard).toBe(0);
    expect(Number.isFinite(sum.delta)).toBe(true);
    expect(sum.mark?.pnl).toBeNull();
    expect(sum.mark?.missing).toBe(1);
  });
});

describe('一覧の表示モデル（AC4）', () => {
  const s = strangle(50);
  const key = bookKey(s.legs, s.scenario, s.feePerLot, s.futureBasis);

  it('行の文言・単位（受取 + 支払 ≥ 10 万円で千円）・作業中のタグ', () => {
    const e = entryOf(s, '11月 ストラングル');
    const view = bookListModel({
      chain,
      read: readOf(e),
      atmBasis: 'B',
      calendar: CALENDAR,
      unitSetting: 'auto',
      currentKey: key,
      legCount: 2,
    });
    expect(view.state).toBe('ok');
    expect(view.count).toBe(1);
    expect(view.sizeText).toBe('1 件・約 1.2 千字');
    expect(view.unit).toBe('thousand');
    expect(view.unitLabel).toBe('千円');
    expect(view.boardText).toBe('2026-10-13 21:31');
    expect(view.unsaved).toBe(false);
    const row = view.rows[0];
    expect(row).toMatchObject({
      status: 'ok',
      name: '11月 ストラングル',
      current: true,
      tags: [{ text: '作業中', warn: false }],
      months: '2026-11',
      legs: '足 2 本',
      premiumLabel: '受取',
      premiumText: '1,620',
      maxLossText: '−∞',
      markText: '−22.6',
      markNote: null,
      note: null,
      savedText: '2026-10-16 12:00',
      boardText: '2026-10-13 21:31',
    });
    expect(row?.deltaText).toMatch(/^[+−]?\d+\.\d\d$/);
  });

  it('作業中の内容と違えば「未保存」（足 0 本は未保存にしない）', () => {
    const e = entryOf(s);
    const input = {
      chain,
      read: readOf(e),
      atmBasis: 'B' as const,
      calendar: CALENDAR,
      unitSetting: 'yen' as const,
    };
    const changed = run(s, { type: 'editLeg', id: 1, patch: { qty: 2 } });
    const v = bookListModel({
      ...input,
      currentKey: bookKey(changed.legs, changed.scenario, changed.feePerLot, changed.futureBasis),
      legCount: 2,
    });
    expect(v.unsaved).toBe(true);
    expect(v.rows[0]?.current).toBe(false);
    expect(v.rows[0]?.markText).toBe('−22,600');
    expect(bookListModel({ ...input, currentKey: '', legCount: 0 }).unsaved).toBe(false);
  });

  it('板が無ければ評価損益・最大損失・Δ は「—」（受取 / 掛け金は出す）', () => {
    const v = bookListModel({
      chain: null,
      read: readOf(entryOf(s)),
      atmBasis: 'B',
      calendar: CALENDAR,
      unitSetting: 'yen',
      currentKey: key,
      legCount: 2,
    });
    expect(v.boardText).toBeNull();
    expect(v.rows[0]).toMatchObject({
      premiumText: '1,620,000',
      maxLossText: '—',
      deltaText: '—',
      markText: '—（板を読むと出る）',
    });
  });

  it('読めない・新しい版の項目は固定の文言だけ（名前を使わない）。入れ物が読めない・新しい版', () => {
    const v1 = structuredClone(bookV1) as { entries: unknown[] };
    const newer = structuredClone(bookV1.entries[0]) as {
      id: string;
      workspace: { schema_version: number };
    };
    newer.id = 'nw';
    newer.workspace.schema_version = 5;
    v1.entries = [newer, { id: 'bad', name: '<b>x</b>', workspace: 1 }];
    const read = readBook(JSON.stringify(v1));
    const base = {
      chain,
      atmBasis: 'B' as const,
      calendar: CALENDAR,
      unitSetting: 'auto' as const,
      currentKey: '',
      legCount: 0,
    };
    const v = bookListModel({ ...base, read });
    expect(v.rows.map((r) => [r.status, r.name])).toEqual([
      ['newer', NEWER_ROW_TEXT],
      ['invalid', INVALID_ROW_TEXT],
    ]);
    expect(v.rows[0]?.savedText).toBe('2026-10-13 21:45');
    expect(bookListModel({ ...base, read: { kind: 'invalid' } }).state).toBe('invalid');
    expect(bookListModel({ ...base, read: { kind: 'newer', version: 2 } }).state).toBe('newer');
    expect(bookListModel({ ...base, read: { kind: 'empty' } })).toMatchObject({
      state: 'empty',
      count: 0,
      sizeText: '0 件・約 0.0 千字',
    });
  });

  it('容量の 80% を超えたら「残りが少ない」', () => {
    const e = entryOf(s);
    const base = {
      chain: null,
      atmBasis: 'B' as const,
      calendar: CALENDAR,
      unitSetting: 'auto' as const,
      currentKey: '',
      legCount: 0,
    };
    expect(
      bookListModel({ ...base, read: { kind: 'ok', book: { entries: [e] }, chars: 800_001 } })
        .nearFull,
    ).toBe(true);
    expect(
      bookListModel({ ...base, read: { kind: 'ok', book: { entries: [e] }, chars: 800_000 } })
        .nearFull,
    ).toBe(false);
    const many = Array.from({ length: 81 }, (_, i) => ({ ...e, id: `e${i}` }));
    expect(
      bookListModel({ ...base, read: { kind: 'ok', book: { entries: many }, chars: 10 } }).nearFull,
    ).toBe(true);
  });
});

describe('確認・知らせ（AC6・AC7）', () => {
  it('未保存なら開く前に確認、そうでなければすぐ開く', () => {
    expect(requestOpen(true, 'x')).toEqual({ kind: 'open', id: 'x' });
    expect(requestOpen(false, 'x')).toBe('open');
  });

  it('確認・知らせの文言は固定の文 + 件数（+ 利用者の付けた名前）', () => {
    expect(confirmText({ kind: 'open', id: 'x' }, 'A', 3)).toBe(
      '作業中の足 3 本は保存一覧に無い。「A」を開くと置き換わる（作業の自動保存は 1 つだけ）',
    );
    expect(confirmText({ kind: 'overwrite', id: 'x' }, 'A', 2)).toBe(
      '「A」を作業中の内容（足 2 本）で上書きする？',
    );
    expect(confirmText({ kind: 'remove', id: 'x' }, 'A', 0)).toBe('「A」を削除する？');
    expect(importDoneText(3, 1)).toBe('3 件を追加、1 件は読めなかった');
    expect(importDoneText(2, 0)).toBe('2 件を追加');
    expect(exportDoneText(2, 1)).toBe('2 件を書き出した（読めない 1 件は除いた）');
    expect(BOOK_FAIL_TEXT.full).toBe('保存一覧は 100 件まで。不要な項目を削除してから');
    expect(BOOK_FAIL_TEXT.fileTooLarge).toBe('ファイルが大きすぎる（2 MB まで）');
  });
});
