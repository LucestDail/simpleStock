const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **데이터 개선** (2026-09-22 사용자 지시: *"데이터 좀 개선해봐"*)
 *
 * ## 먼저 확인한 사실 — **토스에 관심종목 API 는 없다**
 * 명세 33개 전수 확인: `관심`·`즐겨`·`favorite`·`watchlist`·`interest` **0건**.
 * 오픈API 는 **거래·시세만** 열려 있고 앱의 개인 설정(관심종목)은 노출되지 않는다.
 * ⇒ 관심종목은 우리 쪽 `watchlist.json` 이 정본이고, **토스에서 가져올 방법이 없다.**
 *
 * ## 그래서 고친 것 — **수집해 놓고 안 쓰던 것**
 * `getWarnings`·`getShortSelling` 은 클라이언트가 **있는데 분석이 한 번도 안 불렀다.**
 * 이 저장소가 반복해 밟은 그 패턴이다(오늘만 로그·감사·지문에서 여러 번 나왔다).
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf-8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const TOSS = fs.readFileSync(path.join(__dirname, '..', 'server', 'tossClient.js'), 'utf-8');

test('🔴 분석이 `getWarnings` 를 **실제로 부른다**', () => {
  assert.match(code, /toss\.getWarnings\(/, '🔴 만들어 놓고 안 부른다 — 정리매매 종목을 사라고 할 수 있다');
});

test('🔴 분석이 `getShortSelling` 을 **실제로 부른다**', () => {
  assert.match(code, /toss\.getShortSelling\(/, '🔴 공매도 동향이 수집만 되고 안 쓰인다');
});

/** ⚠️ 국내 전용 API 를 미국 종목에 부르면 낭비다 */
test('⚠️ 공매도는 **KR 일 때만** 부른다', () => {
  const i = code.indexOf('toss.getShortSelling(');
  const before = code.slice(Math.max(0, i - 400), i);
  assert.match(before, /isKr|KR/, '🔴 시장 구분 없이 부른다 — 미국 종목에 국내 전용 API 를 친다');
});

/** 🔴 유의사항은 **점수보다 먼저**여야 한다 — 100점이라도 정리매매면 사면 안 된다 */
test('🔴 유의사항이 프롬프트에서 "매수 제안 금지" 를 명시한다', () => {
  const i = code.indexOf('매수 유의사항');
  assert.ok(i > 0, '🔴 유의사항이 프롬프트에 안 실린다');
  const block = code.slice(i, i + 700);
  assert.match(block, /매수 제안을 내지 마라/, '🔴 경고만 보여 주고 행동을 막지 않는다');
  assert.match(block, /점수가 높아도/, '🔴 점수와의 우선순위가 없다');
});

test('🔴 지수 투자자별 매매대금이 **국장 브리핑일 때** 붙는다', () => {
  assert.match(code, /getIndexInvestorTrading\(/, '🔴 지수 수급을 안 부른다');
  const i = code.indexOf('getIndexInvestorTrading(');
  const before = code.slice(Math.max(0, i - 300), i);
  assert.match(before, /briefMarkets\.includes\('kr'\)/,
    '🔴 국장 브리핑이 아닐 때도 부른다 — 쓰지도 않을 한도를 깎는다');
});

test('🔴 지수 수급이 프롬프트까지 간다 (모으고 버리지 않는다)', () => {
  const i = code.indexOf('국내 지수 투자자별 매매대금');
  assert.ok(i > 0, '🔴 모으기만 하고 프롬프트에 안 넣는다');
  const block = code.slice(i, i + 900);
  assert.match(block, /개인|외국인|기관/, '🔴 투자자 분류가 없다');
  assert.match(block, /중계다/, '⚠️ "등락률만 되풀이하지 마라" 지시가 없다');
});

/** ⚠️ 지수 API 는 KOSPI/KOSDAQ 만 받는다 — 종목 코드를 넣으면 400 */
test('⚠️ 지수 API 가 잘못된 심볼을 **부르기 전에** 막는다', () => {
  const i = TOSS.indexOf('async function getIndexInvestorTrading');
  const block = TOSS.slice(i, i + 700);
  assert.match(block, /KOSPI.*KOSDAQ|KOSDAQ.*KOSPI/s, '🔴 허용 심볼 검사가 없다');
  assert.ok(block.indexOf('throw') < block.indexOf('apiGet'),
    '🔴 검사보다 호출이 먼저다 — 400 을 맞고 나서야 안다');
});

/** ⚠️ 실패를 조용히 넘기지 않는다 */
test('⚠️ 세 조회 모두 실패 시 로그가 남는다', () => {
  for (const ev of ['analyst.warnings_failed', 'analyst.short_selling_failed', 'analyst.index_flow_failed']) {
    assert.ok(code.includes(ev), `🔴 ${ev} 가 없다 — 실패가 "데이터 없음" 으로 보인다`);
  }
});
