# Cloud Run simulator（docs/design.md 8.3、#36）: API（api/、Flask / gunicorn）と画面（ui/ を Vite でビルドした dist/）を 1 つのイメージに。
# ビルド context はリポジトリ直下:
#   docker build -t simulator:local .
# context に入るものは .dockerignore（許可リスト方式）で限定する。入力パスを変えたら .github/scripts/image.sh も直す。
# ベースイメージは digest で固定する（公開から 2 週間以上たった版。uv の exclude-newer と同じ考え方）
ARG NODE_IMAGE=node:24.20.0-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ARG PYTHON_IMAGE=python:3.13.15-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b

# 画面: package-lock.json の integrity で検証して入れ、vite build で dist/ を作る（合成の板・JSON は dist に入らない）
FROM ${NODE_IMAGE} AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY vite.config.ts tsconfig.json ./
COPY scripts/devFixtures.mjs ./scripts/
COPY ui ./ui
COPY model ./model
COPY data ./data
RUN npm run build

# API: uv.lock のハッシュで検証して /opt/venv に入れる（開発用の依存は入れない）
FROM ${PYTHON_IMAGE} AS build
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install --no-cache-dir uv==0.12.19
WORKDIR /src
# 依存だけ先に入れて層をキャッシュする
COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY api/src ./src
RUN uv sync --locked --no-dev --no-editable

FROM ${PYTHON_IMAGE}
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app
COPY --from=build /opt/venv /opt/venv
COPY --from=web /src/dist /app/static
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    STATIC_DIR=/app/static \
    PORT=8080
WORKDIR /app
USER 10001
# GCP_PROJECT（必須）・BQ_DATASET・BQ_LOCATION は実行時の環境変数（infra/prod）。
# 1 ワーカー: API のキャッシュと single-flight はワーカー（プロセス）ごとなので、インスタンス内で共有するため（13.4、#33）。
# I/O 待ちが主なのでスレッド 8 で並べる（Cloud Run の同時実行 8 と同じ）。--timeout 60 は Cloud Run のタイムアウトと同じ
CMD ["sh", "-c", "exec gunicorn --bind :${PORT} --workers 1 --threads 8 --timeout 60 --no-control-socket simulator_api.app:app"]
