const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 **감시 41종을 지켜보면서 판단에는 0개가 들어가고 있었다** (2026-10-01)
 *
 * `alertService.collectMomentumRows()` 가 5분마다 유니버스 **전체**의 등락·분포를 계산하는데,
 * 그 rows 는 `trigger.decide()` 에만 쓰이고 **분석 프롬프트로는 안 갔다.** 정기 회차
 * (preopen/open/mid/close)의 `reasons` 에는 스케줄 사유 하나뿐이라, `## 되살/신규 진입 후보`
 * 절(`kind==='momentum'` 만 읽는다)은 **항상 비었다.**
 * ⇒ 모델이 보는 종목 = 보유 2 + 후보 2 = **4개**.
 *
 * 실측(10-01 11:5x KST): 감시 39종 중 |1.5%| 이상 **16종** · |3%| 이상 **6종**
 * (KORU -5.08 · 신한지주 -4.99 · KODEX코스닥150 +4.62 · 한미반도체 +4.16 · KB금융 -3.64 · GOOGL +3.29)
 * — **한 줄도** 브리핑에 안 실렸다. 이 저장소가 반복해 밟은 *"수집해 놓고 안 쓰는"* 자리다.
 *
 * ★ 이 파일이 지키는 핵심 불변식 **셋**:
 *   ① 움직임이 있으면 **실린다**
 *   ② 조용하면 *"특이 움직임 없음"* 이라고 **쓴다** — 절을 빼지 않는다
 *   ③ **못 받았으면** ②와 **다른 문장**을 낸다 — *"조용했다"* 와 *"안 봤다"* 가 같아 보이면 안 된다
 */

process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-set-watchmoves-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `sswm-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `sswm-act-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const analyst = require('../server/analystService');
const trigger = require('../server/analystTrigger');

/** 변동성 ~1.2% 짜리 분포 — z 가 계산되려면 표본이 10개 이상이어야 한다(`stats` 규약) */
const HIST = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 1.2);
const row = (symbol, pct, role = 'watch', history = HIST) => ({ symbol, dailyChangePct: pct, role, history });

/** 🔴 실측 모양 — 손으로 지어낸 숫자를 쓰면 자가 실제 상태를 못 재현한다 */
const LIVE_ROWS = [
  row('KORU', -5.08), row('055550', -4.99), row('229200', 4.62), row('042700', 4.16),
  row('105560', -3.64), row('GOOGL', 3.29), row('AMD', -2.81), row('TSLA', 2.44, 'reentry'),
  row('META', -2.2), row('NVDA', 2.05), row('SCHD', -1.9, 'targeted'), row('005930', 1.85),
  row('SOXL', -1.8), row('TQQQ', 1.7), row('PLTR', -1.6), row('IONQ', 1.55),
  // 조용한 나머지 — 문턱 미만
  ...Array.from({ length: 23 }, (_, i) => row(`Q${i}`, 0.3)),
];
const OPTS = {
  heldSet: new Set(['QLD', 'RAM']),
  nameOf: (s) => ({ '055550': '신한지주', '229200': 'KODEX코스닥150' }[s] || null),
  zOf: (r) => trigger.zScore(r.dailyChangePct, r.history),
};

// ── ① 움직임이 실린다 ────────────────────────────────────────

test('🔴 실측 데이터에서 **변동 큰 종목이 실제로 실린다**', () => {
  const s = analyst.watchMovesSection(LIVE_ROWS, OPTS);
  assert.match(s, /## 감시 종목 오늘의 움직임/);
  assert.match(s, /KORU -5\.08%/, '🔴 가장 크게 움직인 종목이 빠졌다');
  assert.match(s, /055550\(신한지주\) -4\.99%/, '🔴 이름이 안 붙었다 — KR 6자리는 코드만으로는 무의미하다');
  assert.match(s, /\+4\.62%/, '🔴 상승 종목에 부호가 없다');
});

test('🔴 등락률 **크기 순**이다 (부호가 아니라 절댓값)', () => {
  const s = analyst.watchMovesSection(LIVE_ROWS, OPTS);
  const order = s.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.split(' ')[1].replace(/\(.*\)/, ''));
  assert.deepEqual(order.slice(0, 4), ['KORU', '055550', '229200', '042700'], '🔴 순서가 크기순이 아니다');
});

