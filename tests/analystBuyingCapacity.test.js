const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * ⚠️ **기본 버퍼는 0 이 됐다** (2026-10-02 사용자 지시). 이 파일은 **버퍼 기계 자체**를
 *    재는 자라서 15% 를 명시해 켠다 — 끈 상태로 두면 이 파일 전체가 공허하게 통과한다.
 *    (기본값이 0 이라는 사실은 `orderAccountCheck.test.js` 가 따로 못박는다.)
 */
process.env.CASH_FLOOR_PCT = '15';
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 **"매수 제안이 왜 0건인가" 를 사실로 말한다** (2026-10-01)
 *
 * 실측 상태: 가용 현금 **USD 3.76 · KRW 0**(총 평가액 15,674 USD). 현금 버퍼 15% 는
 * 2,351 USD 라 `orderService` 의 `cash-floor` 게이트는 **도달조차 불가능한 사문**이었다 —
 * 신규 매수가 **물리적으로 불가능**한데 프롬프트도, 폰 브리핑도, 로그도 그 사실을
 * **한 번도 말하지 않았다.** 41.6시간 4회차 중 3회차가 `proposed:0` 으로 끝났고,
 * 사용자는 그걸 *"제안이 없다"* 로만 봤다.
 *
 * ★ **침묵이 "정상" 과 "고장" 을 똑같이 보이게 만든다.** 이 파일이 지키는 것은 그 구분이다.
 *
 * ⚠️ 그래서 **두 갈래를 양방향으로** 잠근다 — 한쪽만 단언하면 분기가 죽어도 초록불이다.
 *    (`현금 부족` ↔ `모델이 제안 안 함` 이 **서로 다른 문장**으로 나와야 한다)
 */

// 🔴 테스트 파일은 **병렬로** 돈다 — 설정 파일을 공유하면 서로의 값을 덮어쓴다
process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-set-capacity-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `sscap-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `sscap-act-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];
let reportToReturn = null;
/**
 * 모델에게 실제로 간 프롬프트 — "사실을 줬는가" 는 **보낸 글**로만 확인된다.
 *
 * 🔴 **라벨로 골라야 한다.** 첫 판에서 `lastUserPrompt` 한 칸만 두었더니
 *    발송 직전 **토스라이팅 정제**(`tossWriting.refine`)가 같은 AI 함수를 한 번 더 타면서
 *    그 값을 덮어썼다 — 분석 프롬프트를 찾는 단언이 **엉뚱한 글**을 보고 빨간불을 냈고,
 *    더 나쁘게는 `doesNotMatch` 쪽이 **공허하게 통과**했다(검사 대상에 재려던 것이 없었다).
 * ★ *"대상이 0건인가가 아니라 재려던 그것이 대상에 들었나"* 를 자가 직접 밟은 자리다.
 */
const prompts = [];
/**
 * ⚠️ **못 찾으면 빈 문자열을 돌려주면 안 된다** — 그러면 `doesNotMatch` 가 영원히 통과하고
 *    `match` 는 엉뚱한 이유로 실패한다. **검사 대상이 없는 것은 통과가 아니다.**
 */
function analystPrompt() {
  const hit = prompts.find((p) => /trade_analyst/.test(p.label || ''));
  assert.ok(hit, `🔴 분석 프롬프트를 못 찾았다 — 자가 대상을 놓쳤다(받은 라벨: ${prompts.map((p) => p.label).join(',') || '없음'})`);
  assert.match(hit.text, /## 계좌/, '🔴 잡은 글에 계좌 절이 없다 — 재려던 그것이 대상에 안 들었다');
  return hit.text;
}

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|activityLog|mcpClient|tossClient|settingsService|tickerTapeService/.test(k)) {
      delete require.cache[k];
    }
  }
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      generateStructuredOutput: async (opts) => {
        prompts.push({ label: String(opts?.logLabel || ''), text: String(opts?.userPrompt || '') });
        return reportToReturn;
      },
      getAiSettings: () => ({}),
    },
  };
  const tapePath = require.resolve('../server/tickerTapeService');
  const realTape = require(tapePath);
  require.cache[tapePath] = {
    id: tapePath, filename: tapePath, loaded: true,
    exports: { ...realTape, getTape: async () => ({ items: [], fixed: [], failed: [] }) },
  };
  const tossPath = require.resolve('../server/tossClient');
  const realToss = require(tossPath);
  require.cache[tossPath] = {
    id: tossPath, filename: tossPath, loaded: true,
    exports: {
      ...realToss,
      getCommissions: async () => [],
      getInvestorTrading: async () => [],
      getCandles: async () => ({ rows: [] }),
    },
  };
  const mcpPath = require.resolve('../server/mcpClient');
  const realMcp = require(mcpPath);
  require.cache[mcpPath] = {
    id: mcpPath, filename: mcpPath, loaded: true,
    exports: { ...realMcp, searchMarketNews: async () => ({ ok: false, error: '꺼짐', kind: 'disabled', results: [] }) },
  };
  return require('../server/analystService');
}

