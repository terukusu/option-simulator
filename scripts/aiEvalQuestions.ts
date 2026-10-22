/**
 * AI の評価（scripts/aiEval.mjs）の質問の組（#200・#138・#156・#139・#136・#266。#240 で id を足して aiEval.mjs から移した）。
 * id は前回の実行との差（scripts/aiEvalDiff.ts）で問を対応づける鍵 = 変えない。判定の規則は aiEval.mjs の各ループの
 * 説明を見る。値・前提の文はすべて架空。
 */

interface Question {
  /** 問の名前（前回の実行との比較の鍵。変えない） */
  id: string;
  case: string;
}

/** テクニカルの質問（#200・#206）。mentions は返答が触れること */
export const TECH_QUESTIONS: (Question & { text: string; mentions?: RegExp })[] = [
  {
    id: 'oscillators-daily-4h',
    case: 'put_sell',
    text: '日足と4時間足のRSI・MACD・ストキャスティクスを見て、このポジの崩れ方は？',
  },
  {
    id: 'oscillators-weekly',
    case: 'iron_condor',
    text: '週足のRSI・MACD・ストキャスティクスはどんな状態？過去に似た状態の後はどう動いた？',
  },
  {
    id: 'stoch-rsi-4h',
    case: 'calendar',
    text: '4時間足のストキャスティクスとRSIは今どこにいる？',
  },
  // #206: EMA の 3 本（並び順・距離）。返答が EMA に触れること（mentions）も pass の条件
  {
    id: 'ema-trend',
    case: 'put_sell',
    text: '日足と週足のトレンドは？移動平均の並びと価格の位置で教えて。',
    mentions: /EMA/,
  },
];

/** IV の統計の質問（#138・#158） */
export const IV_QUESTIONS: (Question & { text: string; mentions: RegExp })[] = [
  {
    id: 'iv-percentile',
    case: 'strangle_sell',
    text: '今の IV は過去のどの辺？前に IV が跳ねたときは、どれくらいで萎んだ？',
    mentions: /分位|%/,
  },
  {
    id: 'iv-jump-beta',
    case: 'put_sell',
    text: '2 日で 5% くらい下げたとき、IV は過去どれくらい跳ねてきた？β の実測も教えて。',
    mentions: /β/,
  },
  {
    id: 'iv-vs-hv',
    case: 'iron_condor',
    text: '今の IV は実際の値動き（HV）に比べて高い？ボラ売りのタイミングとしてはどう？',
    mentions: /HV/,
  },
];

/** 自分の前提つきの質問（#156）。misuse はツールの入力に出たら失敗の前提の金額（円） */
export const PROFILE_QUESTIONS: (Question & {
  profile: string;
  text: string;
  mentions: RegExp;
  misuse: number[];
})[] = [
  {
    id: 'loss-limit',
    case: 'put_sell',
    profile:
      '1 回の損失は 1,500 千円まで。期近の深い OTM の put の売りが基本。ネイキッドのコールの売りは避ける。',
    text: '私の前提に照らして、このポジションの弱点と、前提から外れているところを教えて。',
    mentions: /許容|前提|1,500 千円/,
    misuse: [1_500_000, -1_500_000],
  },
  {
    id: 'adjust-words',
    case: 'strangle_sell',
    profile:
      'ネイキッドのコールの売りは避ける。上値の損失は限定したい。判断は SQ までの日数を重く見る。',
    text: 'このポジションの調整の方向を、言葉だけで 3 つ挙げて。',
    mentions: /コール/,
    misuse: [],
  },
];

/** ポジションの提案の質問（#139） */
export const PROPOSE_QUESTIONS: (Question & {
  text: string;
  want: string | null;
  target: 'new_tab' | 'current';
  floor?: number;
})[] = [
  {
    id: 'vol-sell-candidates',
    case: 'strangle_sell',
    text: '今の IV と資金規模から見て、ボラ売りのポジションの候補を出して。新しいタブで比べられるようにして。',
    want: 'structure_candidates',
    target: 'new_tab',
  },
  {
    id: 'hedge-floor',
    case: 'put_ratio',
    text: '最大損失を −1,000 千円に抑えるヘッジの足を足して。',
    want: 'strike_scan',
    target: 'current',
    floor: -1_000_000,
  },
  {
    id: 'condor-adjust',
    case: 'iron_condor',
    text: 'このアイアンコンドルの調整案を出して。足の削除・枚数・行使価格の変更でもいい。',
    want: null,
    target: 'current',
  },
];

/**
 * 行使価格の理論価格の質問（#266）: 文脈のスマイルの 11 点（m ±0.2）の外の遠い OTM。行使価格は合成の板の架空の値。
 * mentions は返答が触れること
 */
export const QUOTE_QUESTIONS: (Question & { text: string; mentions: RegExp })[] = [
  {
    id: 'far-otm-put',
    case: 'put_sell',
    text: '11 月限の遠い OTM の put（行使価格 45,000 円と 40,000 円）の妥当な値段は？スマイルから出して、板の気配と比べて。',
    mentions: /理論|妥当/,
  },
  {
    id: 'thin-and-off-board',
    case: 'strangle_sell',
    text: '12 月限の 37,500 円の put は気配が薄いけど、スマイルから見た IV と妥当な値段はいくら？板に無い 85,000 円の call も。',
    mentions: /IV/,
  },
];

/** [AI に聞く]（#136）: 質問の文は画面と同じ表示モデルから作る */
export const ASK_QUESTIONS: (Question & {
  where: 'tile' | 'readout' | 'tail' | 'iv';
  key?: string;
})[] = [
  { id: 'tile-maxloss', case: 'put_sell', where: 'tile', key: 'maxLoss' },
  { id: 'tile-greeks', case: 'iron_condor', where: 'tile', key: 'greeks' },
  { id: 'readout-delta', case: 'strangle_sell', where: 'readout', key: 'delta' },
  { id: 'tail', case: 'put_sell', where: 'tail' },
  { id: 'iv', case: 'put_sell', where: 'iv' },
];

/** 全部の組の id（重なりの検査用） */
export const QUESTION_IDS = {
  technicals: TECH_QUESTIONS.map((q) => q.id),
  iv_stats: IV_QUESTIONS.map((q) => q.id),
  profile: PROFILE_QUESTIONS.map((q) => q.id),
  propose: PROPOSE_QUESTIONS.map((q) => q.id),
  ask: ASK_QUESTIONS.map((q) => q.id),
  quote: QUOTE_QUESTIONS.map((q) => q.id),
};
