import { Fragment } from 'preact';
import type { FullRow } from '../../view/metricsPanel';

/**
 * 全文（指標のタイル・舞台の読み取りのポップオーバーの中身。#107）。行は表示モデルが作る（ここでは組み立てない）。
 * 2 列の格子（見出し / 値。値は等幅・右寄せ・折り返さない）。1 行目（見出し + 値）は強調。
 * クラスに .k / .v / .s を使わない（.tile .k・.ro .v の CSS・検査と衝突させない）。
 */
export function FullText({ rows }: { rows: readonly FullRow[] }) {
  return (
    <div class="full">
      {rows.map((r, i) => (
        // 行は毎回同じ順で作り直す（続きの行は見出しが空なので位置を key に）
        <Fragment key={i}>
          <span class={i === 0 ? 'fk lead' : 'fk'}>{r.k}</span>
          <span class={i === 0 ? 'fv lead' : 'fv'}>{r.v}</span>
        </Fragment>
      ))}
    </div>
  );
}
