const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 🔴 VIX stale 재사용의 `ageMin` (2026-09-28, pm1 위임 — worker3 이
 * "캐시 시각이 모듈 비공개라 결정적 재현이 비싸다" 고 신고한 축)
 *
 * ★ **제품 표면을 안 넓히고도 쟀다.** `getVix()` 의 유일한 외부 의존은 전역 `fetch`
 *   (`fetchJson` 이 그걸 쓴다)이고, 시간 참조는 `Date.now()` 뿐이다. 둘 다 이미 이
 *   저장소의 기존 관례(`freezeGlobalDate` — kstDateKeys.test.js 참조, `global.fetch`
 *   대역 — alerts.test.js 참조)로 제어 가능하므로 **새 이음새를 추가할 필요가 없었다.**
 *   ⇒ 캐시 채우기(성공 응답) → 시계를 47분 뒤로 얼림 → 실패 응답 → `ageMin===47` 확인.
 */

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

/** kstDateKeys.test.js 의 freezeGlobalDate 와 같은 기법(그 파일의 private 헬퍼라 여기 다시 둔다) */
function freezeGlobalDate(ms) {
  const RealDate = global.Date;
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [ms])); }
    static now() { return ms; }
  }
  global.Date = FrozenDate;
  return () => { global.Date = RealDate; };
}

function freshMarketData() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('marketDataService')) delete require.cache[k];
  }
  return require('../server/marketDataService');
}

const okVixResponse = () => ({
  ok: true,
  json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 22.5, previousClose: 20, symbol: '^VIX' } }] } }),
});

test('🔴 stale 재사용 ageMin — 47분 뒤에 실패하면 ageMin=47, stale=true', async () => {
  const market = freshMarketData();
  const T0 = Date.parse('2026-09-28T09:00:00+09:00');

  let unfreeze = freezeGlobalDate(T0);
  try {
    global.fetch = async () => okVixResponse();
    const first = await market.getVix();
    assert.equal(first.stale, false, '첫 성공 응답인데 stale 이다');
  } finally {
    unfreeze();
  }

  // 47분 뒤 — 이번엔 실패
  unfreeze = freezeGlobalDate(T0 + 47 * 60_000);
  try {
    global.fetch = async () => { throw new Error('network down'); };
    const second = await market.getVix();
    assert.ok(second, '캐시가 있는데 null 을 줬다(60분 유예 안에서는 재사용해야 한다)');
    assert.equal(second.stale, true, 'stale 표시가 안 붙었다');
    assert.equal(second.ageMin, 47, `ageMin 이 47 이 아니다: ${second.ageMin}`);
  } finally {
    unfreeze();
  }
});

test('신선한 경우(캐시 5분 이내) — ageMin/stale 이 안 붙는다(회귀 없음)', async () => {
  const market = freshMarketData();
  const T0 = Date.parse('2026-09-28T09:00:00+09:00');
  const unfreeze = freezeGlobalDate(T0);
  try {
    global.fetch = async () => okVixResponse();
    const first = await market.getVix();
    assert.equal(first.stale, false);
    assert.equal(first.ageMin, undefined, '신선한 값에 ageMin 이 붙었다 — 코드가 안 바뀌었어야 한다');
  } finally {
    unfreeze();
  }
});
