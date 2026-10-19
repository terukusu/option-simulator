"""供給元の口（sources.py。#154）: DATA_SOURCE の値 → 実装の表が 1 か所にあり、どの供給元も同じ口を持つ。"""

import inspect
from pathlib import Path

import pytest
from support import Clock, FakeRunner, World, jst

from simulator_api import settings as st
from simulator_api import sources
from simulator_api.service import ChainService, FileChainService, QuotesFileService

METHODS = ("chain", "calendar", "atm_iv", "atm_daily")


def test_builders_match_settings():
    assert set(sources.BUILDERS) == set(st.DATA_SOURCES)


@pytest.mark.parametrize("cls", [ChainService, FileChainService, QuotesFileService])
def test_implementations_have_the_interface(cls):
    for name in METHODS:
        assert callable(getattr(cls, name, None)), f"{cls.__name__}.{name}"
        want = list(inspect.signature(getattr(sources.DataSource, name)).parameters)
        got = list(inspect.signature(getattr(cls, name)).parameters)
        assert len(got) == len(want), f"{cls.__name__}.{name} の引数"


def test_build_selects_implementation(tmp_path):
    clock = Clock(jst(2026, 10, 13, 21, 46))
    bq = sources.build(st.Settings(project="example-project"), FakeRunner(World()), clock, clock.monotonic)
    assert isinstance(bq, ChainService)
    f = sources.build(st.Settings(data_source="file", chain_file=tmp_path / "c.json"), None, clock, clock.monotonic)
    assert isinstance(f, FileChainService)
    q = sources.build(st.Settings(data_source="quotes", quotes_file=tmp_path / "q.json",
                                  calendar_file=tmp_path / "cal.json"), None, clock, clock.monotonic)
    assert isinstance(q, QuotesFileService)


def test_unknown_source_rejected_at_startup():
    with pytest.raises(ValueError):
        st.Settings(data_source="other")
    with pytest.raises(ValueError):
        st.from_env({"DATA_SOURCE": "other"})


def test_quotes_settings_from_env():
    cfg = st.from_env({"DATA_SOURCE": "quotes", "QUOTES_FILE": "/x/q.json", "CALENDAR_FILE": "/x/cal.json"})
    assert cfg.data_source == "quotes"
    assert cfg.quotes_file == Path("/x/q.json") and cfg.calendar_file == Path("/x/cal.json")
    with pytest.raises(ValueError):
        st.from_env({"DATA_SOURCE": "quotes", "QUOTES_FILE": "/x/q.json"})
    with pytest.raises(ValueError):
        st.from_env({"DATA_SOURCE": "quotes", "CALENDAR_FILE": "/x/cal.json"})
    # quotes は GCP のプロジェクトを要らない
    assert st.from_env({"DATA_SOURCE": "quotes", "QUOTES_FILE": "a", "CALENDAR_FILE": "b"}).project == ""
