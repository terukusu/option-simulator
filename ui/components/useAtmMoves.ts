/**
 * 追証マップの過去の点（#152。/api/atm_daily の日次の値から作る 2 営業日の動き）の読み込み（DOM を持たない常駐の
 * フック。NextApp が持つ = パネルを閉じても残る・保存しない）。
 *
 * - active（指標のパネルが見えていて資金・足がある。#176 で開く前に先読み）が初めて true になったときに 1 回だけ読む
 *   （セッションで 1 回）。失敗したら [再試行]（retry）でだけ読み直す。トップバーの [最新] では読み直さない
 * - 2 営業日の組（data/atmDaily.ts の atmMoves）は読めた値と休業日（nonTradingDays）が変わったときだけ作る
 * - 読めた値（daily）は過去の急落の再生（#307）の道筋にも使う（読み込みは 1 回のまま）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type AtmDailyData, type AtmMove, atmMoves, loadAtmDaily } from '../../data';
import type { Holidays } from '../../model';
import type { HoldMovesStatus } from '../view/holdMap';

export interface AtmMovesCtl {
  status: HoldMovesStatus;
  moves: readonly AtmMove[];
  /** 読めた日次の値（#307 の再生。読めていなければ null） */
  daily: AtmDailyData | null;
  retry: () => void;
}

const NONE: readonly AtmMove[] = [];

/** endpoint は同一オリジンの相対 URL（本番は /api/atm_daily。dev の合成の板・ファイルでは /fixtures/atm_daily） */
export function useAtmMoves(
  active: boolean,
  endpoint: string,
  nonTradingDays: Holidays,
): AtmMovesCtl {
  const [load, setLoad] = useState<{ status: HoldMovesStatus; data: AtmDailyData | null }>({
    status: 'idle',
    data: null,
  });
  const statusRef = useRef<HoldMovesStatus>('idle');
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const ac = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    ac.current?.abort();
    const c = new AbortController();
    ac.current = c;
    statusRef.current = 'loading';
    setLoad((s) => ({ ...s, status: 'loading' }));
    loadAtmDaily({ endpoint: endpointRef.current, signal: c.signal }).then(
      (data) => {
        if (ac.current !== c) return;
        ac.current = null;
        statusRef.current = 'ok';
        setLoad({ status: 'ok', data });
      },
      (e: unknown) => {
        if (ac.current !== c) return;
        ac.current = null;
        if (e instanceof Error && e.name === 'AbortError') return;
        statusRef.current = 'failed';
        setLoad((s) => ({ ...s, status: 'failed' }));
      },
    );
  }, []);

  useEffect(() => {
    if (active && statusRef.current === 'idle') start();
  }, [active, start]);
  useEffect(
    () => () => {
      ac.current?.abort();
      ac.current = null;
    },
    [],
  );

  const retry = useCallback(() => {
    if (statusRef.current === 'failed') start();
  }, [start]);
  const { data } = load;
  const moves = useMemo(
    () => (data ? atmMoves(data.days, nonTradingDays) : NONE),
    [data, nonTradingDays],
  );
  return useMemo(
    () => ({ status: load.status, moves, daily: data, retry }),
    [load.status, moves, data, retry],
  );
}
