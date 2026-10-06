/**
 * 🎯 장기 목표 배분 — 선언·검증·괴리 계산 (2026-10-06 신설)
 *
 * ## 이 자가 지키는 것
 * ① **깨진 설정은 쓰지 않는다** — 합이 100 이 아니면 null + warn. 합 90 인 목표로 괴리를
 *    계산하면 모든 칸이 "부족" 으로 나와 **모델을 한 방향으로 민다**.
 * ② **심볼은 카탈로그 안에만** — 실제 `config/etf-catalog.json` 으로 대조한다(손으로 지어낸
 *    픽스처로 재면 카탈로그가 바뀌어도 모른다).
 * ③ 🔴 **분모 동치** — 괴리 계산의 비중이 `analystService.portfolioWeights` 와 같은 값인가.
 *    같은 식을 두 번 쓰면 "화면 31.2% / 괴리 절 60.9%" 처럼 갈라진다(2026-10-04 riskMetrics
 *    가 실제로 밟은 자리). 이 단언이 깨지면 **화면과 프롬프트의 숫자가 달라졌다는 뜻**이다.
 * ④ `promptSection` 에 **모델이 오독하지 않기 위해 반드시 필요한 네 가지**가 실린다
 *    (숫자 · 스위칭 규칙 · "방향을 바꾸지 않는다" · 미분류 정리 우선순위).
 *
 * ⚠️ `analystService` 를 require 하면 orderService 가 DATA_DIR 에서 주문을 복원한다 —
 *    실제 `data/` 를 건드리지 않도록 **먼저** 격리한다("테스트가 라이브 데이터" 가족).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 🔴 require 보다 먼저 — 아래 analystService 가 이 경로를 읽는다
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-target-'));
process.env.DATA_DIR = TMP;
process.env.ORDERS_FILE = path.join(TMP, 'orders.json');
process.env.ACTIVITY_FILE = path.join(TMP, 'activity.jsonl');

const ta = require('../server/targetAllocation');
const regime = require('../server/regimeService');

const CATALOG = regime.readCatalog();

/** 실제 라이브 모양 (2026-10-06 계좌) */
const LIVE_ITEMS = [
  { symbol: 'O', quantity: 4, lastPrice: 53.98, marketValue: 4 * 53.98, leverageFactor: 1 },
  { symbol: 'QLD', quantity: 50, lastPrice: 99.94, marketValue: 50 * 99.94, leverageFactor: 2 },
  { symbol: 'RAM', quantity: 200, lastPrice: 13.87, marketValue: 200 * 13.87, leverageFactor: 1 },
];
const LIVE_SUMMARY = { cash: { usd: { amount: 8045 } }, fx: { rate: 1400 } };

/** warn 을 가로채서 센다 — "조용히 버렸다" 와 "말하고 버렸다" 를 구분한다 */
function captureWarns(fn) {
  const logger = require('../server/logger');
  const orig = logger.logWarn;
  const seen = [];
  // ⚠️ 모듈이 구조분해로 가져가므로 그 자리를 바꿔도 안 먹는다 — console.warn 을 잡는다
  const origConsole = console.warn;
  console.warn = (line) => { try { seen.push(JSON.parse(line)); } catch { seen.push({ raw: line }); } };
  try { return { result: fn(), warns: seen }; } finally { console.warn = origConsole; logger.logWarn = orig; }
}

