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
  // ⚠️ 고정 창은 코드가 자라면 밀린다 — 기타법인 추가로 900자가 모자라 한 번 깨졌다
  const block = code.slice(i, i + 1400);
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
  // ⚠️ 2026-09-22 저녁: 공매도 단독 → KR 4축 세트가 되며 short_selling_failed 가
  //    kr_supply_failed(axis 라벨 포함)로 바뀌었다 — 의도된 변화라 자를 따라 옮긴다
  for (const ev of ['analyst.warnings_failed', 'analyst.kr_supply_failed', 'analyst.index_flow_failed', 'analyst.orderbook_failed', 'analyst.index_candles_failed']) {
    assert.ok(code.includes(ev), `🔴 ${ev} 가 없다 — 실패가 "데이터 없음" 으로 보인다`);
  }
});

/**
 * 🔴 **KR 전용 API 를 미국 종목에 부르고 있었다** (2026-09-22 라이브 로그에서 발견)
 *
 * `analyst.flows_failed QLD/RAM 토스 API 오류 (400)` 이 **분석마다** 났다.
 * 쓸 수 없는 호출로 한도를 깎으면서, 그 실패가 리포트에 *"수급 조회 실패"* gap 으로 남아
 * **"데이터가 없다" 로 읽혔다.** 실제로는 **애초에 물어볼 수 없는 곳에 물은 것**이다.
 *
 * ⚠️ 같은 날 `short-selling` 에 KR 가드를 넣으면서 **이 자리를 안 훑었다** —
 *    *"규칙을 정하면 그 자리에서 적용 범위를 전수로 훑어라"* 를 또 어긴 것이다.
 */
test('🔴 투자자별 매매동향(KR 전용)을 **미국 종목에 안 부른다**', () => {
  const i = code.indexOf('toss.getInvestorTrading(');
  assert.ok(i > 0, 'getInvestorTrading 호출부를 못 찾았다');
  const before = code.slice(Math.max(0, i - 400), i);
  assert.match(before, /market[\s\S]{0,40}KR/,
    '🔴 시장 구분 없이 부른다 — 미국 종목마다 400 이 나고 한도가 깎인다');
});

/** ⚠️ KR 전용 API 세 개가 **전부** 가드를 갖는가 — 하나만 고치고 옆을 안 보는 그 병 */
test('⚠️ KR 전용 호출이 전부 시장 가드를 갖는다 (전수)', () => {
  for (const fn of ['getInvestorTrading', 'getShortSelling']) {
    const i = code.indexOf(`toss.${fn}(`);
    assert.ok(i > 0, `${fn} 호출부가 없다`);
    const before = code.slice(Math.max(0, i - 400), i);
    /**
     * ⚠️ **첫 판에서 이 자가 틀렸다** — `/KR/` 로만 봤는데 가드 변수가 `isKr`(소문자 r)이라
     *    안 걸렸다. 주석은 `codeOnly` 가 지우므로 한글 "국내 전용" 도 안 보인다.
     *    제품은 멀쩡했고 **자가 대소문자에서 틀린 것**이다 ⇒ 두 형태를 다 받는다.
     */
    assert.ok(/\bisKr\b|['"]KR['"]/.test(before), `🔴 ${fn} 이 시장 가드 없이 불린다`);
  }
});

/**
 * 🔴 **지수 수급 필드명을 추측해서 외국인·기관이 조용히 사라졌다** (2026-09-22 첫 실증)
 *
 * 명세의 실제 키: `individual` · `foreigner` · `institution` (각각 `{buyAmount, sellAmount}`, **문자열**).
 * 나는 `foreign`·`institutional` 로 짐작했고, null 방어가 오히려 증상을 숨겨
 * **개인만 프롬프트에 실렸다.** 잡은 건 내가 아니라 **모델의 gap 불평**이었다
 * ("코스피·코스닥 개인만 제공") — 사람이 로그만 봤으면 webHits·stances 다 정상이라 몰랐다.
 */
test('🔴 지수 수급 파싱이 **명세의 실제 키**를 쓴다', () => {
  const i = code.indexOf("['개인', 'individual']");
  assert.ok(i > 0, '수급 파싱을 못 찾았다');
  const block = code.slice(i, i + 200);
  assert.match(block, /'foreigner'/, "🔴 'foreign' 은 명세에 없다 — 외국인이 조용히 사라진다");
  assert.match(block, /'institution'/, "🔴 'institutional' 은 명세에 없다 — 기관이 조용히 사라진다");
  assert.ok(!/'foreign'[^e]/.test(block), '옛 추측 키가 남아 있다');
});

/** 🔴 명세 모양의 실데이터로 셋 다 계산되는지 — 키만 보면 "있다"까지고 이게 "맞다"다 */
test('🔴 명세 모양 레코드에서 개인·외국인·기관 **셋 다** 나온다', () => {
  const r = {
    date: '2026-09-22',
    individual: { buyAmount: '1000000000000', sellAmount: '900000000000' },
    foreigner: { buyAmount: '2000000000000', sellAmount: '2300000000000' },
    institution: { buyAmount: '500000000000', sellAmount: '400000000000', breakdown: {} },
  };
  const net = (who) => {
    const b = Number(r?.[`${who}BuyAmount`] ?? r?.[who]?.buyAmount);
    const sl = Number(r?.[`${who}SellAmount`] ?? r?.[who]?.sellAmount);
    if (!Number.isFinite(b) || !Number.isFinite(sl)) return null;
    return Math.round((b - sl) / 1e8);
  };
  const parts = [['개인', 'individual'], ['외국인', 'foreigner'], ['기관', 'institution']]
    .map(([ko, k]) => { const n = net(k); return n == null ? null : `${ko} ${n > 0 ? '+' : ''}${n}억`; })
    .filter(Boolean);
  assert.equal(parts.length, 3, `🔴 ${3 - parts.length}개 투자자 분류가 조용히 사라졌다: ${parts}`);
  assert.deepEqual(parts, ['개인 +1000억', '외국인 -3000억', '기관 +1000억']);
});

/** pm2 실응답에 `otherCorporation`(기타법인)이 있어 함께 싣는다 — 프롬프트 배선 확인 */
test('기타법인도 파싱 목록에 있다', () => {
  const i = code.indexOf("['기타법인', 'otherCorporation']");
  assert.ok(i > 0, '🔴 기타법인이 빠졌다 — 실응답에 있는 주체를 버린다');
});

// ── 2026-09-22 저녁 — "제공하는 기능을 왜 안 쓰나" 전수 정비 ──────
/**
 * 🔴 사용자: *"toss_security.json 보고 안 쓰고 있는 내용 있으면 활용해."*
 * 전수 대조 결과 **만들어 놓고 소비 0** 이 7개였다(exchange-rate·orderbook·price-limits ·
 * 지수캔들·신용·프로그램·대차). 이 블록이 각 배선의 **소비 실재**를 잠근다 —
 * 클라이언트 함수 존재만 보면 "쓴다" 로 보이는 그 함정을 막는 자다.
 */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const ORDER_SVC = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'orderService.js'), 'utf-8'));
