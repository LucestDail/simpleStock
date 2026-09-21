const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, opinionFor, bandText, RUBRICS, TYPES } = require('../server/stockRating');

/**
 * 종목 계층 평가 (2026-09-21 사용자 사양)
 *
 * ## 🔴 자의 초점 — **점수와 투자의견이 어긋나면 안 된다**
 *
 * 사양이 명시적으로 금지했다. 모델에게 둘 다 맡기면 88점에 "적극 매수" 를 쓴다.
 * ⇒ 의견은 **코드가 점수에서 유도**하고, 여기서 구간 경계를 못박는다.
 * ⚠️ 사양이 `90점 초과` 라고 썼다 — **90.0 은 적극 매수가 아니다.** 경계를 정확히 잰다.
 */

test('투자의견 구간이 사양과 정확히 맞는다 (경계 포함)', () => {
  // 대형주: 90 초과 / 80 이상 / 70 이상 / 60 이상 / 그 아래
  assert.equal(opinionFor(TYPES.LARGE, 90.1), '적극 매수');
  assert.equal(opinionFor(TYPES.LARGE, 90), '매수', '🔴 90.0 은 "초과" 가 아니다');
  assert.equal(opinionFor(TYPES.LARGE, 80), '매수');
  assert.equal(opinionFor(TYPES.LARGE, 79.9), '중립');
  assert.equal(opinionFor(TYPES.LARGE, 70), '중립');
  assert.equal(opinionFor(TYPES.LARGE, 69.9), '비중축소 / 약중립');
  assert.equal(opinionFor(TYPES.LARGE, 60), '비중축소 / 약중립');
  assert.equal(opinionFor(TYPES.LARGE, 59.9), '매도 권고');
});

/** 🔴 **중소형은 문턱이 낮다** — 같은 점수라도 의견이 다르다. 섞으면 기준이 무너진다 */
test('중소형 성장주는 기준이 다르다', () => {
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 85.1), '적극 매수');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 85), '매수');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 75), '매수');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 65), '중립');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 55), '관찰 / 고위험 중립');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 54), '매도 권고');
  // 같은 82점인데 유형에 따라 다르다 — 이게 유형 구분의 이유다
  assert.equal(opinionFor(TYPES.LARGE, 82), '매수');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 82), '매수');
  assert.equal(opinionFor(TYPES.LARGE, 68), '비중축소 / 약중립');
  assert.equal(opinionFor(TYPES.SMALL_GROWTH, 68), '중립');
});

test('유형을 시총·배당으로 판정한다', () => {
  assert.equal(classify({ marketCap: 5.3e12, quality: { dividendYield: 0.0002 } }).type, TYPES.LARGE);
  assert.equal(classify({ marketCap: 4e11, quality: { dividendYield: 0.031 } }).type, TYPES.LARGE_DIV);
  assert.equal(classify({ marketCap: 2e9, quality: {} }).type, TYPES.SMALL_GROWTH);
  // ⚠️ 배당률은 소스에 따라 0.031 또는 3.1 로 온다 — 둘 다 받아야 한다
  assert.equal(classify({ marketCap: 4e11, quality: { dividendYield: 3.1 } }).type, TYPES.LARGE_DIV);
});

/**
 * 🔴 **시총을 못 받으면 유형을 단정하지 않는다** — `assumed` 를 켜서 그 사실을 남긴다.
 *    조용히 대형주로 치면 기준이 후해지고, 중소형 종목이 **더 쉬운 잣대**로 평가된다.
 */
test('시가총액이 없으면 가정했다고 표시한다', () => {
  const c = classify({ quality: {} });
  assert.equal(c.assumed, true);
  assert.match(c.why, /미확인/);
});

test('유형마다 항목이 10개이고 유형별로 다르다', () => {
  /**
   * ⚠️ `ETF·펀드` 는 **면제** — 일부러 채점표를 주지 않는다.
   *    사양의 10항목(`구조적 우위`·`매출·이익 동반 성장`)은 **회사** 를 재는 자라서
   *    펀드에 대면 모델이 숫자를 지어낸다(실측: QLD 가 `69점 / 비중축소` 를 받았다).
   */
  const scored = Object.values(TYPES).filter((t) => t !== TYPES.FUND);
  assert.equal(scored.length, 3, '채점 유형 개수가 바뀌었다 — 이 자를 다시 보라');
  for (const t of scored) {
    assert.equal(RUBRICS[t].length, 10, `${t} 항목이 10개가 아니다 — 총점이 100 이 안 된다`);
  }
  assert.equal((RUBRICS[TYPES.FUND] || []).length, 0, 'ETF 에 기업 채점표가 생겼다');
  assert.ok(RUBRICS[TYPES.LARGE_DIV].includes('배당 지속성·안정성'), '배당주에 배당 항목이 없다');
  assert.ok(RUBRICS[TYPES.SMALL_GROWTH].includes('자금조달·희석 리스크'), '중소형에 희석 항목이 없다');
  assert.ok(!RUBRICS[TYPES.LARGE].includes('배당 지속성·안정성'), '대형주에 배당 항목이 섞였다');
});

