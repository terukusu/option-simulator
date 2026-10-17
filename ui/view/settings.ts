/**
 * 新しい画面の設定のダイアログ（#87 (C)。docs/ui-redesign.md §3・§11-9）の表示モデル（純関数。DOM・時計を読まない）。
 * 行 = ATM の基準・金額の単位・手数料・損益グラフの縦軸・先物の basis・ΔX の単位・テーマ・前提（読み取り専用）。
 * β・IV の動き方はシナリオの「モデルの前提」だけに置く（§11-9）。値はすべて既存の state / prefs のまま（保存の形式は変えない）。
 */

import type { AtmBasis } from '../../model';
import type { ThemePref } from '../prefs';
import { type MetricsUnitSetting, parseFee } from '../state';
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
