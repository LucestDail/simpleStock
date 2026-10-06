const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// 🔴 테스트 파일은 **병렬로** 돈다 — 설정을 공유하면 서로의 값을 덮어쓴다(경합은 초록불도 만든다)
process.env.SETTINGS_FILE = require('node:path').join(require('node:os').tmpdir(), `ss-set-entrybl-${process.pid}.json`);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 가격 기준선 = **진입 용도일 수 있다** (2026-10-06 사용자 실사용에서 발각)
 *
 * 사용자가 QLD 에 `stop: 90` 을 걸었는데 이것은 손절이 아니라 **"$90 떨어지면 진입 검토"** 다.
 * 그런데 서버가 ①"손절선 이탈" 이라고 용도를 지어내 알리고 ②보유 종목만 판정해
 * 미보유 진입 기준선이 영영 안 울리고 ③전량 매도하면 기준선을 자동 삭제했다.
 *
 * ## 이 자가 지키는 세 가지
 * 1. **문구에 용도가 없다** — 방향만("상향/하향 기준선 통과"). 용도는 사용자만 안다.
 *    평가손익 꼬리는 보유 중일 때만(미보유 행에 붙이면 NaN% 가 나간다).
 * 2. **감시중(watch=on) 미보유 종목도 판정한다** — 시세는 배치 1콜(`toss.getPrices`).
 *    ⚠️ 시세를 못 읽은 종목은 판정하지 않는다(0 비교는 하향 기준선 거짓 발화) + warn.
 * 3. **pruning 이 감시중 종목을 보존한다** — 보유·감시 **모두 아닌** 것만 지운다.
 *    감시 목록을 못 읽었으면(null) 지우지 않는다(보유 실패와 같은 보수 규칙).
 */

process.env.ALERTS_STATE_FILE = path.join(os.tmpdir(), `ss-entrybl-${process.pid}.json`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-entrybl-act-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN';
process.env.TELEGRAM_CHAT_ID = '999';
// 🔴 발송을 켜 둔다 — 안 켜면 "무엇이 나갔는가" 테스트가 전부 공허하게 통과한다(alerts.test.js 전례)
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];
let warns = [];
let realLogWarn = null;

/** ⚠️ 스텁은 alertService require **전**에 — 구조분해 캡처 때문(이 저장소에서 네 번 밟은 함정) */
function freshAlerts(env = {}, before = null) {
  for (const k of Object.keys(require.cache)) {
    if (/alertService|telegramBot|telegramService|tickerTapeService|tossPortfolio|tossClient|activityLog|settingsService/.test(k)) {
      delete require.cache[k];
    }
  }
  Object.assign(process.env, env);
  if (before) before();
  return require('../server/alertService');
}

/**
 * 보유·기준선·감시 목록·시세를 흉내 낸다.
 * @param {Map|Error|null} prices  미보유 감시 종목의 시세. Error 면 getPrices 가 던진다.
 * @param {boolean} watchlistBroken  getWatchlistState 가 던진다(못 읽음 축)
 */
function stubs({ items = [], targets = {}, watchGroups = [], prices = new Map(), watchlistBroken = false, onSave = null } = {}) {
  return () => {
    require('../server/tossPortfolio').getHoldings = async () => ({ items, summary: null });
    const ss = require('../server/settingsService');
    ss.getDashboardSettings = () => ({ targets });
    if (onSave) ss.updateSettings = async (patch) => { onSave(patch); };
    const wl = require('../server/watchlistService');
    wl.getWatchlistState = watchlistBroken
      ? () => { throw new Error('watchlist 깨짐'); }
      : () => ({ groups: watchGroups });
    require('../server/tossClient').getPrices = async () => {
      if (prices instanceof Error) throw prices;
      return prices;
    };
    // warn 을 기록한다 — "못 읽었다" 가 debug 로 삼켜지지 않는지 보는 축
    const logger = require('../server/logger');
    if (!realLogWarn) realLogWarn = logger.logWarn;
    logger.logWarn = (msg, ctx) => { warns.push({ msg, ctx }); };
  };
}

const QUIET_OFF = {
  ALERTS_ENABLED: 'true',
  ALERTS_MOVE_PCT: '99',
  ALERTS_INDEX_PCT: '999',
  ALERTS_QUIET_FROM: '3',
  ALERTS_QUIET_TO: '3',
};

beforeEach(() => {
  sent = [];
  warns = [];
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
  if (realLogWarn) { require('../server/logger').logWarn = realLogWarn; }
  for (const f of [process.env.ALERTS_STATE_FILE, process.env.ACTIVITY_FILE]) {
    if (f && fs.existsSync(f)) fs.rmSync(f);
  }
  delete process.env.ALERTS_ENABLED;
});

// ── ① 문구 중립 + 꼬리 조건 ─────────────────────────────────

test('📉 감시중 미보유 종목의 하향 기준선 — 중립 문구 · 평가손익 꼬리 없음', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [], // 전량 매도 상태
    targets: { QLD: { target: null, stop: 90 } },
    watchGroups: [{ id: 'g', tickers: [{ symbol: 'QLD', name: 'QLD', watch: true }] }],
    prices: new Map([['QLD', { price: 85 }]]),
  }));
  await a.tick();
  const hit = sent.find((x) => /하향 기준선 통과/.test(x.body.text || ''));
  assert.ok(hit, '미보유 감시 종목의 기준선이 안 울렸다 — 진입 기준선이 죽어 있다');
  // 🔴 용도 단어 금지 — "손절선 이탈" 은 서버가 용도를 지어낸 것이다(진입 용도일 수 있다)
  assert.ok(!/손절|목표가/.test(hit.body.text), `용도 단어가 남아 있다: ${hit.body.text}`);
  // 미보유 — 평가손익이 없으니 꼬리를 붙이면 안 된다(NaN% 방지)
  assert.ok(!/평가손익/.test(hit.body.text), `미보유인데 평가손익 꼬리가 붙었다: ${hit.body.text}`);
});