/** ⚠️ 사양: 점수 기준표는 **표가 아니라 텍스트**로 출력한다 */
test('구간표를 유형에 맞는 텍스트로 낸다', () => {
  const t = bandText(TYPES.SMALL_GROWTH);
  assert.match(t, /중소형 성장주 기준/);
  assert.match(t, /85점 초과: 적극 매수/);
  assert.ok(!t.includes('|'), '표 문법이 섞였다 — 사양은 텍스트로 내라고 했다');
  assert.match(bandText(TYPES.LARGE), /90점 초과: 적극 매수/);
});

/**
 * ETF·펀드 분리 (2026-09-21)
 *
 * ## 왜 있나
 *
 * 라이브 첫 평가에서 QLD 가 **`69점 / 비중축소`** 를 받았다. 그런데 QLD 는 회사가 아니라
 * **2배 레버리지 ETF** 다 — `구조적 우위`·`매출·이익 동반 성장` 이라는 축 자체가 없다.
 * 모델은 없는 것을 재라니 **그럴듯한 숫자를 지어냈고**, 그 숫자가 매도 판단을 끌 수 있었다.
 *
 * 🔴 사용자 보유 **2종이 둘 다** 여기 해당한다(QLD·RAM). 남의 얘기가 아니다.
 * ★ `quoteType` 으로 깨끗이 갈린다 — 실측 QLD/RAM/SPY=`ETF`, NVDA=`EQUITY`.
 */
const F = (name, quoteType, marketCap) => classify({ name, quoteType, marketCap, quality: {} });

test('🔴 ETF 는 기업 유형으로 분류하지 않는다 (라이브 실측 quoteType)', () => {
  assert.equal(F('ProShares Ultra QQQ', 'ETF', null).type, TYPES.FUND);
  assert.equal(F('Roundhill T-REX 2x Long DRAM Daily Target ETF', 'ETF', null).type, TYPES.FUND);
  assert.equal(F('SPDR S&P 500 ETF Trust', 'ETF', null).type, TYPES.FUND);
  // 판별력 — 진짜 회사는 여전히 기업 유형이어야 한다(오탐하면 기업 평가가 통째로 죽는다)
  assert.equal(F('NVIDIA Corporation', 'EQUITY', 5367153557504).type, TYPES.LARGE);
});

test('🔴 레버리지·일일 리밸런싱을 짚는다 (횡보장 가치 감쇠)', () => {
  const qld = F('ProShares Ultra QQQ', 'ETF', null);
  assert.equal(qld.leverage.leveraged, true, '🔴 2배 상품인데 못 짚었다');
  assert.deepEqual(qld.leverage.hints, ['2배']);

  const ram = F('Roundhill T-REX 2x Long DRAM Daily Target ETF', 'ETF', null);
  assert.deepEqual(ram.leverage.hints, ['2배', '일일 리밸런싱']);

  // ⚠️ **추정임을 감추지 않는다** — 야후가 배수를 구조화해 주지 않는다
  assert.match(ram.leverage.why, /이름에서 추정/);
});

test('🔴 오탐 검사: 평범한 지수 ETF 를 레버리지로 찍지 않는다', () => {
  for (const n of ['SPDR S&P 500 ETF Trust', 'Invesco QQQ Trust', 'iShares Core MSCI EAFE ETF', 'Vanguard Total Stock Market ETF']) {
    assert.equal(F(n, 'ETF', null).leverage.leveraged, false, `🔴 ${n} 을 레버리지로 오탐했다`);
  }
});

test('3배·인버스도 짚는다', () => {
  assert.deepEqual(F('ProShares UltraPro QQQ', 'ETF', null).leverage.hints, ['3배']);
  const inv = F('Direxion Daily Semiconductor Bear 3X Shares', 'ETF', null).leverage.hints;
  assert.ok(inv.includes('3배') && inv.includes('인버스(하락 베팅)'), `인버스를 놓쳤다: ${inv}`);
});

/**
 * 🔴 `quoteType` 이 **없으면** 펀드로 단정하지 않는다.
 *    이름 추측으로 기업을 펀드로 오분류하면 기업 평가가 사라진다 —
 *    "모르면 기존 경로" 가 안전한 방향이다.
 */
test('quoteType 이 없으면 펀드로 단정하지 않는다', () => {
  assert.notEqual(F('Something Ultra Corp', null, 20e9).type, TYPES.FUND);
});