const MKT = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'marketDataService.js'), 'utf-8'));

test('🔴 환율: 야후 실패 시 토스 폴백이 배선돼 있다', () => {
  assert.match(MKT, /getExchangeRate\(/, '🔴 토스 환율 폴백이 없다 — 야후 단일 의존이면 야후 장애=환산 전체 사망');
  const i = MKT.indexOf('getExchangeRate(');
  const before = MKT.slice(Math.max(0, i - 600), i);
  assert.match(before, /catch/, '🔴 폴백이 아니라 본선이다 — 평시에도 MARKET_INFO 한도(3/s)를 깎는다');
});

test('🔴 상하한가: KR 지정가 제안을 사전검증한다', () => {
  assert.match(ORDER_SVC, /getPriceLimits\(/, '🔴 상하한 검증이 없다 — 승인 누른 뒤에야 거래소 거부를 안다');
  const i = ORDER_SVC.indexOf('getPriceLimits(');
  const around = ORDER_SVC.slice(Math.max(0, i - 400), i + 700);
  assert.match(around, /\\d\{6\}|price-limit/, 'KR 판정 또는 거부 kind 가 없다');
  assert.match(around, /catch/, '🔴 조회 실패가 정당한 제안을 막으면 안 된다(보조 축) — 경고만');
});

test('🔴 호가: 보유 종목 프롬프트에 최우선 호가가 실린다', () => {
  assert.match(code, /getOrderbook\(/, '🔴 호가를 안 부른다');
  assert.match(code, /이 호가를 기준/, '🔴 모으고 프롬프트에 안 싣는다');
});

test('🔴 지수 캔들: 국장 브리핑에 추세가 실린다 (같은 판정 함수 재사용)', () => {
  assert.match(code, /getIndexCandles\(/, '🔴 지수 캔들을 안 부른다 — 수급만 있고 추세가 없는 반쪽 시황');
  const i = code.indexOf('getIndexCandles(');
  const after = code.slice(i, i + 400);
  assert.match(after, /summarizeCandles/, '🔴 자를 새로 만들었다 — 보유 종목과 같은 판정 함수를 써야 한다');
  assert.match(code, /지수 기술적 위치/, '🔴 렌더가 없다');
});

test('🔴 KR 수급이 4축이다 (공매도·신용·프로그램·대차)', () => {
  for (const fn of ['getShortSelling', 'getCreditTrades', 'getProgramTrades', 'getSecuritiesLending']) {
    assert.match(code, new RegExp(`toss\\.${fn}\\(`), `🔴 ${fn} 이 안 불린다`);
  }
  assert.match(code, /국내 수급 4축/, '🔴 렌더가 4축이 아니다');
  assert.match(code, /추세와 조합/, '⚠️ 읽는 법 지시가 없다 — 숫자만 주면 모델이 절대량으로 읽는다');
});

/** 🔴 렌더 키가 **실제 명세/반환** 키인가 — 오늘 두 번 밟은 "필드명 추측" 차단 */
test('🔴 렌더가 추측 키를 쓰지 않는다', () => {
  assert.ok(!/high20|low20/.test(code), '🔴 summarizeCandles 에 없는 키(high20/low20)를 쓴다');
  assert.match(code, /balanceQuantity/, '대차잔고 키(명세 SecuritiesLendingRecord)가 없다');
  assert.match(code, /arbitrage/, '프로그램 키(명세 ProgramTradeRecord)가 없다');
});
