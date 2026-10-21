import type { MutableRef } from 'preact/hooks';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AtmBasis, TechParamKey, TechParams } from '../../model';
import type { Domain } from '../chart/scale';
import type { MarginPrefKey, MarginPrefs, ThemePref } from '../prefs';
import type { Action, MetricsUnitSetting } from '../state';
import type { HeaderModel } from '../view/header';
import type { PnlYSettings } from '../view/pnlChart';
import type { DXUnit } from '../view/scenario';
import { basisAction, type FutureBasis } from '../view/scenarioRegion';
import {
  AI_PROFILE_NOTES,
  AI_PROFILE_PLACEHOLDER,
  aiProfileCount,
  aiProfileField,
  feeField,
  MARGIN_FIELDS,
  MARGIN_LONG_OPTIONS,
  MARGIN_RESET,
  MARGIN_SETTINGS_NOTES,
  type MarginLongValue,
  marginField,
  marginFieldText,
  marginLongPatch,
  marginLongValue,
  settingsModel,
  TECH_FIELDS,
  TECH_RESET,
  TECH_SETTINGS_NOTES,
  techField,
} from '../view/settings';
import {
  DEFAULT_TECH_LINE_WIDTHS,
  TECH_LINE_FIELDS,
  TECH_LINE_PX_OPTIONS,
  type TechLineWidths,
  techLinePxOf,
} from '../view/techLineWidth';
import { Dialog } from './parts/Dialog';
import { Seg } from './parts/Seg';
import { YAxisFields } from './parts/YAxisFields';

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  atmBasis: AtmBasis;
  metricsUnit: MetricsUnitSetting;
  feePerLot: number;
  pnlY: PnlYSettings;
  futureBasis: FutureBasis;
  dXUnit: DXUnit;
  /** 基準原資産 X₀（円。決まらなければ NaN = ΔX の単位を押せない） */
  x0: number;
  theme: ThemePref;
  header: HeaderModel | null;
  /** 今の縦軸の範囲（舞台が描くたびに入れる。手動に切り替えたときの初期値） */
  yNow: MutableRef<Domain | null>;
  dispatch: (a: Action) => void;
  onDXUnit: (u: DXUnit) => void;
  onTheme: (t: ThemePref) => void;
  /** 証拠金（概算）の設定（端末の設定。#131） */
  margin: MarginPrefs;
  onMargin: (patch: Partial<MarginPrefs>) => void;
  /** テクニカル指標の期間（端末の設定。先物推移の段と AI のツール technicals に同じ値。#205） */
  techParams: TechParams;
  onTechParams: (patch: Partial<TechParams>) => void;
  /** テクニカルの線の太さ（px。端末の設定。EMA の 3 本とオシレーターの線。#214） */
  techLineWidths: TechLineWidths;
  onTechLineWidths: (patch: Partial<TechLineWidths>) => void;
  /** AI に渡す自分の前提（端末の設定。#156。未設定は空文字） */
  aiProfile: string;
  onAiProfile: (text: string) => void;
}

/**
 * 設定のダイアログ（#87 (C)。docs/ui-redesign.md §3・§11-9）: ATM の基準・金額の単位・手数料・損益グラフの縦軸・
 * 先物の basis・ΔX の単位・テーマ・証拠金（概算。#131）・テクニカル指標（#205。線の太さ = #214）・AI に渡す自分の前提（#156）・前提（読み取り専用）。変えたらすぐ state / prefs に入る（[保存] なし）。
 * 値と選べない理由は ui/view/settings.ts、縦軸の欄は舞台の ⋯ と同じ YAxisFields。開いている間だけ描く。
 */
export function SettingsDialog(p: SettingsDialogProps) {
  return (
    <Dialog open={p.open} title="設定" onClose={p.onClose} class="settings">
      <SettingsBody {...p} />
    </Dialog>
  );
}

