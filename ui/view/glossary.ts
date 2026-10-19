/**
 * 用語集（#167。docs/ui-redesign.md §4.6・§5、docs/user-guide.md 14 章「用語集（説明カード）」）のデータと表示モデル
 * （純データと純関数。Preact・DOM に依存しない）。
 *
 * - GLOSSARY は関数・undefined を持たず JSON にそのまま直せる形（AI アドバイザー #137 の根拠と共有できる形）
 * - 説明は docs/design.md・docs/user-guide.md の定義に合わせる（定義は変えない）。例の数値は架空の値（「架空」と書く）
 * - 外部 URL を置かない。マニュアルの節は docs/user-guide.md の見出しのアンカー（GitHub の規則）と節の名前だけで、
 *   画面には節の名前を文字で出す（マニュアルはビルド成果物に入れない）
 * - 検索語（termSearchText）は見出し・読み・別名。パレット（ui/view/palette.ts）の行の keywords に入れる
 */

export type TermId =
  | 'iv-shift'
  | 'skew'
  | 'dx'
  | 'iv'
  | 'hv'
  | 'iv30'
  | 'beta'
  | 'greeks'
  | 'delta'
  | 'gamma'
  | 'vega'
  | 'theta'
  | 'forward'
  | 'basis'
  | 'sticky'
  | 'nov'
  | 'pfe'
  | 'margin'
  | 'requirement'
  | 'room'
  | 'margin-line'
  | 'hold-map'
  | 'var-span'
  | 'jscc';

export interface GlossaryTerm {
  id: TermId;
  /** 見出し（例「スキュー Δs」） */
  title: string;
  /** ボタンの短い形（ⓘ の「用語:」・関連する用語。例「Δs」） */
  short: string;
  /** 読み（ひらがな。空白で区切ってよい） */
  reading: string;
  /** 別名（記号・英語・言い換え。括弧を含めない） */
  aliases: string[];
  /** 一言 */
  summary: string;
  /** 説明（段落。1〜4） */
  body: string[];
  /** 式（テキスト） */
  formula?: string;
  /** 例（「架空」を含む） */
  example?: string;
  /** simulator のどこに出るか */
  where: string[];
  /** docs/user-guide.md の見出しのアンカー（# なし）と節の名前 */
  guide: { anchor: string; title: string };
  related: TermId[];
}

const G_STEPPER = { anchor: 'ステッパー', title: '6 章 シナリオ > ステッパー' };
const G_MODEL_PREMISE = { anchor: 'モデルの前提', title: '6 章 シナリオ > モデルの前提' };
const G_LINES = { anchor: '線と印', title: '4 章 舞台（損益グラフ）> 線と印' };
const G_BREAKDOWN = { anchor: '内訳', title: '8 章 作業台: 指標 · テール > 内訳' };
const G_MARGIN = { anchor: '証拠金概算', title: '8 章 作業台: 指標 · テール > 証拠金（概算）' };
const G_HOLD = {
  anchor: '追証マップ',
  title: '8 章 作業台: 指標 · テール > 追証マップ',
};
const G_IV_HISTORY = {
  anchor: 'iv-推移atm-iv-の-30-日固定',
  title: '10 章 市場: スマイル・IV 推移 > IV 推移（ATM IV の 30 日固定）',
};
const G_PRICE_MODEL = { anchor: '価格モデル', title: '16 章 計算の前提と単位 > 価格モデル' };
const G_AXIS = {
  anchor: '横軸基準原資産-xと複数限月',
  title: '16 章 計算の前提と単位 > 横軸（基準原資産 X）と複数限月',
};
const G_UNITS = { anchor: '単位', title: '16 章 計算の前提と単位 > 単位' };