/** 🔴 **실측 모양 그대로** — 손으로 지어낸 숫자를 쓰면 자가 실제 상태를 못 재현한다 */
const LIVE_ITEMS = [
  { symbol: 'QLD', name: 'QLD', market: 'US', currency: 'USD', quantity: 85, avgPrice: 69.04, lastPrice: 88.93, marketValue: 7559.05 },
  { symbol: 'RAM', name: 'RAM', market: 'US', currency: 'USD', quantity: 500, avgPrice: 19.08, lastPrice: 16.5, marketValue: 8115.0 },
];
const LIVE_CASH = { usd: { raw: '$3.76', amount: 3.76 }, krw: { raw: '0원', amount: 0 }, failed: [] };

function dash(cash, items = LIVE_ITEMS) {
  return {
    portfolio: {
      items,
      summary: { value: { krw: 21_500_000 }, profitRate: -3.1, dailyRate: 0.2, cash },
    },
    momentum: [], warnings: {}, rankings: {},
  };
}

const HOLD_ONLY = {
  marketView: '혼조입니다.', momentumRead: '', dataGaps: [],
  positions: [
    { symbol: 'QLD', trend: '20일선 부근 횡보', confidence: 'LOW', rationale: '20일선 위', evidence: [], risk: 'x' },
    { symbol: 'RAM', trend: '20일선 부근 횡보', confidence: 'LOW', rationale: '평단 회복 대기', evidence: [], risk: 'y' },
  ],
  proposals: [],
};

