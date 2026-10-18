/**
 * 市場ピル（#87。docs/ui-redesign.md §2.1・§3「板の読み込み・鮮度」・§9 `Header`・§11-11。純関数）。
 * 入力は headerModel の出力（呼び直さない・数を作り直さない。文字列を選んで並べるだけ）・表示中の限月の id・読み込みの状態。
 *
 * - 要約（ピル）: ● + `板 MM/DD HH:mm` + タグ（重い順）+ `F … · ATM … · 先物 …`。F・ATM は表示中の限月だけ（§11-11）、
 *   ATM は今の基準。F の ± は全文だけ。スマホは短縮形（`HH:mm` + 最も重い警告のタグ 1 つの短い形）
 * - 全文（ポップオーバー）: 旧 Header の全部 + 前提の ⓘ の文 + 表示中（loaderNote）+ 失敗の詳細
 */

import type { LoadErrorView } from '../state';
import type { HeaderModel, HeaderMonthView, ReferenceView } from './header';
import { boardNoticeText } from './notices';

export type PillState = 'loading' | 'failed' | 'ready' | 'none';

export type PillTagKey =
  | 'loading'
  | 'failed'
  | 'boardStale'
  | 'calendar'
  | 'noForward'
  | 'noAtm'
  | 'refStale'
  | 'fellBack'
  | 'futureProxy'
  | 'reason';

/** タグの重い順（読み込み中… は先頭） */
export const PILL_TAG_ORDER: readonly PillTagKey[] = [
  'loading',
  'failed',
  'boardStale',
  'calendar',
  'noForward',
  'noAtm',
  'refStale',
  'fellBack',
  'futureProxy',
  'reason',
];

export interface PillTag {
  key: PillTagKey;
  label: string;
  /** スマホの短縮形の文字（カレンダー期限切れ → 期限切れ。ほかは同じ） */
  short: string;
  /** 警告（● の警告色・短縮形の対象） */
  warn: boolean;
}

export interface PillLoad {
  loading: boolean;
  error: LoadErrorView | null;
  /** 失敗しても前の板を表示している旨（keptBoardNote。板が無ければ null） */
  kept: string | null;
  /** 表示中のデータ元（loaderNote。空なら出さない） */
  loaderNote: string;
}

/** 全文の 1 行（見出し・値・小さな注記・タグ） */
export interface PillRow {
  k: string;
  v: string;
  note: string | null;
  tags: { label: string; warn: boolean }[];
}

export interface PillRef {
  /** `A 先物` / `B 合成先物` */
  label: string;
  price: string;
  /** 時刻（`—` なら null） */
  time: string | null;
  tags: { label: string; warn: boolean }[];
  /** 今の基準 */
  active: boolean;
}

export interface PillMonth {
  id: string;
  /** 表示中の限月 */
  current: boolean;
  title: string;
  dates: string;
  forward: string;
  forwardKind: { label: string; warn: boolean };
  refs: PillRef[];
  atmLabel: string;
  atm: string;
  noAtm: boolean;
}

export interface PillFull {
  /** 板が無いときの知らせの文（boardNoticeText） */
  notice: { text: string; warn: boolean } | null;
  rows: PillRow[];
  reasonNote: string | null;
  months: PillMonth[];
  assumptions: { text: string; warn: boolean }[];
  /** 旧 Header の ⓘ「計算の前提」の文（板があるときだけ） */
  hint: string | null;
  loaderNote: string | null;
  error: { message: string; kept: string | null; errors: string[] } | null;
}

export interface MarketPillModel {
  state: PillState;
  /** ● を警告色に */
  warn: boolean;
  /** `板 10/13 21:31`（板が無ければ `読み込み中…` / `板を読めない` / `板なし`） */
  time: string;
  /** スマホの短縮形の時刻 `21:31`（板が無ければ time と同じ） */
  clock: string;
  /** 重い順 */
  tags: PillTag[];
  /** 最も重い警告のタグ（無ければ null） */
  shortTag: PillTag | null;
  /** 表示中の限月の F（± の前）・ATM（今の基準）・先物。限月の F / ATM が無ければ null（タグで出す） */
  values: { f: string | null; atm: string | null; future: string } | null;
  /** ボタンの aria-label（要約の全文） */
  summary: string;
  full: PillFull;
}