/** 用語（並びはパレットの行の順。IV を先頭に = `?シグマ` の Enter で IV（Δσ より前）） */
export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    id: 'iv',
    title: 'IV（インプライド・ボラティリティ）σ',
    short: 'IV',
    reading: 'あいぶい いんぷらいど ぼらてぃりてぃ しぐま',
    aliases: ['IV', 'σ', 'sigma', 'implied volatility', 'インプライドボラティリティ', '予想変動率'],
    summary: 'オプションの価格から逆算した、市場が織り込む変動率（年率 %）',
    body: [
      'IV はオプションの価格（気配・建値）から Black-76 を逆に解いて逆算した変動率。市場参加者が見込む値動きの大きさ（年率 %）を表す。実際の値動きから計算する HV（ヒストリカルボラティリティ）と対になる用語。',
      '式では σ と書く。σ はグリークではない（グリークは価格の微分で、σ に対する価格の感応度がベガ）。',
      'simulator は足を入れた時点の建値から逆算した IV（アンカー IV）を足ごとに持ち、スマイル（限月ごとの IV の曲線）で行使価格による違いを補う。シナリオの Δσ・Δs・β はこの IV を動かす。',
      'IV と HV の差（IV − HV）はボラティリティ・プレミアムと呼ばれる。',
    ],
    formula: 'Black-76 の理論価格(F, K, T, σ) = 市場の価格 となる σ が IV',
    example:
      '例（架空の値）: IV 20% は 1 年で ±20% 程度（1 標準偏差）の値動きを織り込む水準。30 日なら 20% × √(30 / 365) ≒ 5.7%',
    where: ['板の IV の列', 'スマイル', 'ポジションの足の IV（アンカー IV）', '舞台の IV レール'],
    guide: G_PRICE_MODEL,
    related: ['hv', 'iv30', 'vega', 'greeks', 'iv-shift'],
  },
  {
    id: 'iv-shift',
    title: 'IV 平行移動 Δσ',
    short: 'Δσ',
    reading: 'あいぶい へいこういどう でるたしぐま',
    aliases: ['Δσ', 'デルタシグマ', 'delta sigma', 'IV シフト', 'IV の平行移動'],
    summary: 'すべての行使価格の IV に同じだけ足すシナリオの値（pt）',
    body: [
      'シナリオのステッパーの 1 つ。すべての足・行使価格の IV に同じだけ足す。単位は pt（IV の % ポイント）で、範囲は −10〜+40pt、0.5pt 刻み。',
      'β（IV–原資産連動）とは別に足し算される。β = 1 で原資産が −10% なら、β の分の +10pt に Δσ が加わる。',
      'Δσ はグリークではなくシナリオの入力。Δσ を 1pt 動かしたときの損益の変化の目安がベガ（V）。',
    ],
    formula: 'σ′ = max(1%, σ_base + Δσ + Δσ_β − Δs × x_eff / 0.1)',
    example: '例（架空の値）: ATM の IV 20% で Δσ +5 なら 25%。β = 1・ΔX −10% も当てると 35%',
    where: [
      'シナリオのステッパー「IV 平行移動 Δσ」',
      '舞台の IV レール',
      'プリセットのチップ（急落 −10% / +20pt / +3 など）',
      '必要証拠金・余力のタイルの点の印',
    ],
    guide: G_STEPPER,
    related: ['skew', 'beta', 'vega', 'iv'],
  },
  {
    id: 'skew',
    title: 'スキュー Δs',
    short: 'Δs',
    reading: 'すきゅー でるたえす',
    aliases: ['Δs', 'デルタエス', 'skew', 'スキューの変化', 'IV の傾き'],
    summary: 'moneyness 10% あたりの IV の傾きを変えるシナリオの値（pt / 10%）',
    body: [
      'シナリオのステッパーの 1 つ。単位は pt / moneyness 10%。正の値で put 側（安い行使価格）の IV が上がり、call 側（高い行使価格）の IV が下がる。範囲は −5〜+5、0.5 刻み。',
      'moneyness は x = ln(K / F)。ATM（K = F）では効かないので、ATM の IV（IV 推移のシナリオの水準など）は Δs で動かない。',
      '急落のときに put の IV がより大きく上がる（スキューが立つ）場面を表すのに使う。',
    ],
    formula: 'IV の変化（pt）= −Δs × ln(K / F) / 0.1',
    example:
      '例（架空の値）: Δs = 3 なら 10% OTM の put（ln 0.9 ≒ −0.105）で +3.16pt、10% OTM の call（ln 1.1 ≒ +0.095）で −2.86pt',
    where: [
      'シナリオのステッパー「スキュー Δs」',
      'プリセットのチップ',
      '必要証拠金・余力のタイルの点の印',
    ],
    guide: G_STEPPER,
    related: ['iv-shift', 'iv', 'sticky'],
  },
  {
    id: 'dx',
    title: '原資産の変化 ΔX',
    short: 'ΔX',
    reading: 'げんしさんのへんか でるたえっくす きじゅんげんしさん',
    aliases: ['ΔX', 'デルタエックス', 'X₀', '基準原資産', '原資産'],
    summary: '基準原資産 X₀ からの変化。損益グラフの横軸は基準原資産 X',
    body: [
      '損益グラフの横軸は基準原資産 X。基準 X₀ は 1 限月の基準価格（既定は 1 限月の合成先物 F）。',
      'ΔX はシナリオで X₀ を動かす量で、% か円で入れる。操作の範囲は −90%〜+100%、数値入力は −99%〜+900%。',
      '他の限月・先物の足の原資産は、X との差（basis）を一定に保って動く（円モード）。',
    ],
    formula: 'X′ = X₀ + ΔX',
    example: '例（架空の値）: X₀ 40,000 円で ΔX −5% なら X′ = 38,000 円',
    where: [
      'シナリオのステッパー「原資産 ΔX」',
      '舞台のハンドル（シナリオ点）と X₀ の縦線',
      '読み取り・指標の X',
      '追証マップの横軸',
    ],
    guide: G_AXIS,
    related: ['forward', 'basis', 'beta'],
  },
  {
    id: 'hv',
    title: 'HV（ヒストリカルボラティリティ）',
    short: 'HV',
    reading: 'えいちぶい ひすとりかる ぼらてぃりてぃ',
    aliases: ['HV', 'historical volatility', 'ヒストリカルボラ', '実現ボラティリティ'],
    summary: '実際の値動き（日々の騰落率）から計算した変動率（年率 %）',
    body: [
      'HV は原資産の実際の値動きから計算した変動率で、日々の騰落率の標準偏差を年率にしたもの。過去に実際にどれだけ動いたかを表す。',
      'IV（オプションの価格から逆算した、市場が織り込む変動率）と対になる。IV − HV はボラティリティ・プレミアムと呼ばれ、IV が HV より高いほど、オプションは実際の値動きに比べて高く値付けされている。',
      'simulator は HV を計算・表示しない。IV の水準は IV 推移（iv30）で見る。',
    ],
    formula: 'HV ≒ 日々の騰落率の標準偏差 × √（1 年の営業日の数）',
    example: '例（架空の値）: 日々の騰落率の標準偏差が 1.2% なら HV ≒ 1.2% × √245 ≒ 18.8%',
    where: ['simulator には出ない（IV と比べるための用語）'],
    guide: G_IV_HISTORY,
    related: ['iv', 'iv30'],
  },
  {
    id: 'iv30',
    title: 'iv30（IV 推移の 30 日固定）',
    short: 'iv30',
    reading: 'あいぶいさんじゅう さんじゅうにちこてい',
    aliases: ['iv30', '30 日固定', 'IV 推移', 'constant maturity', 'コンスタントマチュリティ'],
    summary: '残存 30 日にそろえた ATM の IV（%）。IV 推移のチャートの値',
    body: [
      'optionchan が板から 1 回ごとに計算して保存している、残存 30 日にそろえた ATM の IV。期近・次限月の ATM の IV を総分散で 30 日に補間する（SQ の前 3 日は次限月を使う）。限月の乗り換え・ATM の移動による段差が無い。',
      'スマイルの ATM IV・足のアンカー IV（simulator のモデルの IV）とは計算の仕方が別で、近いことが多いが一致しない。',
      '今の IV が過去に比べて高いか低いかを見るのに使う。追証マップの過去の点（2 営業日の IV の倍率）もこの値から作る。',
    ],
    formula: '総分散 w = σ² × T を期近・次限月の間で T = 30 日に線形補間し、iv30 = √(w / T)',
    example:
      '例（架空の値）: 期近（残り 20 日）の ATM IV 22%・次限月（残り 48 日）の 20% なら iv30 は約 20.9%',
    where: ['IV 推移のチャート（「今」の点・シナリオの水準）', '追証マップの過去の点'],
    guide: G_IV_HISTORY,
    related: ['iv', 'hv', 'hold-map'],
  },
  {
    id: 'beta',
    title: 'IV–原資産連動 β',
    short: 'β',
    reading: 'あいぶいげんしさんれんどう べーた',
    aliases: ['β', 'ベータ', 'beta', 'IV 連動'],
    summary: '原資産が 1% 下がるごとに IV を β pt 上げる設定（pt / 1%）',
    body: [
      'シナリオの「モデルの前提」の設定。原資産が 1% 下がるごとに IV を β pt 上げ、上がれば下げる。既定 1.0、0 で連動なし（0〜10）。',
      '評価する点ごとに、その点の下落率で効く（損益グラフの横軸の各点・テール表の各行）。Δσ とは別に足し算される。',
      '株価指数は急落のときに IV が上がりやすい。β はその傾向をシナリオに入れるためのもので、株式の β（市場との連動の係数）とは別の意味。',
    ],
    formula: 'Δσ_β = −β × ΔX%（pt）',
    example:
      '例（架空の値）: β = 1.0 で原資産 −10% なら IV +10pt。プリセット「急落」の Δσ +20pt を足すと ATM の IV は +30pt',
    where: [
      'シナリオの「モデルの前提」の行（β 1.0 · sticky strike …）',
      '損益グラフ・テール表の各点の IV',
      'IV 推移のシナリオの水準',
    ],
    guide: G_MODEL_PREMISE,
    related: ['iv-shift', 'dx', 'sticky'],
  },
  {
    id: 'greeks',
    title: 'グリーク',
    short: 'グリーク',
    reading: 'ぐりーく',
    aliases: ['greeks', '感応度'],
    summary: 'オプションの価格を原資産・時間・IV で微分した感応度の総称',
    body: [
      'グリークは、オプションの評価額を原資産・時間・IV で微分した値（感応度）。Δ（デルタ）・Γ（ガンマ）・Θ（シータ）・ベガ（V）がある。ベガはギリシャ文字ではないが、慣用でグリークに含める。',
      'どれも「いまの点で少しだけ動いたときの変化」の近似。大きく動いたときの損益は損益グラフ・シナリオで見る。',
      'σ（IV）はグリークではない。σ は価格を決める入力で、σ に対する感応度がベガ。',
      'simulator の合計グリークは、シナリオ点（d・ΔX・Δσ・Δs を当てた点）の値を全部の足で合計したもの（乗数込み）。',
    ],
    formula: 'Δ = ∂V/∂F、Γ = ∂²V/∂F²、Θ = −∂V/∂T（T = 残存期間）、ベガ = ∂V/∂σ（V = 評価額）',
    where: [
      '指標のタイル「合計グリーク」',
      '内訳「合計グリーク（シナリオ点）」',
      'ポジションの行の詳細「シナリオ点（足別）」',
    ],
    guide: G_BREAKDOWN,
    related: ['delta', 'gamma', 'theta', 'vega', 'iv'],
  },
  {
    id: 'delta',
    title: 'デルタ Δ',
    short: 'Δ',
    reading: 'でるた',
    aliases: ['Δ', 'delta'],
    summary: '原資産が動いたときの評価額の変化。ラージ先物換算の枚数で出す',
    body: [
      'Δ は評価額を原資産で微分した値。simulator はラージ換算（ラージ先物の枚数。Σ 枚数 × δ × 乗数 / 1,000）で出し、括弧にミニ換算（× 10）を添える。',
      'Δ が +1 枚なら、原資産が 100 円上がると約 +100,000 円（ラージ先物 1 枚分）動く。put の買い・call の売りは負。先物は 1 枚で ラージ 1 / ミニ 0.1 / マイクロ 0.01。',
      'ポジションのデルタヘッジは、この Δ を 0 に近づける先物の枚数を出す。',
    ],
    formula: 'Δ（ラージ換算）= Σ 売買の符号 × 枚数 × δ × 乗数 / 1,000、ミニ換算 = ラージ換算 × 10',
    example: '例（架空の値）: δ −0.20 の put を 5 枚売ると Δ = +1.000 枚（ミニ +10.00）',
    where: ['指標のタイル「合計グリーク」', '内訳の Δ', 'ポジションの行の詳細', 'デルタヘッジ'],
    guide: G_UNITS,
    related: ['gamma', 'greeks', 'forward'],
  },
  {
    id: 'gamma',
    title: 'ガンマ Γ',
    short: 'Γ',
    reading: 'がんま',
    aliases: ['Γ', 'gamma'],
    summary: '原資産が 100 円動いたときの Δ（ラージ換算）の変化',
    body: [
      'Γ は Δ を原資産で微分した値（評価額の 2 階微分）。simulator は原資産が 100 円動いたときの Δ（ラージ換算の枚数）の変化で出す（単位は / 100 円）。',
      'オプションの買いは正、売りは負。売りで Γ が負に大きいと、原資産が動くほど Δ が不利な向きに増え、損失が加速する。',
      '満期が近く ATM に近い足ほど大きい。',
    ],
    formula: 'Γ（/ 100 円）= Σ 売買の符号 × 枚数 × γ × 乗数 / 1,000 × 100（γ は 1 円あたり）',
    example: '例（架空の値）: Γ −0.0500 / 100 円なら、原資産が 100 円上がると Δ が約 0.05 枚減る',
    where: ['内訳の Γ', '指標のタイル「合計グリーク」の全文'],
    guide: G_UNITS,
    related: ['delta', 'theta', 'greeks'],
  },
  {
    id: 'vega',
    title: 'ベガ V',
    short: 'V',
    reading: 'べが',
    aliases: ['V', 'vega', 'ν'],
    summary: 'IV が 1pt 動いたときの評価額の変化（円 / IV 1pt）',
    body: [
      'ベガは評価額を IV（σ）で微分した値。simulator は IV が 1pt（% ポイント）上がったときの円の変化（乗数込み）で出す（円 / IV 1pt）。',
      'オプションの買いは正（IV が上がると得）、売りは負。残存が長いほど大きい。',
      'ベガは σ に対する感応度で、σ（IV）そのものはグリークではない。Δσ を 1pt 動かしたときの損益の変化の目安がベガ。',
    ],
    formula: 'V = Σ 売買の符号 × 枚数 × 乗数 × ∂価格/∂σ ÷ 100（円 / IV 1pt）',
    example: '例（架空の値）: V −12,000 円 / pt で Δσ +5 なら、ほかが同じとき損益は約 −60,000 円',
    where: ['内訳の V（/ pt）', '指標のタイル「合計グリーク」の副題'],
    guide: G_UNITS,
    related: ['iv', 'iv-shift', 'theta', 'greeks'],
  },
  {
    id: 'theta',
    title: 'シータ Θ',
    short: 'Θ',
    reading: 'しーた',
    aliases: ['Θ', 'theta'],
    summary: '1 暦日たったときの評価額の変化（円 / 暦日）',
    body: [
      'Θ は時間の経過による評価額の変化。simulator は 1 暦日（土日・休日も 1 日）たったときの円の変化（乗数込み）で出す（円 / 暦日。画面の表示は「/ 日」）。',
      'オプションの買いは負（時間がたつと価値が減る）、売りは正。満期が近く ATM に近い足ほど大きい。',
      '時間は暦日 / 365 で数える（営業日ではない）。',
    ],
    formula: 'Θ = Σ 売買の符号 × 枚数 × 乗数 × θ（θ は 1 暦日あたりの価格の変化）',
    example: '例（架空の値）: Θ +8,000 円 / 日なら、ほかが同じとき 3 暦日で約 +24,000 円',
    where: ['内訳の Θ（/ 日）', '指標のタイル「合計グリーク」の副題'],
    guide: G_UNITS,
    related: ['vega', 'gamma', 'greeks'],
  },
  {
    id: 'forward',
    title: 'F（合成先物・フォワード価格）',
    short: 'F',
    reading: 'えふ ごうせいさきもの ふぉわーど',
    aliases: ['F', 'フォワード', 'forward', '合成先物', 'プット・コール・パリティ', 'PCP'],
    summary: '限月ごとに、板の put・call の気配から逆算したフォワード価格',
    body: [
      'F は Forward（フォワード価格）の F。simulator は限月ごとに、板の put と call の気配からプット・コール・パリティで逆算した合成先物を F にする（ATM ±4% の行の無裁定の幅を重ねた中点）。',
      'オプションの価格は Black-76（F を原資産にした Black-Scholes の仲間。Fischer Black 1976）で計算する。日経 225 OP は SQ で決済されるヨーロピアン型なので、配当・金利を織り込んだ F を使えば現物と配当の推定が要らない。',
      '取引所の先物の値とは別。市場ピルの「先物」は直近四半期限月のラージ先物の値で、限月が違うと F とずれる。気配のペアが足りない限月は先物で代用し、印が付く。',
    ],
    formula: 'C − P = e^(−rT) × (F − K) から F = K + (C − P) × e^(rT)',
    example: '例（架空の値）: K 40,000 で C 600・P 500（金利の影響を無視）なら F ≒ 40,100',
    where: [
      '市場ピルの「F · ATM」',
      '損益グラフの横軸の基準 X₀（既定は 1 限月の F）',
      'スマイルの moneyness ln(K / F)',
    ],
    guide: G_PRICE_MODEL,
    related: ['basis', 'dx', 'iv'],
  },
  {
    id: 'basis',
    title: 'basis（限月の差）',
    short: 'basis',
    reading: 'べーしす',
    aliases: ['basis', 'ベーシス', '限月差'],
    summary: '足の原資産（各限月の F・先物）と基準原資産 X の差',
    body: [
      'basis_i = F_i − X₀。他の限月・先物の足は、X が動いてもこの差を一定に保って動かす（円モード）。',
      'そのため満期の線の折れ点は「行使価格 − その限月の basis」の位置に出る。',
      'モデルの前提の「先物の basis: 固定 / 減衰」は、先物の足の basis を一定にするか、先物の SQ に向けて 0 へ線形に減らすかの選択。',
    ],
    formula: 'F_i′ = X′ + basis_i（basis_i = F_i − X₀）',
    example:
      '例（架空の値）: 2 限月の F が X₀ より 75 円高ければ、X が動いても 2 限月の F は常に X + 75',
    where: ['シナリオの「モデルの前提」の先物の basis', '⋯ > 設定…', '満期の線の折れ点'],
    guide: G_AXIS,
    related: ['forward', 'dx', 'sticky'],
  },
  {
    id: 'sticky',
    title: 'sticky strike / sticky moneyness',
    short: 'sticky',
    reading: 'すてぃっきー すとらいく まねねす',
    aliases: ['sticky', 'スティッキーストライク', 'スティッキーマネネス', 'IV の動き方'],
    summary: '原資産が動いたときに IV（スマイル）をどう動かすかの選択',
    body: [
      'sticky strike（既定）: 原資産が動いても、行使価格ごとの IV は変えない。',
      'sticky moneyness: スマイルが原資産と一緒に動く（同じ moneyness = ln(K / F) の IV を保つ）。put スキューの上では、原資産が下がると同じ行使価格の IV は下がる向きに動く。',
      'どちらでも、急落時の IV の上昇は β と Δσ で表す。',
    ],
    formula:
      'sticky strike: x = ln(K / F)、sticky moneyness: x = ln(K / F′)（F′ はシナリオ後の F）',
    where: ['シナリオの「モデルの前提」の IV の動き方', '損益グラフの前提（ⓘ）'],
    guide: G_MODEL_PREMISE,
    related: ['beta', 'skew', 'basis'],
  },
  {
    id: 'nov',
    title: 'NOV（OP の評価額）',
    short: 'NOV',
    reading: 'えぬおーぶい ねっとおぷしょんばりゅー',
    aliases: ['NOV', 'Net Option Value', 'ネットオプションバリュー', 'OP の評価額'],
    summary: '証拠金に入れるオプションの足の評価額の合計。買いは +、売りは −',
    body: [
      'NOV（Net Option Value）は、証拠金の計算に入れるオプションの足の評価額の合計（売買の符号 × 枚数 × 乗数 × 評価価格）。買いは正、売りは負。',
      '証拠金所要額 = 必要証拠金 − NOV。売りでは NOV が負なので、受け取ったプレミアムの分だけ所要額が大きくなる。',
      '必要証拠金（k × PFE）には NOV を含めない（証券会社の建てる前の必要委託証拠金と同じ物差し）。',
    ],
    formula: 'NOV = Σ 売買の符号 × 枚数 × 乗数 × 評価価格',
    example: '例（架空の値）: 評価価格 100 円の put を 2 枚売ると NOV = −200,000 円',
    where: ['内訳の NOV（シナリオ点）・NOV（今）', '必要証拠金のタイルの全文'],
    guide: G_MARGIN,
    related: ['requirement', 'margin', 'pfe'],
  },
  {
    id: 'pfe',
    title: 'PFE（格子の最悪の損失）',
    short: 'PFE',
    reading: 'ぴーえふいー',
    aliases: ['PFE', '最悪の損失', '最悪の点'],
    summary: '原資産・IV・経過を動かした格子の中での評価額の最悪の損失',
    body: [
      '必要証拠金の概算の元になる値。原資産を ±R・±R/2・0、IV を足ごとの状態の IV（シナリオの β・Δσ などを入れた値）の ×(1 + 上げ) / ×1 / ×(1 − 下げ)、経過を 0 / 2 営業日にした 30 点の格子で評価額を計算し、今の評価額からの最悪の損失を PFE とする（0 未満にしない）。',
      '既定は R 5%・IV ×1.5 / ×0.75。⋯ > 設定… で変えられる。',
      '決めた幅で動かした場面の最悪値を取る作りは SPAN 型に近い。JSCC の実際の証拠金（VaR 方式）の再現ではない。',
    ],
    formula: 'PFE = max(0, max_格子 (V(今) − V(格子の点)))',
    example:
      '例（架空の値）: 30 点のうち原資産 −5%・IV ×1.5・経過 0 日の点で評価額が 480,000 円下がるのが最悪なら PFE = 480,000 円',
    where: ['内訳の「最悪の点」', '必要証拠金（= 掛け目 × PFE）'],
    guide: G_MARGIN,
    related: ['margin', 'var-span', 'nov'],
  },
  {
    id: 'margin',
    title: '必要証拠金（概算）',
    short: '必要証拠金',
    reading: 'ひつようしょうこきん がいさん',
    aliases: ['必要証拠金', '証拠金', 'margin', '必要委託証拠金'],
    summary: '格子の最悪の損失 × 掛け目。受け取るプレミアムを含まない概算',
    body: [
      '必要証拠金（概算）= 掛け目 k × PFE。受け取るプレミアム（NOV）を含まない、証券会社の建てる前の画面の必要委託証拠金と同じ物差し。',
      '既定（買いの OP で減らさない）では、売りの OP と先物だけで計算する。設定で「相殺する」にすると、買いの OP も含めて相殺する。',
      '概算で、JSCC の証拠金（VaR 方式）の再現ではない。ストレス日・先物との組み合わせ・レシオなどでは実際の額と違いうる。建てる前に証券会社の画面の額で確かめる。',
    ],
    formula: '必要証拠金 = k × PFE（k = 掛け目。既定 100%）',
    example: '例（架空の値）: PFE 480,000 円・掛け目 100% なら必要証拠金 480,000 円',
    where: [
      '指標のタイル「必要証拠金（概算）」',
      '内訳の必要証拠金（シナリオ点）・（今）',
      'テールの証拠金の表',
    ],
    guide: G_MARGIN,
    related: ['pfe', 'requirement', 'nov', 'room', 'var-span'],
  },
  {
    id: 'requirement',
    title: '証拠金所要額',
    short: '所要額',
    reading: 'しょうこきんしょようがく',
    aliases: ['所要額', 'requirement'],
    summary: '必要証拠金 − NOV（0 未満にしない）。余力の計算に使う額',
    body: [
      '証拠金所要額 = max(0, 必要証拠金 − NOV)。売りでは NOV が負なので、受け取ったプレミアムの分だけ必要証拠金より大きい。掛け目は NOV には掛けない。',
      '余力・建てられる倍数・追証の線はこの額で計算する。',
    ],
    formula: '証拠金所要額 = max(0, k × PFE − NOV)',
    example: '例（架空の値）: 必要証拠金 480,000 円・NOV −200,000 円なら所要額 680,000 円',
    where: ['内訳の証拠金所要額（シナリオ点）・（今）', '必要証拠金・余力のタイルの全文'],
    guide: G_MARGIN,
    related: ['margin', 'nov', 'room'],
  },
  {
    id: 'room',
    title: '余力（概算）',
    short: '余力',
    reading: 'よりょく',
    aliases: ['余力', '建てられる倍数'],
    summary: '資金から支払・手数料・所要額を引いた残り。負なら追証の目安',
    body: [
      '余力 = 資金 − 支払 + 受取 − 手数料 + 先物の評価損益 + 決済済みの足の清算額 − 証拠金所要額。資金は ⋯ > 設定… で入れる（未設定なら「—」）。',
      '余力が負なら追証の目安（警告の色）。建てられる倍数は、今のポジションの何倍まで余力が 0 以上かを表す。',
      'タイルの値はシナリオ点（d・ΔX・Δσ・Δs を当てた点）のもの。副題は今の余力。',
    ],
    formula:
      '余力 = 資金 − 支払 + 受取 − 手数料 + 先物の評価損益 + 決済済みの足の清算額 − 証拠金所要額',
    example:
      '例（架空の値）: 資金 3,000,000 円・受取 200,000 円・手数料 0・所要額 680,000 円なら余力 2,520,000 円',
    where: [
      '指標のタイル「余力（概算）」',
      '内訳の余力（シナリオ点）・（今）',
      'テールの証拠金の表',
    ],
    guide: G_MARGIN,
    related: ['requirement', 'margin-line', 'hold-map'],
  },
  {
    id: 'margin-line',
    title: '追証の線',
    short: '追証の線',
    reading: 'おいしょうのせん',
    aliases: ['追証', '追加証拠金', 'margin call', 'マージンコール'],
    summary: '余力が 0 になる原資産の水準（損益グラフの赤の破線）',
    body: [
      '損益グラフの赤の破線と札「追証」。指定日 + シナリオで原資産だけを動かしたとき、余力（概算）が 0 になる原資産の水準。',
      '資金を設定したときだけ出る。余力がどこでも正なら出ない。ΔX・パン・拡大では動かず、d・Δσ・Δs・β などを動かしている間は消え、止まると出る。',
      '原資産だけを動かす線なので、急落と IV の急騰が同時に来る場面は追証マップで見る。',
    ],
    formula: '余力(X) = 0 となる X',
    example:
      '例（架空の値）: X₀ 40,000 円で追証の線が 36,400 円なら、ほかが同じまま原資産が約 −9% 動くと余力が 0',
    where: ['損益グラフ（赤の破線と札「追証」）', 'テールの証拠金の表の「追証」の印'],
    guide: G_LINES,
    related: ['room', 'hold-map', 'margin'],
  },
  {
    id: 'hold-map',
    title: '追証マップ',
    short: '追証マップ',
    reading: 'おいしょうまっぷ',
    // 旧名（#179 で改名）も検索で引けるよう別名に残す
    aliases: ['持ちこたえマップ', 'ホールドマップ', 'hold map'],
    summary: '原資産と IV が同時に動いたときの余力を、余力あり / 追証の 2 色で塗り分けた図',
    body: [
      '指標 · テールの末尾の折りたたみ。横 = 原資産の変化（−30%〜+20%）、縦 = IV の倍率（×0.5〜×2.5）で、各マスの余力が正か負（追証）かを 2 色で塗る。',
      '過去の点は、取り込まれた全期間の 2 営業日の動き（原資産の変化と iv30 の倍率）。追証の側に入った回数が上に出る。',
      '日数・スキュー・IV の動き方はシナリオのまま。ΔX・Δσ・β は効かない（縦軸が IV の変化そのもの）。',
      '追証の側（赤）は simulator の証拠金の概算で余力が負になるところ。実際の追証の判定は引けの清算値で行われるので、日中に追証の側へ入っても引けで戻れば追証にならない。',
    ],
    example:
      '例（架空の値）: 原資産 −6%・IV ×1.6 のマスが追証の色なら、2 日でそれだけ動くと余力が負になる',
    where: ['指標 · テールの「追証マップ」'],
    guide: G_HOLD,
    related: ['margin-line', 'room', 'iv30'],
  },
  {
    id: 'var-span',
    title: 'VaR / SPAN（証拠金の計算方式）',
    short: 'VaR / SPAN',
    reading: 'ばりゅーあっとりすく すぱん',
    aliases: ['VaR', 'SPAN', 'HS-VaR', 'value at risk', 'バリューアットリスク', 'スパン'],
    summary: 'JSCC の証拠金の計算方式。2023-11 に SPAN から VaR 方式へ変わった',
    body: [
      'SPAN（米国の CME が作った方式）は、決めた幅で原資産と IV を動かした十数通りの場面の最大の損失をもとに証拠金を決め、深い OTM の売りには売りオプションの最低証拠金（下限。リスク量と比べて大きい方を取る）を設けていた。JSCC は 2023-11-06 に SPAN から VaR 方式へ変えた。',
      'VaR 方式（指数先物・OP はヒストリカル・シミュレーションの HS-VaR）は、過去の値動き（1,250 日分）とストレスシナリオでポートフォリオの損益を計算し、大きな損失をカバーする額を証拠金にする。',
      'simulator の必要証拠金は、決めた幅の格子の最悪の損失（SPAN 型）× 掛け目の概算で、VaR 方式の再現ではない。',
    ],
    where: ['指標の ⓘ・設定の証拠金の注記（JSCC の VaR 証拠金の再現ではない）'],
    guide: G_MARGIN,
    related: ['jscc', 'margin', 'pfe'],
  },
  {
    id: 'jscc',
    title: 'JSCC（日本証券クリアリング機構）',
    short: 'JSCC',
    reading: 'じぇいえすしーしー にほんしょうけんくりありんぐきこう',
    aliases: ['JSCC', '日本証券クリアリング機構', '清算機関'],
    summary: '日経 225 先物・OP の清算機関。証拠金の計算方式を決める',
    body: [
      'JSCC は JPX グループの清算機関で、日経 225 先物・OP の取引の清算（決済の保証）をし、証拠金の計算方式を決める。',
      '今の方式は VaR 方式（2023-11 から。以前は SPAN）。証券会社が投資家に求める証拠金は、JSCC の額をもとに各社が決める。',
      'simulator の必要証拠金は JSCC の額の再現ではない概算。建てる前に JSCC の Web 試算か証券会社の画面の額で確かめる。',
    ],
    where: ['指標の ⓘ', '設定の証拠金の注記'],
    guide: G_MARGIN,
    related: ['var-span', 'margin'],
  },
];

