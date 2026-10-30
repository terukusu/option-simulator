import { useMemo, useState } from 'preact/hooks';
import type { IvDynamics } from '../../../model';
import type { AppController } from '../../components/useAppController';
import { HINT_TERMS } from '../../view/glossary';
import { PANEL_FOCUS_LABEL } from '../../view/keys';
import { revealViewport } from '../../view/pnlChart';
import { type DXUnit, fromDisplay } from '../../view/scenario';
import {
  advSummary,
  basisAction,
  betaNote,
  betaStepper,
  type Chip as ChipView,
  dynamicsAction,
  editText,
  evalChips,
  type FutureBasis,
  parseStepperInput,
  presetChips,
  presetRevealAction,
  type ScenarioRegionInput,
  type StepperView,
  scenarioSteppers,
  stepperAction,
  stepperText,
} from '../../view/scenarioRegion';
import { PanelHead } from '../PanelHead';
import { Chip, ChipRow } from '../parts/Chip';
import { Icon } from '../parts/Icon';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';
import { Stepper } from '../parts/Stepper';
import { TermLinks } from '../parts/TermLinks';

const DYNAMICS = [
  { value: 'sticky_strike', text: 'sticky strike' },
  { value: 'sticky_moneyness', text: 'sticky moneyness' },
] as const;
const BASIS = [
  { value: 'fixed', text: '固定' },
  { value: 'decay', text: '減衰' },
] as const;

/**
 * シナリオ（docs/ui-redesign.md §2・§3・§4.2・§5。#83）: ステッパー 4 つ（d・ΔX・Δσ・Δs）→ プリセットのチップ →
 * 評価時刻のチップ → 「モデルの前提」の折りたたみ（β のステッパー・IV の動き方・先物の basis・ΔX の単位）。
 * 表示モデルと操作 → action は ui/view/scenarioRegion.ts。状態は既存の action だけ（#82 の舞台と同じ state.scenario）。
 * ΔX の単位は NextApp のローカル（保存しない）、前提の開閉・数値入力のエラーはここのローカル（保存しない）。
 */
/** シナリオの表示モデルの入力（コマンドパレットのシナリオ・評価時刻の行も同じ組み立て。#89 段 B） */
export function scenarioInputOf(c: AppController, dXUnit: DXUnit): ScenarioRegionInput {
  const base = c.pnlBase;
  return {
    scenario: c.state.scenario,
    futureBasis: c.state.futureBasis,
    x0: c.positions?.ctx.x0 ?? Number.NaN,
    maxDays: base?.maxDays ?? 0,
    evalTime: base?.ctx.evalTime ?? null,
    targets: c.targets,
    dXUnit,
  };
}