/** 임시 목표 파일을 만들고 load 한다 */
function loadWith(obj) {
  const f = path.join(TMP, `target-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return captureWarns(() => ta.load({ file: f, catalog: CATALOG }));
}

// ───────────────────────── ① 합 100 검증 ─────────────────────────

test('실제 config/target-allocation.json 은 합 100 으로 통과한다', () => {
  const t = ta.load({ catalog: CATALOG });
  assert.ok(t, '정본 목표 파일이 load 에서 null 이 됐다');
  assert.equal(t.sumPct, 100);
  assert.equal(t.buckets.length, 4);
  assert.deepEqual(t.buckets.map((b) => b.key),
    ['defensive_income', 'base_slot', 'core_aggressive', 'cash']);
});

test('합이 90 이면 null + warn — 깨진 목표로 괴리를 계산하지 않는다', () => {
  const { result, warns } = loadWith({
    buckets: [
      { key: 'a', targetPct: 60, symbols: ['QLD'] },
      { key: 'b', targetPct: 30, symbols: ['QQQM'] },
    ],
  });
  assert.equal(result, null, '합 90 인 목표가 통과했다 — 모든 칸이 부족으로 나와 모델을 한 방향으로 민다');
  const w = warns.find((x) => x.event === 'target.sum_invalid');
  assert.ok(w, `sum_invalid warn 이 없다 — 조용히 버리면 아무도 모른다. 받은 것: ${JSON.stringify(warns.map((x) => x.event))}`);
  assert.equal(w.sum, 90);
});

test('합 100 ± 허용치 안이면 통과한다 (반올림 오차를 설정 오류로 읽지 않는다)', () => {
  const { result } = loadWith({
    toleranceSumPct: 0.5,
    buckets: [
      { key: 'a', targetPct: 33.3, symbols: ['QLD'] },
      { key: 'b', targetPct: 33.3, symbols: ['QQQM'] },
      { key: 'c', targetPct: 33.3, symbols: [], cash: true },
    ],
  });
  assert.ok(result, '합 99.9 가 거부됐다 — 허용치가 안 먹는다');
  assert.equal(result.sumPct, 99.9);
});

// ───────────────────── ② 카탈로그에 없는 심볼 ─────────────────────

test('카탈로그에 없는 심볼은 버리고 warn — 버킷은 살린다', () => {
  const { result, warns } = loadWith({
    buckets: [
      { key: 'core', targetPct: 50, symbols: ['QLD', 'NOSUCHTICKER', 'QQQM'] },
      { key: 'cash', targetPct: 50, symbols: [], cash: true },
    ],
  });
  assert.ok(result, '티커 하나 오타가 목표를 통째로 날렸다');
  assert.deepEqual(result.buckets[0].symbols, ['QLD', 'QQQM'], '없는 심볼이 남았거나 실재 심볼이 사라졌다');
  const w = warns.find((x) => x.event === 'target.symbol_not_in_catalog');
  assert.ok(w, '없는 심볼을 조용히 버렸다');
  assert.deepEqual(w.dropped, ['NOSUCHTICKER']);
});

test('정본 목표의 심볼은 전부 실제 카탈로그에 실재한다', () => {
  const known = new Set();
  for (const c of Object.values(CATALOG.categories || {})) {
    for (const e of c.etfs || []) known.add(String(e.symbol).toUpperCase());
  }
  assert.ok(known.size > 100, `카탈로그를 못 읽었다(${known.size}종) — 이 자가 공허하게 통과한다`);

  const raw = JSON.parse(fs.readFileSync(ta.TARGET_FILE, 'utf8'));
  const declared = raw.buckets.flatMap((b) => b.symbols || []);
  assert.ok(declared.length >= 6, `검사 대상이 ${declared.length}개 — 너무 적다`);
  const missing = declared.filter((s) => !known.has(String(s).toUpperCase()));
  assert.deepEqual(missing, [], `정본 목표가 카탈로그 밖 티커를 선언했다: ${missing.join(',')}`);
});

test('카탈로그를 못 읽으면 심볼 검증을 건너뛴다 — 건너뜀을 "전부 없음" 으로 읽지 않는다', () => {
  const f = path.join(TMP, 'target-nocat.json');
  fs.writeFileSync(f, JSON.stringify({
    buckets: [{ key: 'core', targetPct: 100, symbols: ['QLD', 'QQQM'] }],
  }));
  const { result, warns } = captureWarns(() => ta.load({ file: f, catalog: { categories: {} } }));
  assert.ok(result, '카탈로그가 비자 목표가 통째로 죽었다');
  assert.deepEqual(result.buckets[0].symbols, ['QLD', 'QQQM'], '검사 못 한 것을 전부 없는 심볼로 읽었다');
  assert.ok(warns.some((x) => x.event === 'target.symbol_check_skipped'),
    '건너뛴 것을 화면에 남기지 않았다 — "검사 안 한 것" 과 "통과한 것" 은 다르다');
});

test('목표 파일을 못 읽으면 null + warn', () => {
  const { result, warns } = captureWarns(() => ta.load({ file: path.join(TMP, 'absent.json'), catalog: CATALOG }));
  assert.equal(result, null);
  assert.ok(warns.some((x) => x.event === 'target.unreadable'));
});

// ────────────────── ③ compare — 라이브 모양 괴리 ──────────────────

test('compare 가 라이브 모양(O 4 · QLD 50 · RAM 200 · 현금 8045)의 괴리를 낸다', () => {
  const cmp = ta.compare(LIVE_ITEMS, LIVE_SUMMARY, CATALOG);
  assert.ok(cmp, 'compare 가 null 을 냈다');

  // 분모 = 주식 7986.92 + 현금 8045 = 16031.92
  assert.equal(Math.round(cmp.totalValue * 100) / 100, 16031.92);

  const by = Object.fromEntries(cmp.buckets.map((b) => [b.key, b]));

  // QLD 4997 / 16031.92 = 31.2% vs 목표 30 → 괴리 +1.2 → 밴드(±3) 안이라 ok
  assert.equal(by.core_aggressive.currentPct, 31.2);
  assert.equal(by.core_aggressive.gapPct, 1.2);
  assert.equal(by.core_aggressive.direction, 'ok');

  // QQQM·TQQQ 보유 0 → 20%p 부족 → add
  assert.equal(by.base_slot.currentPct, 0);
  assert.equal(by.base_slot.gapPct, -20);
  assert.equal(by.base_slot.direction, 'add');
  assert.deepEqual(by.base_slot.held, []);

  // O 215.92 / 16031.92 = 1.3% vs 목표 25 → add
  assert.equal(by.defensive_income.currentPct, 1.3);
  assert.equal(by.defensive_income.direction, 'add');
  assert.deepEqual(by.defensive_income.held, [{ symbol: 'O', pct: 1.3, leverage: 1 }]);

  // 현금 8045 / 16031.92 = 50.2% vs 목표 25 → trim
  assert.equal(by.cash.currentPct, 50.2);
  assert.equal(by.cash.gapPct, 25.2);
  assert.equal(by.cash.direction, 'trim');

  // 🔴 RAM 은 목표 어느 칸에도 없다 → 미분류(= 정리 대상)
  assert.deepEqual(cmp.unclassified, [{ symbol: 'RAM', pct: 17.3, category: 'semiconductor', leverage: 1 }]);
});

test('🔴 분모 동치 — 괴리의 비중이 portfolioWeights 와 글자 그대로 같다', () => {
  const weights = require('../server/analystService').portfolioWeights(LIVE_ITEMS, LIVE_SUMMARY, CATALOG);
  const cmp = ta.compare(LIVE_ITEMS, LIVE_SUMMARY, CATALOG);

  assert.equal(cmp.totalValue, weights.total, '분모가 갈렸다 — 화면과 프롬프트 숫자가 달라진다');

  const byBucket = Object.fromEntries(cmp.buckets.map((b) => [b.key, b]));
  assert.equal(byBucket.cash.currentPct, weights.cashPct, '현금 비중이 portfolioWeights 와 다르다');

  // 버킷에 들어간 보유 비중이 weights.holdings 의 값과 하나하나 같다
  const wPct = new Map(weights.holdings.map((h) => [h.symbol, h.pct]));
  let checked = 0;
  for (const b of cmp.buckets) {
    for (const h of b.held) {
      assert.equal(h.pct, wPct.get(h.symbol), `${h.symbol} 비중이 갈렸다`);
      checked += 1;
    }
  }
  for (const u of cmp.unclassified) {
    assert.equal(u.pct, wPct.get(u.symbol), `${u.symbol}(미분류) 비중이 갈렸다`);
    checked += 1;
  }
  // ⚠️ 대상이 0건이면 이 자는 공허하게 통과한다 — 보유 전수가 계정됐는지 본다
  assert.equal(checked, weights.holdings.length, `보유 ${weights.holdings.length}종 중 ${checked}종만 대조했다`);

  // 버킷 현재합 + 미분류합 = 100 (현금 포함) — 어디에도 안 든 보유가 없다
  const sum = cmp.buckets.reduce((a, b) => a + b.currentPct, 0)
    + cmp.unclassified.reduce((a, u) => a + u.pct, 0);
  assert.ok(Math.abs(sum - 100) < 0.2, `버킷+미분류 합이 ${sum}% — 누락·중복이 있다`);
});

test('보유·현금이 전부 0 이면 null — 0 을 "목표 달성" 으로 읽지 않는다', () => {
  const { result, warns } = captureWarns(() => ta.compare([], { cash: { usd: { amount: 0 } } }, CATALOG));
  assert.equal(result, null);
  assert.ok(warns.some((x) => x.event === 'target.weights_unavailable'));
});

test('목표가 깨졌으면 compare 도 null — 깨진 목표로 괴리를 내지 않는다', () => {
  const cmp = ta.compare(LIVE_ITEMS, LIVE_SUMMARY, CATALOG, { target: null });
  assert.equal(cmp, null);
});

// ──────────────────── ④ promptSection 내용 ────────────────────

test('promptSection 에 버킷별 목표·현재·괴리 숫자가 실린다', () => {
  const s = ta.promptSection(ta.compare(LIVE_ITEMS, LIVE_SUMMARY, CATALOG));
  assert.match(s, /장기 목표 배분/);
  // 표에 네 버킷이 다 있고 목표·현재 숫자가 보인다
  for (const name of ['방어·현금흐름', '기반 자산 슬롯', '코어 공격', '현금']) {
    assert.ok(s.includes(name), `${name} 버킷이 프롬프트에 없다`);
  }
  assert.ok(s.includes('31.2%'), 'QLD 현재 비중(31.2%)이 안 실렸다 — 괴리를 모르면 리밸런싱 제안은 원리상 안 나온다');
  assert.ok(s.includes('-20%p'), 'base_slot 괴리(-20%p)가 안 실렸다');
  assert.ok(s.includes('+25.2%p'), '현금 초과(+25.2%p)가 안 실렸다');
});

test('🔴 promptSection 에 base_slot 스위칭 규칙이 실린다 (안 적으면 둘 다 쌓는 제안이 나온다)', () => {
  const s = ta.promptSection(ta.compare(LIVE_ITEMS, LIVE_SUMMARY, CATALOG));
  assert.match(s, /스위칭 규칙/);
  assert.match(s, /한 슬롯/, '"한 슬롯이다" 가 없다 — 모델이 QQQM·TQQQ 를 각각의 칸으로 읽는다');
  assert.match(s, /둘 다 쌓는 칸이 아니다/);
  assert.match(s, /교체/, '"교체" 라는 말이 없으면 추가 매수로 읽힌다');
  assert.ok(s.includes('QQQM') && s.includes('TQQQ'), '슬롯 양쪽 심볼이 안 실렸다');
  // 슬롯 최대치가 전체 비중으로 환산돼 실린다 (20% × 50% = 10%)
  assert.match(s, /전체의 10%/, 'TQQQ 상한을 전체 비중으로 환산한 값이 없다 — 슬롯 기준 50% 만 보면 과대 해석한다');
});

test('🔴 promptSection 에 "국면이 나쁘면 속도를 줄이되 방향을 바꾸지 않는다" 가 실린다', () => {
  const s = ta.promptSection(ta.compare(LIVE_ITEMS, LIVE_SUMMARY, CATALOG));
  assert.match(s, /속도.*줄이[되고].*방향/s, '속도/방향 구분이 없다 — 모델이 "지금 당장 채워라" 로 읽어 국면 무시가 된다');
  assert.match(s, /국면이 단기 우선/, '국면 우선 규칙이 없다 — playbook 과 충돌할 때 판단 근거가 없다');
});

test('🔴 promptSection 에 미분류 보유가 정리 우선순위로 실린다', () => {
  const s = ta.promptSection(ta.compare(LIVE_ITEMS, LIVE_SUMMARY, CATALOG));
  assert.match(s, /정리 우선순위/);
  assert.ok(s.includes('RAM 17.3%'), '미분류 보유 RAM 이 비중과 함께 안 실렸다');
  assert.match(s, /새로 늘리는 대상은 아니다/, '"늘리지 말라" 가 없으면 모델이 목표 밖 종목을 또 산다');
});

test('미분류가 없으면 그렇다고 적는다 — 빈칸으로 두지 않는다', () => {
  const onlyTargets = [
    { symbol: 'QLD', quantity: 50, lastPrice: 99.94, marketValue: 4997, leverageFactor: 2 },
    { symbol: 'QQQM', quantity: 10, lastPrice: 200, marketValue: 2000, leverageFactor: 1 },
  ];
  const s = ta.promptSection(ta.compare(onlyTargets, LIVE_SUMMARY, CATALOG));
  assert.match(s, /목표 밖 보유: 없음/);
  assert.ok(!s.includes('정리 우선순위'), '미분류가 없는데 정리 절이 떴다');
});

test('promptSection(null) 은 빈 문자열 — 못 구한 것이 프롬프트를 깨지 않는다', () => {
  assert.equal(ta.promptSection(null), '');
});

/**
 * 🔴 **라우트 도달 가드** (2026-10-06) — 모듈·프롬프트 배선을 다 해놓고 **라우트를 빠뜨려서**
 * 화면이 목표 배분을 못 받고 있었다(서브에이전트가 찾았다). 같은 날 세 번째로 밟은
 * *"등록됐다 ≠ 도달한다"* 다 — 새 서버 모듈은 **모듈·프롬프트·라우트·화면** 네 자리를 다 봐야 한다.
 * ⇒ 소스를 훑어 창구가 실재하는지 못박는다(이름 grep 은 약하지만, 지워지면 잡는다).
 */
test('라우트 도달 — /api/target-allocation 이 실재하고 compare 를 부른다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/api/target-allocation'");
  assert.ok(i > 0, '/api/target-allocation 라우트가 없다 — 화면이 목표 배분을 영영 못 받는다');
  const body = src.slice(i, i + 900);
  assert.match(body, /targetAllocation'\)\.compare\(/, '라우트가 compare 를 부르지 않는다');
  assert.match(body, /readCatalog\(\)/, '카탈로그를 안 넘긴다 — 심볼 검증이 건너뛰어진다');
  assert.match(body, /50[23]/, '실패를 조용히 넘긴다 — 빈 목표는 화면에 "괴리 없음" 으로 보인다');
});
