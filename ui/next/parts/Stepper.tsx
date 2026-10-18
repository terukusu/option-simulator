import { useEffect, useRef, useState } from 'preact/hooks';
import type { Parsed } from '../../state';
import {
  clickSteps,
  EDIT_HOLD_MS,
  EDIT_MOVE_PX,
  editOutcome,
  isHot,
  repeatSteps,
  type StepSpec,
  scrubSteps,
  sentAfterProps,
  stepBy,
  stepKey,
  stepOrigin,
  stepperJump,
  stepperKey,
  stepperMove,
  wheelStep,
} from '../../view/stepper';
import { livePulse } from '../live';

/** 数値入力（#83）。parse は表示の単位の値、text は開いたときの文字列、onError はエラーの文言（null で消す） */
export interface StepperEdit {
  parse: (text: string) => Parsed<number>;
  text: (v: number) => string;
  onError: (message: string | null) => void;
  /** 数値入力で値を確定したあと（表示の単位の値。変えずに閉じたときは呼ばない。#144: ΔX の点を横軸に見せる） */
  onCommit?: (v: number) => void;
}

interface Props {
  label: string;
  spec: StepSpec;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  sub?: string | undefined;
  /** ルートの data-name（検査・CSS の手がかり。#83） */
  name?: string;
  /** どの操作でも onChange を呼ばない（± は disabled、値は aria-disabled。#83） */
  disabled?: boolean;
  /** Shift + クリック 10 段・± の長押しの連続・スクラブ・ホイール・全キー（#83。省略時は ↑↓ だけ） */
  gestures?: boolean;
  /** 段の格子に寄せない（d。#83） */
  keepFraction?: boolean;
  /** 数値入力（ダブルクリック / タッチの長押し。#83） */
  edit?: StepperEdit;
}

/**
 * ステッパー（docs/ui-redesign.md §5・§4.2。規則は ui/view/stepper.ts）。− / 値（太字 + 副題）/ +。
 * 値にフォーカスして ↑↓ で ±1 段、範囲で止める、既定でない値は .hot（強調色）。
 * #83 の省略可能な props: gestures（± の pointerdown で 1 段・Shift で 10 段・押し続けると連続、値の上の
 * 横のスクラブ 8px で 1 段・ホイール 1 段・↑→ / ↓← / Shift・PageUp/PageDown ±10 / Home / End / R）、
 * keepFraction（d の端数を保つ）、edit（ダブルクリック / タッチ 450ms で同じ場所に入力欄）、disabled、name。
 * 連続の操作（スクラブ・ホイール・長押し）は 1 フレーム 1 回 onChange（rAF）。props の値が描画に届く前の次の段は
 * 最後に送った値から作る（段を落とさない）。
 */
