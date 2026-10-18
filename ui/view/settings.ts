/**
 * 新しい画面の設定のダイアログ（#87 (C)。docs/ui-redesign.md §3・§11-9）の表示モデル（純関数。DOM・時計を読まない）。
 * 行 = ATM の基準・金額の単位・手数料・損益グラフの縦軸・先物の basis・ΔX の単位・テーマ・前提（読み取り専用）。
 * β・IV の動き方はシナリオの「モデルの前提」だけに置く（§11-9）。値はすべて既存の state / prefs のまま（保存の形式は変えない）。
 * #131 で証拠金（概算）の節（資金・掛け目・値動き幅 R・IV の上げ / 下げ幅。端末の設定 ui/prefs.ts）の欄の判定を足した。
 * #149 で同じ節に「買いの OP」の 2 択（減らさない / 相殺する）を足した。
 */

import type { AtmBasis } from '../../model';
import {
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

/** 証拠金の欄の並び・見出し（#131。設計 5.10。値は % / pt / 円） */
export const MARGIN_FIELDS: readonly { key: MarginPrefKey; label: string }[] = [
  { key: 'capitalYen', label: '資金（円）' },
  { key: 'factorPct', label: '掛け目（%）' },
  { key: 'rangePct', label: '値動き幅 R（%）' },
  { key: 'ivUpPt', label: 'IV の上げ幅（pt）' },
  { key: 'ivDownPt', label: 'IV の下げ幅（pt）' },
];

/** 欄ごとのエラー文（範囲は ui/prefs.ts の MARGIN_PREF_RANGE と同じ） */
export const MARGIN_FIELD_ERROR: Record<MarginPrefKey, string> = {
  capitalYen: '資金は 0〜1,000,000,000,000 円の整数（空欄 = 未設定）',
  factorPct: '掛け目は 50〜300%',
  rangePct: '値動き幅 R は 1〜30%',
  ivUpPt: 'IV の上げ幅は 0〜50pt',
  ivDownPt: 'IV の下げ幅は 0〜30pt',
};

/** 証拠金の節の注記（仮置き・深い OTM の売り・JSCC の Web 試算で確かめる。設計 5.10） */
export const MARGIN_SETTINGS_NOTES: readonly string[] = [
  '証拠金は概算（原資産 ±R × IV の上げ / 下げ × 2 営業日の格子の最悪値 × 掛け目）。JSCC の VaR 証拠金の再現ではない',
  '既定（R 8%・IV +8 / −4pt・掛け目 120%）は仮置き。深い OTM の売りでは実額より小さく出うる',
  'JSCC の Web 試算か証券会社の額で確かめ、幅・掛け目で寄せる。資金はこの端末にだけ保存（保存一覧・共有の URL に載せない）',
  '買いの OP: 減らさない（既定）= 売りの OP と先物だけで計算（証券会社の扱いに合わせる。買いの支払は余力から引く）。相殺する = 全足（JSCC の形）。売りどうしの相殺の扱いは未確認',
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
  ivUpPt: DEFAULT_MARGIN_PREFS.ivUpPt,
  ivDownPt: DEFAULT_MARGIN_PREFS.ivDownPt,
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
