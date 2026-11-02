/**
 * 画面の段階（#61。docs/ui-redesign.md §2・§2.5・§10.1）。ui/**\/*.css の @media と同じ文字列にする（CSS からは import
 * できない。tests/ui/layout.test.ts が CSS の @media の条件をすべて CSS_MEDIA と照合する）。
 *
 * - スマホ: 幅 < 720px、または横向き（LAND_QUERY）。舞台 / シート / ドック（横向きは 舞台 | パネルの列 | 右端のドック）
 * - タブレット: 720〜1199.98px で横向きでない（市場 | シミュレーター + 詳細 の 2 列）
 * - PC: ≥ 1200px（板 | シミュレーター | 詳細 の 3 列）
 *
 * 書き方は Media Queries 3（カンマの和と and だけ）。MQ4 の `not (…)`・範囲の構文は iOS 16.4 未満で規則ごと落ちるので使わない。
 */

/**
 * スマホの横向き（#348）: タッチが主の端末で、高さ 500px 以下・幅 560〜1199.98px（幅 ≥ 560 > 高さなので横向きは含意）。
 * マウスの PC の低い窓・タブレットの横向き（高さ ≥ 700）・縦向きのスマホ（幅 < 560）・幅 ≥ 1200 の低いタッチの窓は含まない
 */
export const LAND_QUERY =
  '(pointer: coarse) and (min-width: 560px) and (max-width: 1199.98px) and (max-height: 500px)';
/** スマホの段（幅 < 720px か横向き。損益グラフの描画域の高さは ui/view/pnlChart.ts の pnlChartHeight） */
export const PHONE_QUERY = `(max-width: 719.98px), ${LAND_QUERY}`;
/** PC の幅（市場 | 舞台 + シナリオ | 作業台 の 3 列。CSS の `@media (min-width: 1200px)`） */
export const PC_QUERY = '(min-width: 1200px)';
/**
 * タブレットの段（CSS だけ。JS の段は PHONE_QUERY・PC_QUERY のどちらでもない）= 幅 720〜1199.98px かつ 横向きでない。
 * 横向きでない = pointer が coarse でない（fine / none）か、高さ > 500px の和（幅 ≥ 720 は横向きの幅の条件を満たすので、
 * 残る 2 つの条件の否定の和で足りる）
 */
const TABLET_W = '(min-width: 720px) and (max-width: 1199.98px)';
export const TABLET_MEDIA = [
  `${TABLET_W} and (pointer: fine)`,
  `${TABLET_W} and (pointer: none)`,
  `${TABLET_W} and (min-height: 500.02px)`,
].join(', ');
/** タブレット以上（スマホの段でない。シナリオを舞台の下に常設する）= PC か タブレット */
export const TABLET_UP_MEDIA = `${PC_QUERY}, ${TABLET_MEDIA}`;

/**
 * CSS の @media に書いてよい条件（`prefers-*` を除く）。段の 4 つ・横向き・PC の中の細かい幅（IV 推移のツールの行）と、
 * PC でない（スマホ + タブレット）
 */
export const CSS_MEDIA: readonly string[] = [
  PHONE_QUERY,
  PC_QUERY,
  TABLET_MEDIA,
  TABLET_UP_MEDIA,
  LAND_QUERY,
  '(max-width: 1199.98px)',
  '(min-width: 1200px) and (max-width: 1439.98px)',
  '(min-width: 1200px) and (max-width: 1279.98px)',
];