/** 旧画面のヘッダ（#91 で削除）の ⓘ「計算の前提」の文（JSX の行を空白 1 つでつないだもの） */
export const ASSUMPTION_HINT_TEXT =
  '金利は割引（e^−rT）とプット・コール・パリティに使う年率（価格への影響はおおむね 金利 × 残存期間。0.5% なら 1 か月で 0.05% 程度）。評価時刻は残存期間を数える起点で、指定日 d はここから数える。取引カレンダーは SQ 日・取引最終日の休業日の判定に使い、確定の範囲より先は休業日が漏れている可能性がある';

const BASIS_LABEL = { A: 'A ラージ先物（直近四半期）', B: 'B 合成先物（限月ごと）' } as const;

const SNAPSHOT_RE = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})$/;

/** `YYYY-MM-DD HH:mm` → `MM/DD HH:mm`（形が違えばそのまま。`—` も）。 */
export function pillDate(snapshot: string): string {
  const m = SNAPSHOT_RE.exec(snapshot);
  return m ? `${m[1]}/${m[2]} ${m[3]}` : snapshot;
}

/** `YYYY-MM-DD HH:mm` → `HH:mm`（形が違えばそのまま）。 */
export function pillClock(snapshot: string): string {
  const m = SNAPSHOT_RE.exec(snapshot);
  return m ? (m[3] ?? snapshot) : snapshot;
}

const tag = (key: PillTagKey, label: string, warn: boolean, short = label): PillTag => ({
  key,
  label,
  short,
  warn,
});

function currentMonth(header: HeaderModel, monthId: string | null): HeaderMonthView | undefined {
  return header.months.find((m) => m.id === monthId) ?? header.months[0];
}

function pillTags(header: HeaderModel | null, month: HeaderMonthView | undefined, load: PillLoad) {
  const tags: PillTag[] = [];
  // 板が無いときは時刻の場所の文（読み込み中… / 板を読めない）で出す（同じ語を重ねない）
  if (!header) return tags;
  if (load.loading) tags.push(tag('loading', '読み込み中…', false));
  if (load.error) tags.push(tag('failed', '読めない', true));
  if (header.boardStale) tags.push(tag('boardStale', '古い板', true));
  if (header.calendarWarning !== null) {
    tags.push(tag('calendar', 'カレンダー期限切れ', true, '期限切れ'));
  }
  if (month) {
    if (month.noForward) tags.push(tag('noForward', 'F なし', true));
    if (month.noAtm) tags.push(tag('noAtm', 'ATM なし', true));
    const ref = header.basis === 'A' ? month.refA : month.refB;
    if (ref.stale) tags.push(tag('refStale', '古い', true));
    if (ref.fellBack) tags.push(tag('fellBack', 'A で代用', false));
    if (month.forwardKind === 'future' || month.forwardKind === 'future_other_month') {
      tags.push(tag('futureProxy', '先物で代用', false));
    }
  }
  tags.push(tag('reason', header.reason, false));
  return tags;
}

function refView(r: ReferenceView, active: boolean): PillRef {
  const tags: { label: string; warn: boolean }[] = [];
  if (r.fellBack) tags.push({ label: 'A で代用', warn: false });
  if (r.stale) tags.push({ label: '古い', warn: true });
  return {
    label: r.basis === 'A' ? 'A 先物' : 'B 合成先物',
    price: r.price,
    time: r.time === '—' ? null : r.time,
    tags,
    active,
  };
}

