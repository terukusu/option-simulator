/**
 * 過去の急落の再生（#307。設計 docs/design.md 5.14）の画面側の計算の単位と表示モデル（純関数。Preact・DOM に
 * 依存しない）。
 *
 * - 入力（replayInput）は 板の基礎（pnlBoard）・IV の動き方・パラメータ・資金・休業日だけ（シナリオの d・ΔX・Δσ・β・Δs・
 *   パン・拡大では変わらない = 作り直さない。再生はシナリオを使わず、動き方だけをシナリオの値にする）
 * - 道筋（data/replay.ts の replayPath）の日ごとに model/replay.ts の replayDay。戻らなかった道筋の底までは実際の結果を
 *   使い回す。最も遠い足の SQ を過ぎた日で切る（ended）
 * - 表示: 出来事の 1 行・要約 2 行（実際 / 戻らなかった）・日ごとの表の行・注記。文字列だけ（色はクラス名）
 * - 部品は ui/next/regions/Replay.tsx。計算の時機は ui/components/useReplay.ts
 */

import type { ReplayBuild, ReplayDay, ReplayEvent } from '../../data/replay';
import {
  type Holidays,
  type IvDynamics,
  type MarginParams,
  premiumSummary,
  type ReplayCalc,
  type ReplayDayResult,
  type ReplaySummary,
  replayDay,
  replaySummary,
} from '../../model';
import { fmtNum, fmtSigned } from './format';
import {
  HOLD_MAP_FAILED,
  HOLD_MAP_LOADING,
  HOLD_MAP_NO_CAPITAL,
  type HoldMovesStatus,
} from './holdMap';
import { AMOUNT_UNIT_LABEL, type AmountUnit, fmtAmount } from './metrics';
import { MARGIN_CALL_MARK } from './metricsPanel';
import type { PnlBase } from './pnlChart';

export const REPLAY_TITLE = '過去の急落の再生';
export const REPLAY_NO_LEGS = '足を入れると再生する';
export const REPLAY_NO_CAPITAL = HOLD_MAP_NO_CAPITAL;
export const REPLAY_LOADING = HOLD_MAP_LOADING;
export const REPLAY_FAILED = HOLD_MAP_FAILED;
export const REPLAY_COMPUTING = '計算中…';
export const REPLAY_NO_DATA = 'この期間の値が無い（まだ読めていない・データの範囲の外）';
export const REPLAY_BROKEN = 'この期間は値がつながらない（限月の切り替わりをまたいで値が欠けた）';
export const REPLAY_EVENT_LABEL = '出来事';
export const REPLAY_PATHS = [
  { value: 'actual', text: '実際' },
  { value: 'noRecovery', text: '戻らなかった' },
] as const;
export type ReplayPathKind = (typeof REPLAY_PATHS)[number]['value'];
/** 戻らなかった道筋を作れない（始まりが底）ときの要約・表の代わりの文 */
export const REPLAY_NO_RECOVERY_NONE = '—（始まりが底の区間なので、戻らなかった道筋は作れない）';
/** 欠けた日の印と注 */
export const REPLAY_GAP_MARK = '*';
export const REPLAY_GAP_NOTE = '* = 前の取引日の値が無い（その日の分の動きもまとめた）';
export const REPLAY_CONT = '続落';
/** ⓘ の説明（何を見るか） */
export const REPLAY_CAPTION =
  '過去の急落の道筋（日中の引けの原資産と ATM の IV）を、今のポジションに 1 日ずつ当てた余力と損益。「実際」はその後に戻った道筋、「戻らなかった」は底からもう一度同じだけ下げた道筋（IV は底の水準のまま）。日 = 始まりからの当時の取引日の数（経過日数は今日からその数の営業日）';
/** ⓘ の注記（当て方・前提） */
export const REPLAY_METHOD_NOTE =
  'スマイルの形は今のまま（行使価格ごとの IV は今のスマイル + 平行の上乗せ。追証マップと同じ）で、水準だけを当時の ATM の IV の倍率（足の残存に合わせた 1・2 限月の ATM の IV の比）で当てる。β・Δσ・Δs は使わず、IV の動き方はシナリオの値。追証になった日の後も入金して持ち続けた前提（余力は資金 + 損益で計り直すだけ）。日中の引けどうしで、夜間・日中の途中の動きは入らない。最も遠い足の SQ を過ぎた日から先は出さない';