test('⚠️ z 와 role 을 함께 적는다', () => {
  const s = analyst.watchMovesSection(LIVE_ROWS, OPTS);
  assert.match(s, /KORU -5\.08% · [\d.]+σ · 감시/, '🔴 z 또는 role 이 빠졌다');
  assert.match(s, /TSLA[^\n]*되살후보/, '🔴 role 라벨이 안 붙었다');
});

/** 🔴 z 는 **못 구할 수 있다** — 그때 0 으로 적으면 "평범하다" 는 **거짓 판정**이 된다 */
test('🔴 z 를 못 구하면 0 이 아니라 **"판정불가"** 라고 쓴다', () => {
  const s = analyst.watchMovesSection([row('ABC', 9.9, 'watch', [0.1, 0.2])], OPTS);
  assert.match(s, /σ 판정불가/, '🔴 표본이 모자란데 z 를 지어냈다');
  assert.doesNotMatch(s, /0\.0σ/);
});

test('⚠️ 보유 종목은 **뺀다** (`## 보유 종목` 절이 더 자세히 싣는다)', () => {
  const s = analyst.watchMovesSection([row('QLD', -9.9), row('GOOGL', 3.29)], OPTS);
  assert.doesNotMatch(s, /QLD/, '🔴 보유가 중복으로 실렸다 — 예산 낭비다');
  assert.match(s, /GOOGL/);
});

// ── ② 조용하면 "없음" 이라고 쓴다 (절을 빼지 않는다) ──────────

