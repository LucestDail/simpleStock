const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 애널리스트 → 텔레그램 자동 발송 (2026-09-21)
 *
 * 사용자: *"텔레그램 발송을 별도로 버튼으로 하지말고 … **애널리스트가 판단하면 바로 쏴.**"*
 *
 * ## 🔴 "바로 쏴" 와 "같은 말을 세 번 하지 마" 를 **둘 다** 지켜야 한다
 *
 * 같은 요청에서 사용자는 *"매매 분석은 바로 실행 시작해"* 도 했다 —
 * **화면에 들어올 때마다 분석이 돈다.** 그대로 쏘면 새로고침 세 번에 **같은 글이 세 번** 간다.
 * 그건 사용자가 원한 "바로" 가 아니다. ⇒ **내용이 같으면 건너뛰고, 바뀌면 즉시 보낸다.**
 */

process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `sstg-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `sstg-act-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];
let reportToReturn = null;

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService/.test(k)) {
      delete require.cache[k];
    }
  }
  // LLM 은 스텁 — 이 테스트가 재는 건 **발송 규칙**이지 모델이 아니다
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: { generateStructuredOutput: async () => reportToReturn, getAiSettings: () => ({}) },
  };
  const mcpPath = require.resolve('../server/mcpClient');
  const realMcp = require(mcpPath);
  require.cache[mcpPath] = {
    id: mcpPath, filename: mcpPath, loaded: true,
    exports: { ...realMcp, searchMarketNews: async () => ({ ok: false, error: '꺼짐', kind: 'disabled', results: [] }) },
  };
  return require('../server/analystService');
}

const DASH = { portfolio: { items: [], summary: null }, momentum: [], warnings: {}, rankings: {} };

beforeEach(() => {
  sent = [];
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init?.body || '{}'));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});
afterEach(() => { global.fetch = realFetch; });

test('판단이 나오면 **버튼 없이 바로** 텔레그램으로 간다', async () => {
  reportToReturn = {
    marketView: '지수는 혼조입니다.',
    momentumRead: '큰 움직임 없음',
    dataGaps: [],
    positions: [{ symbol: 'QLD', stance: 'HOLD', confidence: 'MEDIUM', rationale: '20일선 위', evidence: [], risk: '변동성' }],
    proposals: [],
  };
  const analyst = fresh();
  await analyst.analyze(DASH);
  // 비동기 발송이라 한 틱 기다린다
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 1, '분석했는데 안 보냈다');
  assert.match(sent[0].text, /매매 분석/);
  assert.match(sent[0].text, /지수는 혼조/);
  assert.match(sent[0].text, /QLD HOLD/);
});

test('🔴 **같은 내용이면 두 번 보내지 않는다** (화면 새로고침마다 분석이 돈다)', async () => {
  reportToReturn = {
    marketView: '같은 시황', momentumRead: '', dataGaps: [], positions: [], proposals: [],
  };
  const analyst = fresh();
  await analyst.analyze(DASH);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1);

  await analyst.analyze(DASH);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1, '🔴 같은 분석을 또 보냈다 — 새로고침 세 번이면 세 번 온다');
});

/**
 * 🔴 **이 테스트는 원래 버그를 지키고 있었다** (2026-09-21 정정)
 *
 * 종전 판정은 *"`marketView` 문장이 바뀌면 보낸다"* 였다. 그런데 그 문장은 **모델이 매번
 * 다르게 쓴다** — 같은 판단인데도 지문이 달라져 **화면을 열 때마다 알림이 갔다.**
 * 실제로 내 스크린샷 시도 10분에 **사용자 폰으로 6건**이 나갔다.
 *
 * ★ 내가 지키려던 불변식은 *"**판단**이 바뀌었는가"* 인데 자는 *"**글자**가 바뀌었는가"* 를 쟀다.
 *   ⇒ 판정을 뒤집는다: **서술만 바뀐 것은 새 소식이 아니다.**
 */
test('🔴 시황 **문장만** 바뀐 것은 보내지 않는다 (같은 판단을 다르게 설명한 것뿐)', async () => {
  const pos = [{ symbol: 'QLD', stance: 'HOLD', confidence: 'MEDIUM', rationale: 'x', evidence: [], risk: 'y' }];
  reportToReturn = { marketView: '첫 문장', momentumRead: '', dataGaps: [], positions: pos, proposals: [] };
  const analyst = fresh();
  await analyst.analyze(DASH);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1);

  reportToReturn = { marketView: '같은 판단을 다른 문장으로 설명합니다', momentumRead: '', dataGaps: [], positions: pos, proposals: [] };
  await analyst.analyze(DASH);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1, '🔴 문장만 바뀌었는데 보냈다 — 새로고침마다 알림이 간다');
});

