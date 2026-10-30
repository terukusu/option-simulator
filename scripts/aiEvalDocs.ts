/**
 * AI の評価（scripts/aiEval.mjs）の文書の質問（#137・#240・#308）。中継の read_doc でマニュアル・設計書の節を読み、節を示して
 * 答えるか（計算の前提 11・操作の案内 3）、文書に無いことを無いと言うか（1）。
 *
 * - expect は読んでほしい節（read_doc の `<file>:<節の番号>`。どれか 1 つ。中継のログがあるときだけ判定）。番号が
 *   索引にあることは api の pytest（test_ai_docs.py）が確かめる
 * - points は答えの要点（その節に書いてあること）。自動では判定しない（文書の値は照合できない）。返答の全文ファイルに
 *   想定の節と並べて書き、人が「節と矛盾しないか」を見比べる（EPIC #141 の終了条件 7 の照合表）
 */

export type DocQuestionKind = 'premise' | 'howto' | 'absent';

export interface DocQuestion {
  /** 問の名前（前回の実行との比較の鍵。変えない） */
  id: string;
  kind: DocQuestionKind;
  text: string;
  /** 想定の節（どれか 1 つを読めばよい）。absent は null */
  expect: string[] | null;
  /** 答えの要点（人の照合用） */
  points: string;
}

