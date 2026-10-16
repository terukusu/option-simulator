import type { ReadoutModel } from '../view/readout';
import { pure } from './pure';

export interface ReadoutProps {
  model: ReadoutModel;
}

/**
 * 読み取りの帯（シナリオ点の値。#52）。損益グラフの直下。上端に残るのは親のドック（.pnl-dock。#61）。
 * 連続して変わる値なので aria-live は付けない。値は ui/view/readout.ts の表示モデル。
 */
function ReadoutView({ model }: ReadoutProps) {
  if (model.empty) return null;
  const t = model.text;
  const u = model.unitLabel;
  return (
    <section class="readout" aria-label="シナリオ点の値">
      <p class="readout-row">
        <span>
          X <b>{t.x}</b>（ΔX {t.dX} 円 / {t.dXPct}%）
        </span>
        <span>d {t.days} 日</span>
      </p>
      <p class="readout-row">
        <span>
          損益（{u}）<span class="lg date">指定日 {t.pnlDate}</span>
        </span>
        <span class="lg expiry">満期 {t.pnlExpiry}</span>
        <span class="lg today">今日 {t.pnlToday}</span>
      </p>
      <p class="readout-row">
        <span>
          Δ {t.deltaLarge} 枚（ミニ {t.deltaMini}）
        </span>
        <span>Γ {t.gamma} / 100 円</span>
        <span>
          Θ {t.theta} {u} / 日
        </span>
        <span>
          V {t.vega} {u} / pt
        </span>
      </p>
    </section>
  );
}

/** 読み取りの帯。props が変わらなければ描き直さない */
export const Readout = pure(ReadoutView);
