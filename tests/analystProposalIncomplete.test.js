const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **반쪽 제안이 조용히 증발하고 있었다** (2026-10-01)
 *
 * `asProposal` 은 `symbol`·`side`·`quantity>0`·`price>0` 중 하나라도 없으면
 * **말없이 `null`** 을 돌려줬다. 그래서 `proposed:0` 을 볼 때
 *   · 모델이 **제안을 안 낸 것**인지
 *   · 반쪽 제안을 냈는데 **우리가 버린 것**인지
 * **원리상 구분할 수 없었다.** 몇 건이 증발했는지 셀 방법이 아예 없었다.
 * 형제인 `asPosition` 은 같은 자리에 이미 `stance_unrecognized` 를 갖고 있었다 —
 * **형제 중 하나만 빠진** 그 전형이다.
 *
 * ⚠️ 그런데 **소음이면 침묵과 같다.** 이 함수는 모델 응답의 *모든 배열의 모든 원소*에
 *    불리고, `side` 자리의 `BUY|SELL` 은 **판단(stance)** 으로도 들어온다.
 *    ⇒ 발동 축과 **오탐 축을 같은 무게로** 잠근다.
 */

const analyst = require('../server/analystService');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf-8');

/** 콘솔 warn 을 가로채 **이 사건만** 센다 */
const realWarn = console.warn;
let warns = [];
beforeEach(() => {
  warns = [];
  console.warn = (line) => {
    try {
      const o = JSON.parse(line);
      if (o?.event === 'analyst.proposal_incomplete') warns.push(o);
    } catch { /* 우리 포맷이 아니면 무시 */ }
  };
});
afterEach(() => { console.warn = realWarn; });

/** `shapeReport` 를 통해 태운다 — **실제 경로**로 들어가야 분기가 산 채로 검사된다 */
const shape = (arr) => analyst.shapeReport({ marketView: 'v', proposals: arr });

// ── 발동 축 ──────────────────────────────────────────────────

test('🔴 수량이 빠진 제안이 **보이게** 버려진다', () => {
  const r = shape([{ symbol: 'QLD', side: 'BUY', price: 88.93 }]);
  assert.equal(r.proposals.length, 0, '반쪽 제안은 여전히 버린다(거부될 것을 만들지 않는다)');
  assert.equal(warns.length, 1, '🔴 조용히 증발했다 — 몇 건이 사라졌는지 셀 수 없다');
  assert.equal(warns[0].symbol, 'QLD');
  assert.equal(warns[0].side, 'BUY');
  assert.deepEqual(warns[0].missing, ['quantity>0']);
  assert.match(warns[0].received, /QLD/, '🔴 원문이 없으면 "모델이 뭐라 했는지" 를 또 추론해야 한다');
});

test('🔴 가격이 빠진 제안도 짖는다', () => {
  shape([{ symbol: 'RAM', side: 'SELL', quantity: 10 }]);
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0].missing, ['price>0']);
});

test('🔴 종목만 빠져도 짖는다 (수량·가격은 왔다 = 명백한 제안 시도)', () => {
  shape([{ side: 'BUY', quantity: 3, price: 50 }]);
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0].missing, ['symbol']);
  assert.equal(warns[0].symbol, null, '못 읽은 종목은 null 이다(빈 문자열로 뭉개지 않는다)');
});

/**
 * 🔴 **`quantity: 0` 처럼 "틀린 값" 이야말로 보고 싶은 것**이다 —
 *    키의 존재로 판정해야 이 모양이 잡힌다(값으로 판정하면 0 은 "없음" 과 같아진다).
 */
test('🔴 수량이 0 인 제안이 잡힌다 (키는 있고 값이 틀린 모양)', () => {
  shape([{ symbol: 'QLD', side: 'BUY', quantity: 0, price: 88.93 }]);
  assert.equal(warns.length, 1, '🔴 0 을 "키 없음" 과 같게 보면 이 모양이 영영 안 보인다');
  assert.deepEqual(warns[0].missing, ['quantity>0']);
});

