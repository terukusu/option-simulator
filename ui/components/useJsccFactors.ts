/**
 * 当て直しの r・g（`/api/jscc_factors`。#387・docs/design.md 5.10）の読み込みの状態（DOM・CSS を持たないフック）。
 * 規則は今の JSCC（useJsccScenarios。#382）と同じ:
 *
 * - 読む契機は 基準日・限月の集合・板の読み直し（reload）が変わったときと、メモリに無い（LRU で追い出された）とき。
 *   自動のポーリングはしない。板の読み直しでは not_ready・失敗が期限（JSCC_RETRY_MS）を過ぎていれば読み直す。ok は
 *   読み直さない
 * - 結果はモジュールのメモリ（タブ・保有の一覧で共有。保存しない）に (エンドポイント, 日, 限月) で LRU
 * - 返す値: 基準日・限月が無い → null（入力なし = 概算）。読み込み中は { status: 'unavailable', reason: 'loading' }
 */

import { useEffect, useState } from 'preact/hooks';
import { JSCC_RETRY_MS, type JsccFactorsInput, loadJsccFactors } from '../../data';

/** 応答をメモリに持つ件数 */
export const JSCC_FACTORS_MEMO_SIZE = 8;

interface MemoEntry {
  input: JsccFactorsInput;
  until: number;
}

const memo = new Map<string, MemoEntry>();
const inflight = new Map<string, Promise<void>>();

function fresh(key: string, now: number): boolean {
  const e = memo.get(key);
  if (!e) return false;
  memo.delete(key);
  memo.set(key, e);
  return now < e.until;
}

function store(key: string, input: JsccFactorsInput, now: number): void {
  memo.delete(key);
  memo.set(key, {
    input,
    until: input.status === 'ok' ? Number.POSITIVE_INFINITY : now + JSCC_RETRY_MS,
  });
  while (memo.size > JSCC_FACTORS_MEMO_SIZE) {
    memo.delete(memo.keys().next().value as string);
  }
}

/** テスト用: メモリを空にする */
export function clearJsccFactorsMemo(): void {
  memo.clear();
  inflight.clear();
}

const LOADING: JsccFactorsInput = { status: 'unavailable', reason: 'loading' };

export function useJsccFactors(
  baseDate: string | null,
  periods: readonly string[],
  endpoint: string,
  reload: number | null = null,
): JsccFactorsInput | null {
  const text = periods.join(',');
  const key = baseDate !== null && text !== '' ? `${endpoint}|${baseDate}|${text}` : null;
  const [, setDone] = useState(0);
  const missing = key !== null && !memo.has(key) && !inflight.has(key);
  useEffect(() => {
    if (key === null || baseDate === null) return;
    if (fresh(key, Date.now())) return;
    let alive = true;
    let p = inflight.get(key);
    if (!p) {
      p = loadJsccFactors(baseDate, text.split(','), { endpoint })
        .then(
          (r) =>
            store(
              key,
              r.status === 'ok'
                ? { status: 'ok', data: r.data }
                : { status: 'unavailable', reason: r.reason },
              Date.now(),
            ),
          () => store(key, { status: 'unavailable', reason: 'error' }, Date.now()),
        )
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    void p.then(() => {
      if (alive) setDone((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [key, baseDate, text, endpoint, reload, missing]);
  if (key === null) return null;
  return memo.get(key)?.input ?? LOADING;
}
