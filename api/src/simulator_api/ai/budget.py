"""費用の 1 日上限（K15・docs/ai-advisor.md 論点 3）。金額は整数の µUSD（1e-6 USD。浮動小数の境界を避ける）。

- 予約 = 送る前にその要求の最大額を先に計上する。1 要求で上流を最大 T = AI_MAX_TURNS 回呼ぶ（Skill の turn。#221）。
  E = 入力の見積もり（トークン数の上界。CLI が足す分を含む）、M = max_tokens、
  S = 1 turn で読むスキルの上界（skill_tokens。SKILL.md の合計 + Skill の枠。turn ごとに足す = 保守側。各スキルは
  1 要求に 1 回・呼び出しは AI_SKILL_MAX_CALLS 回までをフックが守る。#338）、
  D = 1 要求で読む文書の上界（doc_tokens。read_doc の 1 要求の合計の上限 + 枠。docs.Reader が要求全体で数えるので
  1 要求に 1 回だけ足す。#137・#338 = ADR-0007 の追補）、
  w = 書き込みの単価（5 分と 1 時間の大きい方。CLI は資格情報によって 1 時間の TTL を付ける）、r = 読み出しの単価、
  o = 出力の単価。turn i ≥ 1 の要求 = 前の turn の要求（キャッシュの読み出し）+ 増えた分（前の出力 M + S + 文書）を
  書き込み。文書は最悪の並び（turn 0 の結果で全部読む）で数える（t = max(T, 1)）:
    書き込み = E + (t−1)(M + S) + D·[t > 1]
    読み出し = (t−1)E + (M + S)(t−1)(t−2)/2 + D·max(t−2, 0)
    出力 = t·M
  T = 1 では E × w + M × o（画像の読み取り read_positions は S = D = 0）。
  前提: CLI は各要求の最後の message に cache_control を付け、次の turn の要求は前の turn の要求をそのまま前置きに
  持つ（tests/test_ai_agent_sdk_cli.py で固定）ので、前の turn の要求はキャッシュから読まれる。キャッシュから
  読めなかったとき（追い出し）だけ、その差（前の要求 × (w − r)）の分、精算で予約を越えうる（次の要求は 429）。
  CLI がフックより前にエラーで返すツール呼び出し（知らないツール名・一覧に無いスキル名・入力の型の誤り）の結果も
  同じく式の外（ADR-0007 の追補の「残る例外」）。計上額 + 予約額 ≤ 上限 のときだけ送る
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
    """入力トークンの見積もり（上界）: UTF-8 のバイト数 + 見えない分の余裕 + CLI が足す分（settings の説明）"""
    return len(text.encode("utf-8")) + st.AI_INPUT_OVERHEAD_TOKENS + st.AI_CLI_OVERHEAD_TOKENS


def skill_tokens() -> int:
    """1 turn で読むスキルの上界 S（トークン。トークン数 ≤ バイト数）: SKILL.md の合計 + Skill の枠の余裕
    （tool_use・tool_result・deny の文・CLI が足す前置き。AI_SKILL_MAX_CALLS 回ぶん）。turn ごとに足す"""
    from . import skills

    return skills.total_bytes() + st.AI_SKILL_OVERHEAD_TOKENS


def doc_tokens() -> int:
    """1 要求で読む文書の上界 D: read_doc の 1 要求の合計の上限 + 枠の余裕（#137。docs.Reader が要求全体で数える
    ので 1 要求に 1 回。#338）。文書の索引が無いときも足す = 保守側"""
    return st.AI_DOC_REQUEST_MAX_BYTES + st.AI_DOC_OVERHEAD_TOKENS


def reserve_micro_usd(model: str, est_input_tokens: int, max_tokens: int, turns: int = 1,
                      per_turn_tokens: int = 0, per_request_tokens: int = 0) -> int:
    """予約額（µUSD）。per_turn_tokens = S（turn ごとに増えうる分）、per_request_tokens = D（1 要求の合計で上限が
    ある分）。モジュールの説明の式"""
    p = st.AI_PRICES[model]
    write = max(p["cache_write_5m"], p["cache_write_1h"])
    g = max_tokens + per_turn_tokens
    d = per_request_tokens
    t = max(turns, 1)
    written = est_input_tokens + (t - 1) * g + (d if t > 1 else 0)
    read = (t - 1) * est_input_tokens + g * (t - 1) * (t - 2) // 2 + d * max(t - 2, 0)
    return _ceil_div(written * write + read * p["cache_read"] + t * max_tokens * p["output"], MTOK)


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
