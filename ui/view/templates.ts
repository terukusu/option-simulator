/**
 * 戦略テンプレート（#20。docs/design.md M7・AC9・5.9・13.4「戦略テンプレート」）。純関数（DOM・通信・時計に依存しない）。
 *
 * 形の表（SHAPES）と、形 × 限月 × 距離 × 翼 × ATM の基準 → 足の仕様（種別・限月・K・売買・倍率）か組めない理由
 * （shapeLegs）。AI の提案の structure_candidates（ui/view/aiPropose.ts）も同じ組み立てを使う（|Δ| の距離・atmK を渡す）。
 *
 * 行使価格の選び方（5.9 の「揃えるもの」）:
 * - OTM の距離 = [σ | Δ | 円]。σ = X₀,i × σ_ATM,i × √T_i × 倍率（σ_ATM,i = ATM の行の OTM 側の節点の mid IV）、
 *   円 = X₀,i からの距離。put は K ≤ X₀,i、call は K ≥ X₀,i の両気配の行のうち目標に最も近い行（同じ距離は OTM の遠い方）。
 *   Δ = OTM 側で |Δ| が最も近い両気配の行（AI の提案と同じ strikeByDelta。OTM の判定は F）
 * - ATM の形 = ATM（`m.atm[basis].pick`。板・スマイルと同じ）から板の行で n 本
 * - 翼 = K × (1 ± 翼%) に最も近い両気配の行（AI の提案と同じ strikeNear。put は K より下、call は上）
 * - put レシオの買い = 売りの |Δ| + 0.15（Δ の距離は目標の |Δ| + 0.15 = AI の提案と同じ）
 * - カレンダー = 選んだ限月を売り・板の次の限月（スマイルと F があるもの）を買い。同じ K（ATM から n 本）、種別はその行の
 *   OTM 側（K < F は put）。両方の限月でその K が両気配であること
 *
 * 単位: K・円は円、σ の値は倍率（× σ_ATM）、Δ の値は |Δ|（0〜1）、翼は %（3 = 3%）、T は年（m.T）。
 */

import type { Chain, ChainMonth } from '../../data';
import type { AtmBasis, OptionType, Side } from '../../model';
import { fin } from './finite';
import {
  atmOffsetK,
  atmSigma,
  deltaAt,
  nearestQuoted,
  quotedStrikes,
  rowIndex,
  strikeByDelta,
  strikeNear,
  usableMonth,
} from './strikePick';

/** 形の ID（AI の提案の structure と同じ文字列） */
export const SHAPE_IDS = [
  'short_strangle',
  'short_straddle',
  'iron_condor',
  'bull_put',
  'bear_call',
  'put_ratio',
  'long_strangle',
  'long_straddle',
  'bull_call',
  'bear_put',
  'call_butterfly',
  'calendar',
] as const;
export type ShapeId = (typeof SHAPE_IDS)[number];

export const isShapeId = (v: unknown): v is ShapeId =>
  typeof v === 'string' && (SHAPE_IDS as readonly string[]).includes(v);

/** 一覧の群（売り / 買い） */
export type ShapeGroup = 'sell' | 'buy';

export interface Shape {
  id: ShapeId;
  /** 名前（カードの見出し・トースト・パレット） */
  name: string;
  /** 一覧の短い名前（360px の 2 列で切れないように。省略 = name） */
  short?: string;
  group: ShapeGroup;
  /** 行使価格の選び方: otm = OTM の距離 [σ | Δ | 円]、atm = ATM から n 本 */
  place: 'otm' | 'atm';
  /** 翼の幅 % を使う */
  wing: boolean;
  /** 一言（一覧） */
  note: string;
  /** 検索の語（パレット。英語の読み） */
  keywords: string;
  /**
   * 満期の損益の形の小さな図の点列（viewBox 0 0 32 16。y は下向き = 小さいほど利益。0 の線は y = 8）。固定の値
   */
  points: readonly (readonly [number, number])[];
}

