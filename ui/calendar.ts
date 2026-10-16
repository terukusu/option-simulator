/**
 * 同梱の取引カレンダー（ビルド時にコミット済みの JSON をバンドルに入れる。`/api/calendar` と同じ形）。
 * API から一度も取れていないとき（dev の合成の板・ファイル選択・`DATA_SOURCE=file` の Flask・通信の失敗）に使う。
 * JSON（data/calendar/calendar.json）は手で作り直して PR にする（手順は README の「取引カレンダー」）。
 * 形の検証・休業日の集合は data/calendar.ts。壊れていても例外を出さない（ok = false。画面は「カレンダー期限切れ」を出す）。
 */

import { buildCalendar, type Calendar } from '../data';
import bundledJson from '../data/calendar/calendar.json';

export const BUNDLED_CALENDAR: Calendar = buildCalendar(bundledJson, 'bundled');

/** 初期状態とテストで使うカレンダー（= 同梱の版） */
export const CALENDAR: Calendar = BUNDLED_CALENDAR;
