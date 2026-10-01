const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyst = require('../server/analystService');

/**
 * 사용자 보유 방침을 **코드가 지킨다** — 2026-10-01 라이브 실사고 가드
 *
 * ## 무엇이 아팠나
 * 프롬프트에 이렇게 적혀 있었다:
 * ```
 * RAM: 사용자가 **보유 유지**를 정했다(평단 19.08 회복 대기, 16.0 근접 시 매도 검토).
 *   급락·구조 악화가 아니면 RAM SELL 제안을 반복하지 마라.
 * ```
 * 그런데 **2026-10-01 12:19 에 `RAM SELL 50주 @14.1` 이 폰으로 갔다.** 그때 RAM 은
 * 13.9 대였고 급락도 아니었다 — 허용 조건 어디에도 안 맞는다. 사용자는 12:43 에 거절했다.
 *
 * ★ **프롬프트는 지시일 뿐이고 보장은 코드가 한다** — 이 저장소가 셸 가드·도구 승인
 *   판정에서 이미 세 번 배운 것이다. 그런데 **방침 축에는 적용이 안 돼 있었다**
 *   ("규칙을 정하면 그 자리에서 적용 범위를 전수로 훑는다" 를 안 한 자리).
 *
 * ## 🔴 이 자가 재는 네 축 — 발동만 보면 안 된다
 * ```
 * 발동      허용 조건 밖의 매도를 막는가
 * 오탐 ①    조건을 만족하면 통과시키는가        ← 안 지키면 정당한 매도를 영영 못 한다
 * 오탐 ②    방침 없는 종목·매수는 안 건드리는가   ← 안 지키면 제품이 통째로 멈춘다
 * 모름      시세를 못 읽으면 **막지 않는다**     ← 데이터 장애가 사용자 결정을 막으면 안 된다
 * ```
 * ## ⚠️ 그리고 정본이 하나인지
 * 프롬프트 문구와 게이트가 **같은 설정 파일**에서 나온다. 두 벌이면 누가 값을 고쳐도
 * 한쪽만 바뀌고, 그러면 *"프롬프트는 16 이라는데 코드는 18에서 막는"* 상태가 된다.
 */

const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'holding-policy.json'), 'utf8'));
const RAM = POLICY.holdings.RAM;
const 허용가 = RAM.sellAllowedWhen.priceAtOrAbove;
const 급락선 = RAM.sellAllowedWhen.dayChangePctAtOrBelow;

const sell = (symbol, price) => ({ symbol, side: 'SELL', quantity: 50, price });
const held = (symbol, lastPrice, dailyRate) => ({ symbol, lastPrice, dailyRate });

// ── 발동 ────────────────────────────────────────────────────────

test('🔴 라이브에서 실제로 나갔던 그 제안을 막는다 (RAM SELL @14.1 · 현재 13.92)', () => {
  const r = analyst.holdingPolicyGate(sell('RAM', 14.1), held('RAM', 13.92, 3.45));
  assert.equal(r.ok, false, '12:19 에 폰으로 간 그 제안이 그대로 통과한다');
  assert.match(r.why, /보유 유지/);
  assert.match(r.why, /13\.92/, '왜 막혔는지 숫자가 없으면 사용자가 판단을 못 한다');
});

test('소문자 심볼·소문자 side 로 와도 막는다 (모델 출력은 모양이 흔들린다)', () => {
  assert.equal(analyst.holdingPolicyGate({ symbol: 'ram', side: 'sell', price: 14 }, held('RAM', 13.9, 0)).ok, false);
});

// ── 오탐 ① — 조건을 만족하면 통과해야 한다 ──────────────────────

test(`현재가가 ${허용가} 이상이면 매도를 허용한다 (사용자가 정한 바로 그 조건)`, () => {
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 허용가 + 0.2), held('RAM', 허용가, 1)).ok, true);
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 허용가 + 1), held('RAM', 허용가 + 0.5, 1)).ok, true);
});

test(`당일 ${급락선}% 이하 급락이면 매도를 허용한다`, () => {
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 12), held('RAM', 12.5, 급락선)).ok, true);
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 12), held('RAM', 12.5, 급락선 - 2)).ok, true);
});

test('경계: 허용가 바로 아래는 막고, 딱 그 값은 통과한다', () => {
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 16), held('RAM', 허용가 - 0.01, 0)).ok, false);
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 16), held('RAM', 허용가, 0)).ok, true);
});

// ── 오탐 ② — 대상이 아닌 것은 건드리지 않는다 ───────────────────

test('방침이 없는 종목은 안 건드린다 (QLD)', () => {
  assert.equal(analyst.holdingPolicyGate(sell('QLD', 97), held('QLD', 96.5, 1)).ok, true);
});

test('매수는 안 건드린다 — 방침은 "보유 유지" 이지 "거래 금지" 가 아니다', () => {
  assert.equal(analyst.holdingPolicyGate({ symbol: 'RAM', side: 'BUY', price: 13 }, held('RAM', 13.9, 1)).ok, true);
});

// ── 모름 ────────────────────────────────────────────────────────

test('🔴 시세를 못 읽으면 막지 않는다 (데이터 장애가 사용자 결정을 막으면 안 된다)', () => {
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 14), undefined).ok, true);
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 14), { symbol: 'RAM' }).ok, true);
});

test('한쪽만 알면 아는 쪽으로 판정한다 (등락률만 있어도 급락은 가른다)', () => {
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 12), { symbol: 'RAM', dailyRate: 급락선 - 1 }).ok, true);
  assert.equal(analyst.holdingPolicyGate(sell('RAM', 14), { symbol: 'RAM', dailyRate: 0 }).ok, false);
});

// ── 정본이 하나인지 ─────────────────────────────────────────────

test('🔴 프롬프트 문구가 게이트와 같은 설정에서 나온다 (두 벌이면 조용히 갈라진다)', () => {
  const lines = analyst.holdingPolicyLines().join('\n');
  assert.ok(lines.includes('RAM'), '방침 문구에 대상 종목이 없다');
  assert.ok(lines.includes(String(허용가)), `프롬프트가 허용가(${허용가})를 안 적는다 — 모델이 기준을 모른다`);
  assert.ok(lines.includes(String(급락선)), `프롬프트가 급락선(${급락선})을 안 적는다`);
  assert.ok(lines.includes('코드가 거부한다'), '코드가 막는다는 사실을 모델에게 안 알린다');
});

test('설정에 종목을 더하면 문구와 게이트가 **함께** 바뀐다', () => {
  // 하드코딩이면 이 테스트가 깨진다 — 정본이 하나라는 것의 실증
  const syms = Object.keys(POLICY.holdings);
  const lines = analyst.holdingPolicyLines().join('\n');
  for (const s of syms) {
    assert.ok(lines.includes(s), `${s} 가 설정엔 있는데 프롬프트 문구엔 없다`);
    const r = analyst.holdingPolicyGate(sell(s, 1), held(s, 1, 0));
    assert.equal(r.ok, false, `${s} 가 설정엔 있는데 게이트가 안 본다`);
  }
  assert.ok(syms.length >= 1, '검사 대상이 0건이면 이 자는 아무것도 안 본 것이다');
});