/**
 * ⚠️ 종목 판단(stance)만 바뀌어도 **새 판단**이다 — 시황 문장이 같다고 넘기면 안 된다.
 *    지문에 `positions` 를 넣은 이유가 이것이다.
 */
test('시황 문장이 같아도 종목 판단이 바뀌면 보낸다', async () => {
  const base = { marketView: '같은 시황', momentumRead: '', dataGaps: [], proposals: [] };
  reportToReturn = { ...base, positions: [{ symbol: 'QLD', stance: 'HOLD', confidence: 'LOW', rationale: 'x', evidence: [], risk: 'y' }] };
  const analyst = fresh();
  await analyst.analyze(DASH);
  await new Promise((r) => setTimeout(r, 30));

  reportToReturn = { ...base, positions: [{ symbol: 'QLD', stance: 'SELL', confidence: 'HIGH', rationale: 'x', evidence: [], risk: 'y' }] };
  await analyst.analyze(DASH);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(sent.length, 2, 'HOLD → SELL 인데 안 보냈다 — 이건 새 판단이다');
});

/** 🔴 발송이 실패해도 **분석 결과는 돌아온다** — 곁가지가 본체를 죽이지 않는다 */
test('텔레그램이 죽어도 분석은 성공한다', async () => {
  global.fetch = async () => { throw new Error('텔레그램 죽음'); };
  reportToReturn = { marketView: '분석은 됐다', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  const analyst = fresh();
  const r = await analyst.analyze(DASH);
  await new Promise((r2) => setTimeout(r2, 30));
  assert.equal(r.marketView, '분석은 됐다');
});

/**
 * 🔴 **진동을 묶는다** — 모델이 `HOLD → SELL → HOLD` 로 오가면 종전 규칙으로는 **매번 새 판단**이다.
 * ⚠️ 다만 **처음 보는 판단은 즉시 보낸다** — 사용자 지시가 *"판단하면 바로 쏴"* 다.
 *    일괄 최소 간격을 걸면 `HOLD → SELL` 이라는 진짜 신호가 늦는다.
 */
const P = (stance) => [{ symbol: 'QLD', stance, confidence: 'MEDIUM', rationale: 'x', evidence: [], risk: 'y' }];

test('🔴 처음 보는 판단은 **즉시** 보낸다 (HOLD → SELL)', async () => {
  reportToReturn = { marketView: 'v', momentumRead: '', dataGaps: [], positions: P('HOLD'), proposals: [] };
  const analyst = fresh();
  await analyst.analyze(DASH);
  await new Promise((r) => setTimeout(r, 30));

  reportToReturn = { marketView: 'v', momentumRead: '', dataGaps: [], positions: P('SELL'), proposals: [] };
  await analyst.analyze(DASH);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 2, '🔴 HOLD → SELL 은 새 판단이다 — 늦추면 안 된다');
});

test('🔴 최근에 보낸 판단으로 **되돌아오면** 보내지 않는다 (HOLD → SELL → HOLD)', async () => {
  const analyst = fresh();
  for (const st of ['HOLD', 'SELL', 'HOLD']) {
    reportToReturn = { marketView: 'v', momentumRead: '', dataGaps: [], positions: P(st), proposals: [] };
    await analyst.analyze(DASH);
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(sent.length, 2, `🔴 진동이 그대로 알림이 됐다(${sent.length}건) — HOLD 로 돌아온 건 새 소식이 아니다`);
});

/** 🔴 판별력 — 창을 0 으로 두면 되돌아온 것도 보내야 한다(안 그러면 위 테스트가 다른 이유로 통과한 것) */
test('🔴 자기검증: 창을 0 으로 두면 되돌아온 판단도 보낸다', async () => {
  process.env.ANALYST_SEND_WINDOW_MS = '0';
  const analyst = fresh();
  for (const st of ['HOLD', 'SELL', 'HOLD']) {
    reportToReturn = { marketView: 'v', momentumRead: '', dataGaps: [], positions: P(st), proposals: [] };
    await analyst.analyze(DASH);
    await new Promise((r) => setTimeout(r, 30));
  }
  delete process.env.ANALYST_SEND_WINDOW_MS;
  assert.equal(sent.length, 3, '창이 0인데도 막혔다 — 위 테스트가 창 때문에 통과한 게 아니다');
});
