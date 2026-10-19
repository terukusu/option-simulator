"""日の計上を Firestore の名前つき DB（settings.AI_FIRESTORE_DATABASE、Native モード）に置く（ADR-0004）。

文書 projects/<P>/databases/simulator-ai/documents/ai_spend/<YYYY-MM-DD（JST）> の charged_micro_usd・requests（整数）。
REST（google.auth の AuthorizedSession）で読み書きする（google-cloud-firestore は grpc 一式が入るので使わない）。

- 予約: 読む → 上限を判定 → currentDocument の前提条件（updateTime、無ければ exists=false）つきで書く。前提条件の失敗
  （他のインスタンスと競合）は読み直して AI_FIRESTORE_RETRIES 回まで。それでも駄目なら StoreUnavailable
- 精算: commit の fieldTransforms.increment（原子的。前提条件なし）。足した後の値は transformResults から
- 読めない・書けない・タイムアウトは StoreUnavailable（呼び出し側は 503 で送らない）。例外の本文は持ち出さない
"""

import threading

from .. import settings as st
from .budget import StoreUnavailable

BASE = "https://firestore.googleapis.com/v1"
SCOPE = "https://www.googleapis.com/auth/datastore"
CONFLICT_STATUSES = ("FAILED_PRECONDITION", "ALREADY_EXISTS", "ABORTED", "NOT_FOUND")


def _default_session():
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    credentials, _ = google.auth.default(scopes=[SCOPE])
    return AuthorizedSession(credentials)


def _json(res) -> dict:
    try:
        body = res.json()
    except Exception as e:
        raise StoreUnavailable() from e
    if not isinstance(body, dict):
        raise StoreUnavailable()
    return body


def _int_field(doc: dict, name: str) -> int:
    v = (doc.get("fields") or {}).get(name) or {}
    raw = v.get("integerValue")
    try:
        return int(raw) if raw is not None else 0
    except (TypeError, ValueError) as e:
        raise StoreUnavailable() from e


class FirestoreStore:
    def __init__(self, project: str, session=None, database: str = st.AI_FIRESTORE_DATABASE):
        self.project = project
        self.database = database
        self._session = session
        self._lock = threading.Lock()

    @property
    def db_path(self) -> str:
        return f"projects/{self.project}/databases/{self.database}"

    def doc_name(self, day: str) -> str:
        return f"{self.db_path}/documents/{st.AI_FIRESTORE_COLLECTION}/{day}"

    def session(self):
        with self._lock:
            if self._session is None:
                try:
                    self._session = _default_session()
                except Exception as e:
                    raise StoreUnavailable() from e
            return self._session

    def _call(self, method: str, url: str, **kw):
        try:
            return self.session().request(method, url, timeout=st.AI_FIRESTORE_TIMEOUT_SECONDS, **kw)
        except StoreUnavailable:
            raise
        except Exception as e:  # タイムアウト・接続の失敗・トークンの取得の失敗
            raise StoreUnavailable() from e

    def _get(self, day: str) -> tuple[int, str | None]:
        res = self._call("GET", f"{BASE}/{self.doc_name(day)}")
        if res.status_code == 404:
            return 0, None
        if res.status_code != 200:
            raise StoreUnavailable()
        doc = _json(res)
        return _int_field(doc, "charged_micro_usd"), doc.get("updateTime")

    def read(self, day: str) -> int:
        return self._get(day)[0]

    def reserve(self, day: str, amount: int, limit: int) -> tuple[bool, int]:
        for _ in range(st.AI_FIRESTORE_RETRIES):
            res = self._call("GET", f"{BASE}/{self.doc_name(day)}")
            if res.status_code == 404:
                charged, requests, update_time = 0, 0, None
            elif res.status_code == 200:
                doc = _json(res)
                charged = _int_field(doc, "charged_micro_usd")
                requests = _int_field(doc, "requests")
                update_time = doc.get("updateTime")
            else:
                raise StoreUnavailable()
            if charged + amount > limit:
                return False, charged
            params = [("updateMask.fieldPaths", "charged_micro_usd"), ("updateMask.fieldPaths", "requests")]
            if update_time is None:
                params.append(("currentDocument.exists", "false"))
            else:
                params.append(("currentDocument.updateTime", update_time))
            body = {"fields": {"charged_micro_usd": {"integerValue": str(charged + amount)},
                               "requests": {"integerValue": str(requests + 1)}}}
            res = self._call("PATCH", f"{BASE}/{self.doc_name(day)}", params=params, json=body)
            if res.status_code == 200:
                return True, charged + amount
            if not self._is_conflict(res):
                raise StoreUnavailable()
        raise StoreUnavailable()

    def adjust(self, day: str, delta: int) -> int:
        body = {"writes": [{"transform": {"document": self.doc_name(day), "fieldTransforms": [
            {"fieldPath": "charged_micro_usd", "increment": {"integerValue": str(delta)}}]}}]}
        res = self._call("POST", f"{BASE}/{self.db_path}/documents:commit", json=body)
        if res.status_code != 200:
            raise StoreUnavailable()
        body = _json(res)
        try:
            return int(body["writeResults"][0]["transformResults"][0]["integerValue"])
        except (KeyError, IndexError, TypeError, ValueError) as e:
            raise StoreUnavailable() from e

    @staticmethod
    def _is_conflict(res) -> bool:
        if res.status_code not in (400, 404, 409):
            return False
        try:
            status = res.json().get("error", {}).get("status")
        except Exception:
            return False
        return status in CONFLICT_STATUSES
