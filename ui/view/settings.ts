/**
 * 新しい画面の設定のダイアログ（#87 (C)。docs/ui-redesign.md §3・§11-9）の表示モデル（純関数。DOM・時計を読まない）。
 * 行 = ATM の基準・金額の単位・手数料・損益グラフの縦軸・先物の basis・ΔX の単位・テーマ・前提（読み取り専用）。
 * β・IV の動き方はシナリオの「モデルの前提」だけに置く（§11-9）。値はすべて既存の state / prefs のまま（保存の形式は変えない）。
 * #131 で証拠金（概算）の節（資金・掛け目・値動き幅 R・IV の上げ / 下げ幅。端末の設定 ui/prefs.ts）の欄の判定を足した。
 * #149 で同じ節に「買いの OP」の 2 択（減らさない / 相殺する）を足した。
 * #205 でテクニカル指標の節（RSI・MACD・ストキャスティクスの期間。端末の設定。先物推移の段と AI のツール technicals に
 * 同じ値を渡す）の欄の判定を足した。
 * #214 で同じ節に線の太さ（EMA の線・オシレーターの線の px。#223 で表記を改めた。ui/view/techLineWidth.ts）を足した。
 * #156 で節「AI に渡す自分の前提」（自由記述の欄 1 つ。端末の設定）の判定・字数の表示・注記を足した。
 */

import {
  type AtmBasis,
  DEFAULT_TECH_PARAMS,
  isEmaOrder,
  isTechParamValue,
  TECH_PARAM_RANGE,
  type TechParamKey,
  type TechParams,
} from '../../model';
import {
  AI_PROFILE_MAX,
  DEFAULT_MARGIN_PREFS,
  isMarginPrefValue,
  type MarginPrefKey,
  type MarginPrefs,
  type ThemePref,
} from '../prefs';
import { type MetricsUnitSetting, parseFee } from '../state';
import { parseNum } from './format';
import type { HeaderModel } from './header';
import type { PnlYMode, PnlYSettings } from './pnlChart';
import type { DXUnit } from './scenario';
import type { FutureBasis } from './scenarioRegion';

export interface SegRow<T extends string> {
  value: T;
  options: { value: T; text: string; disabled?: boolean }[];
}

export interface SettingsInput {
  atmBasis: AtmBasis;
  metricsUnit: MetricsUnitSetting;
  pnlY: PnlYSettings;
  futureBasis: FutureBasis;
  dXUnit: DXUnit;
  /** 基準原資産 X₀（円。決まらなければ NaN） */
  x0: number;
  theme: ThemePref;
  header: HeaderModel | null;
}

export interface SettingsView {
  basis: SegRow<AtmBasis>;
  unit: SegRow<MetricsUnitSetting>;
  /** 損益グラフの縦軸（行の中身は舞台の ⋯ と同じ部品 YAxisFields） */
  yMode: PnlYMode;
  futureBasis: SegRow<FutureBasis>;
  dXUnit: SegRow<DXUnit>;
  theme: SegRow<ThemePref>;
  /** 前提（headerModel.assumptions と同じ順・同じ文。warn = カレンダー期限切れの文） */
  assumptions: { text: string; warn: boolean }[];
  /** 板が無いときの前提の行の文（板があれば null） */
  noBoard: string | null;
}

export const SETTINGS_NO_BOARD_TEXT = '板が無い（前提は板を読むと出る）';

const BASIS_OPTIONS: SegRow<AtmBasis>['options'] = [
  { value: 'B', text: '合成先物（B）' },
  { value: 'A', text: 'ラージ先物（A）' },
];
const UNIT_OPTIONS: SegRow<MetricsUnitSetting>['options'] = [
  { value: 'auto', text: '自動' },
  { value: 'yen', text: '円' },
  { value: 'thousand', text: '千円' },
];
const FUTURE_BASIS_OPTIONS: SegRow<FutureBasis>['options'] = [
  { value: 'fixed', text: '固定' },
  { value: 'decay', text: '減衰' },
];
const THEME_OPTIONS: SegRow<ThemePref>['options'] = [
  { value: 'auto', text: '端末に合わせる' },
  { value: 'dark', text: 'ダーク' },
  { value: 'light', text: 'ライト' },
];