/** ⓘ の注記（データの偏り） */
export const REPLAY_BIAS_NOTE =
  '2018-10 以降の 8% を超える下げ（日中の引け・20 営業日以内）は、途中の 2026-10 を除く 17 回すべてが底から 4〜36 営業日で半値まで戻っている。このデータは「待てば戻る」側に偏っているので、戻らなかった場合も並べる';

/** 計算の 1 切れの上限（ms。日が単位 = 日の途中では切らない。追証マップと同じ） */
export const REPLAY_SLICE_MS = 8;

export interface ReplayInput {
  base: PnlBase;
  ivDynamics: IvDynamics;
  params: MarginParams;
  capital: number;
  holidays: Holidays;
}

/** 再生の入力（板・足が無い・資金が未設定なら null） */
export function replayInput(
  base: PnlBase | null,
  ivDynamics: IvDynamics,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
): ReplayInput | null {
  if (!base || capital === null || base.legs.length === 0) return null;
  return { base, ivDynamics, params, capital, holidays };
}

/** 日ごとの計算の入力（追証マップの holdMapCalcOf と同じ求め方の premium・休業日） */
export function replayCalcOf(input: ReplayInput): ReplayCalc {
  const { base, ivDynamics, params, capital, holidays } = input;
  const { legs, ctx, settings, maxDays } = base;
  return {
    legs,
    ctx,
    settings,
    params,
    dynamics: ivDynamics,
    capital,
    premium: premiumSummary(legs, settings),
    holidays,
    maxDays,
  };
}

/** 道筋（ok のとき）と計算の結果 */
export type ReplayPathOk = Extract<ReplayBuild, { status: 'ok' }>;

/** 1 日の結果（道筋の日 + 余力・損益） */
export interface ReplayRow {
  day: ReplayDay;
  res: ReplayDayResult;
}

export interface ReplayResult {
  input: ReplayInput;
  path: ReplayPathOk;
  /** 実際の道筋の結果（最も遠い SQ で切ったら、その前の日まで） */
  actual: ReplayRow[];
  /** 戻らなかった道筋の結果（作れなければ null） */
  noRecovery: ReplayRow[] | null;
  /** 最も遠い SQ で切った日（当時の取引日の数。切っていなければ null） */
  actualEnd: number | null;
  noRecoveryEnd: number | null;
}

/**
 * 計算する日の並び（実際の全日 → 戻らなかった道筋の続落の日）。底までの戻らなかった道筋は実際の結果を使い回す
 */
export function replayJobs(path: ReplayPathOk): Array<{ kind: ReplayPathKind; day: ReplayDay }> {
  const out: Array<{ kind: ReplayPathKind; day: ReplayDay }> = path.actual.map((day) => ({
    kind: 'actual',
    day,
  }));
  if (path.noRecovery) {
    for (const day of path.noRecovery.slice(path.bottom + 1)) out.push({ kind: 'noRecovery', day });
  }
  return out;
}

/** 計算の途中の状態（useReplay が日ごとに進める。テスト・計測は replayResultOf で一度に） */
export interface ReplayWork {
  calc: ReplayCalc;
  jobs: Array<{ kind: ReplayPathKind; day: ReplayDay }>;
  next: number;
  actual: ReplayRow[];
  cont: ReplayRow[];
  actualEnd: number | null;
  noRecoveryEnd: number | null;
}

export function replayWork(input: ReplayInput, path: ReplayPathOk): ReplayWork {
  return {
    calc: replayCalcOf(input),
    jobs: replayJobs(path),
    next: 0,
    actual: [],
    cont: [],
    actualEnd: null,
    noRecoveryEnd: null,
  };
}

/** 1 日だけ進める（終わったら false） */
export function replayStep(w: ReplayWork, path: ReplayPathOk): boolean {
  const job = w.jobs[w.next];
  if (!job) return false;
  w.next++;
  const ended = job.kind === 'actual' ? w.actualEnd !== null : w.noRecoveryEnd !== null;
  if (ended) return w.next < w.jobs.length;
  const day0 = path.actual[0] as ReplayDay;
  const res = replayDay(w.calc, job.day, day0);
  if (res.ended) {
    if (job.kind === 'actual') w.actualEnd = job.day.k;
    else w.noRecoveryEnd = job.day.k;
  } else if (job.kind === 'actual') w.actual.push({ day: job.day, res });
  else w.cont.push({ day: job.day, res });
  // 実際の道筋が底の前で切れたら、戻らなかった道筋も同じ日で切れる（底までは同じ行）
  return w.next < w.jobs.length;
}