/**
 * 証拠金の 1 欄（手数料の欄と同じ規則: 入力ごとに検証、通って値が変わったら入れる。外で値が変わったら欄を戻す）。
 * 値は端末の設定（usePrefs の setMargin）。
 */
function MarginField({
  field,
  margin,
  onMargin,
}: {
  field: { key: MarginPrefKey; label: string };
  margin: MarginPrefs;
  onMargin: (patch: Partial<MarginPrefs>) => void;
}) {
  const { key, label } = field;
  const value = margin[key];
  const [text, setText] = useState(() => marginFieldText(key, margin));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const r = marginField(key, text);
    if (!r.ok || r.value !== value) {
      setText(marginFieldText(key, margin));
      setError(null);
    }
  }, [value]);
  const onInput = (t: string) => {
    setText(t);
    const r = marginField(key, t);
    setError(r.ok ? null : r.error);
    if (r.ok && r.value !== value) onMargin({ [key]: r.value });
  };
  const id = `set-margin-${key}`;
  return (
    <>
      <div class="set-line">
        <label class="set-k" for={id}>
          {label}
        </label>
        <input
          id={id}
          class={key === 'capitalYen' ? 'set-input wide' : 'set-input'}
          type="text"
          inputMode={key === 'capitalYen' ? 'numeric' : 'decimal'}
          size={key === 'capitalYen' ? 14 : 6}
          value={text}
          aria-invalid={error !== null}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      </div>
      {error !== null && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * テクニカル指標の 1 欄（証拠金の欄と同じ規則: 入力ごとに検証、通って値が変わったら入れる。外で値が変わったら欄を戻す）。
 * MACD の短期 < 長期・EMA の短期 < 中期 < 長期は今の相手の値で判定する（#205・#206）
 */
function TechField({
  field,
  params,
  onTechParams,
}: {
  field: { key: TechParamKey; label: string };
  params: TechParams;
  onTechParams: (patch: Partial<TechParams>) => void;
}) {
  const { key, label } = field;
  const value = params[key];
  const [text, setText] = useState(() => String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const r = techField(key, text, params);
    if (!r.ok || r.value !== value) {
      setText(String(value));
      setError(null);
    }
  }, [value]);
  // MACD・EMA（#206）の相手が変わって順序が正しくなったら、エラーのままの欄の値を入れる
  const { macdFast, macdSlow, emaShort, emaMid, emaLong } = params;
  useEffect(() => {
    if (error === null) return;
    const r = techField(key, text, params);
    if (!r.ok) return;
    setError(null);
    if (r.value !== value) onTechParams({ [key]: r.value });
  }, [macdFast, macdSlow, emaShort, emaMid, emaLong]);
  const onInput = (t: string) => {
    setText(t);
    const r = techField(key, t, params);
    setError(r.ok ? null : r.error);
    if (r.ok && r.value !== value) onTechParams({ [key]: r.value });
  };
  const id = `set-tech-${key}`;
  return (
    <>
      <div class="set-line">
        <label class="set-k" for={id}>
          {label}
        </label>
        <input
          id={id}
          class="set-input"
          type="text"
          inputMode="numeric"
          size={6}
          value={text}
          aria-invalid={error !== null}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      </div>
      {error !== null && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * AI に渡す自分の前提の欄（#156）: 入力ごとに判定し、上限以内なら端末の設定に入れる（超えたらエラー文で知らせ、値は
 * 変えない）。外で値が変わったら欄を戻す
 */
function AiProfileField({
  value,
  onAiProfile,
}: {
  value: string;
  onAiProfile: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (aiProfileField(text).ok && text.trim() !== value.trim()) {
      setText(value);
      setError(null);
    }
  }, [value]);
  const onInput = (t: string) => {
    setText(t);
    const r = aiProfileField(t);
    setError(r.ok ? null : r.error);
    if (r.ok) onAiProfile(t);
  };
  return (
    <>
      <textarea
        id="set-ai-profile"
        class="set-textarea"
        rows={5}
        value={text}
        placeholder={AI_PROFILE_PLACEHOLDER}
        aria-invalid={error !== null}
        aria-describedby="set-ai-profile-count"
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      <p id="set-ai-profile-count" class="set-note set-count">
        {aiProfileCount(text)}
      </p>
      {error !== null && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function SettingsBody(p: SettingsDialogProps) {
  const { dispatch, feePerLot, yNow } = p;
  const v = useMemo(
    () =>
      settingsModel({
        atmBasis: p.atmBasis,
        metricsUnit: p.metricsUnit,
        pnlY: p.pnlY,
        futureBasis: p.futureBasis,
        dXUnit: p.dXUnit,
        x0: p.x0,
        theme: p.theme,
        header: p.header,
      }),
    [p.atmBasis, p.metricsUnit, p.pnlY, p.futureBasis, p.dXUnit, p.x0, p.theme, p.header],
  );
  // 手数料の欄（旧画面の指標と同じ規則: 入力ごとに検証、通って値が変わったら入れる。外で値が変わったら欄を戻す）
  const [feeText, setFeeText] = useState(String(feePerLot));
  const [feeError, setFeeError] = useState<string | null>(null);
  useEffect(() => {
    const r = feeField(feeText);
    if (r.value !== feePerLot) {
      setFeeText(String(feePerLot));
      setFeeError(null);
    }
  }, [feePerLot]);
  // [既定に戻す] で欄を作り直す（エラーのまま値が既定と同じ欄の文字も戻す）
  const [techGen, setTechGen] = useState(0);
  const onFee = (t: string) => {
    setFeeText(t);
    const r = feeField(t);
    setFeeError(r.error);
    if (r.value !== null && r.value !== feePerLot) dispatch({ type: 'setFee', fee: r.value });
  };

  return (
    <div class="set-list">
      <div class="set-row">
        <div class="set-line">
          <span class="set-k">ATM の基準</span>
          <Seg<AtmBasis>
            label="ATM の基準"
            value={v.basis.value}
            options={v.basis.options}
            onChange={(basis) => dispatch({ type: 'setBasis', basis })}
          />
        </div>
        <p class="set-note">板の ATM 行・スマイルの ATM・市場ピルの ATM の基準</p>
      </div>
      <div class="set-row">
        <div class="set-line">
          <span class="set-k">金額の単位</span>
          <Seg<MetricsUnitSetting>
            label="金額の単位"
            value={v.unit.value}
            options={v.unit.options}
            onChange={(unit) => dispatch({ type: 'setMetricsUnit', unit })}
          />
        </div>
        <p class="set-note">自動 = 受取 + 支払が 10 万円以上なら千円、未満なら円</p>
      </div>
      <div class="set-row">
        <div class="set-line">
          <label class="set-k" for="set-fee">
            手数料（円 / 枚）
          </label>
          <input
            id="set-fee"
            class="set-input"
            type="text"
            inputMode="numeric"
            size={8}
            value={feeText}
            aria-invalid={feeError !== null}
            onInput={(e) => onFee(e.currentTarget.value)}
          />
        </div>
        {feeError !== null && (
          <p class="field-error" role="alert">
            {feeError}
          </p>
        )}
        <p class="set-note">損益・指標・テール表に効く（1 枚あたり × 枚数）</p>
      </div>
      <div class="set-row">
        <div class="set-line">
          <span class="set-k">損益グラフの縦軸</span>
        </div>
        <div class="stage-pop set-y">
          <YAxisFields pnlY={p.pnlY} current={() => yNow.current} dispatch={dispatch} />
        </div>
      </div>
      <div class="set-row">
        <div class="set-line">
          <span class="set-k">先物の basis</span>
          <Seg<FutureBasis>
            label="先物の basis"
            value={v.futureBasis.value}
            options={v.futureBasis.options}
            onChange={(b) => dispatch(basisAction(b))}
          />
        </div>
        <p class="set-note">固定 = 先物と原資産の差を一定に / 減衰 = 先物の SQ で 0 へ</p>
      </div>
      <div class="set-row">
        <div class="set-line">
          <span class="set-k">ΔX の単位</span>
          <Seg<DXUnit>
            label="ΔX の単位"
            value={v.dXUnit.value}
            options={v.dXUnit.options}
            onChange={p.onDXUnit}
          />
        </div>
        <p class="set-note">シナリオの ΔX の表示（保存しない）</p>
      </div>
      <div class="set-row">
        <div class="set-line">
          <span class="set-k">テーマ</span>
          <Seg<ThemePref>
            label="テーマ"
            value={v.theme.value}
            options={v.theme.options}
            onChange={p.onTheme}
          />
        </div>
      </div>
      <div class="set-row set-margin">
        <div class="set-line">
          <span class="set-k">証拠金（概算）</span>
          <button type="button" class="btn sm" onClick={() => p.onMargin(MARGIN_RESET)}>
            既定に戻す
          </button>
        </div>
        {MARGIN_FIELDS.map((f) => (
          <MarginField field={f} margin={p.margin} onMargin={p.onMargin} key={f.key} />
        ))}
        <div class="set-line">
          <span class="set-k">買いの OP</span>
          <Seg<MarginLongValue>
            label="買いの OP で証拠金を減らさない"
            value={marginLongValue(p.margin)}
            options={MARGIN_LONG_OPTIONS}
            onChange={(v) => p.onMargin(marginLongPatch(v))}
          />
        </div>
        {MARGIN_SETTINGS_NOTES.map((t) => (
          <p class="set-note" key={t}>
            {t}
          </p>
        ))}
      </div>
      <div class="set-row set-tech">
        <div class="set-line">
          <span class="set-k">テクニカル指標</span>
          <button
            type="button"
            class="btn sm"
            onClick={() => {
              p.onTechParams(TECH_RESET);
              p.onTechLineWidths(DEFAULT_TECH_LINE_WIDTHS);
              setTechGen((g) => g + 1);
            }}
          >
            既定に戻す
          </button>
        </div>
        {TECH_FIELDS.map((f) => (
          <TechField
            field={f}
            params={p.techParams}
            onTechParams={p.onTechParams}
            key={`${f.key}-${techGen}`}
          />
        ))}
        {TECH_LINE_FIELDS.map((f) => (
          <div class="set-line" key={f.key}>
            <label class="set-k" for={`set-tech-lw-${f.key}`}>
              {f.label}
            </label>
            <select
              id={`set-tech-lw-${f.key}`}
              class="set-input"
              aria-label={f.aria}
              value={String(p.techLineWidths[f.key])}
              onChange={(e) => {
                const px = techLinePxOf(e.currentTarget.value);
                if (px !== null) p.onTechLineWidths({ [f.key]: px });
              }}
            >
              {TECH_LINE_PX_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.text}
                </option>
              ))}
            </select>
          </div>
        ))}
        {TECH_SETTINGS_NOTES.map((t) => (
          <p class="set-note" key={t}>
            {t}
          </p>
        ))}
      </div>
      <div class="set-row set-ai-profile">
        <div class="set-line">
          <label class="set-k" for="set-ai-profile">
            AI に渡す自分の前提
          </label>
        </div>
        <AiProfileField value={p.aiProfile} onAiProfile={p.onAiProfile} />
        {AI_PROFILE_NOTES.map((t) => (
          <p class="set-note" key={t}>
            {t}
          </p>
        ))}
      </div>
      <div class="set-row">
        <div class="set-line">
          <span class="set-k">前提</span>
          <span class="set-ro">変更不可</span>
        </div>
        {v.noBoard !== null ? (
          <p class="set-note">{v.noBoard}</p>
        ) : (
          v.assumptions.map((a) => (
            <p class={a.warn ? 'set-note warn' : 'set-note'} key={a.text}>
              {a.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