export function settingsModel(i: SettingsInput): SettingsView {
  const x0ok = Number.isFinite(i.x0) && i.x0 > 0;
  const off = x0ok ? {} : { disabled: true };
  return {
    basis: { value: i.atmBasis, options: BASIS_OPTIONS },
    unit: { value: i.metricsUnit, options: UNIT_OPTIONS },
    yMode: i.pnlY.mode,
    futureBasis: { value: i.futureBasis, options: FUTURE_BASIS_OPTIONS },
    dXUnit: {
      value: i.dXUnit,
      options: [
        { value: 'pct', text: '%', ...off },
        { value: 'yen', text: '円', ...off },
      ],
    },
    theme: { value: i.theme, options: THEME_OPTIONS },
    assumptions: i.header
      ? i.header.assumptions.map((text) => ({
          text,
          warn: i.header?.calendarWarning !== null && text === i.header?.calendarWarning,
        }))
      : [],
    noBoard: i.header ? null : SETTINGS_NO_BOARD_TEXT,
  };
}

/** 手数料の欄（円 / 枚）の判定: parseFee に委ねる（旧画面の指標の欄と同じ規則・同じ文） */
export function feeField(text: string): { value: number | null; error: string | null } {
  const r = parseFee(text);
  return r.ok ? { value: r.value, error: null } : { value: null, error: r.message };
}

/** 証拠金の欄の並び・見出し（#131・#150。設計 5.10。値は % / 円） */
export const MARGIN_FIELDS: readonly { key: MarginPrefKey; label: string }[] = [
  { key: 'capitalYen', label: '資金（円）' },
  { key: 'factorPct', label: '掛け目（%）' },
  { key: 'rangePct', label: '値動き幅 R（%）' },
  { key: 'ivUpPct', label: 'IV の上げ（%）' },
  { key: 'ivDownPct', label: 'IV の下げ（%）' },
];

/** 欄ごとのエラー文（範囲は ui/prefs.ts の MARGIN_PREF_RANGE と同じ） */
export const MARGIN_FIELD_ERROR: Record<MarginPrefKey, string> = {
  capitalYen: '資金は 0〜1,000,000,000,000 円の整数（空欄 = 未設定）',
  factorPct: '掛け目は 50〜300%',
  rangePct: '値動き幅 R は 1〜30%',
  ivUpPct: 'IV の上げは 0〜200%',
  ivDownPct: 'IV の下げは 0〜90%',
};

/** 証拠金の節の注記（定義・答え合わせ・未確認の形・JSCC の Web 試算で確かめる。設計 5.10・#150） */
export const MARGIN_SETTINGS_NOTES: readonly string[] = [
  '必要証拠金は概算（原資産 ±R × IV の倍率（足の今の IV の ×(1 + 上げ) / ×(1 − 下げ)）× 2 営業日の格子の最悪の損失 × 掛け目）。証券会社の建てる前の必要委託証拠金と同じ物差しで、受け取るプレミアム（NOV）を含まない。JSCC の VaR 証拠金の再現ではない',
  '余力 = 資金 − 支払 + 受取 − 手数料 + 先物の評価損益 − (必要証拠金 − NOV)',
  '既定（R 5%・IV +50% / −25%・掛け目 100%）は 1 枚ずつの売りの 6 形（put 3 形・call・ストラングル・期先）の答え合わせ（証券会社の額との比 0.98〜1.07）で決めた。ストレス日・先物との組み合わせなどは未確認で、実額と違いうる',
  'JSCC の Web 試算か証券会社の額で確かめ、幅・掛け目で寄せる。資金はこの端末にだけ保存（保存一覧・共有の URL に載せない）',
  '買いの OP: 減らさない（既定）= 売りの OP と先物だけで計算（証券会社の扱いに合わせる。買いの支払は余力から引く）。相殺する = 全足（JSCC の形）。売りどうしはポジション全体の格子で相殺する',
];