export const DOC_QUESTIONS: DocQuestion[] = [
  {
    id: 'beta-preset',
    kind: 'premise',
    text: 'β と IV の平行移動 Δσ はどう組み合わさって効くの？急落のプリセットで ATM の IV はどうなる？',
    expect: ['design:5.4', 'user-guide:6', 'user-guide:6.2', 'user-guide:6.4', 'user-guide:16.1'],
    points:
      'Δσ_total = Δσ + Δσ_β − Δs × x_eff / 0.1、Δσ_β = −β × ΔX%（評価点ごとの下落率）。プリセットの Δσ は β と独立に足される（β 1.0 で −10% のプリセットなら ATM は +20pt + 10pt = +30pt）',
  },
  {
    id: 'iv30',
    kind: 'premise',
    text: 'IV 推移の「30 日固定」の ATM IV って何？どうやって求めているの？',
    expect: ['user-guide:10', 'user-guide:10.4', 'user-guide:10.5', 'design:5.9'],
    points:
      '残存 30 日に揃えた ATM の IV（期近・次限月の ATM の IV を総分散で 30 日に補間。SQ の前 3 日は次限月）。スマイルの ATM IV・足のアンカー IV とは計算の仕方が別で一致はしない',
  },
  {
    id: 'margin',
    kind: 'premise',
    text: '必要証拠金（概算）はどうやって計算しているの？実際の証拠金と違うことはある？',
    expect: ['user-guide:8', 'user-guide:8.4', 'user-guide:13.2.1', 'design:5.10'],
    points:
      '原資産 ±R・IV の上げ下げ・経過の格子の最悪の損失（PFE）× 掛け目。JSCC の VaR 方式の再現ではない概算で、答え合わせをしていない形（急落の日・先物との組み合わせ・レシオなど）では実際の額と違うことがある',
  },
  {
    id: 'sticky',
    kind: 'premise',
    text: 'IV の動き方の sticky strike と sticky moneyness は何が違う？原資産が下がると同じ行使価格の IV はどうなる？',
    expect: ['design:5.4', 'user-guide:6', 'user-guide:6.4'],
    points:
      'sticky strike（既定）は原資産が動いても行使価格ごとの IV を変えない。sticky moneyness はスマイルが原資産と一緒に動き、put スキューの上では原資産が下がると同じ行使価格の IV は下がる。急落時の IV の上昇は β と Δσ で表す',
  },
  {
    id: 'tail-multiple',
    kind: 'premise',
    text: 'テール表の ×N の倍率は何に対する倍率？「指定日 + シナリオ」の列はどう計算している？',
    expect: ['design:5.6', 'user-guide:8', 'user-guide:8.3'],
    points:
      '基準は受取超なら受取 − 支払（手数料抜き）、支払超なら掛け金（支払 − 受取 + 手数料）。倍率は |損益 / 基準|。指定日 + シナリオの列は d・Δσ・Δs・β・動き方をシナリオのまま、原資産だけを各行の値にする（β は行ごとの下落率で効く）',
  },
  {
    id: 'anchor-iv',
    kind: 'premise',
    text: '足の IV（アンカー IV）はどう決まる？シナリオを全部 0 にすると足の理論価格はどうなる？',
    expect: ['design:5.3', 'design:5.4', 'user-guide:7', 'user-guide:7.4'],
    points:
      '今の板で入れた足は建値から逆算した IV。原資産が動くとスマイルに沿って相対的に動かす（σ_base = σ_anchor + σ_smile(x) − σ_smile(x₀)）。シナリオ 0（sticky strike）では理論価格は建値に戻る。逆算できない建値はスマイルの IV と建値ずれ。前の板で建てた足は今の値段（mid）から逆算し、シナリオ 0 の損益は含み損益から始まる',
  },
  {
    id: 'time',
    kind: 'premise',
    text: '残存期間はどう数えている？営業日？満期の直前はどう評価するの？',
    expect: ['design:5.2', 'user-guide:16', 'user-guide:16.1'],
    points:
      'T = (SQ 日 9:00 − 評価時刻) / 365 の暦日（営業日ではない）。評価時刻の既定は板の時刻。残り 1 分以下は本源的価値で評価する',
  },
  {
    id: 'basis',
    kind: 'premise',
    text: '2 限月の足を入れると、満期の線の折れ点が行使価格からずれるのはなぜ？',
    expect: ['design:5.5', 'user-guide:16', 'user-guide:16.2'],
    points:
      '横軸は 1 限月の基準価格 X。他の限月の原資産は X との差 basis を一定に保つ（円モード F_i′ = X′ + basis_i）ので、折れ点は K − basis_i に出る',
  },
  {
    id: 'greek-units',
    kind: 'premise',
    text: '指標の Δ・Γ・Θ・V はそれぞれどんな単位？',
    expect: ['design:5.6', 'user-guide:16', 'user-guide:16.3'],
    points:
      'Δ はラージ先物換算の枚数（ミニ換算は × 10）、Γ は原資産が 100 円動いたときの Δ（ラージ換算）の変化、Θ は円 / 暦日（乗数込み・買いが負）、V は円 / IV 1pt（乗数込み）',
  },
  {
    id: 'synthetic-f',
    kind: 'premise',
    text: 'オプションの原資産 F には何を使っている？先物の価格そのまま？',
    expect: ['design:5.1', 'user-guide:16', 'user-guide:16.1'],
    points:
      '限月ごとの合成先物（プット・コール・パリティ。ATM 付近の両側気配の行使価格ごとの無裁定の箱の交差区間の中点）を Black-76 の F に使う。ペアが 5 組未満なら先物の価格にフォールバック',
  },
  {
    id: 'beta-measured',
    kind: 'premise',
    text: 'IV の統計で β の実測が 1.1 くらいと出た。既定の β 1.0 は実態に合っている？',
    expect: ['design:5.12'],
    points:
      'β の実測は 30 日固定の ATM の IV の反応で、シナリオの β は sticky strike の上に足す量なので直接比べない（そのまま入れると二重に数える）。同じ行使価格の上乗せはふつうの下げで 1.0 より小さく、深い急落で大きい。期間で変わり、深い急落は件数が少ない',
  },
  {
    id: 'margin-map',
    kind: 'howto',
    text: '追証マップの点は何を表している？',
    expect: ['user-guide:8', 'user-guide:8.5', 'design:5.11'],
    points: '追証マップの節の説明',
  },
  {
    id: 'pane-reset',
    kind: 'howto',
    text: '先物推移の指標の段の高さを元に戻すには？',
    expect: ['user-guide:10', 'user-guide:10.9', 'user-guide:14.4'],
    points: '先物推移・グラフの操作の節の説明',
  },
  {
    id: 'other-device',
    kind: 'howto',
    text: '今のポジションを別の端末で開くにはどうすればいい？',
    expect: ['user-guide:11', 'user-guide:11.2', 'user-guide:11.3'],
    points: 'URL で渡す・保存一覧の節の説明',
  },
  {
    id: 'png-export',
    kind: 'absent',
    text: '損益グラフを PNG 画像で保存するボタンはどこ？',
    expect: null,
    points: '文書に書かれていないと言う',
  },
];