export const SHAPES: readonly Shape[] = [
  {
    id: 'short_strangle',
    name: 'ストラングル売り',
    group: 'sell',
    place: 'otm',
    wing: false,
    note: '両側の OTM を売る。レンジで稼ぐ',
    keywords: 'short strangle',
    points: [
      [0, 15],
      [10, 4],
      [22, 4],
      [32, 15],
    ],
  },
  {
    id: 'short_straddle',
    name: 'ストラドル売り',
    group: 'sell',
    place: 'atm',
    wing: false,
    note: 'ATM を両方売る。動かなければ最大',
    keywords: 'short straddle',
    points: [
      [0, 15],
      [16, 2],
      [32, 15],
    ],
  },
  {
    id: 'iron_condor',
    name: 'アイアンコンドル',
    group: 'sell',
    place: 'otm',
    wing: true,
    note: 'ストラングル売りに翼の買い。損失に上限',
    keywords: 'iron condor',
    points: [
      [0, 12],
      [8, 12],
      [12, 4],
      [20, 4],
      [24, 12],
      [32, 12],
    ],
  },
  {
    id: 'bull_put',
    name: 'ブル put スプレッド',
    group: 'sell',
    place: 'otm',
    wing: true,
    note: 'put を売り、下の put を買う',
    keywords: 'bull put spread',
    points: [
      [0, 12],
      [10, 12],
      [18, 4],
      [32, 4],
    ],
  },
  {
    id: 'bear_call',
    name: 'ベア call スプレッド',
    group: 'sell',
    place: 'otm',
    wing: true,
    note: 'call を売り、上の call を買う',
    keywords: 'bear call spread',
    points: [
      [0, 4],
      [14, 4],
      [22, 12],
      [32, 12],
    ],
  },
  {
    id: 'put_ratio',
    name: 'put レシオ（1 買 2 売）',
    short: 'put レシオ',
    group: 'sell',
    place: 'otm',
    wing: false,
    note: 'put を 1 枚買い 2 枚売る。下に損失',
    keywords: 'put ratio spread',
    points: [
      [0, 15],
      [12, 3],
      [20, 7],
      [32, 7],
    ],
  },
  {
    id: 'long_strangle',
    name: 'ストラングル買い',
    group: 'buy',
    place: 'otm',
    wing: false,
    note: '両側の OTM を買う。大きく動けば利益',
    keywords: 'long strangle',
    points: [
      [0, 1],
      [10, 12],
      [22, 12],
      [32, 1],
    ],
  },
  {
    id: 'long_straddle',
    name: 'ストラドル買い',
    group: 'buy',
    place: 'atm',
    wing: false,
    note: 'ATM を両方買う。どちらかに動けば利益',
    keywords: 'long straddle',
    points: [
      [0, 1],
      [16, 14],
      [32, 1],
    ],
  },
  {
    id: 'bull_call',
    name: 'ブル call スプレッド',
    group: 'buy',
    place: 'atm',
    wing: true,
    note: 'ATM の call を買い、上の call を売る',
    keywords: 'bull call spread',
    points: [
      [0, 12],
      [12, 12],
      [20, 4],
      [32, 4],
    ],
  },
  {
    id: 'bear_put',
    name: 'ベア put スプレッド',
    group: 'buy',
    place: 'atm',
    wing: true,
    note: 'ATM の put を買い、下の put を売る',
    keywords: 'bear put spread',
    points: [
      [0, 4],
      [12, 4],
      [20, 12],
      [32, 12],
    ],
  },
  {
    id: 'call_butterfly',
    name: 'バタフライ（call）',
    group: 'buy',
    place: 'atm',
    wing: true,
    note: '中心を 2 枚売り両翼を買う。中心で最大',
    keywords: 'call butterfly',
    points: [
      [0, 11],
      [10, 11],
      [16, 2],
      [22, 11],
      [32, 11],
    ],
  },
  {
    id: 'calendar',
    name: 'カレンダー',
    group: 'buy',
    place: 'atm',
    wing: false,
    note: '近い限月を売り、次の限月を買う（同じ K）',
    keywords: 'calendar spread time spread',
    points: [
      [0, 11],
      [8, 10],
      [16, 2],
      [24, 10],
      [32, 11],
    ],
  },
];

