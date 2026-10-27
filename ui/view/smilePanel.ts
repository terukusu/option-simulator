/**
 * 画面のスマイルの表示モデル（純関数。#85、docs/ui-redesign.md §3・§4.3・§11 決定 12）。
 * 座標・点・線は今の `ui/view/smile.ts`（smileModel・smileMarkX）のまま。ここは操作行・凡例・線の種類の文字列だけ。
 */

import type { ChainMonth } from '../../data';
import type { AtmBasis, OptionType } from '../../model';
import { type FairView, fairView } from './fairValue';
import { fmtIv, fmtNum } from './format';
import { smilePickRow } from './smile';

/** 縦線の種類（CSS: ATM = --ink-3 の点線、シナリオ ATM = --pin2 の細い実線（舞台と同じ）、選択 = --ink。#279） */
export const SMILE_LINE_CLASS = { atm: 'atm', scenario: 'atm2', pick: 'sel' } as const;

/** 操作行の未選択の案内 */
export const SMILE_ACT_HINT = '点をタップで選ぶ · 長押しで連続 · , .';
/** [効率] オンで未選択のときの操作行（#259。線は必ず ATM 付近で尖るので、効率の定義と注意をここに出す） */
export const SMILE_EFF_ACT_HINT =
  '効率 = プレミアム ÷ 必要証拠金（1 枚売り）· 高い所ほど値動きの損失も大きい';

export type SmileAct =
  | { hint: string }
  | {
      k: number;
      /** `64,000 put` */
      title: string;
      /** `IV 28.0`（その行のスマイルの IV、1 桁） */
      iv: string;
      unstable: boolean;
      /**
       * 理論価格（#264。その行の気配を使わず周りの気配の狭い行のスマイルから。外挿の印（中立の .tag）。使った IV と
       * 気配の中の位置は title（label）だけ = bid / ask は隣のボタンに出ている）。出せなければ null
       */
      fair: FairView | null;
      /** 足の種別（OTM 側。smilePickRow） */
      type: OptionType;
      /** bid / ask の数字（無ければ —） */
      bid: string;
      ask: string;
      /** ボタンの aria-label */
      sellLabel: string;
      buyLabel: string;
    };

/**
 * 操作行（未選択・板に無い K は案内。[効率] オンなら効率の定義と注意 = SMILE_EFF_ACT_HINT）。r は理論価格の金利（chain.r）。
 */
export function smileAct(
  month: ChainMonth,
  pick: number | null,
  r: number,
  effOn = false,
): SmileAct {
  const hint = { hint: effOn ? SMILE_EFF_ACT_HINT : SMILE_ACT_HINT };
  if (pick === null) return hint;
  const row = smilePickRow(month, pick);
  if (!row) return hint;
  const info = month.strikes.find((s) => s.k === pick);
  const title = `${fmtNum(row.k, 0)} ${row.type}`;
  const bid = fmtNum(row.bid, 0);
  const ask = fmtNum(row.ask, 0);
  return {
    k: row.k,
    title,
    iv: `IV ${fmtIv(info?.smileIv)}`,
    unstable: row.unstable,
    fair: fairView(month, row.k, row.type, r, row.bid, row.ask),
    type: row.type,
    bid,
    ask,
    sellLabel: `${title} を売り（bid ${row.bid === null ? '気配なし' : bid}）`,
    buyLabel: `${title} を買い（ask ${row.ask === null ? '気配なし' : ask}）`,
  };
}

export interface SmileLegendItem {
  key: string;
  text: string;
  /** 狭い列での短い形（項目は隠さず短くする。全文は ⓘ の SMILE_HINT） */
  short: string;
  /** 印の色のクラス（線・点と同じ） */
  cls: string;
}

/**
 * 凡例（ΔX ≠ 0 = シナリオ ATM の K があれば、ATM の後にシナリオ ATM）。bid / ask の点は板の気配と同じ色なので凡例に
 * 出さない（意味は ⓘ の SMILE_LEGEND_HINT。#279 D-07）。売りの効率の線（#163）を重ねているとき（eff）は
 * 最後に効率の線（シナリオの点 = 実線、今の線があれば（eff.now）今 = 破線。#259 S-1）
 */
export function smileLegend(
  basis: AtmBasis,
  scenarioAtmK: number | null,
  eff: { now: boolean } | null = null,
): SmileLegendItem[] {
  const items: SmileLegendItem[] = [
    { key: 'mid', text: '● mid', short: '●mid', cls: 'mid' },
    { key: 'node', text: '─ 節点', short: '─節点', cls: 'node' },
    { key: 'interp', text: '┄ 補間・外挿', short: '┄補間', cls: 'interp' },
    { key: 'x', text: '× IV 不安定', short: '×不安定', cls: 'x' },
    { key: 'atm', text: `┆ ATM（${basis}）`, short: '┆ATM', cls: SMILE_LINE_CLASS.atm },
  ];
  if (scenarioAtmK !== null) {
    items.push({
      key: 'atm2',
      text: `│ シナリオ ATM ${fmtNum(scenarioAtmK, 0)}`,
      short: '│シナリオ',
      cls: SMILE_LINE_CLASS.scenario,
    });
  }
  if (eff) {
    items.push({ key: 'eff', text: '─ 効率（シナリオ点）', short: '─効率', cls: 'eff' });
    if (eff.now) items.push({ key: 'effNow', text: '┄ 効率（今）', short: '┄今', cls: 'eff now' });
  }
  return items;
}

/** 見出しの ⓘ（今の「スマイルの操作」の文） */
export const SMILE_HINT =
  '点をタップで選択（もう一度タップで解除）。長押しして左右にドラッグで選択を切り替え。十字線: マウスを載せる・タップ（点のタップは点に、横線は指の高さの IV、読み取りは曲線の IV。交点をドラッグで動かす、ほかの所のタップで消す）。操作行の「理論」= その行の IV からではなく、周りの気配の狭い行のスマイルから求めた価格（その行の気配は使わない。100 円未満は小数 1 桁。使った IV と気配の中の位置は文字に重ねた全文・板の K のポップオーバー。翼は外挿）';

/** ⓘ の印の意味（凡例は狭い列で短い形になるので全文はここ） */
export const SMILE_LEGEND_HINT =
  '● mid / bid / ask = OTM 側の IV · ─ 節点の区間 · ┄ 補間・外挿の区間 · × IV 不安定 · ┆ ATM（基準 A / B） · │ シナリオ ATM（ΔX ≠ 0 のとき。損益グラフと同じ線） · ─ 効率（シナリオ点）/ ┄ 効率（今）= [効率] の売りの効率の線（右の目盛り %）';

/** 描画域の操作の説明（今の Smile の aria-label） */
export const SMILE_PLOT_LABEL =
  'スマイル（点をタップで選択・もう一度タップで解除、長押しして左右にドラッグで選択を切り替え、マウスを載せる・タップで十字線（交点をドラッグで動かす、ほかの所のタップで消す）。ホイール・ピンチで拡大、ドラッグでパン、ダブルクリックでリセット。キー: + / − 拡大縮小、← / → パン、R リセット、, / . で選択を 1 本、< / > で 5 本左右へ）';

/** 横軸の Seg の文字（`Δ` は aria-label `デルタ`） */
export const SMILE_AXIS_OPTIONS = [
  { value: 'k', text: '行使価格' },
  { value: 'moneyness', text: 'moneyness' },
  { value: 'delta', text: 'Δ', label: 'デルタ' },
] as const;
