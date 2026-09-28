const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 VIX 사다리 배선 (2026-09-28, pm1 위임)
 *
 * `regimeService.compute()` 는 `vix.{value,stale,ageMin}` 을 이미 상태에 싣고
 * `ladderProposals()` 도 그 셋을 받아 `reason` 문구에 낡은 정도를 적도록 돼 있었는데,
 * **실제 호출부(`alertService.js`)가 안 넘기고 있었다.** 675개 테스트가 전부 초록이었던
 * 이유는 함수 단위 테스트가 이 "호출부가 실제로 넘기는가" 를 원리상 못 보기 때문이다.
 *
 * 이 파일은 그 배선 자체를 잰다 — `ladderProposals` 가 받은 **인자 객체**를 포착해
 * `rgState.vix` 의 값과 **정확히 일치**하는지 본다("옵션을 받는다" 가 아니라 "받았다").
 */

process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-set-ladderwire-${process.pid}.json`);
process.env.ALERTS_STATE_FILE = path.join(os.tmpdir(), `ssalerts-ladderwire-${process.pid}.json`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ssact-ladderwire-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];

/** ⚠️ 스텁은 alertService 를 require 하기 *전*에 꽂는다(alerts.test.js 와 같은 함정) */
function freshAlerts(env = {}, before = null) {
  for (const k of Object.keys(require.cache)) {
    if (/alertService|telegramBot|telegramService|tickerTapeService|tossPortfolio|tossClient|activityLog|settingsService|regimeService|orderService/.test(k)) {
      delete require.cache[k];
    }
  }
  Object.assign(process.env, env);
  if (before) before();
  return require('../server/alertService');
}

/**
 * `regime.refresh()` 를 틱마다 다른 밴드/VIX 메타를 주는 대역으로, `ladderProposals` 를
 * 인자를 포착만 하고 빈 배열을 돌려주는 대역으로 갈아끼운다(빈 배열이면 시세 조회·주문
 * 제안 경로를 안 타므로 이 테스트는 **배선만** 본다 — 발화 조건·산수는 건드리지 않는다).
 */
function stubRegimeSequence(bandSeq, vixMetaSeq, captured) {
  return () => {
    require('../server/tossPortfolio').getHoldings = async () => ({
      items: [], summary: { cash: { usd: { amount: 5000 } } },
    });
    require('../server/settingsService').getDashboardSettings = () => ({ targets: {} });
    let call = 0;
    const regime = require('../server/regimeService');
    regime.refresh = async () => {
      const i = Math.min(call, bandSeq.length - 1);
      const band = bandSeq[i];
      const vixMeta = vixMetaSeq[i];
      call += 1;
      return {
        state: { vix: band == null ? null : { band, ...vixMeta } },
        transitions: [],
        scenarios: [],
      };
    };
    regime.ladderProposals = (args) => { captured.push(args); return []; };
  };
}

beforeEach(() => {
  sent = [];
  if (fs.existsSync(process.env.ALERTS_STATE_FILE)) fs.rmSync(process.env.ALERTS_STATE_FILE);
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('finance.yahoo.com')) {
      return { ok: true, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 100 } }] } }) };
    }
    sent.push({ url: u, body: JSON.parse(init?.body || '{}') });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});
afterEach(() => {
  global.fetch = realFetch;
  for (const f of [process.env.ALERTS_STATE_FILE, process.env.ACTIVITY_FILE]) {
    if (f && fs.existsSync(f)) fs.rmSync(f);
  }
  delete process.env.ALERTS_ENABLED;
});

test('🔴 낡은 VIX — ladderProposals 가 vixValue/vixStale/vixAgeMin 을 rgState.vix 그대로 받는다', async () => {
  const captured = [];
  const a = freshAlerts({ ALERTS_ENABLED: 'true' }, stubRegimeSequence(
    [1, 2],
    [{ value: 20, stale: false, ageMin: null }, { value: 29, stale: true, ageMin: 47 }],
    captured,
  ));
  await a.tick(); // 기준선(prevBand=null) — 사다리 호출 없음
  assert.equal(captured.length, 0, '기준선 틱에서 사다리가 불렸다');

  await a.tick(); // band 1→2 전이, VIX stale
  assert.equal(captured.length, 1, '밴드가 올랐는데 사다리가 안 불렸다');
  assert.equal(captured[0].vixValue, 29, 'vixValue 가 rgState.vix.value 와 다르다');
  assert.equal(captured[0].vixStale, true, 'vixStale 이 true 로 안 넘어갔다');
  assert.equal(captured[0].vixAgeMin, 47, 'vixAgeMin 이 안 넘어갔다');
  assert.equal(captured[0].prevBand, 1);
  assert.equal(captured[0].band, 2);
});

test('신선한 VIX — vixStale 이 명시적으로 false 로 넘어간다(평상시 문구를 안 더럽힌다는 증거)', async () => {
  const captured = [];
  const a = freshAlerts({ ALERTS_ENABLED: 'true' }, stubRegimeSequence(
    [1, 2],
    [{ value: 18, stale: false, ageMin: null }, { value: 18, stale: false, ageMin: null }],
    captured,
  ));
  await a.tick();
  await a.tick();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].vixValue, 18);
  assert.equal(captured[0].vixStale, false, 'vixStale 이 false 로 명시되지 않았다(생략이 아니라 값으로)');
  assert.equal(captured[0].vixAgeMin, null);
});

// ── 🔴 이름 어긋남 감지 (2026-09-28, pm1 재지시) ─────────────────────────
//
// 위 두 테스트는 `regime.refresh()` 를 손으로 적은 리터럴 `{value, stale, ageMin}` 로
// 갈아끼운다. 그래서 `regimeService.compute()` 가 실제로 만드는 키 이름이 바뀌어도
// (worker3 교차 변이 실측: `ageMin` → `ageMinutes`) **못 잡는다** — 스텁과 배선이
// 같은 문자열을 각자 손으로 타이핑한 우연으로 통과했을 뿐이다.
//
// 그래서 이 테스트는 `compute()` 를 **실물로** 불러 그 산출물을 그대로 `refresh()` 의
// 반환값에 흘려보낸다. 🔴 기대값은 그 산출물에서 **같은 이름으로 다시 읽어오지 않는다**
// (그러면 양쪽이 undefined 로 우연히 같아질 수 있다) — 대신 우리가 `compute()` 에
// **넣은 원본 리터럴**과 비교한다. `compute()` 나 `alertService` 어느 쪽이든 필드
// 이름이 어긋나면 그 값은 원본과 달라지므로(대개 null/false) 반드시 깨진다.

test('🔴 이름 어긋남 감지 — compute() 실물 산출물을 흘려보내도 원본 입력값이 그대로 나온다', async () => {
  const captured = [];
  const VIX_INPUT = 26.4; // 실사고 라이브 메시지("VIX 26.4 — 38분 전 값")와 같은 값
  const AGE_MIN_INPUT = 38;

  const a = freshAlerts({ ALERTS_ENABLED: 'true' }, () => {
    require('../server/tossPortfolio').getHoldings = async () => ({
      items: [], summary: { cash: { usd: { amount: 5000 } } },
    });
    require('../server/settingsService').getDashboardSettings = () => ({ targets: {} });
    const regime = require('../server/regimeService');
    // 🔴 손으로 만든 객체가 아니라 **실제 compute() 호출 결과**를 그대로 쓴다
    const baseline = regime.compute({ vix: 18 }); // 낮은 밴드 — 기준선
    const rising = regime.compute({ vix: VIX_INPUT, vixStale: true, vixAgeMin: AGE_MIN_INPUT }); // 높은 밴드 + stale
    const sequence = [baseline, rising];
    let call = 0;
    regime.refresh = async () => {
      const state = sequence[Math.min(call, sequence.length - 1)];
      call += 1;
      return { state, transitions: [], scenarios: [] };
    };
    regime.ladderProposals = (args) => { captured.push(args); return []; };
  });

  await a.tick(); // 기준선
  assert.equal(captured.length, 0, '기준선 틱에서 사다리가 불렸다');

  await a.tick(); // 밴드 전이(compute() 실물 판정으로 vixBandOf(18) < vixBandOf(26.4) 여야 한다)
  assert.equal(captured.length, 1,
    '밴드 전이인데 사다리가 안 불렸다 — compute() 가 만드는 band 이름이 alertService 가 읽는 이름과 어긋났을 수 있다');
  // ⚠️ 아래는 rising.vix.value/stale/ageMin 을 "다시 읽어" 비교하지 않는다(그러면 양쪽이 같은
  //    이름을 잃어도 undefined===undefined 로 통과해 버린다). 원본 입력 리터럴과 비교한다.
  assert.equal(captured[0].vixValue, VIX_INPUT,
    'vixValue 파이프가 끊겼다 — compute() 산출 키와 alertService 읽기 키 이름이 어긋난다');
  assert.equal(captured[0].vixStale, true,
    'vixStale 파이프가 끊겼다 — compute() 산출 키와 alertService 읽기 키 이름이 어긋난다');
  assert.equal(captured[0].vixAgeMin, AGE_MIN_INPUT,
    'vixAgeMin 파이프가 끊겼다 — compute() 산출 키와 alertService 읽기 키 이름이 어긋난다(예: ageMin→ageMinutes)');
});