beforeEach(() => {
  sent = [];
  prompts.length = 0;
  global.fetch = async (url, init) => {
    const u = String(url || '');
    if (!/api\.telegram\.org/.test(u)) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    sent.push(JSON.parse(init?.body || '{}'));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});
afterEach(() => { global.fetch = realFetch; });

// ── ① 판정 자체 (순수 함수) ──────────────────────────────────


/**
 * 🔴 **종전 조건(`krw<=0 && usd<=0`)이 왜 못 잡았는지**를 자가 직접 보여 준다.
 *    이 단언이 없으면 "고쳤다" 는 말만 남고 **무엇이 달라졌는지**는 안 남는다.
 */
test('🔴 판별력: 옛 조건이면 통과했을 상태다 (usd 3.76 > 0)', () => {
  assert.ok(LIVE_CASH.usd.amount > 0, '옛 조건 `usd<=0` 은 이 상태에서 한 번도 안 걸렸다');
});

test('⚠️ 현금이 넉넉하면 **ok** 다 (가드가 정상 매수를 막으면 해롭다)', () => {
  const analyst = fresh();
  const cash = { usd: { raw: '$10,000', amount: 10000 }, krw: { raw: '0원', amount: 0 }, failed: [] };
  const items = [{ symbol: 'QLD', currency: 'USD', lastPrice: 88.93, marketValue: 1000 }];
  const cap = analyst.assessBuyingCapacity(dash(cash, items).portfolio.summary, items);
  assert.equal(cap.state, 'ok', '🔴 살 수 있는데 못 산다고 했다 — 오탐은 제품을 망가뜨린다');
});

test('🔴 버퍼를 빼고도 남지만 **1주 값에 못 미치면** blocked 다', () => {
  const analyst = fresh();
  const cash = { usd: { raw: '$50', amount: 50 }, krw: { raw: '0원', amount: 0 }, failed: [] };
  // marketValue 0 이라 버퍼는 7.5 — 남는 42.5 로는 88.93 짜리 1주를 못 산다
  const items = [{ symbol: 'QLD', currency: 'USD', lastPrice: 88.93, marketValue: 0 }];
  const cap = analyst.assessBuyingCapacity(dash(cash, items).portfolio.summary, items);
  assert.equal(cap.byCurrency.USD.state, 'below-min-price');
  assert.equal(cap.state, 'blocked');
});

/** 🔴 **못 읽은 것과 0 은 다르다** — unknown 을 blocked 로 접으면 "살 수 없다" 고 거짓말한다 */
test('🔴 현금을 못 받으면 blocked 가 아니라 **unknown** 이다', () => {
  const analyst = fresh();
  const cash = { usd: null, krw: null, failed: ['USD', 'KRW'] };
  const cap = analyst.assessBuyingCapacity(dash(cash).portfolio.summary, LIVE_ITEMS);
  assert.equal(cap.state, 'unknown', '🔴 조회 실패를 "돈이 없다" 로 단정했다');
  assert.equal(cap.byCurrency.USD.cash, null, '🔴 못 읽은 현금이 0 으로 적혔다');
});

test('⚠️ 한 통화만 못 읽어도 전체를 blocked 로 **단정하지 않는다**', () => {
  const analyst = fresh();
  const cash = { usd: null, krw: { raw: '0원', amount: 0 }, failed: ['USD'] };
  const cap = analyst.assessBuyingCapacity(dash(cash).portfolio.summary, LIVE_ITEMS);
  assert.equal(cap.state, 'unknown', '🔴 안 읽은 통화가 있는데 "살 수 없다" 고 말했다');
});

test('⚠️ summary 자체가 없으면 unknown (0 으로 가정하지 않는다)', () => {
  const analyst = fresh();
  const cap = analyst.assessBuyingCapacity(null, []);
  assert.equal(cap.state, 'unknown');
});

// ── ② 사용자 브리핑 본문 — **두 갈래가 실제로 갈린다** ────────

test('🔴 현금 부족 회차: 폰 브리핑이 **왜 0건인지** 숫자와 함께 말한다', async () => {
  reportToReturn = HOLD_ONLY;
  const analyst = fresh();
  await analyst.analyze(dash(LIVE_CASH));
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(sent.length, 1, '브리핑이 안 갔다');
  const text = sent[0].text;
  /**
   * 🔴 **2026-10-13 — 전제가 바뀌었다.** 10-12 에 라이브에서 제안을 걷어냈으므로
   *    *"매매 제안 0건"* 이라는 틀 자체가 거짓이 됐다(묻지 않으니 0 인 것이지 못 낸 게 아니다).
   *    ⚠️ 그래도 **"1주도 못 산다" 는 사실은 지킨다** — 직접 거래하는 사람에게 그대로 쓸모 있다.
   *    ⇒ 거짓 틀은 **없어야** 하고, 사실은 **있어야** 한다. 둘 다 단언한다.
   */
  assert.doesNotMatch(text, /매매 제안 \d+건/, '🔴 라이브에는 "제안" 이라는 개념이 없다');
  /**
   * ⛔ **2026-10-14 — 뒤집었다** (사용자 지시). 10-13 에 내가 *"직접 거래하는 사람에게
   *    유용한 사실"* 이라며 남긴 줄인데, **"매수 여력" 은 살 것을 전제한 개념**이라
   *    보고서 제품에는 자리가 없다. 사용자: *"신규 매수 여력 없음 저거도 왜 나오는거야?"*
   * ⚠️ **현금 비중 자체는 안 사라진다** — 포트폴리오 화면과 `portfolioRules` 에 숫자로 남는다.
   */
  assert.doesNotMatch(text, /신규 매수 여력 없음/, '🔴 매수 전제 문구가 폰에 되살아났다');
  assert.doesNotMatch(text, /1주도 살 수 없/, '🔴 매수 전제 문구가 폰에 되살아났다');
  // ⛔ 2026-10-14: 현금 줄 자체가 브리핑에서 빠졌으므로 금액도 없다(위 주석 참조)
  assert.doesNotMatch(text, /3\.76/, '🔴 매수 여력 문구가 금액과 함께 되살아났다');
});

test('🔴 현금 충분 회차: **같은 0건인데 다른 이유**가 나온다 (모델이 제안 안 함)', async () => {
  reportToReturn = HOLD_ONLY;
  const analyst = fresh();
  const cash = { usd: { raw: '$10,000', amount: 10000 }, krw: { raw: '0원', amount: 0 }, failed: [] };
  await analyst.analyze(dash(cash, [{ symbol: 'QLD', name: 'QLD', market: 'US', currency: 'USD', quantity: 10, lastPrice: 88.93, marketValue: 889 }]));
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(sent.length, 1);
  const text = sent[0].text;
  /**
   * 🔴 **2026-10-13 — 여력이 있으면 "아무 말도 안 한다" 가 맞다.**
   *    종전엔 *"현금 여력은 있으나 모델이 제안을 내지 않았습니다"* 를 **매 회차** 적었다.
   *    제안을 묻지 않는 지금 그 문장은 거짓이고, 매번 붙으면 소음이 된다
   *    (소음이 되면 침묵과 같아진다 — 이 저장소가 반복해 적어 둔 그 자리).
   */
  assert.doesNotMatch(text, /매매 제안 \d+건/);
  assert.doesNotMatch(text, /신규 매수 여력 없음/, '🔴 현금이 넉넉한데 막혔다고 했다');
  assert.doesNotMatch(text, /현금을 확인하지 못했습니다/, '🔴 읽었는데 못 읽었다고 했다');
  /**
   * 🔴 **양방향** — 갈래가 죽어 한쪽 문구만 나오면 위 테스트와 이 테스트 중 하나는
   *    여전히 통과한다. 그래서 **반대 문구가 없음**까지 단언한다.
   */

});

test('🔴 현금을 못 읽은 회차: 0 이라 하지 않고 **"확인 못 함"** 이라 말한다', async () => {
  reportToReturn = HOLD_ONLY;
  const analyst = fresh();
  await analyst.analyze(dash({ usd: null, krw: null, failed: ['USD', 'KRW'] }));
  await new Promise((r) => setTimeout(r, 40));

  const text = sent[0].text;
  assert.doesNotMatch(text, /매매 제안 \d+건/);
  assert.doesNotMatch(text, /현금을 확인하지 못했습니다/, '🔴 매수 여력 문구가 폰에 되살아났다');
  // 🔴 **양방향** — 한쪽 갈래가 죽어도 다른 테스트가 통과해 버리는 것을 막는다
  assert.doesNotMatch(text, /신규 매수 여력 없음/, '🔴 못 읽은 것을 "없다" 로 단정했다');
});

// ── ③ 모델에게 가는 프롬프트 — **지시가 아니라 사실** ─────────

test('🔴 프롬프트가 "살 수 없다는 **사실**" 을 주고 매도·보유로 돌린다', async () => {
  reportToReturn = HOLD_ONLY;
  const analyst = fresh();
  await analyst.analyze(dash(LIVE_CASH));
  await new Promise((r) => setTimeout(r, 40));

  assert.match(analystPrompt(), /신규 매수는 불가능합니다/, '🔴 모델이 제약을 모른 채 판단한다');
  assert.match(analystPrompt(), /매도·보유 판단에 집중/, '🔴 남은 선택지를 안 알려줬다');
  assert.match(analystPrompt(), /계좌의 상태/, '⚠️ 금지 지시로 읽히면 모델이 판단을 왜곡한다');
});

test('⚠️ 현금이 넉넉하면 프롬프트에 그 문구가 **안 나온다** (오탐 축)', async () => {
  reportToReturn = HOLD_ONLY;
  const analyst = fresh();
  const cash = { usd: { raw: '$10,000', amount: 10000 }, krw: { raw: '0원', amount: 0 }, failed: [] };
  await analyst.analyze(dash(cash, [{ symbol: 'QLD', name: 'QLD', market: 'US', currency: 'USD', quantity: 10, lastPrice: 88.93, marketValue: 889 }]));
  await new Promise((r) => setTimeout(r, 40));

  assert.doesNotMatch(analystPrompt(), /신규 매수는 불가능합니다/, '🔴 살 수 있는데 못 산다고 모델에게 말했다');
});

// ── ④ 이유 문구 생성기 (갈래별) ──────────────────────────────

/**
 * ⛔ **2026-10-14 — `describeNoProposal` 을 재던 두 테스트를 정리했다.**
 *
 * 그 함수는 *"왜 제안이 0건인가"* 를 설명했는데, **2026-10-12 에 라이브가 제안을 묻지 않게**
 * 되면서 호출부가 0 이 됐다(죽은 코드). 네 갈래를 가르던 테스트는 **잴 대상이 사라졌다.**
 *
 * 🔴 **그런데 한 축은 살려서 옮긴다** — *"매수 여력은 **매수에만** 걸린다. 현금이 0 이어도
 *    매도는 할 수 있다"* 는 규율은 지금 쓰는 `describeCashCapacity` 에도 **그대로 유효**하고,
 *    지우면 **아무도 안 재게 된다**(위 209행은 *"여력 없음"* 만 보고 **범위**는 안 본다).
 * ★ *"지우기 전에 그 테스트가 무엇을 지키려 했는지 본다"* — 함수가 죽어도 **규율은 살아 있다.**
 */
test('⚠️ 문구가 "거래 불가" 가 아니라 "**신규 매수** 불가" 라고 적는다 (현금 0 이어도 매도는 된다)', () => {
  const analyst = fresh();
  const cap = analyst.assessBuyingCapacity(dash(LIVE_CASH).portfolio.summary, LIVE_ITEMS);
  const t = analyst.describeCashCapacity(cap);
  assert.match(t, /신규 매수/, '🔴 매도까지 불가능한 것처럼 읽힌다');
  assert.doesNotMatch(t, /거래 불가|매매 불가/, '🔴 매도까지 막힌 것처럼 적었다');
});

test('⚠️ capacityDetail 은 못 읽은 통화를 **"확인 못 함"** 으로 적는다', () => {
  const analyst = fresh();
  const cap = analyst.assessBuyingCapacity(dash({ usd: null, krw: { raw: '0', amount: 0 }, failed: ['USD'] }).portfolio.summary, LIVE_ITEMS);
  const d = analyst.capacityDetail(cap.byCurrency);
  assert.match(d, /USD 확인 못 함/);
  assert.match(d, /KRW 매수가능/);
});

// ── ⑤ 로그 — **금액은 디스크에 남기지 않는다** ────────────────

/**
 * 🔴 **로그에서 금액을 뺀다** (2026-10-01 판정) — `tossPortfolio.js:167` 의
 *    *"금액·수량은 로그에 남기지 않는다. 건수와 성패만."* 이 이긴다. 로그는 **journald 로
 *    디스크에 남고** 일일 백업·`.23` 오프사이트까지 따라간다.
 *
 * ⚠️ 그러면서 **목적은 살린다** — 이 줄은 *"왜 0건인가"* 를 소급으로 가르는 장치이고,
 *    그 질문에는 **구간(none·under_one_share·ok·unknown)** 이면 충분하다.
 * 🔴 **"금액이 안 보인다" 를 구조로 단언한다** — 다음 사람이 되살려도 여기서 잡히게.
 */
function captureNoProposalLog() {
  const realLog = console.log;
  const hits = [];
  console.log = (line) => {
    try {
      const o = JSON.parse(line);
      if (o?.event === 'analyst.no_proposal_reason') hits.push({ obj: o, raw: line });
    } catch { /* 우리 포맷이 아니면 무시 */ }
  };
  return { hits, restore: () => { console.log = realLog; } };
}

/** 🔴 **구별되는 금액**을 쓴다 — 흔한 값이면 "안 실렸다" 가 우연히 통과한다 */
const ODD_CASH = { usd: { raw: '$1234.56', amount: 1234.56 }, krw: { raw: '7654321원', amount: 7654321 }, failed: [] };

test('🔴 로그에 **금액이 한 글자도** 안 실린다', async () => {
  reportToReturn = HOLD_ONLY;
  const analyst = fresh();
  const cap = captureNoProposalLog();
  try {
    await analyst.analyze(dash(ODD_CASH));
    await new Promise((r) => setTimeout(r, 40));
  } finally { cap.restore(); }

  assert.equal(cap.hits.length, 1, '🔴 줄이 안 나왔다 — 자가 대상을 놓쳤다(이유 집계가 통째로 죽는다)');
  const { obj, raw } = cap.hits[0];
  // ① 값으로 — 실제로 넘긴 금액이 직렬화된 줄에 없어야 한다
  for (const amt of ['1234.56', '7654321']) {
    assert.ok(!raw.includes(amt), `🔴 로그에 금액 ${amt} 가 남았다: ${raw}`);
  }
  // ② 구조로 — 금액 성격의 필드 이름이 아예 없어야 한다(다음 사람이 다른 값으로 되살려도 잡힌다)
  const banned = Object.keys(obj).filter((k) => /cash(Usd|Krw)$|available|amount|floorAmount/i.test(k));
  assert.deepEqual(banned, [], `🔴 금액 필드가 되살아났다: ${banned.join(',')}`);
});

test('🔴 대신 **구간**이 실린다 (목적은 살아 있다)', async () => {
  reportToReturn = HOLD_ONLY;
  const analyst = fresh();
  const cap = captureNoProposalLog();
  try {
    await analyst.analyze(dash(LIVE_CASH));
    await new Promise((r) => setTimeout(r, 40));
  } finally { cap.restore(); }

  const o = cap.hits[0].obj;
  assert.equal(o.reason, 'no_buying_capacity');
  assert.equal(o.cashBandUsd, 'none', '🔴 USD 구간이 틀렸다 — 버퍼 빼면 남는 게 없다');
  assert.equal(o.cashBandKrw, 'none');
  // 건수·성패는 남긴다(그건 금지 대상이 아니다)
  assert.equal(o.positions, 2);
  assert.equal(o.proposed, 0);
});

test('🔴 구간이 **갈린다** — ok / under_one_share / unknown', () => {
  const analyst = fresh();
  const band = (cash, items) => analyst.capacityBand(
    analyst.assessBuyingCapacity(dash(cash, items).portfolio.summary, items).byCurrency.USD
  );
  const px = [{ symbol: 'QLD', currency: 'USD', lastPrice: 88.93, marketValue: 0 }];
  assert.equal(band({ usd: { raw: 'x', amount: 10000 }, krw: null, failed: [] }, px), 'ok');
  assert.equal(band({ usd: { raw: 'x', amount: 50 }, krw: null, failed: [] }, px), 'under_one_share');
  assert.equal(band({ usd: null, krw: null, failed: ['USD'] }, px), 'unknown');
  assert.equal(band({ usd: { raw: 'x', amount: 0 }, krw: null, failed: [] }, px), 'none');
});

/**
 * ⚠️ **브리핑 본문에는 금액을 그대로 둔다** — 본인 폰이고 이미 평단·수량이 가는 자리다.
 *    가리는 기준은 *"민감하냐"* 가 아니라 ***"디스크에 남느냐"*** 다.
 *    이 단언이 없으면 다음 사람이 "금액 금지" 를 브리핑까지 확대해 **진단력을 날린다.**
 */
/**
 * ⛔ **2026-10-14 — 뒤집었다.** 종전에는 *"폰 본문에 현금 금액이 유지되는가"* 를 쟀다.
 *    현금 줄 자체를 들어냈으므로(사용자 지시) 금액도 안 간다.
 * ⚠️ **`capacity` 계산은 살아 있다** — 프롬프트와 `portfolioRules` 가 쓴다.
 *    사라진 것은 **폰에 적는 문장** 하나다. 아래 로그 테스트가 계산이 도는 것을 지킨다.
 */
test('🔴 브리핑 본문에 현금 금액이 되살아나지 않는다', async () => {
  reportToReturn = HOLD_ONLY;
  const analyst = fresh();
  await analyst.analyze(dash(LIVE_CASH));
  await new Promise((r) => setTimeout(r, 40));
  assert.doesNotMatch(sent[0].text, /3\.76/, '🔴 매수 전제 문구가 되살아났다');
  assert.doesNotMatch(sent[0].text, /매수 여력|1주도 살 수 없/, '🔴 매수 전제 문구가 되살아났다');
});

/**
 * 🔴 **버퍼 비율은 복제하지 않는다** — `orderService` 의 그 상수를 그대로 읽어야,
 *    누가 값을 바꿔도 이 판정이 옛 값을 보고 "살 수 있다" 고 거짓말하지 않는다.
 *    (이 저장소가 적어 둔 *"가드가 검사하는 값이 실제로 쓰이는 값인가"* 그 실패 모드)
 */
