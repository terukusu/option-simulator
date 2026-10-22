/**
 * スマイルの売りの効率の線（#163）の点を、シナリオが止まってから作るフック（DOM・CSS を持たない）。
 *
 * - 1 本 ≈ 行使価格ごとに Black-76 と証拠金の格子 30 点（322 行の板で数 ms）。スライダーの 1 フレームに足さないため、
 *   シナリオが変わったら MARGIN_LINE_SETTLE_MS（追証の線と同じ）止まってから 1 回作る
 * - 待っている間は前の線を出したまま（限月・横軸・基準・市場が同じときだけ。横軸の座標が変わるなら隠して、すぐ作る）
 * - 入力が null（重ねていない・表示中でない限月・今の線が要らない）なら null
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChainMonth } from '../../data';
import type { AtmBasis, Scenario } from '../../model';
import { MARGIN_LINE_SETTLE_MS } from '../view/margin';
import type { SmileAxis } from '../view/smile';
import { type SmileEffBase, type SmileEffPoint, smileEffPoints } from '../view/smileEff';

export interface SmileEffLineInput {
  month: ChainMonth;
  basis: AtmBasis;
  axis: SmileAxis;
  base: SmileEffBase;
  scenario: Scenario;
}

/** 横軸の座標が同じ（シナリオだけが違う）か */
const sameFrame = (a: SmileEffLineInput, b: SmileEffLineInput) =>
  a.month === b.month && a.basis === b.basis && a.axis === b.axis && a.base === b.base;

export function useSmileEffLine(input: SmileEffLineInput | null): SmileEffPoint[] | null {
  const [line, setLine] = useState<{ key: SmileEffLineInput; pts: SmileEffPoint[] } | null>(null);
  const last = useRef<SmileEffLineInput | null>(null);
  useEffect(() => {
    if (!input) {
      // 消した後にまた重ねたら、前の線（古いシナリオ）を出さずにすぐ作る
      last.current = null;
      setLine(null);
      return;
    }
    // シナリオだけの変化は止まってから、座標が変わる（初回・限月・横軸の切替）ならすぐ作る
    const prev = last.current;
    const delay = prev && sameFrame(prev, input) ? MARGIN_LINE_SETTLE_MS : 0;
    const id = setTimeout(() => {
      last.current = input;
      const { month, basis, axis, base, scenario } = input;
      setLine({ key: input, pts: smileEffPoints(month, basis, axis, base, scenario) });
    }, delay);
    return () => clearTimeout(id);
  }, [input]);
  return input && line && sameFrame(line.key, input) ? line.pts : null;
}
