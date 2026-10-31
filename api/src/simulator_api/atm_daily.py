"""/api/atm_daily（日次の値。表 atm_cm_iv の日中の終値の iv30 と 1 / 2 限月のフォワード、#152）の純粋な関数。
docs/design.md 7.1・7.3・13.4。

- 要求: パラメータなし（知らないパラメータは無視。値は読まない）
- 範囲: [ATM_IV_EPOCH_ISO, 範囲の終わりの日 00:00 JST)。範囲の終わり = settled_end(now) = JST の今日（JST 8:00 以降）か
  前日（8:00 前）= 確定した日だけ（表は毎時 45 分に直近 2 時間、JST 7 時台に前日分を作り直す）
- 日次の値: JST の日付ごとに、JST 9:00〜15:00（両端含む。settings.ATM_DAILY_CLOSE_WINDOW）の行のうち iv30・m1_forward・
  m1_last_trading_day が NULL でない最後の行（sql/atm_cm_daily.sql が束ねる）
- 2 営業日の組はブラウザ（data/atmDaily.ts の atmMoves）。サーバーは日次の値を返すだけ
- JSON: {schema_version: 1, start, end, days: [{d, t, iv, f1, l1, f2, l2, v1, v2}]}。d の昇順・重複なし（重複は後を
  捨てる）。t は close_at の +09:00、iv は %（iv30 のまま）、値は丸めない。iv・f1 が有限で正でない・l1 が NULL の行は
  捨てる。f2・l2 は片方でも NULL / 有限でない / 正でなければ両方 null
- v1・v2（#307）: 1・2 限月の ATM IV（%。m1_iv・m2_iv のまま）。有限で正でなければ null（行は捨てない）。v2 は
  f2・l2 の組があるときだけ値（組が無ければ null）。過去の急落の再生（5.14）の足の残存に合わせた ATM の倍率に使う。
  schema_version は 1 のまま（キーを足しただけ。古い画面は知らないキーを無視する）
- ETag の形の印 ETAG_SHAPE: 同じ範囲の終わり・件数でも v1・v2 の無い古い本文を 304 で使い続けないため
"""

import math
from datetime import UTC, date, datetime, time, timedelta

from . import settings as st
from .calendar import jst_iso
from .usable import JST

SCHEMA_VERSION = 1
# ETag の形の印（JSON の日のキーを変えたら変える。v = v1・v2 を足した形。#307）
ETAG_SHAPE = "v"
DAY = timedelta(days=1)
EPOCH = datetime.fromisoformat(st.ATM_IV_EPOCH_ISO)


def settled_end(now: datetime) -> date:
    """確定した範囲の終わり（JST の日付。その日を含まない）"""
    local = now.astimezone(JST)
    return local.date() if local.time() >= st.ATM_DAILY_SETTLED_AT else local.date() - DAY


def read_window(end_day: date) -> tuple[datetime, datetime]:
    """SQL のパラメータ (start_at, end_at)。end_at = end_day 00:00 JST（UTC で表す）"""
    return EPOCH, datetime.combine(end_day, time(0), JST).astimezone(UTC)


def _positive(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def days_from_rows(rows: list[dict], end_day: date) -> list[dict]:
    """SQL の行 → 日次の値（d の昇順・重複なし。重複は後の行を捨てる）。end_day 以後の行・壊れた行は捨てる"""
    out: dict[date, dict] = {}
    for r in sorted(rows, key=lambda r: r["day"]):  # 安定な並べ替え（同じ日は元の順のまま → 先の行を残す）
        d = r["day"]
        if not isinstance(d, date) or d >= end_day or d in out:
            continue
        close_at = r.get("close_at")
        iv, f1, l1 = r.get("iv30"), r.get("m1_forward"), r.get("m1_last_trading_day")
        if not isinstance(close_at, datetime) or not _positive(iv) or not _positive(f1) or not isinstance(l1, date):
            continue
        f2, l2 = r.get("m2_forward"), r.get("m2_last_trading_day")
        pair = _positive(f2) and isinstance(l2, date)
        v1, v2 = r.get("m1_iv"), r.get("m2_iv")
        out[d] = {"d": d.isoformat(), "t": jst_iso(close_at), "iv": iv, "f1": f1, "l1": l1.isoformat(),
                  "f2": f2 if pair else None, "l2": l2.isoformat() if pair else None,
                  "v1": v1 if _positive(v1) else None, "v2": v2 if pair and _positive(v2) else None}
    return list(out.values())


def atm_daily_json(end_day: date, days: list[dict]) -> dict:
    """応答の JSON。start = 読んだ範囲の始まりの日（EPOCH）、end = 範囲の終わりの日（含まない）"""
    return {
        "schema_version": SCHEMA_VERSION,
        "start": EPOCH.date().isoformat(),
        "end": end_day.isoformat(),
        "days": days,
    }
