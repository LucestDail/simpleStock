/**
 * 산문 가격 수치 검증 — **자의 판별력을 먼저 잰다** (2026-10-02)
 *
 * 🔴 아래 문장은 **지어낸 예시가 아니라 2026-10-02 15:30 KRX 마감 회차에서 모델이
 *    실제로 쓴 글**이다. 손으로 꾸민 문장으로 자를 만들면 라이브의 모양을 못 잡는다
 *    (이 저장소가 외부 API 파싱에서 여러 번 배운 것 — 실응답을 픽스처로).
 *
 * 양방향으로 잠근다:
 *   걸려야 하는 것   QLD 806/732 (실제 96.84) · RAM 46.10/48.80 (실제 14.55)
 *   통과해야 하는 것 BRK.B 495/504/506 (실제 501.15) · O · 그리고 **기간 숫자**
 *                   (`20일선`의 20 · `52주`의 52 · `60일선`의 60 · `1.11%`)
 *
 * ⚠️ 첫 판은 "현재가의 2.5배 밖" 만 봤고 **기간 숫자가 전부 걸렸다.**
 *    그 오탐을 안 재고 배포했으면 **매 회차가 재요청을 돌았을 것**이다.
 */
const test = require('node:test');
const assert = require('node:assert');
const P = require('../server/proseNumbers');

/** 그날의 실제 보고서 조각 */
const LIVE = [
  { symbol: 'QLD',
    scenarioUp: '20일선(약 806) 회복 시 모멘텀 복귀로 반등',
    scenarioDown: '60일선(약 732) 이탈 시 추가 하락' },
  { symbol: 'RAM',
    scenarioUp: '반도체 업황 개선 시 52주 고점(48.80) 경신 시도',
    scenarioDown: '20일선(46.10) 이탈 시 변동성 확대' },
  { symbol: 'BRK.B',
    scenarioUp: '60일선(약 504) 지지 시 20일선(약 506) 복귀',
    scenarioDown: '60일선 이탈 시 495 아래로 추가 하락',
    risk: '일간변동성 1.11% 수준' },
  { symbol: 'O',
    scenarioUp: '20일선 57.11 회복 시 반등',
    scenarioDown: '60일선 61.27 이탈 시 추가 하락',
    rationale: '금리 상승기 리츠 약세 · 평단 54.03 대비 -0.65%' },
];

/** 그날 프롬프트가 실제로 준 값 */
const REF = {
  QLD: { last: 96.84, ma20: 92.69, ma60: 90.13, swingLow: 86.96, swingHigh: 97.82 },
  RAM: { last: 14.55, ma20: 13.67, ma60: 12.86, swingLow: 11.53, swingHigh: 15.35 },
  'BRK.B': { last: 501.15, ma20: 506.74, ma60: 504.71 },
  O: { last: 53.68, ma20: 57.11, ma60: 61.27 },
};

test('🔴 지어낸 수치를 잡는다 — QLD 806/732 · RAM 46.10/48.80', () => {
  const hits = P.findPriceOutliers(LIVE, REF);
  const got = hits.map((h) => `${h.symbol}:${h.raw}`).sort();
  assert.deepStrictEqual(got, ['QLD:732', 'QLD:806', 'RAM:46.10', 'RAM:48.80'].sort(),
    `잡은 것: ${JSON.stringify(got)}`);
});

test('⚠️ 오탐 0 — 기간 숫자와 멀쩡한 가격은 안 걸린다', () => {
  const hits = P.findPriceOutliers(LIVE, REF);
  const bad = hits.filter((h) => h.symbol === 'BRK.B' || h.symbol === 'O');
  assert.deepStrictEqual(bad, [], `오탐: ${JSON.stringify(bad)}`);
  // 🔴 오탐이 나면 **매 회차가 재요청을 돈다** — 놓침보다 비용이 자주 발생한다
  const nums = P.priceNumbers('20일선(약 806) 회복 · 52주 고점 · 60일선 · 1.11% · 300주 · 2026년');
  assert.deepStrictEqual(nums.map((n) => n.raw), ['806'],
    '기간·퍼센트·수량·연도가 가격으로 샜다');
});