function fullModel(header: HeaderModel | null, curId: string | null, load: PillLoad): PillFull {
  const loaderNote = load.loaderNote === '' ? null : load.loaderNote;
  const error = load.error
    ? { message: load.error.message, kept: load.kept, errors: [...load.error.errors] }
    : null;
  if (!header) {
    return {
      notice: boardNoticeText(false, load.loading, load.error, null),
      rows: [],
      reasonNote: null,
      months: [],
      assumptions: [],
      hint: null,
      loaderNote,
      error,
    };
  }
  const rows: PillRow[] = [
    {
      k: '板',
      v: header.snapshot,
      note: `（${header.delay}）`,
      tags: [
        { label: header.reason, warn: false },
        ...(header.boardStale ? [{ label: '古い板', warn: true }] : []),
      ],
    },
  ];
  if (header.fetched) {
    rows.push({
      k: '取得',
      v: header.fetched,
      note: header.loadedFrom ? `（${header.loadedFrom}）` : null,
      tags: [],
    });
  }
  if (header.source) rows.push({ k: 'データ元', v: header.source, note: null, tags: [] });
  rows.push(
    { k: '日経平均', v: header.spot.price, note: `（${header.spot.time}）`, tags: [] },
    {
      k: '先物',
      v: `${header.future.contract} 限 ${header.future.price}`,
      note: `（約定 ${header.future.time}・SQ ${header.future.sqDate}）`,
      tags: [],
    },
    { k: 'ATM の基準', v: BASIS_LABEL[header.basis], note: null, tags: [] },
  );
  return {
    notice: null,
    rows,
    reasonNote: header.reasonNote,
    months: header.months.map((m) => ({
      id: m.id,
      current: m.id === curId,
      title: `${m.id} 限`,
      dates: `最終 ${m.lastTradingDay}・SQ ${m.sqDate}`,
      forward: `F ${m.forward}`,
      forwardKind: { label: m.forwardKindLabel, warn: m.noForward },
      refs: [refView(m.refA, header.basis === 'A'), refView(m.refB, header.basis === 'B')],
      atmLabel: `ATM（${header.basis}）`,
      atm: m.atm,
      noAtm: m.noAtm,
    })),
    assumptions: header.assumptions.map((a) => ({ text: a, warn: a === header.calendarWarning })),
    hint: ASSUMPTION_HINT_TEXT,
    loaderNote,
    error,
  };
}

/** 市場ピルの表示モデル。monthId が header.months に無い / null なら先頭の限月。 */
export function marketPill(
  header: HeaderModel | null,
  monthId: string | null,
  load: PillLoad,
): MarketPillModel {
  const state: PillState = load.loading
    ? 'loading'
    : load.error
      ? 'failed'
      : header
        ? 'ready'
        : 'none';
  const month = header ? currentMonth(header, monthId) : undefined;
  const tags = pillTags(header, month, load);
  const shortTag = tags.find((t) => t.warn) ?? null;
  const time = header
    ? `板 ${pillDate(header.snapshot)}`
    : load.loading
      ? '読み込み中…'
      : load.error
        ? '板を読めない'
        : '板なし';
  const clock = header ? pillClock(header.snapshot) : time;
  const values = header
    ? {
        f: month && !month.noForward ? `F ${month.forward.split(' ±')[0]}` : null,
        atm: month && !month.noAtm ? `ATM ${month.atm}` : null,
        future: `先物 ${header.future.price}`,
      }
    : null;
  const summary = [
    time,
    ...tags.map((t) => t.label),
    ...(values ? [values.f, values.atm, values.future] : []),
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
  return {
    state,
    warn: shortTag !== null || (header === null && load.error !== null),
    time,
    clock,
    tags,
    shortTag,
    values,
    summary,
    full: fullModel(header, month?.id ?? null, load),
  };
}

/** 幅の段階で決めた数だけタグを見せる（残りは +N。測らない = 決定的）。 */
export function visibleTags(
  tags: readonly PillTag[],
  max: number,
): { shown: PillTag[]; more: number } {
  const n = Math.max(0, max);
  return { shown: tags.slice(0, n), more: Math.max(0, tags.length - n) };
}
