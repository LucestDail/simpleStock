/**
 * 정식명 정규화 — **양방향으로 잠근다** (2026-10-02)
 *
 * 🔴 아래 표는 **2026-10-02 라이브 A/B 실측**이다(my-computer `webSearch` 를 실제로 쏴서 셌다).
 * ```
 *   종목  질의                                            적중/5  오염
 *   QLD   PROSHARES TRUST PSHS ULTRA QQQ  (원본)            1      4   ← UltraPro Short·TQQQ·QID
 *   QLD   PROSHARES ULTRA QQQ             (정규화)          1      0   ✅ 채택
 *   RAM   ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF     1      1
 *   RAM   ROUNDHILL T-REX 2X LONG DRAM ETF (DAILY/TARGET 뺌) 0      0   🔴 적중을 잃었다
 *   O     Realty Income                                     5      0   ✅ 어떤 변형에도 안 망가짐
 * ```
 * ⇒ 얻는 것은 **"적중 상승" 이 아니라 "오염 제거"** 다(소형 ETF 는 자체 뉴스가 원래 드물다).
 *   그리고 **오염은 그냥 잡음이 아니라 방향이 반대인 상품**이라 판단을 뒤집는다.
 *
 * ⚠️ 내 첫 규칙은 `DAILY`·`TARGET` 도 뺐고 **RAM 의 적중을 1 → 0 으로 깎았다.**
 *    측정이 아니었으면 그대로 배포했다. ⇒ 원칙을 **법인형 + 중복 축약**으로 좁혔다.
 *    ★ 한 종목에 맞춘 게 아니라 **원칙을 고친 것**이다 — 그 차이를 이 주석이 기록한다.
 */
const test = require('node:test');
const assert = require('node:assert');
const { normalizeOfficialName, isAbbrevOf, DROP } = require('../server/officialName');

test('🔴 바뀌어야 하는 것 — 법인 수식어와 중복 축약만 뗀다', () => {
  assert.strictEqual(
    normalizeOfficialName('PROSHARES TRUST PSHS ULTRA QQQ'),
    'PROSHARES ULTRA QQQ', '오염 4건을 만들던 바로 그 이름');
  assert.strictEqual(normalizeOfficialName('SPDR S&P 500 ETF TRUST'), 'SPDR S&P 500 ETF');
  assert.strictEqual(normalizeOfficialName('BERKSHIRE HATHAWAY INC CLASS B'), 'BERKSHIRE HATHAWAY CLASS B');
});

test('🔴 안 바뀌어야 하는 것 — 건드리면 실측에서 나빠진 이름들', () => {
  // 실측: DAILY·TARGET 을 빼면 적중 1 → 0
  assert.strictEqual(
    normalizeOfficialName('ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF'),
    'ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF');
  // 실측: 이미 5/5·오염 0 — 어떤 변형에도 안 망가지지만 **그래도 안 건드린다**
  assert.strictEqual(normalizeOfficialName('Realty Income'), 'Realty Income');
});

test('🔴 방향·배수는 절대 안 뗀다 — 떼면 반대 상품과 구분이 사라진다', () => {
  for (const n of [
    'PROSHARES ULTRAPRO SHORT QQQ',
    'DIREXION DAILY SEMICONDUCTOR BEAR 3X SHARES',
    'PROSHARES ULTRASHORT S&P500',
  ]) {
    const got = normalizeOfficialName(n);
    for (const keep of ['SHORT', 'BEAR', '3X', 'ULTRA']) {
      if (n.toUpperCase().includes(keep)) {
        assert.ok(got.toUpperCase().includes(keep), `${keep} 가 사라졌다: ${n} → ${got}`);
      }
    }
  }
  // 금지목록에 방향 낱말이 **들어가 있지 않은지** 구조로 확인한다(나중에 누가 넣을 수 있다)
  for (const bad of ['LONG', 'SHORT', 'ULTRA', 'BEAR', 'BULL', '2X', '3X', 'DAILY', 'TARGET']) {
    assert.ok(!DROP.has(bad), `DROP 에 방향·구조 낱말이 들어갔다: ${bad}`);
  }
});

test('⚠️ 전부 지워지면 원본을 쓴다 — 빈 질의는 검색을 통째로 무의미하게 만든다', () => {
  assert.strictEqual(normalizeOfficialName('TRUST'), 'TRUST');
  assert.strictEqual(normalizeOfficialName('THE FUND'), 'THE FUND');
  assert.strictEqual(normalizeOfficialName(''), '');
  assert.strictEqual(normalizeOfficialName(null), '');
});

test('자음 축약 판정의 판별력 — 짧은 조각이 걸리면 안 된다', () => {
  assert.ok(isAbbrevOf('PSHS', 'PROSHARES'));
  assert.ok(!isAbbrevOf('P', 'PROSHARES'), '1글자는 보지 않는다');
  assert.ok(!isAbbrevOf('QQQ', 'PROSHARES'), '부분집합이 아니면 아니다');
  assert.ok(!isAbbrevOf('PROSHARES', 'PROSHARES'), '같은 길이는 축약이 아니다');
});

test('🔴 배선 — buildQuery 가 실제로 이 정규화를 탄다', () => {
  delete require.cache[require.resolve('../server/mcpClient')];
  const mcp = require('../server/mcpClient');
  assert.strictEqual(
    mcp.buildQuery({ symbol: 'QLD', name: 'QLD', officialName: 'PROSHARES TRUST PSHS ULTRA QQQ' }),
    'PROSHARES ULTRA QQQ', '정규화가 질의에 안 닿았다');
  assert.strictEqual(
    mcp.buildQuery({ symbol: 'RAM', name: 'RAM', officialName: 'ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF' }),
    'ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF');
  // ⚠️ 정규화 뒤에도 **맨 티커 가드는 살아 있어야 한다**
  assert.strictEqual(mcp.isBareTickerQuery({ symbol: 'QLD', name: 'QLD' }, 'QLD'), true);
});
