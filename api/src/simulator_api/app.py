"""API（Flask）。docs/design.md 7.1・8.3。

- GET /api/chain: 使える最新の板（7.2）を JSON 版 1 で（data/chainTypes.ts）。?at= は後段（#33 では 400）
- GET /api/calendar: 取引カレンダーの最新版（trading_calendar_latest）
- GET /healthz: 設定の読み込みだけ（BigQuery に触れない）
- 静的ファイル: 環境変数 STATIC_DIR があるときだけ / と /assets/<path>（Vite のビルド成果物 = dist/）
- 認証はアプリでは行わない（Cloud Run の IAP）。IAP のヘッダは読まない・ログに出さない
"""

import time
from datetime import UTC, datetime

from flask import Flask, Response, request, send_from_directory

from . import bq
from . import settings as st
from .log import log
from .service import ChainService, FileChainService, Unavailable

JSON_TYPE = "application/json; charset=utf-8"
# すべての応答に付けるセキュリティヘッダ（optionchan のビューアーと同じ）。スクリプト・スタイル・画像・XHR は
# 同じオリジンの同梱ファイルだけ。他のサイトの frame に入れない
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}
# 未対応のクエリパラメータ（指定されたら 400。値は応答・ログに出さない）
REJECTED_PARAMS = ("at",)


def _now() -> datetime:
    return datetime.now(UTC)


def _error(status: int, code: str) -> Response:
    res = Response(f'{{"error":"{code}"}}', status=status, content_type=JSON_TYPE)
    res.headers["Cache-Control"] = "no-store"
    return res


def _payload_response(payload, cache_control: str) -> Response:
    if payload.etag is not None and request.if_none_match.contains(payload.etag.strip('"')):
        res = Response(status=304)
    elif request.accept_encodings["gzip"] > 0:
        res = Response(payload.gzip_bytes, status=200, content_type=JSON_TYPE)
        res.headers["Content-Encoding"] = "gzip"
    else:
        res = Response(payload.json_bytes, status=200, content_type=JSON_TYPE)
    if payload.etag is not None:
        res.headers["ETag"] = payload.etag
    res.headers["Cache-Control"] = cache_control
    res.headers["Vary"] = "Accept-Encoding"
    return res


def create_app(runner=None, clock=None, monotonic=None, cfg: st.Settings | None = None) -> Flask:
    """runner: (name, params) -> rows（省略時は設定の BigQuery）。clock: 現在時刻、monotonic: 単調時計（テスト用）。
    cfg: 設定（省略時は環境変数）"""
    app = Flask(__name__, static_folder=None)
    if cfg is None:
        cfg = st.from_env()
    if cfg.data_source == "file":
        service = FileChainService(cfg.chain_file)
    else:
        if runner is None:
            runner = bq.BigQueryRunner(cfg)
        service = ChainService(runner, clock or _now, monotonic or time.monotonic)

    @app.after_request
    def security_headers(res):
        for k, v in SECURITY_HEADERS.items():
            res.headers.setdefault(k, v)
        return res

    def serve(endpoint, produce, cache_control):
        try:
            payload = produce()
        except Unavailable as e:
            log("WARNING", "unavailable", endpoint=endpoint, code=e.args[0] if e.args else None)
            return _error(503, "unavailable")
        except Exception as e:
            # BigQuery の例外の本文はプロジェクト番号・アカウントを含みうるので、応答には出さず、ログは型だけ
            log("ERROR", "query_failed", endpoint=endpoint, error_type=type(e).__name__)
            return _error(503, "unavailable")
        return _payload_response(payload, cache_control)

    @app.get("/healthz")
    def healthz():
        res = Response("ok\n", status=200, content_type="text/plain; charset=utf-8")
        res.headers["Cache-Control"] = "no-store"
        return res

    @app.get("/api/chain")
    def api_chain():
        for name in REJECTED_PARAMS:
            if name in request.args:
                # 入力値は応答・ログに出さない（反射しない）。どのパラメータかだけ
                log("INFO", "bad_request", endpoint="chain", param=name)
                return _error(400, "bad_request")
        return serve("chain", service.chain, "private, max-age=60")

    @app.get("/api/calendar")
    def api_calendar():
        return serve("calendar", service.calendar, "private, max-age=3600")

    if cfg.static_dir is not None:
        static_dir = cfg.static_dir.resolve()

        @app.get("/")
        def index():
            res = send_from_directory(static_dir, "index.html", max_age=0)
            res.headers["Cache-Control"] = "no-cache"
            return res

        @app.get("/assets/<path:name>")
        def assets(name):
            # send_from_directory はディレクトリの外（..）を 404 にする
            res = send_from_directory(static_dir / "assets", name)
            res.headers["Cache-Control"] = "private, max-age=31536000, immutable"
            return res

    return app


def __getattr__(name):
    # gunicorn の simulator_api.app:app・flask --app simulator_api.app。import しただけでは設定・BigQuery に触れない
    if name == "app":
        global app
        app = create_app()
        return app
    raise AttributeError(name)
