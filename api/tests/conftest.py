import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
API_ROOT = TESTS_DIR.parent
PKG_DIR = API_ROOT / "src" / "simulator_api"
REPO_ROOT = API_ROOT.parent

# support（合成の板・偽の runner）を import できるようにする
sys.path.insert(0, str(TESTS_DIR))
