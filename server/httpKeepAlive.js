/**
 * HTTP keep-alive 전역 설치 (2026-09-22)
 *
 * ## 왜 필요한가 — 도커 DNS 간헐 실패의 **남은 절반**
 * pm2 가 호스트 리졸버 캐시를 붙여 조회 **비용**은 72ms → 6ms 가 됐다. 그러나
 * **조회 횟수 자체**는 그대로다 — 관측: 시세 갱신이 겹치는 창에 분당 333회 조회.
 * 원인은 내장 fetch(undici)의 기본 유휴 타임아웃이 **4초**라는 것이다:
 * ```
 * 갱신 틱 간격 5분  ≫  유휴 4초   ⇒ 틱마다 연결이 전부 죽어 있다
 * ⇒ 매 틱 첫 물결(배치 시세·캔들·계좌…)이 전부 **새 연결 = 새 DNS 조회**
 * ```
 * 조회가 사라지면 `EAI_AGAIN` 간헐 실패에 **노출되는 면적 자체**가 준다 —
 * 큐의 되꽂기(치료)와 층이 다른 **예방**이다.
 *
 * ## 설계
 * - 유휴 유지 **60초**: 틱 안(분석 97초 포함)의 연발 호출이 같은 연결을 탄다.
 *   ⚠️ 5분 틱 간격까지 살리려면 서버 쪽 유휴 한도도 그만큼 길어야 하는데 **그건 토스가 정한다**
 *   — 우리가 늘려도 서버가 끊으면 소용없으므로, 낙관하지 않고 틱 내 재사용만 노린다.
 * - 호스트당 연결 **8**: 무제한이면 동시 요청마다 새 연결이 생겨 keep-alive 가 무의미해진다.
 *   큐가 초당 발사량을 이미 제한하므로 8이면 충분하다.
 *
 * ## ⚠️ 전역 `fetch` 를 교체한다 — 이유를 적는다
 * 내장 fetch 는 **내장 undici 사본**을 쓰므로 npm undici 의 `setGlobalDispatcher` 가
 * 안 닿는다. 호출부(tossClient 등)를 고치지 않는 이유는 **테스트가 `global.fetch` 를
 * 스텁하는 구조**라서다 — 모듈 참조로 바꾸면 기존 스텁이 전부 무력화된다.
 * server.js 기동 시 한 번만 설치하고, 테스트는 이 모듈을 로드하지 않는다.
 */
const { Agent, setGlobalDispatcher, fetch: undiciFetch } = require('undici');
const { logInfo } = require('./logger');

const KEEP_ALIVE_MS = Math.max(1000, Number(process.env.HTTP_KEEPALIVE_MS) || 60_000);
const CONNECTIONS = Math.max(1, Number(process.env.HTTP_CONNECTIONS_PER_HOST) || 8);

let installed = false;

function install() {
  if (installed) return false; // 두 번 설치하면 Agent 가 새로 생겨 연결 풀이 갈린다
  installed = true;
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: Math.max(KEEP_ALIVE_MS, 10 * 60_000),
    connections: CONNECTIONS,
    pipelining: 1,
  }));
  // undici 패키지의 fetch 는 위 전역 dispatcher 를 탄다(내장 fetch 는 아니다)
  globalThis.fetch = undiciFetch;
  logInfo('http.keepalive', { keepAliveMs: KEEP_ALIVE_MS, connectionsPerHost: CONNECTIONS });
  return true;
}

module.exports = { install, KEEP_ALIVE_MS, CONNECTIONS };
