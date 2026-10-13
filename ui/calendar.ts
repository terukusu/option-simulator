/**
 * 画面で使う取引カレンダー（ビルド時にコミット済みの JSON をバンドルに入れる。ネットワークに出ない）。
 * JSON は `npm run calendar:sync` が書く生成物（data/calendar/）。形の検証・休業日の集合は data/calendar.ts。
 * 壊れていても例外を出さない（CALENDAR.ok = false。画面は「カレンダー期限切れ」を出す）。
 */

import { buildCalendar, type Calendar } from '../data';
import holidaysJson from '../data/calendar/holidays_jp.json';
import tradingJson from '../data/calendar/trading_calendar.json';

export const CALENDAR: Calendar = buildCalendar(tradingJson, holidaysJson);
