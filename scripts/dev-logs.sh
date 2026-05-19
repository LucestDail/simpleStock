#!/usr/bin/env bash
# 운영 서버 로그/포트폴리오 빠른 진단 도구
# 사용:
#   ./scripts/dev-logs.sh                   # 최근 100라인
#   ./scripts/dev-logs.sh tail 300          # 최근 300라인
#   ./scripts/dev-logs.sh follow            # 실시간 스트리밍
#   ./scripts/dev-logs.sh actions           # action.batch 로그만 필터
#   ./scripts/dev-logs.sh holdings          # 현재 portfolio.json holding 덤프
#   ./scripts/dev-logs.sh ai                # 최근 AI 호출(supervisor/specialist/synth) 로그
#   ./scripts/dev-logs.sh chat <키워드>      # 최근 chat 로그에서 키워드 검색
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-192.168.11.25}"
REMOTE_USER="${REMOTE_USER:-seunghyun}"
REMOTE_PASSWORD="${REMOTE_PASSWORD:-1234}"
CONTAINER="${CONTAINER:-simplestock-app-1}"

ssh_run() {
  sshpass -p "$REMOTE_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

cmd="${1:-tail}"
arg="${2:-}"

case "$cmd" in
  tail)
    n="${arg:-100}"
    ssh_run "docker logs ${CONTAINER} --tail ${n} 2>&1"
    ;;
  follow)
    ssh_run "docker logs -f ${CONTAINER} 2>&1"
    ;;
  actions)
    ssh_run "docker logs ${CONTAINER} 2>&1 | grep -E 'action\\.batch|amount_backfilled|amount_backfill_skipped|dedupe_upsert|chat\\.actions\\.applied' | tail -30"
    ;;
  ai)
    ssh_run "docker logs ${CONTAINER} 2>&1 | grep -E 'ai\\.generate|ai\\.specialist|ai\\.supervisor|ai\\.graph' | tail -30"
    ;;
  holdings)
    ssh_run "docker exec ${CONTAINER} node -e \"const{loadStore}=require('./server/dataStore');loadStore().portfolio.holdings.forEach(h=>console.log(JSON.stringify({id:h.id,name:h.name,category:h.category,amount:h.amount,ticker:h.details?.ticker||null})))\""
    ;;
  chat)
    keyword="${arg:-}"
    if [ -z "$keyword" ]; then
      echo "사용법: $0 chat <키워드>" >&2
      exit 1
    fi
    ssh_run "docker logs ${CONTAINER} 2>&1 | grep -i '${keyword}' | tail -50"
    ;;
  *)
    echo "사용법:" >&2
    echo "  $0 tail [N]              최근 N(기본 100)라인" >&2
    echo "  $0 follow                실시간 로그" >&2
    echo "  $0 actions               action.batch 관련 로그만" >&2
    echo "  $0 ai                    AI 호출 로그만" >&2
    echo "  $0 holdings              현재 portfolio holdings 덤프" >&2
    echo "  $0 chat <키워드>          chat 로그 키워드 검색" >&2
    exit 1
    ;;
esac
