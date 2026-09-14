#!/usr/bin/env bash
# 로컬 simpleStock → 원격 동기화 후 Docker 재빌드
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${REMOTE_ENV_FILE:-$SCRIPT_DIR/.env.remote}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

REMOTE_HOST="${REMOTE_HOST:-192.168.11.25}"
REMOTE_USER="${REMOTE_USER:-seunghyun}"
REMOTE_PASSWORD="${REMOTE_PASSWORD:-1234}"
REMOTE_DIR="${REMOTE_DIR:-~/simpleStock}"
REMOTE_PORT="${REMOTE_PORT:-50000}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

remote_ssh() {
  if [ -n "${REMOTE_PASSWORD:-}" ] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$REMOTE_PASSWORD" ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"
  else
    ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"
  fi
}

remote_rsync() {
  if [ -n "${REMOTE_PASSWORD:-}" ] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$REMOTE_PASSWORD" rsync -az --delete \
      --exclude node_modules/ \
      --exclude frontend/node_modules/ \
      --exclude frontend/dist/ \
      --exclude data/ \
      --exclude .env \
      --exclude .git/ \
      --exclude '**/.DS_Store' \
      -e "ssh ${SSH_OPTS[*]}" \
      "$ROOT/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
  else
    rsync -az --delete \
      --exclude node_modules/ \
      --exclude frontend/node_modules/ \
      --exclude frontend/dist/ \
      --exclude data/ \
      --exclude .env \
      --exclude .git/ \
      --exclude '**/.DS_Store' \
      -e "ssh ${SSH_OPTS[*]}" \
      "$ROOT/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"
  fi
}

echo "[deploy] 1/3 sync -> ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
remote_rsync

echo "[deploy] 2/3 docker compose up -d --build"
remote_ssh "cd ${REMOTE_DIR} && docker compose up -d --build && docker compose ps"

echo "[deploy] 3/3 smoke test"
sleep 3
if curl -sf -m 15 "http://${REMOTE_HOST}:${REMOTE_PORT}/" >/dev/null; then
  echo "[deploy] app root OK"
else
  echo "[deploy] ❌ app root 응답 실패: http://${REMOTE_HOST}:${REMOTE_PORT}/"
  exit 1
fi

# 🔴 2026-09-14: 종전에는 토큰을 못 읽으면 `skip`, 읽어도 `|| true` 라
#    **인증·API 계층이 통째로 깨져도 배포가 성공**이었다. 검사가 있으나 마나였다.
#    ⇒ 건너뛴 것은 요약에 남기고, 호출했으면 결과로 판정한다.
DEPLOY_FAIL=0
DEPLOY_SKIP=""
REMOTE_TOKEN="$(remote_ssh "grep -E '^APP_ACCESS_TOKEN=' ${REMOTE_DIR}/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\"'" || true)"
if [ -n "${REMOTE_TOKEN:-}" ]; then
  if curl -sf -m 15 -H "Authorization: Bearer ${REMOTE_TOKEN}" \
      "http://${REMOTE_HOST}:${REMOTE_PORT}/api/system/status" | head -c 240; then
    echo ""
    echo "[deploy] /api/system/status OK"
  else
    echo ""
    echo "[deploy] ❌ /api/system/status 실패 — 인증 또는 API 계층이 깨졌다"
    DEPLOY_FAIL=$((DEPLOY_FAIL + 1))
  fi
else
  # 못 읽은 것은 통과가 아니다.
  echo "[deploy] ⚠️ /api/system/status 검사 못 함(원격 .env 에서 APP_ACCESS_TOKEN 을 못 읽음)"
  DEPLOY_SKIP="$DEPLOY_SKIP api/system/status"
fi

GATEWAY_BASE_PATH="$(remote_ssh "grep -E '^VITE_BASE_PATH=' ${REMOTE_DIR}/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\"'" || true)"
GATEWAY_BASE_PATH="${GATEWAY_BASE_PATH:-}"
if [ -n "$GATEWAY_BASE_PATH" ]; then
  case "$GATEWAY_BASE_PATH" in
    */) GATEWAY_URL="http://${REMOTE_HOST}${GATEWAY_BASE_PATH}" ;;
    *) GATEWAY_URL="http://${REMOTE_HOST}/${GATEWAY_BASE_PATH#/}/" ;;
  esac
  echo "[deploy] gateway smoke: ${GATEWAY_URL}"
  curl -sf -m 15 "${GATEWAY_URL}" >/dev/null
  echo "[deploy] gateway OK"
fi

echo "[deploy] 완료: http://${REMOTE_HOST}:${REMOTE_PORT}/"
if [ -n "${GATEWAY_URL:-}" ]; then
  echo "[deploy] gateway: ${GATEWAY_URL}"
fi

# 🔴 마지막 줄이 그 실행의 전부를 말한다.
if [ "${DEPLOY_FAIL:-0}" -gt 0 ]; then
  echo "[deploy] ✖ 검증 실패 ${DEPLOY_FAIL}건${DEPLOY_SKIP:+ / 검사 못 함:$DEPLOY_SKIP}"
  exit 1
fi
if [ -n "${DEPLOY_SKIP:-}" ]; then
  echo "[deploy] 완료(검사 못 한 항목:$DEPLOY_SKIP)"
fi