/** 買いの OP の 2 択の値（ignore = 減らさない、offset = 相殺する。#149） */
export type MarginLongValue = 'ignore' | 'offset';

export const MARGIN_LONG_OPTIONS: SegRow<MarginLongValue>['options'] = [
  { value: 'ignore', text: '減らさない' },
  { value: 'offset', text: '相殺する' },
];

export function marginLongValue(m: MarginPrefs): MarginLongValue {
  return m.ignoreLongOptions ? 'ignore' : 'offset';
}

export function marginLongPatch(v: MarginLongValue): Partial<MarginPrefs> {
  return { ignoreLongOptions: v === 'ignore' };
}

/** [既定に戻す] で戻す項目（幅・掛け目・買いの OP。資金は戻さない） */
export const MARGIN_RESET: Partial<MarginPrefs> = {
  factorPct: DEFAULT_MARGIN_PREFS.factorPct,
  rangePct: DEFAULT_MARGIN_PREFS.rangePct,
  ivUpPct: DEFAULT_MARGIN_PREFS.ivUpPct,
  ivDownPct: DEFAULT_MARGIN_PREFS.ivDownPct,
  ignoreLongOptions: DEFAULT_MARGIN_PREFS.ignoreLongOptions,
};

/** 欄に出す文字列（資金の未設定は空欄） */
export function marginFieldText(key: MarginPrefKey, m: MarginPrefs): string {
  const v = m[key];
  return v === null ? '' : String(v);
}

/**
 * 証拠金の欄の判定（入力ごと）: 通れば値（資金の空欄・0 は null = 未設定）、通らなければエラー文。
 * 桁区切り・全角でない数の書き方は parseNum と同じ
 */
export function marginField(
  key: MarginPrefKey,
  text: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (key === 'capitalYen' && text.trim() === '') return { ok: true, value: null };
  const v = parseNum(text);
  if (!isMarginPrefValue(key, v)) return { ok: false, error: MARGIN_FIELD_ERROR[key] };
  if (key === 'capitalYen' && v === 0) return { ok: true, value: null };
  return { ok: true, value: v };
}

/** テクニカル指標の欄の並び・見出し（#205。並びは model の TECH_PARAM_KEYS と同じ） */
export const TECH_FIELDS: readonly { key: TechParamKey; label: string }[] = [
  { key: 'rsi', label: 'RSI の期間' },
  { key: 'macdFast', label: 'MACD の短期' },
  { key: 'macdSlow', label: 'MACD の長期' },
  { key: 'macdSignal', label: 'MACD のシグナル' },
  { key: 'stochK', label: 'SO の %K の期間' },
  { key: 'stochSmooth', label: 'SO のスロー' },
  { key: 'stochD', label: 'SO の %D' },
  { key: 'emaShort', label: 'EMA の短期' },
  { key: 'emaMid', label: 'EMA の中期' },
  { key: 'emaLong', label: 'EMA の長期' },
];

const rangeText = (k: TechParamKey) => `${TECH_PARAM_RANGE[k].min}〜${TECH_PARAM_RANGE[k].max}`;

/** 範囲外・整数でないときの文（範囲は model の TECH_PARAM_RANGE） */
export const TECH_FIELD_ERROR: Record<TechParamKey, string> = {
  rsi: `RSI の期間は ${rangeText('rsi')} の整数`,
  macdFast: `MACD の短期は ${rangeText('macdFast')} の整数`,
  macdSlow: `MACD の長期は ${rangeText('macdSlow')} の整数`,
  macdSignal: `MACD のシグナルは ${rangeText('macdSignal')} の整数`,
  stochK: `%K の期間は ${rangeText('stochK')} の整数`,
  stochSmooth: `スローは ${rangeText('stochSmooth')} の整数`,
  stochD: `%D は ${rangeText('stochD')} の整数`,
  emaShort: `EMA の短期は ${rangeText('emaShort')} の整数`,
  emaMid: `EMA の中期は ${rangeText('emaMid')} の整数`,
  emaLong: `EMA の長期は ${rangeText('emaLong')} の整数`,
};

