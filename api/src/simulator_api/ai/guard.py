"""口の守り（docs/ai-advisor.md 論点 8 = A）。他のサイトから費用を使われない（CSRF）・スレッドを使い切らない。

- 同じオリジン: Sec-Fetch-Site があれば same-origin だけ。Origin があればそのホストが要求のホストと同じこと。
  どちらも無い要求は拒否（ブラウザの fetch は少なくとも片方を付ける）。CORS の許可の見出しは返さない
- Content-Type: application/json だけ（フォームの送信・text/plain の単純要求を受けない）
- 同時の本数（Concurrency）・1 分の回数（RateLimit）: インスタンスごと（利用者は 1 人なので IAP の見出しは使わない）
"""

import threading
from collections import deque
from collections.abc import Callable
from urllib.parse import urlsplit


def origin_ok(headers, host: str) -> bool:
    site = headers.get("Sec-Fetch-Site")
    origin = headers.get("Origin")
    if site is None and origin is None:
        return False
    if site is not None and site != "same-origin":
        return False
    if origin is not None:
        try:
            netloc = urlsplit(origin).netloc
        except ValueError:
            return False
        if not netloc or netloc.lower() != host.lower():
            return False
    return True


def json_content_type(mimetype: str | None) -> bool:
    return (mimetype or "").lower() == "application/json"


class Concurrency:
    def __init__(self, limit: int):
        self._sem = threading.BoundedSemaphore(limit)

    def acquire(self) -> bool:
        return self._sem.acquire(blocking=False)

    def release(self) -> None:
        self._sem.release()


class RateLimit:
    """直近 window 秒に limit 回まで（monotonic を注入）"""

    def __init__(self, limit: int, window: float, monotonic: Callable[[], float]):
        self.limit = limit
        self.window = window
        self._monotonic = monotonic
        self._times: deque[float] = deque()
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            now = self._monotonic()
            while self._times and now - self._times[0] >= self.window:
                self._times.popleft()
            if len(self._times) >= self.limit:
                return False
            self._times.append(now)
            return True
