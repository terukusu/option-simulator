"""費用の 1 日上限（K15・docs/ai-advisor.md 論点 3）。金額は整数の µUSD（1e-6 USD。浮動小数の境界を避ける）。

- 予約 = 送る前にその要求の最大額を先に計上する。1 要求で上流を最大 T = AI_MAX_TURNS 回呼ぶ（Skill の turn。#221）ので
  turn ごとの上界の和: Σ_{i=0}^{T−1} [(E + i·(M + K)) × 書き込みの単価 + M × 出力の単価]
  （E = 入力の見積もり（トークン数の上界）、M = max_tokens、K = 1 回に読むスキルの上界。turn i の入力は最初の入力 +
  それまでの turn の出力（≤ M）と読んだスキル（≤ K）を超えない）。書き込みの単価は 5 分と 1 時間の大きい方（CLI は
  前置きを prompt caching で書き、資格情報によって 1 時間の TTL を付ける。入力の単価の中の最大）。
  計上額 + 予約額 ≤ 上限 のときだけ送る
- 精算: 終わったら usage × 料金表の実額との差を足し引きする。途中で切れたら精算しない（予約額のまま = 多めに数える）
- 日は JST の日付（0:00 JST に戻る）
"""

import threading
from datetime import datetime, time, timedelta, timezone
from typing import Protocol

from .. import settings as st

JST = timezone(timedelta(hours=9))
MTOK = 1_000_000


class StoreUnavailable(Exception):
    """数える場所が読めない・書けない（閉じる側に倒す = 送らない）。本文に値・例外の本文を入れない"""


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def estimate_input_tokens(text: str) -> int:
    """入力トークンの見積もり（上界）: UTF-8 のバイト数 + 見えない分の余裕（settings の説明）"""
    return len(text.encode("utf-8")) + st.AI_INPUT_OVERHEAD_TOKENS


def skill_tokens() -> int:
    """1 回に読むスキルの上界 K（トークン）: SKILL.md の合計のバイト数（トークン数 ≤ バイト数）+ 枠の余裕"""
    from . import skills

    return skills.total_bytes() + st.AI_SKILL_OVERHEAD_TOKENS


def reserve_micro_usd(model: str, est_input_tokens: int, max_tokens: int, turns: int = 1,
                      skill_tokens: int = 0) -> int:
    """予約額（µUSD）= Σ_{i=0}^{turns−1} [(E + i·(M + K)) × 書き込みの単価 + M × 出力の単価]"""
    p = st.AI_PRICES[model]
    write = max(p["cache_write_5m"], p["cache_write_1h"])
    inputs = turns * est_input_tokens + (max_tokens + skill_tokens) * turns * (turns - 1) // 2
    return _ceil_div(inputs * write + turns * max_tokens * p["output"], MTOK)


def cost_micro_usd(model: str, usage: dict) -> int:
    """usage（input_tokens・cache_creation_input_tokens・cache_read_input_tokens・output_tokens、cache_creation の内訳）
    × 料金表。cache_creation の内訳があれば 1 時間の分は 1 時間の単価、無ければ全部 5 分の単価"""
    p = st.AI_PRICES[model]

    def n(key):
        v = usage.get(key)
        return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else 0

    write = n("cache_creation_input_tokens")
    detail = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else {}
    write_1h = min(write, detail.get("ephemeral_1h_input_tokens") or 0)
    total = (n("input_tokens") * p["input"] + (write - write_1h) * p["cache_write_5m"]
             + write_1h * p["cache_write_1h"] + n("cache_read_input_tokens") * p["cache_read"]
             + n("output_tokens") * p["output"])
    return _ceil_div(total, MTOK)


def jst_day(now: datetime) -> str:
    return now.astimezone(JST).date().isoformat()


def resets_at(now: datetime) -> str:
    """翌日 0:00 JST（ISO、+09:00）"""
    d = now.astimezone(JST).date() + timedelta(days=1)
    return datetime.combine(d, time(0, 0), JST).isoformat()


def usd(micro: int | None) -> float | None:
    return None if micro is None else round(micro / 1_000_000, 6)


class SpendStore(Protocol):
    def read(self, day: str) -> int:
        """その日の計上額（µUSD）。読めなければ StoreUnavailable"""

    def reserve(self, day: str, amount: int, limit: int) -> tuple[bool, int]:
        """計上額 + amount ≤ limit なら amount を足して (True, 足した後)、超えるなら足さずに (False, 今の額)。
        他のインスタンスと競合しても上限を越えない（原子的）。読めない・書けなければ StoreUnavailable"""

    def adjust(self, day: str, delta: int) -> int:
        """精算（delta は負 = 戻す、正 = 足す）。足した後の額。失敗は StoreUnavailable"""


class MemoryStore:
    """インスタンスのメモリ（手元・テスト用。冷えるたびに 0 に戻る）。fail を立てると StoreUnavailable"""

    def __init__(self, charged: dict[str, int] | None = None):
        self.charged: dict[str, int] = dict(charged or {})
        self.requests: dict[str, int] = {}
        self.fail = False
        self._lock = threading.Lock()

    def _check(self):
        if self.fail:
            raise StoreUnavailable()

    def read(self, day):
        with self._lock:
            self._check()
            return self.charged.get(day, 0)

    def reserve(self, day, amount, limit):
        with self._lock:
            self._check()
            now = self.charged.get(day, 0)
            if now + amount > limit:
                return False, now
            self.charged[day] = now + amount
            self.requests[day] = self.requests.get(day, 0) + 1
            return True, self.charged[day]

    def adjust(self, day, delta):
        with self._lock:
            self._check()
            self.charged[day] = self.charged.get(day, 0) + delta
            return self.charged[day]
