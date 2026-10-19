"""日の計上の Firestore（REST）の包み（#134 AC2。ADR-0003）。偽の session（GCP に触れない）。"""

import pytest

from simulator_api import settings as st
from simulator_api.ai.budget import StoreUnavailable
from simulator_api.ai.firestore_store import BASE, FirestoreStore

P = "example-project"
DOC = f"projects/{P}/databases/simulator-ai/documents/ai_spend/2026-10-19"


class Res:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def doc(charged, requests=1, update_time="2026-10-19T12:00:00.000001Z"):
    return {"name": DOC, "fields": {"charged_micro_usd": {"integerValue": str(charged)},
                                    "requests": {"integerValue": str(requests)}}, "updateTime": update_time}


class Session:
    """応答の列を順に返し、要求（method・url・params・json・timeout）を記録する"""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, timeout=None, params=None, json=None):
        self.calls.append({"method": method, "url": url, "params": params, "json": json, "timeout": timeout})
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def store(*responses):
    s = Session(*responses)
    return FirestoreStore(P, session=s), s


def test_read_missing_doc_is_zero():
    fs, s = store(Res(404, {"error": {"status": "NOT_FOUND"}}))
    assert fs.read("2026-10-19") == 0
    assert s.calls[0]["url"] == f"{BASE}/{DOC}"
    assert s.calls[0]["timeout"] == st.AI_FIRESTORE_TIMEOUT_SECONDS


def test_reserve_creates_with_exists_false():
    fs, s = store(Res(404, {}), Res(200, doc(500)))
    assert fs.reserve("2026-10-19", 500, 3_000_000) == (True, 500)
    patch = s.calls[1]
    assert patch["method"] == "PATCH" and patch["url"] == f"{BASE}/{DOC}"
    assert ("currentDocument.exists", "false") in patch["params"]
    assert ("updateMask.fieldPaths", "charged_micro_usd") in patch["params"]
    assert patch["json"]["fields"] == {"charged_micro_usd": {"integerValue": "500"},
                                       "requests": {"integerValue": "1"}}


def test_reserve_updates_with_update_time_precondition():
    fs, s = store(Res(200, doc(1000, 3, "T1")), Res(200, doc(1500, 4)))
    assert fs.reserve("2026-10-19", 500, 3_000_000) == (True, 1500)
    assert ("currentDocument.updateTime", "T1") in s.calls[1]["params"]
    assert s.calls[1]["json"]["fields"]["requests"] == {"integerValue": "4"}


def test_reserve_over_limit_does_not_write():
    fs, s = store(Res(200, doc(2_999_999)))
    assert fs.reserve("2026-10-19", 2, 3_000_000) == (False, 2_999_999)
    assert len(s.calls) == 1


def test_reserve_retries_on_conflict_then_succeeds():
    conflict = Res(400, {"error": {"status": "FAILED_PRECONDITION"}})
    fs, s = store(Res(200, doc(1, 1, "T1")), conflict, Res(200, doc(2, 2, "T2")), Res(200, doc(12)))
    assert fs.reserve("2026-10-19", 10, 100) == (True, 12)
    assert ("currentDocument.updateTime", "T2") in s.calls[3]["params"]


def test_reserve_conflict_three_times_unavailable():
    conflict = Res(409, {"error": {"status": "ALREADY_EXISTS"}})
    fs, s = store(*[r for _ in range(st.AI_FIRESTORE_RETRIES) for r in (Res(404, {}), conflict)])
    with pytest.raises(StoreUnavailable):
        fs.reserve("2026-10-19", 10, 100)
    assert len(s.calls) == 2 * st.AI_FIRESTORE_RETRIES


def test_adjust_uses_increment_and_returns_new_value():
    body = {"writeResults": [{"transformResults": [{"integerValue": "4200"}]}]}
    fs, s = store(Res(200, body))
    assert fs.adjust("2026-10-19", -800) == 4200
    call = s.calls[0]
    assert call["method"] == "POST" and call["url"] == f"{BASE}/projects/{P}/databases/simulator-ai/documents:commit"
    assert call["json"] == {"writes": [{"transform": {"document": DOC, "fieldTransforms": [
        {"fieldPath": "charged_micro_usd", "increment": {"integerValue": "-800"}}]}}]}


@pytest.mark.parametrize("responses", [
    (TimeoutError("timed out"),),
    (ConnectionError("down"),),
    (Res(403, {"error": {"status": "PERMISSION_DENIED"}}),),
    (Res(500, None),),
    (Res(200, None),),  # JSON でない
    (Res(200, {"fields": {"charged_micro_usd": {"integerValue": "x"}}}),),
], ids=["timeout", "connection", "permission", "server_error", "not_json", "bad_int"])
def test_failures_are_unavailable(responses):
    fs, _ = store(*responses)
    with pytest.raises(StoreUnavailable):
        fs.read("2026-10-19")


def test_patch_failure_unavailable():
    fs, _ = store(Res(404, {}), Res(403, {"error": {"status": "PERMISSION_DENIED"}}))
    with pytest.raises(StoreUnavailable):
        fs.reserve("2026-10-19", 1, 100)


def test_adjust_failure_unavailable():
    fs, _ = store(Res(503, {}))
    with pytest.raises(StoreUnavailable):
        fs.adjust("2026-10-19", -1)


def test_credentials_failure_unavailable(monkeypatch):
    from simulator_api.ai import firestore_store

    def boom():
        raise RuntimeError("no credentials")

    monkeypatch.setattr(firestore_store, "_default_session", boom)
    with pytest.raises(StoreUnavailable):
        FirestoreStore(P).read("2026-10-19")


def test_relay_with_firestore_store_unavailable_sends_nothing():
    from support import ai_app, ai_body
    from support import ai_post as post

    fs, _ = store(TimeoutError("timed out"))
    client, gw, _, _ = ai_app(store=fs)
    res = post(client, ai_body())
    assert res.status_code == 503 and res.get_json() == {"error": "unavailable"}
    assert gw.count() == 0