export function Scenario(p: { c: AppController; dXUnit: DXUnit; onDXUnit: (u: DXUnit) => void }) {
  const { c, dXUnit } = p;
  const { state, dispatch, pnlBase: base } = c;
  const x0 = c.positions?.ctx.x0 ?? Number.NaN;
  const maxDays = base?.maxDays ?? 0;
  const evalTime = base?.ctx.evalTime ?? null;
  // 依存は組み立てに使う値だけ（c は毎回新しいオブジェクト）
  const input = useMemo<ScenarioRegionInput>(
    () => scenarioInputOf(c, dXUnit),
    [state.scenario, state.futureBasis, x0, maxDays, evalTime, c.targets, dXUnit],
  );
  const view = useMemo(
    () => ({
      steppers: scenarioSteppers(input),
      beta: betaStepper(input),
      presets: presetChips(input),
      evals: evalChips(input),
      summary: advSummary(input),
    }),
    [input],
  );
  const [error, setError] = useState<string | null>(null);
  const x0ok = Number.isFinite(x0) && x0 > 0;

  const stepper = (v: StepperView) => (
    <Stepper
      key={v.field}
      name={v.field}
      label={v.label}
      spec={v.spec}
      value={v.value}
      format={(n) => stepperText(v.field, n, input)}
      sub={v.sub}
      disabled={v.disabled}
      gestures
      keepFraction={v.keepFraction}
      edit={{
        parse: (t) => parseStepperInput(v.field, t, input),
        text: (n) => editText(v.field, n, input),
        onError: setError,
        // ΔX の数値欄で確定した点が横軸の表示範囲の外なら、その点まで表示範囲を広げる（#144。反対側の端は保つ）
        ...(v.field === 'dX' && {
          onCommit: (n: number) => {
            if (!base) return;
            const vp = revealViewport(base, state.pnlViewport, fromDisplay('dX', n, x0, dXUnit));
            if (vp) dispatch({ type: 'setPnlViewport', viewport: vp });
          },
        }),
      }}
      onChange={(n) => {
        const a = stepperAction(v.field, n, input);
        if (a) dispatch(a);
      }}
    />
  );
  const chip = (ch: ChipView) => (
    <Chip
      key={ch.key}
      text={ch.text}
      {...(ch.pressed !== undefined && { pressed: ch.pressed })}
      disabled={ch.disabled}
      onClick={() => {
        if (!ch.action) return;
        // プリセットの後はシナリオ点が表示範囲の内側 10% に入るように広げる（#276。dispatch の前の表示範囲から作る）
        const reveal = presetRevealAction(ch.action, base, state.pnlViewport);
        dispatch(ch.action);
        if (reveal) dispatch(reveal);
      }}
    />
  );

  return (
    <>
      <PanelHead title="シナリオ">
        <Popover label="シナリオの操作" button={<Icon name="info" />}>
          <p>
            ステッパー: [−][＋] で 1 段（Shift で 10
            段、押し続けると連続）。値の上を左右にドラッグ（8px で 1
            段）・ホイールでも動く。値にフォーカスして ↑ → / ↓ ← で ±1、Shift・PageUp / PageDown で
            ±10、Home / End で端、R
            で既定値。値をダブルクリック（タッチは長押し）で数値を入力（Enter で確定、Esc
            で戻す）。d の段は端数を保つ。
          </p>
          <p>{betaNote()}</p>
          <p>
            IV の動き方: sticky strike は原資産が動いても σ(K) を変えない。sticky moneyness
            はスマイルが原資産と一緒に動く。
          </p>
          <p>
            先物 basis: 先物の足をその SQ より前に評価するとき F = X' + basis。減衰は先物の SQ で 0
            へ線形。
          </p>
          <TermLinks ids={HINT_TERMS.scenario} />
        </Popover>
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div
        class="panel-body scn-body"
        tabIndex={-1}
        role="group"
        aria-label={PANEL_FOCUS_LABEL.scenario}
      >
        <div class="scn-grid">{view.steppers.map(stepper)}</div>
        {error !== null && (
          <p class="scn-err" role="alert">
            {error}
          </p>
        )}
        <div class="scn-row">
          <ChipRow label="プリセット">{view.presets.map(chip)}</ChipRow>
        </div>
        <div class="scn-row">
          <span class="lab">評価時刻</span>
          {view.evals.length > 0 ? (
            <ChipRow label="評価時刻">{view.evals.map(chip)}</ChipRow>
          ) : (
            <p class="note">足を入れると評価時刻のチップが出る</p>
          )}
        </div>
        <details class="adv">
          <summary>
            <Icon name="chevron" />
            <span class="ttl">モデルの前提</span>
            <span class="vals">{view.summary}</span>
          </summary>
          <div class="adv-body">
            <span class="item beta">
              <span class="lab">β</span>
              {stepper(view.beta)}
            </span>
            <span class="item">
              <span class="lab">IV の動き方</span>
              <Seg<IvDynamics>
                label="IV の動き方"
                value={state.scenario.ivDynamics}
                options={DYNAMICS}
                onChange={(v) => dispatch(dynamicsAction(v))}
              />
            </span>
            <span class="item">
              <span class="lab">先物の basis</span>
              <Seg<FutureBasis>
                label="先物の basis"
                value={state.futureBasis}
                options={BASIS}
                onChange={(v) => dispatch(basisAction(v))}
              />
            </span>
            <span class="item">
              <span class="lab">ΔX の単位</span>
              <Seg<DXUnit>
                label="ΔX の単位"
                value={dXUnit}
                options={[
                  { value: 'pct', text: '%', disabled: !x0ok },
                  { value: 'yen', text: '円', disabled: !x0ok },
                ]}
                onChange={p.onDXUnit}
              />
            </span>
          </div>
        </details>
      </div>
    </>
  );
}
