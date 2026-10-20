"""道具の登録（docs/ai-advisor.md 論点 5・6、docs/design.md 14 章）。名前 → 入力の形・結果の形・説明・Anthropic に渡す
input_schema。

道具はブラウザの決定論的な計算（K15。ui/view/aiTools.ts）。中継は道具を実行しない。AI の tool_use の入力と、ブラウザが
返す tool_result の結果・事前計算（context.precomputed）を、ここの形で検査する。

結果の値の単位はキーの名前で決める（ui/view/aiNumbers.ts の照合も同じ規則）: `*_yen` は円（整数）、`x`・`k`・`forward`・
`atm_k`・`*_x` は原資産・行使価格の水準（円）、`*_pct` は %（小数 1 桁）、`*_pt` は pt（小数 1 桁）、
`delta_*`・`gamma_*` は枚（ラージ / ミニ換算。Δ は小数 2 桁、Γ は 3 桁）、`*days*` は暦日、
`*ratio*`・`multiple` は倍。値はブラウザが丸めて入れる（AI が書き写す値 = 照合の値）。評価できない値は null。

ブラウザ側の実装と名前の集合・結果の形の一致は、生成した見本 fixtures/synthetic/ai_tools.json（scripts/synthBoard.ts）を
api/tests/test_ai_tools.py がここの result_shape に通して確かめる（言語をまたぐ契約）。
"""

from dataclasses import dataclass

from .shape import DATE, MONTH, Arr, Bool, Enum, Nullable, Num, Obj, Spec, Str


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_shape: Obj
    result_shape: Spec
    input_schema: dict  # Anthropic の tools[].input_schema（JSON Schema。サーバーの定数）

    def definition(self) -> dict:
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}


Registry = dict[str, ToolSpec]

MAX_LEGS = 20
QTY_MAX = 100_000

YEN = Num(-1e13, 1e13, nullable=True)
LEVEL = Num(0, 1e8, nullable=True)  # 原資産・行使価格（円）
PCT = Num(-1e4, 1e4, nullable=True)
PT = Num(-1e4, 1e4, nullable=True)
LOTS = Num(-1e8, 1e8, nullable=True)
DAYS = Num(0, 1000, nullable=True)
RATIO = Num(-1e9, 1e9, nullable=True)
PRODUCT = Enum(("op", "fut_large", "fut_mini", "fut_micro"))
OPT_TYPE = Enum(("C", "P"))
SIDE = Enum(("buy", "sell"))
QTY = Num(1, QTY_MAX, integer=True)

GREEKS = Obj({"delta_large": LOTS, "delta_mini": LOTS, "gamma_per100": LOTS, "theta_yen_per_day": YEN,
              "vega_yen_per_pt": YEN})
LEG_ID = {"product": PRODUCT, "type": OPT_TYPE, "expiry": MONTH, "k": LEVEL, "side": SIDE, "qty": QTY}
LEG_OPTIONAL = frozenset({"type", "k"})  # 先物の足には無い

NO_INPUT = Obj({})
NO_INPUT_SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}

POSITION_SUMMARY = Obj({
    "x0": LEVEL,
    "max_days": DAYS,
    "n_legs": Num(0, MAX_LEGS, integer=True),
    "legs": Arr(Obj({**LEG_ID, "entry_yen": Num(0, 1e9), "iv_pct": PCT, "days_to_sq": DAYS, "delta_large": LOTS,
                     "delta_mini": LOTS}, LEG_OPTIONAL), MAX_LEGS),
    "premium": Obj({"received_yen": YEN, "paid_yen": YEN, "net_yen": YEN, "fees_yen": YEN,
                    "net_after_fees_yen": YEN}),
    "expiry": Obj({"max_profit_yen": YEN, "max_profit_x": LEVEL, "max_profit_unbounded": Bool(),
                   "max_loss_yen": YEN, "max_loss_x": LEVEL, "max_loss_unbounded": Bool(),
                   "breakevens_x": Arr(LEVEL, 20)}),
    "greeks_now": GREEKS,
    "scenario_point": Obj({"days": DAYS, "dx_pct": PCT, "x": LEVEL, "pnl_yen": YEN, "greeks": GREEKS}),
})

