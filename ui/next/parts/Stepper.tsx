import { isHot, type StepSpec, stepBy, stepKey } from '../../view/stepper';

/**
 * ステッパー（docs/ui-redesign.md §5・§4.2。規則は ui/view/stepper.ts）。− / 値（太字 + 副題）/ +。
 * 値にフォーカスして ↑↓ で ±1 段、範囲で止める、既定でない値は .hot（強調色）。
 * スクラブ・ホイール・数値入力・Shift の大きな段は #83。
 */
export function Stepper(p: {
  label: string;
  spec: StepSpec;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  sub?: string;
}) {
  const { spec, value } = p;
  const move = (n: number) => {
    const v = stepBy(spec, value, n);
    if (v !== value) p.onChange(v);
  };
  const text = p.format(value);
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と flex の癖があるので div + role="group"
    <div class={isHot(spec, value) ? 'stepper hot' : 'stepper'} role="group" aria-label={p.label}>
      <button
        type="button"
        aria-label={`${p.label}を減らす`}
        disabled={value <= spec.min}
        onClick={() => move(-1)}
      >
        −
      </button>
      <div
        class="val"
        role="spinbutton"
        tabIndex={0}
        aria-label={p.label}
        aria-valuenow={value}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuetext={p.sub ? `${text} ${p.sub}` : text}
        onKeyDown={(e) => {
          const n = stepKey(e.key);
          if (n === 0) return;
          e.preventDefault();
          move(n);
        }}
      >
        <b>{text}</b>
        {p.sub !== undefined && <small>{p.sub}</small>}
      </div>
      <button
        type="button"
        aria-label={`${p.label}を増やす`}
        disabled={value >= spec.max}
        onClick={() => move(1)}
      >
        +
      </button>
    </div>
  );
}
