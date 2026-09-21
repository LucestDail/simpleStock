const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 🔴 **여유 경고가 계속 울면 그 경고는 죽는다** (2026-09-22)
 *
 * pm2 05시 관측 실측: `toss.ratelimit_low` **158건이 전부 RANKING**, 실제 429 는 **0건**.
 * `RANKING` 은 한도 5 라 여유 1(=0.2)이 **상시 상태**인데 호출할 때마다 경고가 나갔다.
 *
 * ⚠️ 이건 임계값 문제가 아니었다 — **이미 비율 임계였다**(내가 pm2 에게 "절대값이라 한도를 안 본다"
 *    고 말한 건 틀렸다). 진짜 원인은 *"낮은 채로 머무는 동안 계속 운다"* 였다.
 *    ⇒ **상태 전이**에서만 운다(정상→낮음) + 회복 히스테리시스.
 *    ★ 이 저장소가 이미 두 곳에서 쓴 규율이다(장마감 전이 · 모멘텀 돌파).
 *
 * 그리고 한도 1~2 그룹(`ACCOUNT`)은 **구조적으로 늘 낮다** — 비율로는 못 거른다.
 */

function fresh() {
  for (const k of Object.keys(require.cache)) if (/tossClient|logger/.test(k)) delete require.cache[k];
  const logs = [];
  const lp = require.resolve('../server/logger');
  const real = require(lp);
  require.cache[lp] = { id: lp, filename: lp, loaded: true, exports: {
    ...real,
    logWarn: (e, p) => logs.push({ level: 'warn', e, p }),
    logInfo: (e, p) => logs.push({ level: 'info', e, p }),
  } };
  for (const k of Object.keys(require.cache)) if (/tossClient/.test(k)) delete require.cache[k];
  return { t: require('../server/tossClient'), logs };
}

const res = (limit, remaining) => ({
  headers: new Map([['X-RateLimit-Limit', String(limit)], ['X-RateLimit-Remaining', String(remaining)]]),
});
// Map 은 get 만 있으면 된다(코드가 headers.get 만 쓴다)
const warns = (logs) => logs.filter((l) => l.e === 'toss.ratelimit_low');

let ctx;
beforeEach(() => { ctx = fresh(); });

test('🔴 낮은 상태가 이어져도 경고는 **한 번**만 (158건 → 1건)', () => {
  const { t, logs } = ctx;
  for (let i = 0; i < 50; i += 1) t.noteRateLimitHeaders('/api/v1/rankings', res(5, 1));
  assert.equal(warns(logs).length, 1, `🔴 낮은 채로 머무는 동안 계속 울었다: ${warns(logs).length}건`);
});

test('🔴 회복했다가 다시 떨어지면 **새 사건**으로 운다', () => {
  const { t, logs } = ctx;
  t.noteRateLimitHeaders('/api/v1/rankings', res(5, 1));   // 하강 → 1
  for (let i = 0; i < 10; i += 1) t.noteRateLimitHeaders('/api/v1/rankings', res(5, 1));
  t.noteRateLimitHeaders('/api/v1/rankings', res(5, 5));   // 회복
  t.noteRateLimitHeaders('/api/v1/rankings', res(5, 1));   // 다시 하강 → 2
  assert.equal(warns(logs).length, 2, '🔴 회복 후 재하강이 새 사건으로 안 잡힌다');
});

/** ⚠️ 히스테리시스 — 임계 언저리에서 **떨리면** 안 된다 */
test('⚠️ 임계 바로 위로 올라간 정도로는 회복으로 치지 않는다', () => {
  const { t, logs } = ctx;
  t.noteRateLimitHeaders('/api/v1/rankings', res(10, 2));  // 0.2 → 경고
  t.noteRateLimitHeaders('/api/v1/rankings', res(10, 3));  // 0.3 — 아직 회복 아님(0.2*1.5=0.3)
  t.noteRateLimitHeaders('/api/v1/rankings', res(10, 2));  // 다시 하강
  assert.equal(warns(logs).length, 1, '🔴 임계 언저리에서 경고가 떨린다');
});

test('🔴 한도 1 짜리(ACCOUNT)는 아예 경고하지 않는다 (구조적으로 늘 0/1)', () => {
  const { t, logs } = ctx;
  for (let i = 0; i < 20; i += 1) t.noteRateLimitHeaders('/api/v1/accounts', res(1, 0));
  assert.equal(warns(logs).length, 0, '🔴 한도 1 그룹이 매번 경고를 낸다');
});

/** 🔴 **자의 판별력** — 진짜 위험은 여전히 잡는가(오탐만 줄이고 발동은 살아 있는가) */
test('🔴 큰 한도에서 실제로 떨어지면 **잡는다**', () => {
  const { t, logs } = ctx;
  t.noteRateLimitHeaders('/api/v1/rankings', res(100, 90)); // 정상
  t.noteRateLimitHeaders('/api/v1/rankings', res(100, 5));  // 0.05 → 경고
  assert.equal(warns(logs).length, 1, '🔴 진짜 하강을 놓쳤다 — 조용하게 만들다 귀를 막았다');
  assert.equal(warns(logs)[0].p.remaining, 5);
});

/** ⚠️ 분모(호출 수)는 계속 세야 한다 — "여유" 와 "안 불렀다" 를 가르는 값이다 */
test('⚠️ 조용해져도 **호출 수는 센다**', () => {
  const { t } = ctx;
  for (let i = 0; i < 7; i += 1) t.noteRateLimitHeaders('/api/v1/rankings', res(5, 1));
  const snap = t.rateLimitSnapshot();
  const j = JSON.stringify(snap);
  assert.match(j, /RANKING/, '🔴 그룹이 스냅샷에 없다');
  assert.ok(/[7-9]|1\d/.test(j), `🔴 호출 수가 안 세어진다: ${j.slice(0, 200)}`);
});
