import { useEffect, useState } from 'preact/hooks';
import type { Domain } from '../../chart/scale';
import { type Action, parsePremiumN, parseYRange } from '../../state';
import type { PnlYMode, PnlYSettings } from '../../view/pnlChart';
import { Seg } from './Seg';

const Y_MODES = [
  { value: 'auto', text: '自動' },
  { value: 'premium', text: '±N 倍' },
  { value: 'manual', text: '手動' },
] as const;

const manualText = (m: Domain | null, i: 0 | 1) => (m ? String(m[i]) : '');

/**
 * 損益グラフの縦軸の欄（#87 (C)。舞台の ⋯。#275 まで設定のダイアログと共有していた）: Seg（自動 / ±N 倍 / 手動）+ N の欄 /
 * 下限・上限の欄 + 検証の文（role="alert"）。DOM は #82 の舞台の ⋯ の中身のまま（.row / label.row / .field-error）。
 *
 * - current: 手動に切り替えたときの「いま見ている範囲」（舞台の縦軸）。決まらなければ null
 * - 外で N / 手動の範囲が変わったら、欄の文字が今の値を表していなければ値に戻して検証の文を消す
 *   （舞台の ⋯ は常に描かれているので古い文字を残さない。旧画面の指標の手数料の欄と同じ規則）
 */
export function YAxisFields(p: {
  pnlY: PnlYSettings;
  current: () => Domain | null;
  dispatch: (a: Action) => void;
}) {
  const { pnlY, dispatch } = p;
  const [loText, setLoText] = useState(() => manualText(pnlY.manual, 0));
  const [hiText, setHiText] = useState(() => manualText(pnlY.manual, 1));
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [nText, setNText] = useState(String(pnlY.n));
  const [nError, setNError] = useState<string | null>(null);

  // 外の変更に追従（欄の文字が今の値を表していれば触らない = 入力中の欄を書き換えない）
  useEffect(() => {
    const r = parsePremiumN(nText);
    if (!(r.ok && r.value === pnlY.n)) {
      setNText(String(pnlY.n));
      setNError(null);
    }
  }, [pnlY.n]);
  const m = pnlY.manual;
  useEffect(() => {
    if (!m) return;
    const r = parseYRange(loText, hiText);
    if (!(r.ok && r.value[0] === m[0] && r.value[1] === m[1])) {
      setLoText(String(m[0]));
      setHiText(String(m[1]));
      setRangeError(null);
    }
  }, [m?.[0], m?.[1]]);

  const setMode = (mode: PnlYMode) => {
    if (mode === 'manual' && !pnlY.manual) {
      // 手動に切り替えたら、いま見ている範囲から始める（旧画面と同じ）
      const d = p.current();
      const cur: Domain | null = d ? [Math.round(d[0]), Math.round(d[1])] : null;
      setLoText(cur ? String(cur[0]) : '');
      setHiText(cur ? String(cur[1]) : '');
      setRangeError(null);
      dispatch({
        type: 'setPnlY',
        patch: { mode, manual: cur && cur[0] < cur[1] ? cur : null },
      });
      return;
    }
    if (mode === 'manual' && pnlY.manual) {
      setLoText(String(pnlY.manual[0]));
      setHiText(String(pnlY.manual[1]));
    }
    dispatch({ type: 'setPnlY', patch: { mode } });
  };
  const commitRange = (lo: string, hi: string) => {
    const r = parseYRange(lo, hi);
    if (r.ok) {
      setRangeError(null);
      dispatch({ type: 'setPnlY', patch: { manual: r.value } });
    } else setRangeError(r.message);
  };
  const onN = (text: string) => {
    setNText(text);
    const r = parsePremiumN(text);
    if (r.ok) {
      setNError(null);
      dispatch({ type: 'setPnlY', patch: { n: r.value } });
    } else setNError(r.message);
  };

  const errors = [
    pnlY.mode === 'manual' ? rangeError : null,
    pnlY.mode === 'premium' ? nError : null,
  ].filter((e): e is string => e !== null);

  return (
    <>
      <div class="row">
        <span class="lbl">縦軸</span>
        <Seg label="縦軸" value={pnlY.mode} options={Y_MODES} onChange={setMode} />
      </div>
      {pnlY.mode === 'premium' && (
        <label class="row">
          <span class="lbl">N</span>
          <input
            type="text"
            inputMode="decimal"
            size={5}
            value={nText}
            aria-invalid={nError !== null}
            onInput={(e) => onN(e.currentTarget.value)}
          />
        </label>
      )}
      {pnlY.mode === 'manual' && (
        <div class="row">
          <label>
            <span class="lbl">下限</span>
            <input
              type="text"
              inputMode="decimal"
              size={8}
              value={loText}
              aria-invalid={rangeError !== null}
              onInput={(e) => setLoText(e.currentTarget.value)}
              onChange={(e) => commitRange(e.currentTarget.value, hiText)}
            />
          </label>
          <label>
            <span class="lbl">上限</span>
            <input
              type="text"
              inputMode="decimal"
              size={8}
              value={hiText}
              aria-invalid={rangeError !== null}
              onInput={(e) => setHiText(e.currentTarget.value)}
              onChange={(e) => commitRange(loText, e.currentTarget.value)}
            />
          </label>
          <span class="lbl">円</span>
        </div>
      )}
      {errors.length > 0 && (
        <p class="field-error" role="alert">
          {errors.join(' / ')}
        </p>
      )}
    </>
  );
}
