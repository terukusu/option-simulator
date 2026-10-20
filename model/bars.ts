/**
 * 足の束ね（#200。docs/design.md 13.4「4 時間足・週足」）。画面（IV 推移・先物推移の 4 時間足）と AI の道具
 * `technicals`（週足・4 時間足）で共用する純関数（DOM・通信・時計に依存しない）。
 *
 * - 4 時間足（立会に合わせる）: 1 時間足の始まりの JST の時 h で、8〜11 → 08:00（日中の前半 8:45〜12:00）、
 *   12〜16 → 12:00（日中の後半 12:00〜15:45）、17〜20 → 17:00、21〜23・0 → 21:00（0 時は前日の 21:00）、
 *   1〜7 → 01:00（夜間の最後 01:00〜06:00。端数の 1 時間を前の足に足す 5 時間）。1 取引日 = 5 本。日中の終わりと
 *   夜間の始まりを混ぜない。先物の限月交代（17:00）は足の境なので 1 本に 2 限月が混ざらない
 * - 週足: 日足（t = 取引日の 00:00 JST）を JST の月曜始まりの週で束ねる。足の t は週の最初の足の t
 * - open / close = 最初 / 最後、high / low = 最大 / 最小。他のキー（先物の限月 m）は最後の足の値を運ぶ
 */

/** 束ねる足の最小の形（t = 足の始まりの UNIX 秒） */
export interface OhlcBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

const JST_S = 9 * 3600;
const DAY_S = 86400;
const HOUR_S = 3600;

/** JST の時（0〜23）→ その時の 4 時間足の始まりの時（前日の 21 時は −3） */
function fourHourOf(h: number): number {
  if (h >= 8 && h < 12) return 8;
  if (h >= 12 && h < 17) return 12;
  if (h >= 17 && h < 21) return 17;
  if (h >= 21) return 21;
  if (h === 0) return -3;
  return 1;
}

/** UNIX 秒 t（1 時間足の始まり）が属する 4 時間足の始まり（UNIX 秒）。区切りは立会に合わせる（ファイルの説明） */
export function fourHourStart(t: number): number {
  const hourT = Math.floor(t / HOUR_S) * HOUR_S;
  const j = hourT + JST_S;
  const day = Math.floor(j / DAY_S);
  const h = Math.floor((j - day * DAY_S) / HOUR_S);
  return day * DAY_S - JST_S + fourHourOf(h) * HOUR_S;
}

/** UNIX 秒 t が属する JST の週（月曜 00:00 JST の UNIX 秒） */
export function weekStart(t: number): number {
  const day = Math.floor((t + JST_S) / DAY_S);
  // 1970-01-01 は木曜。月曜始まりの週の通し番号
  const monday = day - ((((day + 3) % 7) + 7) % 7);
  return monday * DAY_S - JST_S;
}

/**
 * 足を key(t) ごとに束ねる（足は t の昇順）。足の t は key の値（keepFirstT なら束ねた最初の足の t）。
 * 返す足は新しいオブジェクト（入力を変えない）
 */
export function groupBars<B extends OhlcBar>(
  bars: readonly B[],
  key: (t: number) => number,
  keepFirstT = false,
): B[] {
  const out: B[] = [];
  let cur: B | null = null;
  let curKey = Number.NaN;
  for (const b of bars) {
    const k = key(b.t);
    if (cur && k === curKey) {
      const o: number = cur.o;
      const t: number = cur.t;
      const h = Math.max(cur.h, b.h);
      const l = Math.min(cur.l, b.l);
      Object.assign(cur, b, { t, o, h, l });
    } else {
      cur = { ...b, t: keepFirstT ? b.t : k };
      curKey = k;
      out.push(cur);
    }
  }
  return out;
}

/** 1 時間足 → 4 時間足（立会に合わせる。fourHourStart） */
export function resample4h<B extends OhlcBar>(hourly: readonly B[]): B[] {
  return groupBars(hourly, fourHourStart);
}

/** 日足 → 週足（JST の月曜始まり。足の t は週の最初の日足の t） */
export function resampleWeekly<B extends OhlcBar>(daily: readonly B[]): B[] {
  return groupBars(daily, weekStart, true);
}