const BY_ID: ReadonlyMap<TermId, GlossaryTerm> = new Map(GLOSSARY.map((t) => [t.id, t]));

/** id の用語（無ければ null） */
export function termById(id: string): GlossaryTerm | null {
  return BY_ID.get(id as TermId) ?? null;
}

/**
 * 用語の検索語（見出し・読み・別名を改行で区切る）。パレットの行の keywords。正規化（かな・NFKC・ギリシャ文字の読み）は
 * パレットの paletteFilter が問い合わせと行の両方にかける
 */
export function termSearchText(t: GlossaryTerm): string {
  return [t.title, t.reading, ...t.aliases].join('\n');
}

/** ⓘ の吹き出しの末尾の「用語:」に並べる用語（6 か所。#190 で先物推移） */
export const HINT_TERMS: Readonly<
  Record<
    'scenario' | 'positions' | 'metrics' | 'stage' | 'ivHistory' | 'futHistory',
    readonly TermId[]
  >
> = {
  scenario: ['dx', 'iv-shift', 'skew', 'beta', 'sticky', 'basis'],
  positions: ['greeks', 'delta', 'theta', 'vega', 'iv'],
  metrics: [
    'greeks',
    'margin',
    'nov',
    'requirement',
    'room',
    'pfe',
    'hold-map',
    'var-span',
    'jscc',
  ],
  stage: ['iv-shift', 'skew', 'beta', 'sticky', 'margin-line'],
  ivHistory: ['iv30', 'iv', 'hv', 'beta'],
  futHistory: ['forward', 'basis', 'hv'],
};

// ---------------------------------------------------------------- 説明カードの表示モデル

export interface TermCardView {
  id: TermId;
  title: string;
  reading: string;
  /** 別名を「 · 」で連ねた文（無ければ空） */
  aliases: string;
  summary: string;
  body: readonly string[];
  formula: string | null;
  example: string | null;
  where: readonly string[];
  /** マニュアルの節の名前（画面に文字で出す。リンクにしない） */
  guide: string;
  related: readonly { id: TermId; title: string; short: string }[];
}

/** 説明カードの中身（無い id は null） */
export function termCardView(id: string): TermCardView | null {
  const t = termById(id);
  if (!t) return null;
  const related: { id: TermId; title: string; short: string }[] = [];
  for (const r of t.related) {
    const u = BY_ID.get(r);
    if (u) related.push({ id: u.id, title: u.title, short: u.short });
  }
  return {
    id: t.id,
    title: t.title,
    reading: t.reading,
    aliases: t.aliases.join(' · '),
    summary: t.summary,
    body: t.body,
    formula: t.formula ?? null,
    example: t.example ?? null,
    where: t.where,
    guide: t.guide.title,
    related,
  };
}