TAIL_TABLE = Obj({
    "days": DAYS,
    "base": Obj({"kind": Enum(("received", "paid")), "amount_yen": YEN}),
    "rows": Arr(Obj({"shock_pct": PCT, "x": LEVEL, "sq_pnl_yen": YEN, "sq_ratio": RATIO, "scenario_pnl_yen": YEN,
                     "scenario_ratio": RATIO, "margin_yen": YEN, "room_yen": YEN}), 10),
})

MARGIN_STATE = Obj({"x": LEVEL, "margin_yen": YEN, "requirement_yen": YEN, "nov_yen": YEN, "room_yen": YEN,
                    "multiple": RATIO, "multiple_unbounded": Bool()})
MARGIN_SUMMARY = Obj({
    "capital_yen": YEN,
    "params": Obj({"range_pct": PCT, "iv_up_pct": PCT, "iv_down_pct": PCT, "factor_pct": PCT,
                   "ignore_long_options": Bool()}),
    "now": MARGIN_STATE,
    "point": MARGIN_STATE,
    "call_levels_x": Arr(LEVEL, 40),
})

GRID_DX = 7
GRID_IV = 4
GRID_DAYS = 3
SCENARIO_GRID = Obj({
    "beta": Num(0, 100, nullable=True),
    "skew_pt": PT,
    "days": Arr(DAYS, GRID_DAYS, min_len=1),
    "dx_pct": Arr(PCT, GRID_DX, fixed=True),
    "x": Arr(LEVEL, GRID_DX, fixed=True),
    "iv_shift_pt": Arr(PT, GRID_IV, fixed=True),
    "pnl_yen": Arr(Arr(Arr(YEN, GRID_IV, fixed=True), GRID_DX, fixed=True), GRID_DAYS, min_len=1),
})

SMILE_POSITION = Obj({
    "expiries": Arr(Obj({"expiry": MONTH, "sq_date": DATE, "t_days": DAYS, "forward": LEVEL, "atm_k": LEVEL,
                         "atm_iv_pct": PCT, "put5_iv_pct": PCT, "call5_iv_pct": PCT, "put5_minus_atm_pt": PT,
                         "call5_minus_atm_pt": PT}), 6),
    "legs": Arr(Obj({"expiry": MONTH, "type": OPT_TYPE, "k": LEVEL, "side": SIDE, "qty": QTY, "moneyness_pct": PCT,
                     "iv_pct": PCT, "atm_iv_pct": PCT, "iv_minus_atm_pt": PT}), MAX_LEGS),
})

# evaluate_scenario の入力の範囲（画面のシナリオの欄で入れられる範囲。ui/state.ts の validScenarioPatch）
EVAL_INPUT = Obj({
    "dx_pct": Num(-60, 60),
    "x": Num(0, 1e8, lo_open=True),
    "days": Num(0, 400),
    "iv_shift_pt": Num(-10, 40),
    "skew_pt": Num(-5, 5),
}, frozenset({"dx_pct", "x", "skew_pt"}))
EVAL_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "dx_pct": {"type": "number", "minimum": -60, "maximum": 60,
                   "description": "原資産の変化（今の X₀ に対する %。例 -6 は 6% 安）。x と片方だけ"},
        "x": {"type": "number", "exclusiveMinimum": 0, "description": "原資産の水準（円）。dx_pct と片方だけ"},
        "days": {"type": "number", "minimum": 0, "maximum": 400,
                 "description": "今からの経過日数（暦日。最遠の足の SQ までに収める）"},
        "iv_shift_pt": {"type": "number", "minimum": -10, "maximum": 40,
                        "description": "IV の平行移動（pt。例 5 は全足の IV を 5pt 上げる）"},
        "skew_pt": {"type": "number", "minimum": -5, "maximum": 5,
                    "description": "スキューの変化（pt / moneyness 10%）。省略は今のシナリオの値"},
    },
    "required": ["days", "iv_shift_pt"],
    "additionalProperties": False,
}
EVALUATE_SCENARIO = Obj({
    "scenario": Obj({"days": DAYS, "dx_pct": PCT, "x": LEVEL, "iv_shift_pt": PT, "skew_pt": PT,
                     "days_clamped": Bool()}),
    "pnl_yen": YEN,
    "expiry_pnl_yen": YEN,
    "greeks": GREEKS,
    "legs": Arr(Obj({**LEG_ID, "pnl_yen": YEN, "iv_pct": PCT}, LEG_OPTIONAL), MAX_LEGS),
})