test('🔴 문턱 미만뿐이면 **"특이 움직임 없음"** 이라고 쓴다', () => {
  const s = analyst.watchMovesSection([row('A', 0.3), row('B', -0.9)], OPTS);
  assert.match(s, /## 감시 종목 오늘의 움직임/, '🔴 절이 통째로 사라졌다 — "조용함" 과 "안 봄" 이 같아진다');
  assert.match(s, /특이 움직임 없음/);
  assert.match(s, /조회는 \*\*했습니다\*\*/, '🔴 "봤다" 는 사실이 안 적혔다');
  assert.match(s, /감시 2종/, '⚠️ 몇 종을 봤는지 없으면 "0종을 봤다" 와 구분이 안 된다');
});

test('🔴 rows 가 **빈 배열**이어도 절은 남는다', () => {
  const s = analyst.watchMovesSection([], OPTS);
  assert.match(s, /특이 움직임 없음/);
});

// ── ③ "안 봤다" 는 "조용했다" 와 다른 문장이다 ────────────────

test('🔴🔴 rows 를 **못 받으면** 조용한 경우와 **다른 문장**이다', () => {
  const quiet = analyst.watchMovesSection([row('A', 0.3)], OPTS);
  const missing = analyst.watchMovesSection(undefined, OPTS);
  assert.match(missing, /## 감시 종목 오늘의 움직임/);
  assert.match(missing, /받지 못했습니다/);
  assert.match(missing, /안 봤다/, '🔴 "안 봤다" 라고 말하지 않는다');
  assert.notEqual(quiet, missing, '🔴🔴 두 경우가 **같은 문장**이다 — 이 절의 존재 이유가 무너진다');
  assert.doesNotMatch(missing, /특이 움직임 없음/, '🔴 못 본 것을 "조용했다" 로 적었다');
});

test('⚠️ null·객체 같은 비배열도 "못 받았다" 로 처리한다', () => {
  for (const bad of [null, {}, 'rows']) {
    assert.match(analyst.watchMovesSection(bad, OPTS), /받지 못했습니다/, `🔴 ${JSON.stringify(bad)} 를 조용히 삼켰다`);
  }
});

// ── ④ 길이 예산 — 조용히 자르지 않는다 ───────────────────────

test('🔴 상위 N 개만 싣되 **자른 사실을 적는다**', () => {
  const s = analyst.watchMovesSection(LIVE_ROWS, OPTS);
  const shown = s.split('\n').filter((l) => l.startsWith('- ')).length;
  assert.equal(shown, 8, '기본 N=8 이어야 한다');
  assert.match(s, /\|1\.5%\| 이상 16종/, '🔴 전체 몇 종이 문턱을 넘었는지가 없다');
  assert.match(s, /나머지 8종 생략/, '🔴 조용히 잘랐다 — 8종이 전부인 줄 안다');
});

test('⚠️ 자를 게 없으면 "생략" 문구를 **안 붙인다** (오탐 축)', () => {
  const s = analyst.watchMovesSection([row('A', 5), row('B', -4)], OPTS);
  assert.doesNotMatch(s, /생략/, '🔴 안 자르고도 잘랐다고 적었다');
});

/** ⚠️ **예산은 실측으로 정한다** — "적당히" 는 다음 사람이 못 재현한다 */
test('⚠️ N=8 절의 길이가 예산 안이다 (600자 이하)', () => {
  const s = analyst.watchMovesSection(LIVE_ROWS, OPTS);
  assert.ok(s.length <= 600, `🔴 절이 ${s.length}자다 — 프롬프트 예산을 먹는다`);
  assert.ok(s.length >= 300, `⚠️ ${s.length}자 — 너무 짧으면 내용이 빠진 것이다`);
});

// ── ⑤ 제안 대상이 아니라 보고 대상이다 ───────────────────────

/**
 * 🔴 이렇게 가르지 않으면 모델이 **화이트리스트 밖 티커로 제안**을 내고
 *    계좌·게이트 검증이 **전부 거부**한다 — 지금보다 나빠진다.
 */
test('🔴 "제안 대상이 아니다" 를 **명시**한다', () => {
  const s = analyst.watchMovesSection(LIVE_ROWS, OPTS);
  assert.match(s, /제안 대상이 아니다/, '🔴 모델이 이 티커로 제안을 낸다');
  assert.match(s, /도구상자/, '🔴 어디서 골라야 하는지를 안 알려줬다');
  assert.match(s, /marketView|momentumRead/, '🔴 이 절을 어디에 쓰라는 것인지가 없다');
});

test('⚠️ "없음" 회차에는 제안 금지 문구를 안 붙인다 (적을 이유가 없다)', () => {
  assert.doesNotMatch(analyst.watchMovesSection([row('A', 0.3)], OPTS), /제안 대상이 아니다/);
});

// ── ⑥ 배선 — 두 모듈의 **필드 이름이 같은가** ────────────────

/**
 * 🔴 이 계약은 **파일 두 개에 걸쳐 있고 타입이 없다** — 한쪽에서 이름을 바꾸면
 *    다른 쪽은 `undefined` 를 받아 **조용히 "못 받았다" 로 떨어진다**(절은 나오므로
 *    깨진 티가 안 난다). ⇒ 양쪽을 **소스로 대조**해 못박는다.
 * ⚠️ 주석·문자열을 지우고 **코드로** 본다.
 */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const ALERTS = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'alertService.js'), 'utf-8'));
const ANALYST = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf-8'));

test('🔴 alertService 가 **분석에 rows 를 넘긴다**', () => {
  const i = ALERTS.indexOf('analystRunner({');
  assert.ok(i > 0, '🔴 분석 호출부를 못 찾았다 — 자가 대상을 놓쳤다');
  const call = ALERTS.slice(i, i + 200);
  assert.match(call, /momentumRows:\s*rows/, '🔴 rows 를 안 넘긴다 — 감시 종목이 또 프롬프트에서 사라진다');
});

test('🔴 넘기는 `rows` 가 **collectMomentumRows 의 결과**다 (다른 변수가 아니다)', () => {
  /**
   * ⚠️ 첫 판은 `indexOf('collectMomentumRows(st,')` 로 찾았는데 그게 **함수 선언**(:127)에
   *    먼저 걸려 빨간불이 났다 — 자가 *재려던 그것(호출부)* 이 아니라 다른 것을 잡은 것이다.
   *    ⇒ `await` 를 포함해 **호출부만** 고른다.
   */
  const i = ALERTS.indexOf('await collectMomentumRows(');
  assert.ok(i > 0, '🔴 호출부를 못 찾았다 — 자가 대상을 놓쳤다');
  assert.match(ALERTS.slice(i - 40, i), /const rows =\s*$/, '🔴 변수명이 어긋났다 — 엉뚱한 값을 넘길 수 있다');
});

