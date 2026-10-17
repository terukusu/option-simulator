import type { ChainMonth } from '../../../data';
import { monthSegOptions } from '../../view/boardPanel';
import { Seg } from '../parts/Seg';

/**
 * 限月の Seg（板とスマイルで共用。#85。#79 の IV 推移も使う）。文字は `11月限`、aria-label に `2026-11 限`。
 * 選択は state.monthId（setMonth はスマイルの表示範囲と選択を消す = 今の reducer のまま）。
 */
export function MonthSeg(p: {
  months: readonly ChainMonth[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Seg label="限月" value={p.value} options={monthSegOptions(p.months)} onChange={p.onChange} />
  );
}
