# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS frontend
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

FROM python:3.12-slim AS python-deps
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv \
    && uv sync --frozen --no-dev

FROM python:3.12-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH" \
    PRODUCT_RES_MODE=pilot \
    PRODUCT_RES_DATA_DIR=/data
WORKDIR /app
COPY --from=python-deps /app/.venv /app/.venv
COPY app/ /app/app/
COPY scripts/pilot_backup.py /app/scripts/pilot_backup.py
COPY fixtures/demo/templates/ /app/fixtures/demo/templates/
RUN groupadd --system --gid 10001 productres \
    && useradd --system --uid 10001 --gid productres --home-dir /app --no-create-home productres \
    && mkdir -p /data /tmp \
    && chown -R productres:productres /app /data /tmp
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS gateway
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend /build/web/dist /usr/share/nginx/html
EXPOSE 8080
