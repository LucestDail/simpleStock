const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { healthChecks, healthPayload } = require('../server/healthService');

/**
 * 🔴 **헬스가 의존물을 본다** (2026-09-22) — 09-18 에 *"의존물이 죽어도 UP"* 으로 **기록만 하고**
 *    넘긴 항목을 끝낸다.
 *
 * ## 🔴 이 파일이 존재하는 진짜 이유
 * 첫 구현에서 `dataStore` 를 **import 하지 않았다.** 그런데 `try/catch` 가 그 `ReferenceError` 를
 * 삼켜 **터지지 않고 영원히 `degraded`** 를 냈다 — *"가드가 자기 버그를 잡아 그럴듯한 오답을 내는"*
 * 가장 나쁜 모양이다. ⇒ **"응답이 온다" 가 아니라 "정상일 때 `ok` 가 나오는가"** 를 재야 잡힌다.
 * 그리고 로직만 재면 **안 불리는 것**을 못 보므로 **배선 테스트**를 함께 둔다.
 */

const okStore = (ageMs = 0) => () => ({
  memory: { market: { refreshStatus: 'ready', lastSuccessAt: new Date(Date.now() - ageMs).toISOString() } },
  watchlist: { tickers: [] },
});

test('🔴 정상이면 **ok** (degraded 로 굳어 있지 않다)', () => {
  const b = healthPayload({ loadStore: okStore() });
  assert.deepEqual(b.checks, { data: 'ok', upstream: 'ok' });
  assert.equal(b.status, 'ok');
});

test('🔴 저장소를 못 읽으면 fail — **던지지 않고 드러낸다**', () => {
  const b = healthPayload({ loadStore: () => { throw new Error('ENOENT'); } });
  assert.equal(b.checks.data, 'fail');
  assert.equal(b.status, 'degraded');
});

test('🔴 갱신이 오래되면 stale', () => {
  const b = healthPayload({ loadStore: okStore(6 * 60 * 60_000) });
  assert.equal(b.checks.upstream, 'stale', '🔴 6시간 묵은 시세를 정상이라 한다');
  assert.equal(b.status, 'degraded');
});

/** ⚠️ **검사 안 한 것과 통과한 것은 다르다** */
test('⚠️ 성공 기록이 없으면 ok 가 아니라 unknown', () => {
  const c = healthChecks({ loadStore: () => ({ memory: { market: { refreshStatus: 'ready' } }, watchlist: {} }) });
  assert.equal(c.upstream, 'unknown', '🔴 한 번도 성공 못 했는데 정상이라 한다');
});

test('갱신이 실패 중이고 성공 기록도 없으면 error', () => {
  const c = healthChecks({ loadStore: () => ({ memory: { market: { refreshStatus: 'error' } }, watchlist: {} }) });
  assert.equal(c.upstream, 'error');
});

/** 🔴 무인증 공개 — 규모 정보가 새면 안 된다 */
test('🔴 응답에 숫자·경로·종목·호스트가 없다', () => {
  const j = JSON.stringify(healthPayload({ loadStore: okStore() }));
  assert.ok(!/\d/.test(j), `🔴 숫자가 샌다: ${j}`);
  assert.ok(!/\//.test(j), `🔴 경로가 샌다: ${j}`);
  assert.ok(!/QLD|RAM|localhost|192\.168|\.json/.test(j), `🔴 내부 이름이 샌다: ${j}`);
});

// ── 배선 ─────────────────────────────────────────────────────────
/**
 * 🔴 **로직만 맞고 안 불리는 것을 막는다.** `server.js` 는 require 하면 리스너가 뜨므로
 *    **소스를 구조로** 본다(주석·문자열 제거 후).
 */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('🔴 /health 가 healthService 를 부른다', () => {
  const i = code.indexOf("app.get('/health'");
  assert.ok(i > 0, '🔴 /health 라우트가 없다');
  const block = code.slice(i, i + 300);
  assert.match(block, /healthPayload/, '🔴 라우트가 판정 로직을 안 부른다 — 로직만 맞고 안 불린다');
  assert.match(block, /loadStore/, '🔴 저장소를 안 넘긴다 — 주입 없으면 data 가 늘 fail 이다');
});

/** 🔴 내가 실제로 저지른 버그 — import 누락을 catch 가 삼킨다 */
test('🔴 `dataStore` 가 **import 돼 있다** (누락을 catch 가 삼킨다)', () => {
  assert.match(code, /const dataStore = require\(['"]\.\/server\/dataStore['"]\)/,
    '🔴 dataStore import 가 없다 — 런타임에 안 터지고 영원히 degraded 가 된다');
  assert.match(code, /const health = require\(['"]\.\/server\/healthService['"]\)/);
});

/** ⚠️ 503 을 내지 않는다 — 장 닫힌 밤마다 허브가 빨개지면 아무도 안 본다 */
test('⚠️ 헬스 라우트가 상태코드를 바꾸지 않는다 (200 유지)', () => {
  const i = code.indexOf("app.get('/health'");
  const block = code.slice(i, i + 300);
  assert.ok(!/res\.status\(/.test(block), '🔴 헬스가 상태코드를 바꾼다 — degraded 는 본문으로 낸다');
});