const SHAPE_BY_ID: Readonly<Record<ShapeId, Shape>> = Object.fromEntries(
  SHAPES.map((s) => [s.id, s]),
) as Record<ShapeId, Shape>;

export const shapeOf = (id: ShapeId): Shape => SHAPE_BY_ID[id];

/** 距離の種類 */
export type DistKind = 'sigma' | 'delta' | 'yen';

export interface ShapeOpts {
  /** ATM の基準（A / B。X₀,i と ATM の行） */
  basis: AtmBasis;
  /** OTM の距離（σ = 倍率、delta = |Δ|、yen = 円） */
  dist: { kind: DistKind; value: number };
  /** ATM から n 本（+ = 高い K） */
  n: number;
  /** 翼の幅（%） */
  wingPct: number;
  /** ATM の K（渡せば basis の pick より優先。AI の提案の委譲用。null = ATM 無し） */
  atmK?: number | null;
}

/** 組んだ足の仕様（枚数は倍率 × 枚数） */
export interface ShapeLeg {
  type: OptionType;
  k: number;
  side: Side;
  mul: number;
  /** 板の限月の ID（カレンダーの買いは次の限月） */
  expiry: string;
}

export type ShapeFail =
  | 'bad_input'
  | 'no_forward'
  | 'no_time'
  | 'no_atm'
  | 'no_atm_iv'
  | 'no_quote_put'
  | 'no_quote_call'
  | 'no_wing'
  | 'no_row'
  | 'ratio_order'
  | 'no_delta'
  | 'no_next_month'
  | 'no_quote_next';

export type ShapeResult = { ok: true; legs: ShapeLeg[] } | { ok: false; reason: ShapeFail };

/** 組めない理由の文（カードとボタンの title） */
export const SHAPE_FAIL_TEXT: Readonly<Record<ShapeFail, string>> = {
  bad_input: '距離・翼の値が範囲の外',
  no_forward: 'この限月は F・スマイルが無いので組めない',
  no_time: 'この限月は満期を過ぎているので σ で選べない',
  no_atm: 'この限月は ATM が決まらないので組めない',
  no_atm_iv: 'ATM の IV が無いので σ で選べない（[Δ] か [円] で選べます）',
  no_quote_put: 'put の側に両気配の行が無い',
  no_quote_call: 'call の側に両気配の行が無い',
  no_wing: '翼の側に両気配の行が無い',
  no_row: 'ATM からその本数の行が無い',
  ratio_order: '買いの put（売りより |Δ| が 0.15 大きい行）を売りの上に選べない',
  no_delta: '売りの put の Δ が求まらないので買いの put を選べない（[Δ] で選べます）',
  no_next_month: '次の限月が板に無いのでカレンダーを組めない',
  no_quote_next: '次の限月の同じ行使価格が両気配でない',
};

/** レシオの買いの足の |Δ| の差（AI の提案の RATIO_BUY_DELTA_GAP と同じ） */
export const RATIO_GAP = 0.15;

const fail = (reason: ShapeFail): ShapeResult => ({ ok: false, reason });
const leg = (type: OptionType, k: number, side: Side, mul: number, expiry: string): ShapeLeg => ({
  type,
  k,
  side,
  mul,
  expiry,
});

/** 入力の形（範囲は呼び出し側 = 画面のステッパー・AI の検査。ここは有限・正・整数だけ見る） */
function badInput(o: ShapeOpts): boolean {
  const v = o.dist.value;
  if (!fin(v) || v <= 0) return true;
  if (o.dist.kind === 'delta' && v >= 1) return true;
  if (!Number.isInteger(o.n)) return true;
  return !fin(o.wingPct) || o.wingPct <= 0 || o.wingPct >= 100;
}

/** その種別の行が両気配か */
const quotedAt = (m: ChainMonth, type: OptionType, k: number) => quotedStrikes(m, type).includes(k);

/**
 * バタフライの翼（左右対称）: 中心 K の上下に同じ幅 w で両方とも両気配の call がある組のうち、w が K × 翼% に最も近い組
 * （同じ近さは狭い方）。無ければ null（非対称の翼では組まない = 両側の損失が掛け金に限られる形を保つ）
 */