test('기준값이 없으면 통과가 아니라 **미검사**로 센다', () => {
  const hits = P.findPriceOutliers([{ symbol: 'ZZZZ', scenarioUp: '목표 99999' }], REF);
  assert.deepStrictEqual(hits, [], '기준이 없으면 판정하지 않는다');
  const un = P.unverifiable([{ symbol: 'ZZZZ', scenarioUp: 'x' }], REF);
  assert.deepStrictEqual(un, ['ZZZZ'], '미검사 종목이 집계되지 않으면 0을 통과로 읽는다');
});

test('코드가 채운 자리는 검사하지 않는다 (자기 글을 검사하는 꼴)', () => {
  const hits = P.findPriceOutliers(
    [{ symbol: 'QLD', _codeFilled: true, scenarioUp: '20일선 99999 회복' }], REF);
  assert.deepStrictEqual(hits, []);
});

test('재요청 문구에 **맞는 값**이 들어간다 — 거부만 하면 같은 답을 또 낸다', () => {
  const hits = P.findPriceOutliers(LIVE, REF);
  const note = P.retryNote(hits, REF);
  assert.match(note, /QLD/);
  assert.match(note, /92\.69/, '20일선 실제값이 안 들어갔다');
  assert.match(note, /90\.13/, '60일선 실제값이 안 들어갔다');
  assert.match(note, /13\.67/, 'RAM 실제값이 안 들어갔다');
  assert.ok(!/806/.test(note.split('\n')[0]), '머리말에 틀린 값이 먼저 오면 안 된다');
});

test('재요청까지 실패하면 코드가 **사실로** 교체한다', () => {
  const p = P.replaceWithFacts({ symbol: 'QLD', scenarioUp: '20일선(약 806)' }, REF.QLD);
  assert.match(p.scenarioUp, /92\.69/);
  assert.match(p.scenarioDown, /90\.13/);
  assert.strictEqual(p._priceFabricated, true, '무슨 일이 있었는지 표시가 남아야 한다');
  // ⚠️ 교체본에는 지어낸 값이 **한 글자도** 남으면 안 된다
  assert.ok(!/806/.test(JSON.stringify(p)));
});

test('🔴 자가 살아 있는지 — 허용 배수를 풀면 반드시 놓친다', () => {
  // 변이 검증을 영구 테스트로 둔다(일회성 손 변이는 "안 돌았다" 를 "통과" 로 읽기 쉽다)
  const loose = P.findPriceOutliers(LIVE, REF, { factor: 100 });
  assert.deepStrictEqual(loose, [], '배수를 100 으로 풀었는데도 걸린다면 다른 축이 판정하고 있다');
  const tight = P.findPriceOutliers(LIVE, REF, { factor: 2.5 });
  assert.ok(tight.length === 4, '기본 배수에서 4건을 잡아야 한다');
});

/**
 * 🔴 **배선 테스트** — 순수 함수만 재면 *"로직은 맞는데 안 불린다"* 를 못 잡는다.
 *    (이 저장소가 2026-09-12 에 비싸게 배운 것: `SecretRedactor` 15건이 전부 초록인데
 *     본체가 그 함수를 안 부르고 있었다. 호출 한 줄을 지워도 **전부 초록불**이었다.)
 * ⚠️ 소스를 훑는 자이므로 **주석을 먼저 지운다** — 설명문에 이름이 남아 조용히 통과하면
 *    가드가 아니라 장식이 된다.
 */
test('🔴 배선이 살아 있다 — analyze() 가 실제로 이 검증을 탄다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 블록 주석
    .replace(/^\s*\/\/.*$/gm, ' ');       // 줄 주석
  for (const call of [
    "require('./proseNumbers')",
    'prose.findPriceOutliers(',
    'prose.retryNote(',
    'prose.replaceWithFacts(',
    'prose.unverifiable(',
  ]) {
    assert.ok(src.includes(call), `배선이 끊겼다: ${call} 가 코드에 없다(주석 제외)`);
  }
  // 3단 전부가 있어야 한다 — 검출만 하고 아무것도 안 하면 로그만 쌓인다
  assert.match(src, /analyst\.prose_price_outlier/, '검출 로그가 없다');
  assert.match(src, /analyst\.prose_price_fabricated/, '최종 교체 로그가 없다');
  assert.match(src, /trade_analyst_price_fix/, '재요청 경로가 없다');
});
