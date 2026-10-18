/**
 * 画面の幅の段階（#61。設計 6.1）。ui/next/css/*.css の @media と同じ値にする（CSS からは import できない）。
 *
 * - スマホ: < 720px（1 列。`@media (max-width: 719.98px)`）
 * - タブレット: 720〜1199.98px（板 | シミュレーター + 詳細 の 2 列。`@media (min-width: 720px)`）
 * - PC: ≥ 1200px（板 | シミュレーター | 詳細 の 3 列。`@media (min-width: 1200px)`）
 */

/** スマホの幅（損益グラフの描画域を 180px にする。ui/view/pnlChart.ts の pnlChartHeight） */
export const PHONE_QUERY = '(max-width: 719.98px)';
/** PC の幅（市場 | 舞台 + シナリオ | 作業台 の 3 列。新しい画面 ui/next/ の CSS の `@media (min-width: 1200px)`） */
export const PC_QUERY = '(min-width: 1200px)';