function butterflyWings(m: ChainMonth, k: number, wingPct: number): [number, number] | null {
  const target = (k * wingPct) / 100;
  const calls = new Set(quotedStrikes(m, 'call'));
  let best: number | null = null;
  for (const hi of calls) {
    if (hi <= k || !calls.has(2 * k - hi)) continue;
    const w = hi - k;
    if (
      best === null ||
      Math.abs(w - target) < Math.abs(best - target) ||
      (Math.abs(w - target) === Math.abs(best - target) && w < best)
    )
      best = w;
  }
  return best === null ? null : [k - best, k + best];
}

/**
 * 形の足を今の板で組む。OK なら足の仕様（並びは形の定義の順）、組めなければ理由。例外を投げない・NaN を返さない
 */
export function shapeLegs(chain: Chain, m: ChainMonth, id: ShapeId, o: ShapeOpts): ShapeResult {
  if (badInput(o)) return fail('bad_input');
  if (!usableMonth(m)) return fail('no_forward');
  const shape = SHAPE_BY_ID[id];
  const wing = (type: OptionType, k: number) =>
    strikeNear(m, type, k, k * (1 + ((type === 'put' ? -1 : 1) * o.wingPct) / 100));
  const atmK = o.atmK !== undefined ? o.atmK : (m.atm[o.basis].pick?.k ?? null);

  if (shape.place === 'atm') {
    if (atmK === null) return fail('no_atm');
    const k = o.n === 0 ? atmK : atmOffsetK(m, atmK, o.n);
    if (k === null) return fail('no_row');
    return atmShape(chain, m, id, k, o.wingPct, wing);
  }

  // OTM の距離
  const pick = otmPicker(chain, m, o);
  if (!pick.ok) return pick;
  const put = pick.put;
  const call = pick.call;
  const id_ = m.id;
  switch (id) {
    case 'short_strangle':
    case 'long_strangle': {
      const p = put();
      if (p === null) return fail('no_quote_put');
      const c = call();
      if (c === null) return fail('no_quote_call');
      const side: Side = id === 'short_strangle' ? 'sell' : 'buy';
      return { ok: true, legs: [leg('put', p, side, 1, id_), leg('call', c, side, 1, id_)] };
    }
    case 'bull_put': {
      const k = put();
      if (k === null) return fail('no_quote_put');
      const w = wing('put', k);
      if (w === null) return fail('no_wing');
      return { ok: true, legs: [leg('put', k, 'sell', 1, id_), leg('put', w, 'buy', 1, id_)] };
    }
    case 'bear_call': {
      const k = call();
      if (k === null) return fail('no_quote_call');
      const w = wing('call', k);
      if (w === null) return fail('no_wing');
      return { ok: true, legs: [leg('call', k, 'sell', 1, id_), leg('call', w, 'buy', 1, id_)] };
    }
    case 'iron_condor': {
      const p = put();
      if (p === null) return fail('no_quote_put');
      const c = call();
      if (c === null) return fail('no_quote_call');
      const pw = wing('put', p);
      const cw = wing('call', c);
      if (pw === null || cw === null) return fail('no_wing');
      return {
        ok: true,
        legs: [
          leg('put', pw, 'buy', 1, id_),
          leg('put', p, 'sell', 1, id_),
          leg('call', c, 'sell', 1, id_),
          leg('call', cw, 'buy', 1, id_),
        ],
      };
    }
    case 'put_ratio': {
      const sell = put();
      if (sell === null) return fail('no_quote_put');
      // 買いの |Δ|: Δ の距離は目標 + 0.15（AI の提案と同じ）、σ / 円は売りの行の |Δ| + 0.15
      const base =
        o.dist.kind === 'delta' ? o.dist.value : Math.abs(deltaAt(chain, m, sell, 'put'));
      if (!fin(base)) return fail('no_delta');
      const buy = strikeByDelta(chain, m, 'put', base + RATIO_GAP);
      if (buy === null || buy <= sell) return fail('ratio_order');
      return { ok: true, legs: [leg('put', buy, 'buy', 1, id_), leg('put', sell, 'sell', 2, id_)] };
    }
    default:
      return fail('bad_input');
  }
}

