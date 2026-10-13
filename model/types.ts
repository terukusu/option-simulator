/** 板の型（model/ が受け取る正規化済みの形。API の JSON からの変換は data/）。 */

export interface Quote {
  bid: number | null;
  ask: number | null;
  /** 約定価格（その立会内。無ければ null） */
  last?: number | null;
}

export interface StrikeRow {
  /** 行使価格 */
  k: number;
  call: Quote;
  put: Quote;
}

export function hasTwoSided(q: Quote): q is Quote & { bid: number; ask: number } {
  return q.bid !== null && q.ask !== null && q.bid > 0 && q.ask >= q.bid;
}

export function midOf(q: Quote): number | null {
  return hasTwoSided(q) ? (q.bid + q.ask) / 2 : null;
}
