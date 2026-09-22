/**
 * 종목 정체 — 순수부 (2026-09-22)
 *
 * 배경: 이름이 "RAM" 뿐이라 모델이 레버리지 여부를 회차마다 지어냈다(정반대 답 실측).
 * 토스가 englishName·leverageFactor·listDate 를 주는데 getStockInfo 가 버리고 있었다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../server/stockIdentity');

const NOW = Date.parse('2026-09-22T12:00:00Z');

const RAM_INFO = new Map([
  ['RAM', {
    name: 'RAM',
    englishName: 'ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF',
    securityType: 'ETF', leverageFactor: '2', listDate: '2026-06-24',
  }],
]);

test('enrich: 정식명·배수·상장일이 붙고 원본 name 은 안 덮인다', async () => {
  const items = await identity.enrich([{ symbol: 'RAM', name: 'RAM', quantity: 442 }], RAM_INFO);
  const it = items[0];
  assert.equal(it.name, 'RAM'); // 토스 화면과 같은 이름 유지
  assert.equal(it.officialName, 'ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF');
  assert.equal(it.leverageFactor, 2); // 숫자로 정규화
  assert.equal(it.listDate, '2026-06-24');
  assert.equal(it.quantity, 442); // 기존 필드 보존
});

test('enrich: 정보가 없으면 항목을 그대로 둔다(1 로 지어 채우지 않는다)', async () => {
  const items = await identity.enrich([{ symbol: 'XXXX', name: 'XXXX' }], new Map());
  assert.equal(items[0].leverageFactor, undefined);
  assert.equal(items[0].officialName, undefined);
});

test('describeLine: 레버리지 2배는 🔴 + 감쇠 경고, 신규 상장은 52주 이력 부인', () => {
  const [it] = [{ symbol: 'RAM', name: 'RAM', officialName: 'ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF', securityType: 'ETF', leverageFactor: 2, listDate: '2026-06-24' }];
  const line = identity.describeLine(it, NOW);
  assert.match(line, /레버리지 2배/);
  assert.match(line, /감쇠/);
  assert.match(line, /52주 이력이 존재하지 않는다/);
  assert.match(line, /ROUNDHILL/);
});

test('describeLine: ETF 인데 배수를 모르면 "확인 못 함" — 1배로 지어내지 않는다', () => {
  const line = identity.describeLine({ symbol: 'QLD', name: 'QLD', securityType: 'ETF' }, NOW);
  assert.match(line, /레버리지 배수 확인 못 함/);
  assert.doesNotMatch(line, /1배/);
});

test('sectionFromItems: 혼동 금지·52주 규칙이 데이터와 함께 실린다 / 빈 목록이면 빈 문자열', () => {
  const s = identity.sectionFromItems(
    [{ symbol: 'RAM', name: 'RAM', officialName: 'X', securityType: 'ETF', leverageFactor: 2, listDate: '2026-06-24' }],
    NOW
  );
  assert.match(s, /## 종목 정체/);
  assert.match(s, /다른 회사와 혼동 금지/);
  assert.match(s, /52주 고점/);
  assert.equal(identity.sectionFromItems([]), '');
});