/** MACD の短期 ≥ 長期の文 */
export const TECH_MACD_ORDER_ERROR = 'MACD は短期 < 長期にする';

/** EMA が短期 < 中期 < 長期でないときの文（#206） */
export const TECH_EMA_ORDER_ERROR = 'EMA は短期 < 中期 < 長期にする';

/** テクニカルの節の注記 */
export const TECH_SETTINGS_NOTES: readonly string[] = [
  '先物推移の指標の段・価格に重ねる EMA の線と AI のツール（テクニカル）に同じ期間を使う。基準率もこの期間の指標で数える。SO = スロー・ストキャスティクス（スロー = %K の平滑）',
  '線の太さは画面の px（EMA の線 = 3 本とも同じ、オシレーターの線 = RSI・MACD・シグナル・%K・%D。MACD のヒストの棒は変わらない）',
  'この端末にだけ保存（保存一覧・共有の URL に載せない）。既定 = RSI 14・MACD 12 / 26 / 9・ストキャスティクス 14 / 3 / 3・EMA 5 / 25 / 75・線の太さ EMA 1 px / オシレーター 1.25 px',
];

/** [既定に戻す] で戻す値 */
export const TECH_RESET: TechParams = { ...DEFAULT_TECH_PARAMS };

/**
 * テクニカルの欄の判定（入力ごと）: 範囲内の整数で、MACD は今の相手の値と短期 < 長期、EMA は今の残り 2 つの値と
 * 短期 < 中期 < 長期（#206）のときだけ通す。
 * 書き方は parseNum と同じ（前後の空白・桁区切り）
 */
export function techField(
  key: TechParamKey,
  text: string,
  current: TechParams,
): { ok: true; value: number } | { ok: false; error: string } {
  const v = parseNum(text);
  if (!isTechParamValue(key, v)) return { ok: false, error: TECH_FIELD_ERROR[key] };
  if (key === 'macdFast' && v >= current.macdSlow)
    return { ok: false, error: TECH_MACD_ORDER_ERROR };
  if (key === 'macdSlow' && v <= current.macdFast)
    return { ok: false, error: TECH_MACD_ORDER_ERROR };
  if (
    (key === 'emaShort' || key === 'emaMid' || key === 'emaLong') &&
    !isEmaOrder({ ...current, [key]: v })
  )
    return { ok: false, error: TECH_EMA_ORDER_ERROR };
  return { ok: true, value: v };
}

/** 字数の桁区切り（1,000） */
const count = (n: number) => n.toLocaleString('en-US');

/**
 * AI に渡す自分の前提の欄の判定（#156。入力ごと）: 上限以内なら通す（前後の空白だけ・空 = 未設定）、超えたらエラー文。
 * 字数は String.length（中継の上限と同じ数え方より厳しくならない側）
 */
export function aiProfileField(text: string): { ok: true } | { ok: false; error: string } {
  if (text.length <= AI_PROFILE_MAX) return { ok: true };
  return {
    ok: false,
    error: `${count(AI_PROFILE_MAX)} 字までにする（今 ${count(text.length)} 字。保存していない）`,
  };
}

/** 欄の下の字数（「120 / 1,000 字」） */
export function aiProfileCount(text: string): string {
  return `${count(text.length)} / ${count(AI_PROFILE_MAX)} 字`;
}

/** 欄の例（placeholder。架空の値） */
export const AI_PROFILE_PLACEHOLDER =
  '例: 資金 500 万円。1 回の損失は 30 万円まで。期近の深い OTM の売りが基本。ネイキッドのコールの売りは避ける。決算前は建てない';

/** AI に渡す自分の前提の節の注記 */
export const AI_PROFILE_NOTES: readonly string[] = [
  '資金・許容できる損失・好む形・避ける形・判断の癖などを書くと、AI に相談するたびに一緒に渡します。AI は答えの方針に使い、数字は計算の値（設定の資金・ツールの結果）を使います',
  'この端末にだけ保存（保存一覧・共有の URL・サーバーに載せない）。空にすると渡しません。会話の途中で変えると次の発言から効きます',
];