test('🔴 analystService 가 **같은 이름**으로 읽는다 (계약 양끝)', () => {
  assert.match(ANALYST, /trigger\?\.momentumRows/, '🔴 받는 쪽 필드명이 다르면 조용히 "못 받았다" 가 된다');
});

test('🔴 z 는 **트리거가 쓰는 그 함수**로 센다 (공식 복제 금지)', () => {
  const i = ANALYST.indexOf('watchMovesSection(trigger?.momentumRows');
  assert.ok(i > 0, '🔴 호출부를 못 찾았다');
  assert.match(ANALYST.slice(i, i + 400), /analystTrigger'\)\.zScore/, '🔴 z 공식을 복제하면 두 숫자가 조용히 갈린다');
});

// ── ⑦ 프롬프트에 실제로 실린다 (end-to-end) ──────────────────

const realFetch = global.fetch;
let reportToReturn = null;
const prompts = [];
function analystPrompt() {
  const hit = prompts.find((p) => /trade_analyst/.test(p.label || ''));
  assert.ok(hit, `🔴 분석 프롬프트를 못 찾았다(라벨: ${prompts.map((p) => p.label).join(',') || '없음'})`);
  return hit.text;
}

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService|tickerTapeService/.test(k)) delete require.cache[k];
  }
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      generateStructuredOutput: async (o) => { prompts.push({ label: String(o?.logLabel || ''), text: String(o?.userPrompt || '') }); return reportToReturn; },
      getAiSettings: () => ({}),
    },
  };
  for (const [mod, ex] of [
    ['../server/tickerTapeService', { getTape: async () => ({ items: [], fixed: [], failed: [] }) }],
    ['../server/tossClient', { getCommissions: async () => [], getInvestorTrading: async () => [], getCandles: async () => ({ rows: [] }) }],
    ['../server/mcpClient', { searchMarketNews: async () => ({ ok: false, error: '꺼짐', kind: 'disabled', results: [] }) }],
  ]) {
    const rp = require.resolve(mod); const real = require(rp);
    require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: { ...real, ...ex } };
  }
  return require('../server/analystService');
}

const ITEMS = [
  { symbol: 'QLD', name: 'QLD', market: 'US', currency: 'USD', quantity: 85, avgPrice: 69.04, lastPrice: 88.93, marketValue: 7559.05 },
  { symbol: 'RAM', name: 'RAM', market: 'US', currency: 'USD', quantity: 500, avgPrice: 19.08, lastPrice: 16.5, marketValue: 8115 },
];
const DASH = {
  portfolio: { items: ITEMS, summary: { value: { krw: 21_500_000 }, profitRate: -3.1, dailyRate: 0.2, cash: { usd: { raw: '$3.76', amount: 3.76 }, krw: { raw: '0원', amount: 0 }, failed: [] } } },
  momentum: [], warnings: {}, rankings: {},
};

beforeEach(() => {
  prompts.length = 0;
  reportToReturn = { marketView: 'v', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  global.fetch = async (url) => (/api\.telegram\.org/.test(String(url))
    ? { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
    : { ok: true, status: 200, json: async () => ({}), text: async () => '' });
});
afterEach(() => { global.fetch = realFetch; });

test('🔴 정기 회차 프롬프트에 감시 종목이 **실제로 실린다**', async () => {
  const a = fresh();
  await a.analyze(DASH, { dryRun: true, useWebSearch: false, trigger: { reasons: [{ kind: 'close', key: 'us' }], why: 'close', momentumRows: LIVE_ROWS } });
  const p = analystPrompt();
  assert.match(p, /## 감시 종목 오늘의 움직임/, '🔴 절이 프롬프트에 없다 — 함수만 있고 배선이 없다');
  assert.match(p, /KORU -5\.08%/, '🔴 실제 움직임이 안 실렸다');
  assert.match(p, /제안 대상이 아니다/);
});

test('🔴 트리거 밖 실행(rows 없음)에서는 **"안 봤다"** 가 실린다', async () => {
  const a = fresh();
  await a.analyze(DASH, { dryRun: true, useWebSearch: false, trigger: { reasons: [], why: '수동' } });
  const p = analystPrompt();
  assert.match(p, /## 감시 종목 오늘의 움직임/);
  assert.match(p, /받지 못했습니다/, '🔴 수동 실행이 "조용했다" 로 보인다');
});