export function Stepper(p: Props) {
  const { spec, value } = p;
  const props = useRef(p);
  props.current = p;
  /** 最後に送ってまだ props に届いていない値。描画で props の値が変わったら捨てる（B-2: 古い値を起点にしない） */
  const sent = useRef<number | null>(null);
  const valueRef = useRef(value);
  sent.current = sentAfterProps(sent.current, valueRef.current, value);
  valueRef.current = value;
  const pending = useRef<number | null>(null);
  const frame = useRef(0);
  const repeat = useRef<{
    dir: number;
    t0: number;
    done: number;
    frame: number;
    /** タッチで遅らせた最初の段（0 = 済み） */
    firstN: number;
  } | null>(null);
  const scrub = useRef<{
    id: number;
    x0: number;
    y0: number;
    applied: number;
    moved: boolean;
    timer: number;
  } | null>(null);
  const valRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing !== null;
  /** 開いたときの文字列（変わっていなければ確定しない。B-1） */
  const opened = useRef('');

  const off = () => props.current.disabled === true;
  const base = () => stepOrigin(null, sent.current, valueRef.current);
  const cur = () => stepOrigin(pending.current, sent.current, valueRef.current);
  const emit = (v: number) => {
    if (off() || !Number.isFinite(v) || v === base()) return;
    sent.current = v;
    props.current.onChange(v);
  };
  /** すぐ反映（キー・クリック・数値入力） */
  const now = (v: number) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    pending.current = null;
    emit(v);
  };
  /** 1 フレーム 1 回（スクラブ・ホイール）。連続の変更なので舞台の補間を切る（§6 の `.live`。dispatch より先に） */
  const queue = (v: number) => {
    pending.current = v;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next !== null) {
        livePulse();
        emit(next);
      }
    });
  };
  const move = (from: number, n: number) => {
    const c = props.current;
    return stepperMove(c.spec, from, n, c.keepFraction === true);
  };

  const stopRepeat = () => {
    const r = repeat.current;
    if (r) cancelAnimationFrame(r.frame);
    repeat.current = null;
  };
  const endScrub = () => {
    const s = scrub.current;
    if (s) clearTimeout(s.timer);
    scrub.current = null;
  };

  useEffect(() => {
    const el = valRef.current;
    const onWheel = (e: WheelEvent) => {
      const c = props.current;
      if (!c.gestures || off() || editingRef.current) return;
      const n = wheelStep(e.deltaY);
      if (n === 0) return;
      e.preventDefault();
      queue(move(cur(), n));
    };
    el?.addEventListener('wheel', onWheel, { passive: false });
    const onUp = () => stopRepeat();
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      el?.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(frame.current);
      stopRepeat();
      endScrub();
    };
  }, []);

  useEffect(() => {
    if (editing === null) return;
    const el = inputRef.current;
    if (el && document.activeElement !== el) {
      el.focus();
      el.select();
    }
  }, [editing !== null]);

  const openEdit = () => {
    const c = props.current;
    if (!c.edit || off()) return;
    endScrub();
    stopRepeat();
    c.edit.onError(null);
    opened.current = c.edit.text(base());
    setEditing(opened.current);
  };
  const closeEdit = (refocus: boolean) => {
    setEditing(null);
    props.current.edit?.onError(null);
    if (refocus) requestAnimationFrame(() => valRef.current?.focus());
  };
  /** 確定: 開いたときから変わっていなければ何もしないで閉じる、正しければ反映して閉じる。正しくなければ false */
  const commitEdit = (text: string, refocus: boolean): boolean => {
    const c = props.current;
    if (!c.edit) return false;
    const o = editOutcome(opened.current, text, c.edit.parse);
    if (o.type === 'invalid') {
      c.edit.onError(o.message);
      return false;
    }
    if (o.type === 'set') {
      now(o.value);
      c.edit.onCommit?.(o.value);
    }
    closeEdit(refocus);
    return true;
  };
  /** 入力中の検査（開いたときのままなら正しいとみなす） */
  const invalidOf = (text: string): string | null => {
    const c = props.current;
    if (!c.edit) return null;
    const o = editOutcome(opened.current, text, c.edit.parse);
    return o.type === 'invalid' ? o.message : null;
  };

  /**
   * ± の押下（gestures）: 1 段（Shift で 10）+ 押し続けると連続。タッチは最初の段を離したとき（release）か連続の
   * 始まりまで遅らせる（± の上から縦にスワイプしてシートをスクロールしたとき = pointercancel で値を動かさない。S-1）
   */
  const press = (dir: number, e: PointerEvent) => {
    if (off() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    stopRepeat();
    const firstN = dir * clickSteps(e.shiftKey);
    const touch = e.pointerType !== 'mouse';
    if (!touch) {
      const before = cur();
      const first = move(before, firstN);
      now(first);
      if (first === before) return;
    }
    const r = { dir, t0: performance.now(), done: 1, frame: 0, firstN: touch ? firstN : 0 };
    const tick = () => {
      if (repeat.current !== r) return;
      const total = repeatSteps(performance.now() - r.t0);
      if (total > r.done) {
        const from = cur();
        // 遅らせた最初の段は連続の始まりに足す
        const next = move(from, dir * (total - r.done) + r.firstN);
        r.firstN = 0;
        r.done = total;
        if (next === from) {
          stopRepeat();
          return;
        }
        // 長押しの連続（2 段目から）は連続の変更（§6 の `.live`）。最初の 1 段は離散のまま補間する
        livePulse();
        emit(next);
      }
      r.frame = requestAnimationFrame(tick);
    };
    repeat.current = r;
    r.frame = requestAnimationFrame(tick);
  };
  /** タッチで離したとき: 連続が始まる前なら遅らせた最初の段を入れる */
  const release = () => {
    const r = repeat.current;
    if (r && r.firstN !== 0) now(move(cur(), r.firstN));
    stopRepeat();
  };

  const g = p.gestures === true;
  const disabled = p.disabled === true;
  const text = p.format(value);
  const err = editing !== null && invalidOf(editing) !== null;
  const btn = (dir: -1 | 1) => ({
    disabled: disabled || (dir < 0 ? value <= spec.min : value >= spec.max),
    onClick: (e: MouseEvent) => {
      if (!g) {
        const v = stepBy(spec, value, dir);
        if (!disabled && v !== value) p.onChange(v);
        return;
      }
      // ポインタの押下は pointerdown で済んでいる。キーボード（detail = 0）だけここで
      if (e.detail === 0) now(move(cur(), dir * clickSteps(e.shiftKey)));
    },
    ...(g && {
      onPointerDown: (e: PointerEvent) => press(dir, e),
      onPointerUp: release,
      onPointerCancel: stopRepeat,
      onPointerLeave: stopRepeat,
      onContextMenu: (e: Event) => e.preventDefault(),
    }),
  });
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と flex の癖があるので div + role="group"
    <div
      class={!disabled && isHot(spec, value) ? 'stepper hot' : 'stepper'}
      role="group"
      aria-label={p.label}
      data-name={p.name}
      data-gestures={g ? '' : undefined}
      aria-disabled={disabled ? 'true' : undefined}
    >
      <button type="button" aria-label={`${p.label}を減らす`} {...btn(-1)}>
        −
      </button>
      <div
        class="val"
        ref={valRef}
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
        aria-label={p.label}
        aria-valuenow={value}
        aria-valuemin={Math.min(spec.min, value)}
        aria-valuemax={Math.max(spec.max, value)}
        aria-valuetext={p.sub ? `${text} ${p.sub}` : text}
        aria-disabled={disabled ? 'true' : undefined}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || disabled) return;
          if (!g) {
            const n = stepKey(e.key);
            if (n === 0) return;
            e.preventDefault();
            const v = stepBy(spec, value, n);
            if (v !== value) p.onChange(v);
            return;
          }
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key === 'Enter' && p.edit) {
            e.preventDefault();
            openEdit();
            return;
          }
          const k = stepperKey(e.key, e.shiftKey);
          if (k === null) return;
          e.preventDefault();
          now('n' in k ? move(cur(), k.n) : stepperJump(spec, k.to, cur()));
        }}
        onPointerDown={
          g
            ? (e) => {
                if (disabled || editing !== null || !e.isPrimary) return;
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                endScrub();
                const el = e.currentTarget;
                const s = {
                  id: e.pointerId,
                  x0: e.clientX,
                  y0: e.clientY,
                  applied: 0,
                  moved: false,
                  timer: 0,
                };
                if (e.pointerType !== 'mouse' && p.edit) {
                  s.timer = window.setTimeout(() => {
                    if (scrub.current === s && !s.moved) openEdit();
                  }, EDIT_HOLD_MS);
                }
                scrub.current = s;
                try {
                  el.setPointerCapture(e.pointerId);
                } catch {
                  // capture できない環境でも操作は続ける
                }
              }
            : undefined
        }
        onPointerMove={
          g
            ? (e) => {
                const s = scrub.current;
                if (!s || s.id !== e.pointerId) return;
                const dx = e.clientX - s.x0;
                if (!s.moved && Math.hypot(dx, e.clientY - s.y0) >= EDIT_MOVE_PX) {
                  s.moved = true;
                  clearTimeout(s.timer);
                }
                const total = scrubSteps(dx);
                if (total === s.applied) return;
                const n = total - s.applied;
                s.applied = total;
                queue(move(cur(), n));
              }
            : undefined
        }
        onPointerUp={g ? endScrub : undefined}
        onPointerCancel={g ? endScrub : undefined}
        onLostPointerCapture={g ? endScrub : undefined}
        onDblClick={
          g && p.edit
            ? (e) => {
                e.preventDefault();
                openEdit();
              }
            : undefined
        }
        onContextMenu={g ? (e) => e.preventDefault() : undefined}
      >
        {editing !== null ? (
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            aria-label={`${p.label}の値`}
            aria-invalid={err ? 'true' : 'false'}
            value={editing}
            onInput={(e) => {
              const t = e.currentTarget.value;
              setEditing(t);
              p.edit?.onError(invalidOf(t));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const t = e.currentTarget.value;
                // 正しくなければ開いたまま（文言は commitEdit が出す）
                commitEdit(t, true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeEdit(true);
              }
            }}
            onBlur={(e) => {
              if (!editingRef.current) return;
              if (!commitEdit(e.currentTarget.value, false)) closeEdit(false);
            }}
          />
        ) : (
          <>
            <b>{text}</b>
            {p.sub !== undefined && <small>{p.sub}</small>}
          </>
        )}
      </div>
      <button type="button" aria-label={`${p.label}を増やす`} {...btn(1)}>
        +
      </button>
    </div>
  );
}
