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
curl -sf -m 15 "http://${REMOTE_HOST}:${REMOTE_PORT}/api/system/status" | head -c 240
echo ""
echo "[deploy] 완료: http://${REMOTE_HOST}:${REMOTE_PORT}/"