# technicals（#200）: 先物の週足・日足・4 時間足のテクニカル指標（ui/view/aiTechnicals.ts）。生の足の列は返さない
TECH_TFS = ("weekly", "daily", "4h")
TECH_INDICATORS = ("rsi", "macd", "stoch")
TECH_RECENT = 20
INDEX = Num(0, 100, nullable=True)  # RSI・%K・%D（0〜100）
COUNT = Num(0, 100_000, integer=True)
ZONE = Enum(("high", "low", "mid", None))
BARS_SINCE = Num(0, 100_000, integer=True, nullable=True)
BASE_RATE = Obj({"n": COUNT, "median_pct": PCT, "p10_pct": PCT, "p90_pct": PCT, "insufficient": Bool(),
                 "rolls_excluded": COUNT,
                 "condition": Enum(("rsi_high", "rsi_low", "rsi_mid", "stoch_high", "stoch_low", "stoch_mid",
                                    "macd_above_signal_above_zero", "macd_above_signal_below_zero",
                                    "macd_below_signal_above_zero", "macd_below_signal_below_zero"))},
                frozenset({"condition"}))
TECH_FRAME = Obj({
    "tf": Enum(TECH_TFS),
    "n_bars": COUNT,
    "last_t": Nullable(Str(r"\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?", 16)),
    "close_x": LEVEL,
    "horizon_bars": Num(1, 20, integer=True),
    "last_bar_may_be_partial": Bool(),
    "rsi": Obj({"rsi": INDEX, "recent": Arr(INDEX, TECH_RECENT), "zone": ZONE, "bars_in_zone": COUNT}),
    "macd": Obj({"macd_yen": YEN, "signal_yen": YEN, "hist_yen": YEN, "recent_hist_yen": Arr(YEN, TECH_RECENT),
                 "above_signal": Nullable(Bool()), "bars_since_cross": BARS_SINCE,
                 "above_zero": Nullable(Bool())}),
    "stoch": Obj({"stoch_k": INDEX, "stoch_d": INDEX, "recent_k": Arr(INDEX, TECH_RECENT), "zone": ZONE,
                  "bars_in_zone": COUNT, "k_above_d": Nullable(Bool()), "bars_since_cross": BARS_SINCE}),
    "base_rates": Obj({"all": BASE_RATE, "rsi": BASE_RATE, "macd": BASE_RATE, "stoch": BASE_RATE},
                      frozenset({"rsi", "macd", "stoch"})),
}, frozenset({"rsi", "macd", "stoch"}))
TECHNICALS = Obj({
    "params": Obj({"rsi": Num(1, 100, integer=True), "macd": Arr(Num(1, 100, integer=True), 3, fixed=True),
                   "stoch": Arr(Num(1, 100, integer=True), 3, fixed=True),
                   "rsi_zones": Arr(INDEX, 2, fixed=True), "stoch_zones": Arr(INDEX, 2, fixed=True)}),
    "frames": Arr(TECH_FRAME, len(TECH_TFS), min_len=1),
})
TECHNICALS_INPUT = Obj({
    "timeframes": Arr(Enum(TECH_TFS), len(TECH_TFS), min_len=1),
    "indicators": Arr(Enum(TECH_INDICATORS), len(TECH_INDICATORS), min_len=1),
    "horizon_bars": Num(1, 20, integer=True),
}, frozenset({"timeframes", "indicators", "horizon_bars"}))
TECHNICALS_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "timeframes": {"type": "array", "items": {"enum": list(TECH_TFS)}, "minItems": 1, "maxItems": 3,
                       "description": "足（省略 = 3 つ）"},
        "indicators": {"type": "array", "items": {"enum": list(TECH_INDICATORS)}, "minItems": 1, "maxItems": 3,
                       "description": "指標（stoch = スロー・ストキャスティクス。省略 = 3 つ）"},
        "horizon_bars": {"type": "integer", "minimum": 1, "maximum": 20,
                         "description": "基準率の何本先（省略 = 週足 4・日足 5・4 時間足 5）"},
    },
    "additionalProperties": False,
}


