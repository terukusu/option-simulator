import { useMemo } from 'preact/hooks';
import type { Indicators } from '../../../model';
import type { Domain } from '../../chart/scale';
import { pure } from '../../components/pure';
import {
  IND_IMG_LABEL,
  IND_PANE_H,
  type IndKind,
  type IndPaneModel,
  type IndReadout,
  indPaneHeight,
  indPaneModel,
  indReadout,
} from '../../view/indicators';
import { useSize } from '../useSize';

export interface IndicatorPanesProps {
  /** 足の並び全体の指標（model の indicators。FutHistory が足ごとに 1 回計算する） */
  ind: Indicators;
  n: number;
  kinds: readonly IndKind[];
  viewport: Domain;
  /** 価格の描画域の左の余白（系列の目盛りの列） */
  marginLeft: number;
  cursor: number | null;
}

function Pane({ m, ro }: { m: IndPaneModel; ro: IndReadout }) {
  const { width: w, height: h, range } = m;
  return (
    <svg
      class={`ind-pane ${m.kind}`}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={IND_IMG_LABEL[m.kind]}
    >
      <line class="ind-sep" x1={0} x2={w} y1={0.5} y2={0.5} />
      {m.guides.map((g) => (
        <g key={`g${g.label}`}>
          <line
            class={g.zero ? 'ind-guide zero' : 'ind-guide'}
            x1={range[0]}
            x2={range[1]}
            y1={g.y}
            y2={g.y}
          />
          <text class="ind-ty" x={range[0] - 5} y={g.y}>
            {g.label}
          </text>
        </g>
      ))}
      {m.histUp && <path class="ind-hist up" d={m.histUp} />}
      {m.histDown && <path class="ind-hist down" d={m.histDown} />}
      {m.lines.map((l) => (
        <path key={l.cls} class={l.cls} d={l.d || 'M0 0'} />
      ))}
      {ro.cursorX !== null && (
        <line class="ind-cursor" x1={ro.cursorX} x2={ro.cursorX} y1={2} y2={h - 2} />
      )}
      <text class="ind-head" x={range[0] + 4} y={3}>
        <tspan class="name">{m.title}</tspan>
        {ro.values.map((v) => (
          <tspan key={v.cls} class={`v ${v.cls}`} dx={6}>
            {v.k ? `${v.k} ` : ''}
            {v.v}
          </tspan>
        ))}
      </text>
    </svg>
  );
}

/**
 * 先物推移の指標の段（#200。docs/ui-redesign.md §4.8）。座標は ui/view/indicators.ts の indPaneModel、値は
 * model/technicals.ts（AI の道具 technicals と同じ計算）。価格の描画域（IvPlot）と同じ表示範囲・横の画素範囲で、操作は
 * 持たない（パン・拡大・カーソルは価格の描画域で）。枠の高さは段の数のクラス（n1〜n3）で CSS が決め、縦に狭いと縮む
 * （段の高さは枠の高さ ÷ 段の数 = indPaneHeight）。色は CSS のクラスだけ（style 属性なし）。
 */
function IndicatorPanesView(p: IndicatorPanesProps) {
  const { ref, width, height } = useSize(480, IND_PANE_H * p.kinds.length);
  const paneH = indPaneHeight(height, p.kinds.length);
  const models = useMemo(
    () =>
      p.kinds.map((kind) =>
        indPaneModel({
          ind: p.ind,
          kind,
          n: p.n,
          viewport: p.viewport,
          width,
          marginLeft: p.marginLeft,
          height: paneH,
        }),
      ),
    [p.ind, p.kinds, p.n, p.viewport, width, p.marginLeft, paneH],
  );
  // 縦線と値はカーソルだけで作り直す（線の座標は作り直さない）
  const readouts = useMemo(
    () => models.map((m) => indReadout(p.ind, m.kind, p.n, p.viewport, m.range, p.cursor)),
    [models, p.ind, p.n, p.viewport, p.cursor],
  );
  return (
    <div class={`ind-panes n${p.kinds.length}`} ref={ref}>
      {models.map((m, i) => (
        <Pane key={m.kind} m={m} ro={readouts[i] as IndReadout} />
      ))}
    </div>
  );
}

export const IndicatorPanes = pure(IndicatorPanesView);
