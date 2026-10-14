"""設定（AC-4 の上限。docs/design.md 8.3）。"""

from pathlib import Path

import pytest

from simulator_api import settings as st


def env(**kw):
    return {"GCP_PROJECT": "example-project", **kw}


def test_defaults():
    cfg = st.from_env(env())
    assert cfg.data_source == "bigquery"
    assert cfg.dataset == "optionchan_tokyo"
    assert cfg.location == "asia-northeast1"
    assert cfg.maximum_bytes_billed == 536870912
    assert cfg.static_dir is None and cfg.chain_file is None


def test_project_required():
    with pytest.raises(RuntimeError):
        st.from_env({})


@pytest.mark.parametrize("value", ["536870913", "1073741824", "0", "-1", "abc", "1e6", " 12 3"])
def test_max_bytes_billed_rejected(value):
    with pytest.raises(ValueError):
        st.from_env(env(MAX_BYTES_BILLED=value))


def test_max_bytes_billed_accepted():
    assert st.from_env(env(MAX_BYTES_BILLED="536870912")).maximum_bytes_billed == 536870912
    assert st.from_env(env(MAX_BYTES_BILLED="1048576")).maximum_bytes_billed == 1048576


@pytest.mark.parametrize("key,value", [
    ("GCP_PROJECT", "bad`project"), ("GCP_PROJECT", "a.b"), ("BQ_DATASET", "x.y"), ("BQ_DATASET", "a`b"),
    ("BQ_LOCATION", "asia northeast1"),
])
def test_identifiers_validated(key, value):
    with pytest.raises(ValueError):
        st.from_env(env(**{key: value}))


def test_file_source_and_static_dir():
    cfg = st.from_env({"DATA_SOURCE": "file", "CHAIN_FILE": "/x/chain.json", "STATIC_DIR": "/x/dist"})
    assert cfg.data_source == "file"
    assert cfg.chain_file == Path("/x/chain.json") and cfg.static_dir == Path("/x/dist")
    with pytest.raises(ValueError):
        st.from_env({"DATA_SOURCE": "file"})
    with pytest.raises(ValueError):
        st.from_env({"DATA_SOURCE": "other"})