test('📈 보유 종목의 상향 기준선 — 중립 문구 + 평가손익 꼬리는 **보유라서** 붙는다', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [{ symbol: 'QLD', name: 'QLD', lastPrice: 95, profitRate: 10, dailyRate: 0 }],
    targets: { QLD: { target: 90, stop: null } },
  }));
  await a.tick();
  const hit = sent.find((x) => /상향 기준선 통과/.test(x.body.text || ''));
  assert.ok(hit, '보유 종목 상향 기준선이 안 울렸다');
  assert.ok(!/목표가|손절/.test(hit.body.text), `용도 단어가 남아 있다: ${hit.body.text}`);
  assert.match(hit.body.text, /평가손익 \+10\.00%/, '보유 중인데 평가손익 꼬리가 빠졌다');
});

// ── ② 시세를 못 읽으면 판정하지 않는다 ──────────────────────

test('🔴 시세를 못 읽은 감시 종목은 판정하지 않는다 — 그리고 조용하지 않다(warn)', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [],
    targets: { QLD: { target: null, stop: 90 } },
    watchGroups: [{ id: 'g', tickers: [{ symbol: 'QLD', name: 'QLD', watch: true }] }],
    prices: new Map(), // 배치는 성공했는데 이 종목의 값이 없다
  }));
  await a.tick();
  assert.ok(!sent.some((x) => /기준선 통과/.test(x.body.text || '')),
    '시세도 없이 기준선을 판정했다 — 0/null 비교는 거짓 알림이다');
  assert.ok(warns.some((w) => w.msg === 'alerts.targets_watch_price_missing' && w.ctx?.symbol === 'QLD'),
    '못 읽은 사실이 warn 으로 안 남았다 — "안 울림" 이 "기준 미달" 과 구분이 안 된다');
});

test('감시 아닌 미보유 종목은 (기준선이 있어도) 판정하지 않는다', async () => {
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [],
    targets: { QLD: { target: null, stop: 90 } },
    watchGroups: [], // 감시 아님
    // ⚠️ 시세가 **있어도** 판정하면 안 된다 — "시세가 없어서 조용했다" 로 공허하게 통과하지 않게
    prices: new Map([['QLD', { price: 85 }]]),
  }));
  await a.tick();
  assert.ok(!sent.some((x) => /기준선 통과/.test(x.body.text || '')), '감시도 보유도 아닌데 판정했다');
});

// ── ③ pruning: 보유·감시 모두 아닌 것만 ─────────────────────

test('🔴 전량 매도해도 **감시중이면** 기준선을 보존한다 / 감시 아니면 지운다 (쌍)', async () => {
  let saved = null;
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [{ symbol: 'HELD', name: 'HELD', lastPrice: 10, profitRate: 1, dailyRate: 0 }],
    targets: {
      HELD: { target: 999, stop: null },   // 보유 → 보존
      QLD: { target: null, stop: 90 },     // 미보유+감시 → 보존 (진입 기준선)
      GONE: { target: 10, stop: null },    // 미보유+감시 아님 → 정리
    },
    watchGroups: [{ id: 'g', tickers: [{ symbol: 'QLD', name: 'QLD', watch: true }, { symbol: 'GONE', name: 'GONE', watch: false }] }],
    prices: new Map(), // QLD 시세 없음 — 판정은 안 하지만 기준선은 남아야 한다
    onSave: (patch) => { saved = patch; },
  }));
  await a.tick();
  assert.ok(saved, '정리를 안 했다');
  assert.deepEqual(Object.keys(saved.dashboard.targets).sort(), ['HELD', 'QLD'],
    '감시중 종목을 지웠거나, 보유·감시 모두 아닌 것을 남겼다');
  const prune = sent.find((x) => /기준선을 정리/.test(x.body.text || ''));
  assert.ok(prune, '지운 사실을 안 알렸다');
  assert.match(prune.body.text, /보유·감시 모두 아닌/, '문구가 "보유만" 기준처럼 읽힌다');
  assert.match(prune.body.text, /GONE/);
});

test('🔴 감시 목록을 **못 읽으면** 지우지 않는다 — 못 본 것은 "감시 아님" 이 아니다', async () => {
  let saved = null;
  const a = freshAlerts(QUIET_OFF, stubs({
    items: [{ symbol: 'HELD', name: 'HELD', lastPrice: 10, profitRate: 1, dailyRate: 0 }],
    targets: { QLD: { target: null, stop: 90 } }, // 미보유 — 감시 여부를 모른다
    watchlistBroken: true,
    onSave: (patch) => { saved = patch; },
  }));
  await a.tick();
  assert.equal(saved, null, '감시 목록을 못 읽었는데 기준선을 지웠다 — 사용자 설정이 날아간다');
  assert.ok(warns.some((w) => w.msg === 'alerts.prune_skipped_watchlist_unreadable'),
    '건너뛴 사실이 로그에 안 남았다');
});
