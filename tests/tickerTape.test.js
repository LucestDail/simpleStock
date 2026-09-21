const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const tape = require('../server/tickerTapeService');
const realFetch = global.fetch;

/**
 * 헤더 시세 테이프 (2026-09-21)
 *
 * ## 🔴 이 자의 초점은 **라벨이 값과 맞는가** 다
 *
 * 숫자는 야후가 준다. 우리가 틀릴 수 있는 곳은 **무엇이라고 부르는가** 인데,
 * 여기서 틀리면 **틀린 줄도 모른다** — 30년물 수익률에 "20년" 이라 적어도 숫자는 그럴듯하다.
 * 실제로 사용자는 "미국 국채 2-5-10-20년" 을 요청했지만 야후에 20년물 심볼이 없고,
 * `^TYX` 는 **30년물**이다. 있는 그대로 적었는지 자로 잠근다.
 */

function ok(price, prev) {
  return {
    ok: true,
    json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev } }] } }),
  };
}

beforeEach(() => tape._resetForTest());
afterEach(() => {
  global.fetch = realFetch;
});

test('요청한 항목을 빠짐없이 담았다 (한국 국채는 제외 — 출처가 없다)', () => {
  const labels = tape.TAPE_SYMBOLS.map((s) => s.label).join(' ');
  for (const must of [
    '코스피', '코스닥', '나스닥', '나스닥100 선물', 'S&P 500', 'S&P 500 선물',
    '러셀2000', '러셀2000 선물', '다우존스', 'VIX', '달러인덱스',
    '금', '은', 'WTI', '천연가스', '구리', '밀',
    '비트코인', '이더리움', '리플', '솔라나',
  ]) {
    assert.ok(labels.includes(must), `빠졌다: ${must}`);
  }
  // 🔴 못 띄우는 것을 **조용히 빼지 않고** 적어 뒀는가
  assert.ok(tape.UNAVAILABLE.some((u) => /국고채/.test(u)), '한국 국채를 왜 못 띄우는지 안 적었다');
});

/**
 * 🔴 **라벨이 실제 상품과 달라지면 그게 거짓말이다.**
 * 숫자는 맞는데 이름이 틀리면 사용자는 영원히 모른다.
 */
test('대용품·다른 만기를 라벨에 정직하게 적었다', () => {
  const bySym = Object.fromEntries(tape.TAPE_SYMBOLS.map((s) => [s.symbol, s]));

  // ^TYX 는 30년물이다. 사용자가 "20년" 이라 적었어도 30년이라 적어야 한다
  assert.match(bySym['^TYX'].label, /30년/, '^TYX 는 30년물인데 다른 만기로 적혀 있다');
  assert.ok(!/20년/.test(bySym['^TYX'].label), '^TYX 에 20년이라 적으면 거짓이다');

  // SOXX 는 지수가 아니라 ETF 다 — 지수인 척하면 안 된다
  assert.ok(!/^필라델피아 반도체$/.test(bySym.SOXX.label), 'ETF 를 지수 이름으로 달았다');
  assert.match(bySym.SOXX.label, /SOXX/, '대용품이라는 사실이 라벨에 없다');

  // 2년물은 선물이다
  assert.match(bySym['2YY=F'].label, /선물/, '2YY=F 는 선물인데 현물처럼 적혀 있다');

  // 🔴 밀은 센트다 — 달러 기호를 붙이면 1,000배 틀린 값으로 읽힌다
  assert.equal(bySym['ZW=F'].prefix || '', '', '밀에 달러 기호가 붙었다(야후는 센트로 준다)');
  assert.equal(bySym['ZW=F'].suffix, '¢');

  // 수익률은 % 다(가격이 아니다)
  for (const y of ['^FVX', '^TNX', '^TYX', '2YY=F']) assert.equal(bySym[y].suffix, '%', `${y} 단위 표기 누락`);
});

test('등락률을 계산으로 내고, 전일종가가 없으면 0 이 아니라 null 이다', async () => {
  global.fetch = async () => ok(110, 100);
  const a = await tape.getTape();
  assert.ok(Math.abs(a.items[0].changePct - 10) < 1e-9);

  tape._resetForTest();
  // 🔴 0% 는 "안 움직였다" 는 **거짓말**이다. 모르면 모른다고 한다
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 110 } }] } }),
  });
  const b = await tape.getTape();
  assert.equal(b.items[0].changePct, null);
});

test('엔/원은 100엔 기준으로 환산하고 그 사실을 라벨에 적는다', async () => {
  global.fetch = async () => ok(8.7, 8.7);
  const t = await tape.getTape();
  const jpy = t.items.find((i) => i.symbol === 'JPYKRW=X');
  assert.ok(Math.abs(jpy.price - 870) < 1e-9, '100배 환산이 안 됐다');
  assert.match(jpy.label, /100엔/, '환산했으면 라벨에 적어야 한다');
});

/** ⚠️ 하나가 죽어도 나머지는 흐른다. 못 받은 개수를 **세어서** 돌려준다 */
test('조각 실패를 전체 실패로 만들지 않는다', async () => {
  let n = 0;
  global.fetch = async () => {
    n += 1;
    if (n % 5 === 0) throw new Error('네트워크');
    return ok(100, 100);
  };
  const t = await tape.getTape();
  assert.ok(t.items.length > 0, '일부 실패로 전부 버렸다');
  assert.ok(t.failed > 0, '실패 건수를 안 셌다');
  assert.equal(t.items.length + t.failed, tape.TAPE_SYMBOLS.length, '어디로 샜다');
});

/**
 * 🔴 전부 실패했을 때 **직전 값을 버리지 않는다** — 테이프가 비는 것보다 낫다.
 *    다만 `stale` 로 표시해 화면이 흐리게 보여줄 수 있어야 한다(조용히 옛 값을 보여주면 안 된다).
 */
test('전부 실패하면 직전 값을 유지하되 stale 로 표시한다', async () => {
  global.fetch = async () => ok(100, 100);
  const first = await tape.getTape();
  assert.ok(first.items.length);

  global.fetch = async () => { throw new Error('전부 죽음'); };
  const second = await tape.getTape({ force: true });
  assert.equal(second.items.length, first.items.length, '직전 값을 버렸다');
  assert.equal(second.stale, true, 'stale 표시가 없으면 사용자는 옛 값인 줄 모른다');
});

test('캐시가 살아 있으면 다시 받지 않는다 (무인증 API 를 아낀다)', async () => {
  let calls = 0;
  global.fetch = async () => { calls += 1; return ok(100, 100); };
  await tape.getTape();
  const n = calls;
  await tape.getTape();
  assert.equal(calls, n, '캐시가 있는데 또 받았다');
});
