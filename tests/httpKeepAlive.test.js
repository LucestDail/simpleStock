const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **keep-alive 전역 설치** (2026-09-22 — 도커 DNS 간헐 실패의 "예방" 절반)
 *
 * pm2 캐시가 조회 **비용**을 줄였고(72→6ms), 이건 조회 **횟수**를 없앤다.
 * 내장 fetch 의 기본 유휴 4초 ≪ 틱 간격 5분이라 매 틱 첫 물결이 전부 새 연결=새 DNS 조회였다.
 */
const ka = require('../server/httpKeepAlive');

test('🔴 설치하면 global fetch 가 undici fetch 로 바뀐다', () => {
  const before = globalThis.fetch;
  try {
    const did = ka.install();
    assert.equal(did, true);
    assert.notEqual(globalThis.fetch, before, '🔴 fetch 가 안 바뀌었다 — 내장 undici 사본이 그대로 쓰인다');
  } finally {
    globalThis.fetch = before; // 다른 테스트의 스텁 구조를 지킨다
  }
});

test('🔴 두 번 설치되지 않는다 (Agent 가 갈리면 연결 풀이 쪼개진다)', () => {
  const before = globalThis.fetch;
  try {
    assert.equal(ka.install(), false, '🔴 재설치가 막히지 않는다');
  } finally {
    globalThis.fetch = before;
  }
});

test('⚠️ 유휴 유지가 분석 소요(97초 실측)를 덮을 만큼 길다', () => {
  assert.ok(ka.KEEP_ALIVE_MS >= 60_000, `유휴 ${ka.KEEP_ALIVE_MS}ms — 분석 한 회차 안에서 연결이 죽는다`);
});

/** 🔴 배선 — server.js 가 **다른 require 보다 먼저** 설치하는가 */
test('🔴 server.js 최상단에서 설치된다 (다른 모듈이 fetch 를 잡기 전에)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  const i = src.indexOf("require('./server/httpKeepAlive').install()");
  assert.ok(i > 0, '🔴 설치 호출이 없다 — 모듈만 있고 안 불린다');
  const firstServerRequire = src.indexOf("require('./server/");
  assert.ok(i <= firstServerRequire + 100,
    '🔴 설치가 늦다 — 앞의 모듈이 옛 fetch 참조를 이미 잡았을 수 있다');
});
