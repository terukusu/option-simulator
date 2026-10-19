"""API（Flask）。docs/design.md 7.1・8.3。

- GET /api/chain: 使える最新の板（7.2）を JSON 版 1 で（data/chainTypes.ts）。?at= は後段（#33 では 400）
- GET /api/calendar: 取引カレンダーの最新版（trading_calendar_latest）
- GET /api/atm_iv?tf=<1m|1h|1d>[&start=&end=]: IV 推移（表 atm_cm_iv の iv30 の足。atm_iv.py。#79）
- GET /api/atm_daily: 日次の値（表 atm_cm_iv の日中の終値の iv30・1 / 2 限月のフォワード。確定した日だけ。atm_daily.py。
  #152）。パラメータは読まない
- GET /healthz: 設定の読み込みだけ（BigQuery に触れない）
- 静的ファイル: 環境変数 STATIC_DIR があるときだけ / と /assets/<path>（Vite のビルド成果物 = dist/）と、
  dist/ 直下の決まった名前（ROOT_FILES。manifest とアイコン。#90）
- 認証はアプリでは行わない（Cloud Run の IAP）。IAP のヘッダは読まない・ログに出さない
"""

import time
from datetime import UTC, datetime

from flask import Flask, Response, request, send_from_directory

from . import atm_iv, bq
from . import settings as st
from .log import log
from .service import ChainService, FileChainService, Unavailable

JSON_TYPE = "application/json; charset=utf-8"
# すべての応答に付けるセキュリティヘッダ（optionchan のビューアー + manifest-src 'self'。#90）。スクリプト・スタイル・
# 画像・manifest・XHR は同じオリジンの同梱ファイルだけ。他のサイトの frame に入れない
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}
# STATIC_DIR の直下から配る決まった名前 → Content-Type（ホーム画面に追加の manifest とアイコン。元は
# ui/public/、docs/ui-redesign.md §10.1「PWA」）。名前ごとに固定の経路にする
# （変数を含む経路を作らない = URL がファイル名に流れない）
ROOT_FILES: dict[str, str] = {
    "manifest.webmanifest": "application/manifest+json",
    "favicon.svg": "image/svg+xml",
    "apple-touch-icon.png": "image/png",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
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
    clock = clock or _now
    if cfg.data_source == "file":
        service = FileChainService(cfg.chain_file)
    else:
        if runner is None:
            runner = bq.BigQueryRunner(cfg)
            runner.start_warm()  # import・Client・トークンをバックグラウンドで（起動プローブ・/ を待たせない）
        service = ChainService(runner, clock, monotonic or time.monotonic)

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

    @app.get("/api/atm_iv")
    def api_atm_iv():
        now = clock()
        try:
            req = atm_iv.parse_request(request.args, now)
        except atm_iv.BadRequest as e:
            # 入力値は応答・ログに出さない（反射しない）。どのパラメータかだけ
            log("INFO", "bad_request", endpoint="atm_iv", param=e.param)
            return _error(400, "bad_request")
        max_age = st.ATM_IV_SETTLED_MAX_AGE_SECONDS if atm_iv.is_settled(req, now) else st.ATM_IV_MAX_AGE_SECONDS
        return serve("atm_iv", lambda: service.atm_iv(req), f"private, max-age={max_age}")

    @app.get("/api/atm_daily")
    def api_atm_daily():
        # パラメータは読まない（知らないパラメータは無視。キャッシュのキーを増やさない）
        return serve("atm_daily", service.atm_daily, f"private, max-age={st.ATM_DAILY_MAX_AGE_SECONDS}")

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

        def root_file(name: str, mimetype: str):
            def view():
                # ファイルが無ければ send_from_directory が 404。名前はハッシュを持たないので no-cache（ETag で 304）
                res = send_from_directory(static_dir, name, mimetype=mimetype, max_age=0)
                res.headers["Cache-Control"] = "no-cache"
                return res

            return view

        for name, mimetype in ROOT_FILES.items():
            app.add_url_rule(f"/{name}", endpoint=f"root_file:{name}", view_func=root_file(name, mimetype))

    return app


def __getattr__(name):
    # gunicorn の simulator_api.app:app・flask --app simulator_api.app。import しただけでは設定・BigQuery に触れない
    if name == "app":
        global app
        app = create_app()
        return app
    raise AttributeError(name)