/**
 * 🔴 **점수는 왔는데 서술이 통째로 없다** (2026-09-21 라이브 · 8회 전부)
 *
 * 모델이 평평한 모양으로 답할 때는 **점수만** 준다. 실측 응답이 190자쯤이고
 * `strengths`·`weaknesses`·`oneLiner`·항목 코멘트가 전부 빈 값이었다.
 * 그런데 화면엔 `89점 · 매수 · 확신도 중간` 이 찍혀 **완성된 판단처럼 보였다.**
 *
 * 🔴 더 나쁜 건 `확신도 중간` 이 **내 기본값**이었다는 것 — 모델은 그 말을 한 적이 없다.
 *    숫자를 지어내지 않겠다고 해 놓고 **확신도는 지어내고 있었다.**
 * ⚠️ pm2 의 검증은 *"weaknesses 에 `[` 가 없다"* 로 통과했는데, 빈 문자열에도 `[` 는 없다 —
 *    **"검사하지 않은 것" 이 "통과한 것" 으로 보이는** 그 실패 모드다.
 */
const os = require('node:os');
const path = require('node:path');

function freshRating(replies) {
  for (const k of Object.keys(require.cache)) {
    if (/stockRating|aiService|yahooStats/.test(k)) delete require.cache[k];
  }
  const calls = [];
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      generateStructuredOutput: async (o) => { calls.push(o.logLabel); return replies.shift() ?? {}; },
      getAiSettings: () => ({}),
    },
  };
  const yPath = require.resolve('../server/yahooStats');
  const realY = require(yPath);
  require.cache[yPath] = {
    id: yPath, filename: yPath, loaded: true,
    exports: {
      ...realY,
      getStats: async () => ({
        symbol: 'NVDA', name: 'NVIDIA Corporation', quoteType: 'EQUITY', marketCap: 5.36e12,
        price: 180, currency: 'USD', quality: {}, links: {}, missing: [], at: 'now',
      }),
    },
  };
  return { rating: require('../server/stockRating'), calls };
}

/** 라이브 실측 응답 — 점수만, 서술 0 */
const FLAT = Object.fromEntries(RUBRICS[TYPES.LARGE].map((n, i) => [n, i < 4 ? 10 : 9]));

test('🔴 점수만 오고 서술이 비면 서술만 한 번 더 받는다', async () => {
  const { rating, calls } = freshRating([FLAT, { oneLiner: '대장주', strengths: '해자', weaknesses: '밸류 부담', confidence: '높음' }]);
  const r = await rating.rate('NVDA');
  assert.deepEqual(calls, ['stock_rating', 'stock_rating_prose'], '서술 보충을 안 불렀다');
  assert.equal(r.oneLiner, '대장주');
  assert.equal(r.weaknesses, '밸류 부담');
  // 🔴 점수는 **첫 응답 것**이어야 한다 — 두 번째 호출이 숫자를 흔들면 안 된다
  assert.equal(r.total, 94);
  assert.equal(r.confidence, '높음');
});

test('서술이 이미 있으면 다시 묻지 않는다 (멀쩡한 경로에 비용을 더하지 않는다)', async () => {
  const { rating, calls } = freshRating([{ ...FLAT, strengths: '이미 있다', oneLiner: '있다', confidence: '높음' }]);
  await rating.rate('NVDA');
  assert.deepEqual(calls, ['stock_rating'], '🔴 서술이 있는데 또 물었다');
});

test('점수가 덜 채워졌으면 서술을 묻지 않는다 (총점부터 못 낸다)', async () => {
  const { rating, calls } = freshRating([{ '강한 기업 선호': 9 }]);
  const r = await rating.rate('NVDA');
  assert.deepEqual(calls, ['stock_rating']);
  assert.equal(r.total, null);
});

/**
 * 🔴 **확신도를 지어내지 않는다.**
 * 모델이 안 주면 `낮음` 에서 시작하고 **그 이유를 적는다** — 기본값을 판단처럼 내보내면
 * 사용자는 시스템이 판단한 줄 안다.
 */
test('🔴 모델이 확신도를 안 주면 낮음 + 이유를 남긴다 (중간으로 지어내지 않는다)', async () => {
  const { rating } = freshRating([FLAT, { oneLiner: 'x', strengths: 'y', weaknesses: 'z' }]);
  const r = await rating.rate('NVDA');
  assert.equal(r.confidence, '낮음', '🔴 모델이 말한 적 없는 확신도를 만들어냈다');
  assert.match(r.confidenceWhy, /확신도를 답하지 않음/, '🔴 지어낸 게 아니라는 근거가 없다');
});

test('모델이 확신도를 주면 그걸 쓴다 (판별력)', async () => {
  const { rating } = freshRating([{ ...FLAT, strengths: 'a', oneLiner: 'b', confidence: '중간~높음' }]);
  const r = await rating.rate('NVDA');
  assert.equal(r.confidence, '중간~높음');
  assert.ok(!/답하지 않음/.test(r.confidenceWhy), '준 값인데 "안 줬다" 를 적었다');
});