test('⚠️ 여러 칸이 빠지면 **전부** 적는다', () => {
  shape([{ side: 'BUY', quantity: 'abc', price: null }]);
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0].missing, ['symbol', 'quantity>0', 'price>0']);
});

test('⚠️ 두 건이 반쪽이면 **두 줄**이 난다 (건수를 셀 수 있어야 한다)', () => {
  shape([
    { symbol: 'QLD', side: 'BUY', price: 88.93 },
    { symbol: 'RAM', side: 'SELL', quantity: 5 },
  ]);
  assert.equal(warns.length, 2);
});

// ── 오탐 축 (이쪽이 더 중요하다 — 소음이면 아무도 안 읽는다) ──

/**
 * 🔴 **보유 판단은 제안이 아니다.** `STANCES` 에 BUY·SELL 이 있어서
 *    `{symbol, action:'BUY', confidence, rationale}` 같은 판단이 `asProposal` 까지 온다.
 *    그걸 짖으면 **매 회차 종목 수만큼** 경고가 나고, 그 로그는 읽히지 않는다.
 */
test('🔴 오탐 축: 보유 **판단**(수량·가격 칸이 아예 없음)에는 짖지 않는다', () => {
  const r = analyst.shapeReport({
    marketView: 'v',
    positions: [{ symbol: 'QLD', action: 'BUY', confidence: 'HIGH', rationale: '추세 전환' }],
  });
  assert.equal(warns.length, 0, '🔴 판단을 반쪽 제안으로 오인했다 — 매 회차 소음이 된다');
  assert.equal(r.positions.length, 1, '판단은 판단으로 읽혀야 한다');
});

test('🔴 오탐 축: 아무 관련 키도 없는 객체는 조용하다', () => {
  analyst.shapeReport({ marketView: 'v', notes: [{ side: 'BUY', memo: '그냥 메모' }] });
  assert.equal(warns.length, 0, '🔴 제안 시도가 아닌 객체까지 짖는다');
});

test('⚠️ 오탐 축: 정상 제안에는 한 글자도 안 남는다', () => {
  const r = shape([{ symbol: 'QLD', side: 'BUY', quantity: 2, price: 88.93, reason: 'r' }]);
  assert.equal(r.proposals.length, 1);
  assert.equal(warns.length, 0, '🔴 멀쩡한 제안에 경고가 났다');
});

test('⚠️ 오탐 축: side 가 BUY/SELL 이 아니면 애초에 대상이 아니다', () => {
  analyst.shapeReport({ marketView: 'v', rows: [{ symbol: 'QLD', side: 'HOLD', quantity: 1, price: 2 }] });
  assert.equal(warns.length, 0, '🔴 HOLD 는 제안 시도가 아니다');
});

// ── 자의 생존 확인 ───────────────────────────────────────────

/**
 * 🔴 **가드가 실제로 그 자리에 있는가** — 위 단언들은 "경고가 났다" 만 보고,
 *    누가 조건을 통째로 느슨하게 해도 일부는 통과할 수 있다. 구조로 한 번 더 못박는다.
 *    ⚠️ 주석·문자열을 지우고 **코드로** 본다(이름이 주석에만 있어도 통과하면 안 된다).
 */
test('🔴 경고가 `asProposal` 의 **탈락 경로 안**에 있다', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const i = code.indexOf('function asProposal');
  assert.ok(i > 0, '🔴 대상 함수를 못 찾았다');
  const block = code.slice(i, i + 1600);
  assert.match(block, /analyst\.proposal_incomplete/, '🔴 탈락이 다시 조용해졌다');
  assert.match(block, /missing/, '🔴 무엇이 빠졌는지를 안 적으면 원인을 또 추론해야 한다');
  assert.match(block, /hasOwnProperty/, '🔴 키 존재로 좁히지 않으면 판단까지 짖어 소음이 된다');
});