type Picker =
  | { ok: true; put: () => number | null; call: () => number | null }
  | { ok: false; reason: ShapeFail };

/** OTM の距離の行の選び方（put / call の K を返す関数。σ・円は X₀,i が要る、σ は σ_ATM,i と T > 0 も要る） */
function otmPicker(chain: Chain, m: ChainMonth, o: ShapeOpts): Picker {
  const v = o.dist.value;
  if (o.dist.kind === 'delta') {
    return {
      ok: true,
      put: () => strikeByDelta(chain, m, 'put', v),
      call: () => strikeByDelta(chain, m, 'call', v),
    };
  }
  const x0 = m.atm[o.basis].reference.price;
  if (x0 === null || !fin(x0)) return { ok: false, reason: 'no_atm' };
  let dist: number;
  if (o.dist.kind === 'sigma') {
    if (!(m.T > 0)) return { ok: false, reason: 'no_time' };
    const sig = atmSigma(m, o.basis);
    if (sig === null) return { ok: false, reason: 'no_atm_iv' };
    dist = x0 * sig * Math.sqrt(m.T) * v;
  } else dist = v;
  return {
    ok: true,
    put: () => nearestQuoted(m, 'put', x0 - dist, 'below', x0),
    call: () => nearestQuoted(m, 'call', x0 + dist, 'above', x0),
  };
}

/** ATM の形（K = ATM から n 本） */
function atmShape(
  chain: Chain,
  m: ChainMonth,
  id: ShapeId,
  k: number,
  wingPct: number,
  wing: (type: OptionType, k: number) => number | null,
): ShapeResult {
  const id_ = m.id;
  switch (id) {
    case 'short_straddle':
    case 'long_straddle': {
      if (!quotedAt(m, 'put', k)) return fail('no_quote_put');
      if (!quotedAt(m, 'call', k)) return fail('no_quote_call');
      const side: Side = id === 'short_straddle' ? 'sell' : 'buy';
      return { ok: true, legs: [leg('put', k, side, 1, id_), leg('call', k, side, 1, id_)] };
    }
    case 'bull_call': {
      if (!quotedAt(m, 'call', k)) return fail('no_quote_call');
      const w = wing('call', k);
      if (w === null) return fail('no_wing');
      return { ok: true, legs: [leg('call', k, 'buy', 1, id_), leg('call', w, 'sell', 1, id_)] };
    }
    case 'bear_put': {
      if (!quotedAt(m, 'put', k)) return fail('no_quote_put');
      const w = wing('put', k);
      if (w === null) return fail('no_wing');
      return { ok: true, legs: [leg('put', k, 'buy', 1, id_), leg('put', w, 'sell', 1, id_)] };
    }
    case 'call_butterfly': {
      if (!quotedAt(m, 'call', k)) return fail('no_quote_call');
      const w = butterflyWings(m, k, wingPct);
      if (w === null) return fail('no_wing');
      const [lo, hi] = w;
      return {
        ok: true,
        legs: [
          leg('call', lo, 'buy', 1, id_),
          leg('call', k, 'sell', 2, id_),
          leg('call', hi, 'buy', 1, id_),
        ],
      };
    }
    case 'calendar': {
      const type = m.strikes[rowIndex(m, k)]?.otmType ?? (k < m.F ? 'put' : 'call');
      if (!quotedAt(m, type, k)) return fail(type === 'put' ? 'no_quote_put' : 'no_quote_call');
      const next = nextMonth(chain, m);
      if (!next) return fail('no_next_month');
      if (!quotedAt(next, type, k)) return fail('no_quote_next');
      return { ok: true, legs: [leg(type, k, 'sell', 1, id_), leg(type, k, 'buy', 1, next.id)] };
    }
    default:
      return fail('bad_input');
  }
}

/** 板の次の限月（スマイルと F があるもの。無ければ null） */
export function nextMonth(chain: Chain, m: ChainMonth): ChainMonth | null {
  const i = chain.months.findIndex((x) => x.id === m.id);
  if (i < 0) return null;
  return chain.months.slice(i + 1).find(usableMonth) ?? null;
}