def _spec(name, description, result, input_shape=NO_INPUT, input_schema=None) -> ToolSpec:
    return ToolSpec(name=name, description=description, input_shape=input_shape, result_shape=result,
                    input_schema=NO_INPUT_SCHEMA if input_schema is None else input_schema)


REGISTRY: Registry = {t.name: t for t in (
    _spec("position_summary",
          "今のポジションの要約（画面の指標と同じ計算）。足ごとの売買・枚数・建値・IV（%）・Δ、"
          "受取 / 支払 / 差し引き / 手数料（円）、満期の最大利益・最大損失（円）とその原資産・無限か、"
          "損益分岐点、今の合計グリーク（Δ はラージ枚と"
          "ミニ枚、Γ は原資産 100 円あたりの Δ の変化、Θ は円 / 日、V は円 / IV 1pt）、今のシナリオの点の損益。"
          "診断では最初の <context> の precomputed に入っている", POSITION_SUMMARY),
    _spec("tail_table",
          "急落のテール表（画面のテール表と同じ）。原資産 −5・−10・−20・−30・−40% の行ごとに、SQ（満期）の損益と、"
          "今のシナリオの日数・IV での損益（円）、受取（または掛け金）に対する倍率、資金があれば必要証拠金と余力（円）",
          TAIL_TABLE),
    _spec("margin_summary",
          "証拠金の概算（画面の証拠金のタイルと同じ。SPAN の近似で概算）。今とシナリオの点の必要証拠金・所要額・NOV・"
          "余力（円。資金が未設定なら null）・何倍まで建てられるか、"
          "追証の水準（余力が 0 になる原資産。資金があるとき）、"
          "前提（値動き幅 R・IV の上げ / 下げ・掛け目の %）", MARGIN_SUMMARY),
    _spec("scenario_grid",
          "シナリオの格子。原資産の変化 dx_pct（−10・−5・−3・0・+3・+5・+10%）× IV の平行移動 iv_shift_pt"
          "（−5・0・+5・+10pt）× 経過日数 days（0・今のシナリオの日数・最遠の SQ の前日）の損益（円）。"
          "pnl_yen[日数][原資産][IV] の順。β・スキューは今のシナリオの値", SCENARIO_GRID),
    _spec("smile_position",
          "スマイルと足の IV。限月ごとの F・ATM の行使価格と IV（%）・残存日数・ATM と ±5% の IV の差（pt。スキューの"
          "傾き）、足ごとの行使価格の F に対する位置（%）・足の IV と ATM の IV の差（pt）", SMILE_POSITION),
    _spec("evaluate_scenario",
          "任意のシナリオの点の評価（画面の損益グラフ・指標と同じ計算）。"
          "原資産（dx_pct か x）・経過日数・IV の平行移動・"
          "スキューを指定すると、その点の損益（指定日と満期。円）・合計グリーク・足ごとの損益と IV を返す。"
          "<context> や他の道具に無い条件の数字が要るときに呼ぶ", EVALUATE_SCENARIO, EVAL_INPUT, EVAL_INPUT_SCHEMA),
    _spec("technicals",
          "日経225 先物（ラージ・期近）の週足・日足・4 時間足のテクニカル指標（画面の先物推移の段と同じ計算）。"
          "RSI 14・MACD 12/26/9（円）・スロー・ストキャスティクス 14/3/3 の今の値・直近 20 本・"
          "ゾーン（high / low / mid）と続いた本数・シグナル交差から何本目、"
          "base_rates = 今と同じ状態だった過去の足の horizon_bars 本先の騰落率の分布"
          "（件数 n・中央値・p10・p90 の %。all は条件なし）。insufficient は件数 20 未満。"
          "足は期近のつなぎ足（調整なし）で限月交代の跳びが指標に入る。交代をまたぐ窓は基準率から除く（rolls_excluded）。"
          "最新の足は確定前のことがあり（last_bar_may_be_partial）、今の値は確定値として扱わない", TECHNICALS,
          TECHNICALS_INPUT, TECHNICALS_INPUT_SCHEMA),
)}


def definitions(registry: Registry) -> list[dict]:
    """送る tools（名前の順。毎回同じバイト列にして prompt caching の前置きを保つ）"""
    return [registry[name].definition() for name in sorted(registry)]