/** 計算の結果を束ねる */
export function replayResultFrom(
  input: ReplayInput,
  path: ReplayPathOk,
  w: ReplayWork,
): ReplayResult {
  let noRecovery: ReplayRow[] | null = null;
  let noRecoveryEnd = w.noRecoveryEnd;
  if (path.noRecovery) {
    const head = w.actual.slice(0, path.bottom + 1);
    if (head.length < path.bottom + 1) {
      // 底の前で最も遠い SQ を過ぎた = 戻らなかった道筋も同じ日で切れる
      noRecovery = head;
      noRecoveryEnd = w.actualEnd;
    } else noRecovery = [...head, ...w.cont];
  }
  return {
    input,
    path,
    actual: w.actual,
    noRecovery,
    actualEnd: w.actualEnd,
    noRecoveryEnd,
  };
}

/** 全部を一度に（テスト・計測用。画面は useReplay が日ごとに回す） */
export function replayResultOf(input: ReplayInput, path: ReplayPathOk): ReplayResult {
  const w = replayWork(input, path);
  while (replayStep(w, path)) {
    // 日ごとに進める
  }
  return replayResultFrom(input, path, w);
}

// ---- 表示モデル

/** M/D（先頭の 0 を落とす） */
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 状態の文（中身の上に出す。無ければ main = null） */
export function replayStatusText(o: {
  noLegs: boolean;
  noCapital: boolean;
  loadStatus: HoldMovesStatus;
  build: ReplayBuild | null;
}): { main: string | null; retry: boolean; wait: boolean } {
  if (o.noLegs) return { main: REPLAY_NO_LEGS, retry: false, wait: false };
  if (o.noCapital) return { main: REPLAY_NO_CAPITAL, retry: false, wait: false };
  if (o.loadStatus === 'failed') return { main: REPLAY_FAILED, retry: true, wait: false };
  if (o.loadStatus !== 'ok' || !o.build) return { main: REPLAY_LOADING, retry: false, wait: true };
  if (o.build.status === 'no_data') return { main: REPLAY_NO_DATA, retry: false, wait: false };
  if (o.build.status === 'broken')
    return { main: `${REPLAY_BROKEN}（${o.build.at}）`, retry: false, wait: false };
  return { main: null, retry: false, wait: false };
}

/**
 * 出来事の 1 行: `YYYY-MM-DD → MM-DD · 下げ −x.x%（底 M/D・n 営業日目）`。始まりが底なら
 * `YYYY-MM-DD → MM-DD · 始まりが底 · 終わり +x.x%`（値は読み込んだ値から求める）
 */
export function replayEventLine(ev: ReplayEvent, path: ReplayPathOk): string {
  const end = ev.end.slice(0, 4) === ev.start.slice(0, 4) ? ev.end.slice(5) : ev.end;
  const head = `${ev.start} → ${end}`;
  const b = path.actual[path.bottom] as ReplayDay;
  if (path.bottom === 0) {
    const last = path.actual[path.actual.length - 1] as ReplayDay;
    return `${head} · 始まりが底 · 終わり ${fmtSigned(last.u * 100, 1)}%`;
  }
  return `${head} · 下げ ${fmtSigned(b.u * 100, 1)}%（底 ${md(b.d as string)}・${b.k} 営業日目）`;
}

/** 半値の注記（始まりが底なら null） */
export function replayHalfNote(path: ReplayPathOk): string | null {
  if (path.bottom === 0) return null;
  const b = path.actual[path.bottom] as ReplayDay;
  if (path.half === null) return '期間の中では半値まで戻っていない';
  const h = path.actual[path.half] as ReplayDay;
  return `底から ${h.k - b.k} 営業日で半値まで戻った（当時 ${md(h.d as string)}）`;
}

/** 行の日の文字（当時の日付 / 続落） */
const dateOf = (day: ReplayDay) => (day.d === null ? REPLAY_CONT : md(day.d));

