/** AC8 の計算部分の計測に使うポジション（足 10 本、2 限月 + 先物。架空の値）。 */

import type { Leg } from '../../model/position';
import { FUT, M1, M2 } from './market';

const op = (
  expiry: string,
  type: 'call' | 'put',
  strike: number,
  side: 'buy' | 'sell',
  entry: number,
): Leg => ({
  kind: 'option',
  product: 'op_large',
  type,
  expiry,
  strike,
  side,
  qty: 1,
  entry,
});

export const PERF_LEGS: Leg[] = [
  op(M1.id, 'put', 64000, 'sell', 810),
  op(M1.id, 'call', 70500, 'sell', 995),
  op(M1.id, 'put', 60000, 'buy', 300),
  op(M1.id, 'call', 73000, 'buy', 310),
  op(M1.id, 'put', 47500, 'sell', 30),
  op(M2.id, 'put', 62500, 'sell', 640),
  op(M2.id, 'call', 72500, 'sell', 560),
  op(M2.id, 'put', 60000, 'buy', 320),
  op(M2.id, 'call', 75000, 'buy', 215),
  { kind: 'future', product: 'fut_mini', contract: FUT.id, side: 'buy', qty: 2, entry: FUT.price },
];
