/**
 * 今の必要証拠金の JSCC の VaR パラメータ（`/api/jscc_scenarios`。#382）の読み込みの状態（DOM・CSS を持たないフック）。
 *
 * - 読む契機は 基準日（板の時刻から data/jscc.ts の jsccBaseDate）・銘柄の集合（足のキー）・板の読み直し（reload =
 *   板の時刻）が変わったときと、メモリに無い（LRU で追い出された）とき。自動のポーリングはしない。板の読み直しでは、
 *   not_ready・失敗が期限（JSCC_RETRY_MS）を過ぎていれば読み直す（17:00〜18:30 に not_ready になっても、取り込みの後に
 *   [最新] で板を読めば JSCC の計算に戻る）。ok は読み直さない（基準日のデータは 1 日 1 回）
 * - 結果はモジュールのメモリ（タブ・保有の一覧のダイアログで共有。保存しない）に (エンドポイント, 日, 銘柄) で持つ。
 *   LRU で JSCC_MEMO_SIZE 件、not_ready・失敗は JSCC_RETRY_MS の間は同じ (日, 銘柄) で聞き直さない（期限の後も
 *   読み直すまでは前の結果を出す）
 * - 返す値: 基準日が無い（板が無い・データの始まりより前）・銘柄が無い → null（JSCC の入力なし = 概算。足が無ければ 0）。
 *   読み込み中は { status: 'unavailable', reason: 'loading' }
 */

import { useEffect, useState } from 'preact/hooks';
import { JSCC_RETRY_MS, type JsccInput, loadJsccScenarios } from '../../data';

/** ok の応答をメモリに持つ件数 */
export const JSCC_MEMO_SIZE = 16;

interface MemoEntry {
  input: JsccInput;
  /** 失敗・not_ready の期限（ms。ok は Infinity） */
  until: number;
}

const memo = new Map<string, MemoEntry>();
const inflight = new Map<string, Promise<void>>();

/** 期限内の結果か（最近使った順に並べ直す。期限切れは消さない = 読み直すまで前の結果を出す） */
function fresh(key: string, now: number): boolean {
  const e = memo.get(key);
  if (!e) return false;
  memo.delete(key);
  memo.set(key, e); // 最近使った順
  return now < e.until;
}

function store(key: string, input: JsccInput, now: number): void {
  memo.delete(key);
  memo.set(key, {
    input,
    until: input.status === 'ok' ? Number.POSITIVE_INFINITY : now + JSCC_RETRY_MS,
  });
  while (memo.size > JSCC_MEMO_SIZE) {
    const oldest = memo.keys().next().value as string;
    memo.delete(oldest);
  }
}

/** テスト用: メモリを空にする */
export function clearJsccMemo(): void {
  memo.clear();
  inflight.clear();
}

const LOADING: JsccInput = { status: 'unavailable', reason: 'loading' };

/**
 * baseDate = 基準日（無ければ null）、keys = 要求する銘柄（昇順・重複なし。data/jscc.ts の jsccRequestKeys）、
 * endpoint = 本番は /api/jscc_scenarios（dev の合成の板・ファイルは /fixtures/jscc_scenarios）
 */
export function useJsccScenarios(
  baseDate: string | null,
  keys: readonly string[],
  endpoint: string,
  /** 板の読み直しの印（板の時刻など）。変わったら期限切れの not_ready・失敗を読み直す */
  reload: number | null = null,
): JsccInput | null {
  const keysText = keys.join(',');
  const key = baseDate !== null && keysText !== '' ? `${endpoint}|${baseDate}|${keysText}` : null;
  // 読み終わりで描き直すためだけの状態（値はモジュールのメモリから読む）
  const [, setDone] = useState(0);
  // メモリに無い（LRU で追い出された）ときも読む（描画のたびに見る）
  const missing = key !== null && !memo.has(key) && !inflight.has(key);
  useEffect(() => {
    if (key === null || baseDate === null) return;
    if (fresh(key, Date.now())) return;
    let alive = true;
    let p = inflight.get(key);
    if (!p) {
      p = loadJsccScenarios(baseDate, keysText.split(','), { endpoint })
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
      if (!alive) return;
      setDone((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [key, baseDate, keysText, endpoint, reload, missing]);
  if (key === null) return null;
  // 期限の過ぎた失敗も、読み直すまではそのまま出す
  return memo.get(key)?.input ?? LOADING;
}