/** 要約の 1 行の中身（見出し `実際:` などは部品が付ける） */
export function replaySummaryText(
  rows: readonly ReplayRow[] | null,
  end: number | null,
  unit: AmountUnit,
  allowedLoss: number | null,
): string {
  if (rows === null) return REPLAY_NO_RECOVERY_NONE;
  if (rows.length === 0) return '—（最も遠い足の SQ を過ぎている）';
  const s: ReplaySummary = replaySummary(
    rows.map((r) => r.res),
    allowedLoss,
  );
  const at = (i: number) => rows[i]?.day as ReplayDay;
  const parts: string[] = [];
  if (s.firstCall !== null) {
    const d = at(s.firstCall);
    parts.push(`追証 ${d.k} 営業日目（${d.d === null ? REPLAY_CONT : `当時 ${md(d.d)}`}）`);
    if (s.minRoom) parts.push(`最も足りない ${fmtAmount(s.minRoom.value, unit, true)}`);
  } else {
    parts.push(`追証なし（最小の余力 ${fmtAmount(s.minRoom?.value ?? Number.NaN, unit)}）`);
  }
  if (s.worstPnl) {
    parts.push(
      `最悪 ${fmtAmount(s.worstPnl.value, unit, true)}（${dateOf(at(s.worstPnl.index))}）`,
    );
  }
  parts.push(`終わり ${fmtAmount(s.endPnl, unit, true)}`);
  if (allowedLoss !== null) {
    parts.push(
      s.firstLoss === null ? '許容損失超なし' : `許容損失超 ${at(s.firstLoss).k} 営業日目`,
    );
  }
  if (end !== null) parts.push(`SQ で ${end} 営業日目に終わり`);
  return `${parts.join(' · ')}（${AMOUNT_UNIT_LABEL[unit]}）`;
}

export interface ReplayTableRow {
  key: string;
  /** 当時の取引日の数（欠けた日をまたいだら印つき） */
  k: string;
  /** 当時の日付 M/D か「続落」 */
  date: string;
  /** 原資産の累積の変化 % */
  u: string;
  /** ATM の IV の倍率 */
  c: string;
  pnl: string;
  room: string;
  call: boolean;
  /** 余力の色（追証 = loss。テールの証拠金の表と同じ） */
  tone: 'loss' | null;
  cont: boolean;
}

/** 日ごとの表の行 */
export function replayTableRows(rows: readonly ReplayRow[], unit: AmountUnit): ReplayTableRow[] {
  return rows.map(({ day, res }) => {
    const call = Number.isFinite(res.room) && res.room < 0;
    return {
      key: `${day.cont ? 'c' : 'a'}${day.k}`,
      k: `${day.k}${day.gap > 0 ? REPLAY_GAP_MARK : ''}`,
      date: dateOf(day),
      u: `${fmtSigned(day.u * 100, 1)}%`,
      c: `×${fmtNum(res.c, 2)}`,
      pnl: fmtAmount(res.pnl, unit, true),
      room: fmtAmount(res.room, unit),
      call,
      tone: call ? 'loss' : null,
      cont: day.cont,
    };
  });
}

/** 表の下の注（欠けた日・SQ で切った日。無ければ空） */
export function replayTableNotes(rows: readonly ReplayRow[], end: number | null): string[] {
  const out: string[] = [];
  if (rows.some((r) => r.day.gap > 0)) out.push(REPLAY_GAP_NOTE);
  if (end !== null) out.push(`最も遠い足の SQ（${end} 営業日目）を過ぎたので、ここで終わり`);
  return out;
}

/**
 * ⓘ の水準の注記: 当時の始まりの iv30 と今の 30 日の IV（今が無ければ当時だけ）、iv30 の比に戻した日の数
 */
export function replayLevelNote(path: ReplayPathOk, ivNow: number | null): string {
  const iv0 = (path.actual[0] as ReplayDay).iv;
  const now =
    ivNow !== null && Number.isFinite(ivNow) ? `、今の 30 日の IV は ${fmtNum(ivNow, 1)}%` : '';
  const fb =
    path.iv30Days > 0
      ? `。1・2 限月の ATM の IV から倍率を作れない ${path.iv30Days} 日は 30 日の IV（iv30）の比で当てた`
      : '';
  return `当時の始まりの 30 日の IV は ${fmtNum(iv0, 1)}%${now}。倍率で当てるので、今の IV が当時より高い / 低いと上がり幅（pt）も大きく / 小さくなる${fb}`;
}

/** 表示する出来事の選択肢（Seg・select 用） */
export function replayEventOptions(events: readonly ReplayEvent[]) {
  return events.map((e) => ({ value: e.id, text: e.name }));
}

/** 追証の印（表の余力の列） */
export const REPLAY_CALL_MARK = MARGIN_CALL_MARK;
