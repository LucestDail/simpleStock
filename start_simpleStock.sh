#!/usr/bin/env bash
# SimpleStock 한 번에 기동 (프로젝트 루트에서 실행)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi
APP_PORT="${PORT:-50000}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
  docker compose ps
  echo ""
  echo "SimpleStock (Docker) — http://127.0.0.1:${APP_PORT}"
  echo "로그: cd \"$ROOT\" && docker compose logs -f"
else
  echo "Docker 미사용 — Node 로컬 기동"
  command -v node >/dev/null 2>&1 || {
    echo "Node.js 20 이상이 필요합니다." >&2
    exit 1
  }
  if [[ ! -d node_modules ]] || [[ ! -d frontend/node_modules ]]; then
    npm run install:all
  fi
  npm run build
  echo ""
  echo "SimpleStock (Node) — http://0.0.0.0:${APP_PORT}"
  exec npm start
fi
