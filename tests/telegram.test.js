const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * 텔레그램 발송 (2026-09-21)
 *
 * 🔴 **기본이 dry-run 이다.** 피어가 오늘 변이 테스트 2건을 **사용자 폰으로 실제로 보냈다** —
 *    "시험할 때 조심하자" 는 규칙으로는 안 지켜진다. 스위치를 코드에 박았고 이 테스트가 잠근다.
 * ⚠️ 회사 맥에서는 `api.telegram.org` 가 403(Zscaler)이다. 그래서 여기서는 **fetch 를 가로챈다** —
 *    실제 네트워크를 때리면 테스트가 환경에 따라 갈린다.
 */

/*
 * 🔴 **자격증명을 넣고 시작한다.** 첫 판에서 이걸 안 넣어서 "기본은 dry-run" 테스트가
 *    **엉뚱한 이유로 통과**했다 — 자격증명이 없어서 dry-run 이었던 것이지
 *    **스위치를 검사한 게 아니다.** 변이(기본을 켜짐으로)를 넣어도 안 잡혔다.
 *    ⚠️ 라이브에는 자격증명이 **있다**(피어가 넣었다). 그 상태에서 스위치만 막고 있는지가 요점이다.
 *    (fetch 는 가로채므로 실제 네트워크로는 안 나간다)
 */
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN';
process.env.TELEGRAM_CHAT_ID = '12345';

const telegram = require('../server/telegramService');
const realFetch = global.fetch;
let calls = [];

beforeEach(() => {
  calls = [];
  telegram._resetForTest();
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
});
afterEach(() => { global.fetch = realFetch; });

test('🔴 자격증명이 **있어도** 스위치가 꺼져 있으면 네트워크를 안 때린다', async () => {
  assert.equal(telegram.isConfigured(), true, '자격증명이 없으면 이 테스트는 아무것도 검사하지 못한다');
  const r = await telegram.send('테스트');
  assert.equal(r.ok, true);
  assert.equal(r.sent, false, '실제로 보냈다');
  assert.equal(r.dryRun, true);
  assert.equal(calls.length, 0, `dry-run 인데 ${calls.length}번 호출했다 — 사용자 폰으로 갔을 것이다`);
  assert.equal(telegram.status().reason, 'send_disabled', '막은 이유가 스위치가 아니다 — 자의 판별력이 없다');
});

test('dry-run 이어도 **왜 안 보냈는지** 알려준다 (조용한 성공이 아니다)', async () => {
  const r = await telegram.send('x');
  assert.ok(r.why, '이유가 없다 — "보냈나 안 보냈나" 를 못 가른다');
  const s = telegram.status();
  assert.equal(s.effective, 'dry-run');
  assert.ok(s.reason, '무엇이 막고 있는지 상태에 없다');
});

test('빈 메시지는 보내지 않는다', async () => {
  assert.equal((await telegram.send('   ')).ok, false);
});

test('🔴 같은 종목·같은 방향은 **하루 한 번만** (5분마다 같은 말을 하면 알림을 끈다)', async () => {
  const items = [{ symbol: 'QLD', name: 'QLD', dailyRate: 4.63, profitRate: 11.3, lastPrice: 91.7, currency: 'USD' }];
  const a = await telegram.notifyMomentum(items);
  const b = await telegram.notifyMomentum(items);
  assert.equal(a.sent, 1);
  assert.equal(b.sent, 0, '같은 알림을 두 번 보냈다');
  assert.equal(b.skipped, 1);
});

test('★ 자의 판별력 — 방향이 바뀌면 다시 알린다 (전부 막는 자가 아니다)', async () => {
  const up = [{ symbol: 'QLD', name: 'QLD', dailyRate: 4.6, profitRate: 1, lastPrice: 1, currency: 'USD' }];
  const down = [{ symbol: 'QLD', name: 'QLD', dailyRate: -4.6, profitRate: 1, lastPrice: 1, currency: 'USD' }];
  assert.equal((await telegram.notifyMomentum(up)).sent, 1);
  assert.equal((await telegram.notifyMomentum(down)).sent, 1, '반대 방향인데 막혔다');
});

test('등락률이 없는 종목은 알리지 않는다 (모르는 것을 0으로 치지 않는다)', async () => {
  const r = await telegram.notifyMomentum([{ symbol: 'X', name: 'X', dailyRate: null }]);
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 0);
});

test('날짜가 바뀌면 중복 기록을 비운다 (무한히 쌓이지 않는다)', async () => {
  await telegram.notifyMomentum([{ symbol: 'A', name: 'A', dailyRate: 5, profitRate: 1, lastPrice: 1 }]);
  assert.equal(telegram.status().dedupeEntries, 1);
  const removed = telegram.sweepDedupe(new Date(Date.now() + 3 * 86400000));
  assert.equal(removed, 1);
  assert.equal(telegram.status().dedupeEntries, 0);
});

test('자산 요약이 숫자를 **사람이 읽는 모양**으로 만든다', () => {
  const txt = telegram.formatPortfolio({
    summary: { value: { krw: 13905400, converted: true }, profit: { krw: 1425400 }, profitRate: 11.42,
      dailyProfit: { krw: -218300 }, dailyRate: -1.55 },
    items: [{ name: '삼성전자', dailyRate: -1.09, profitRate: 11.79 }],
  });
  assert.match(txt, /13,905,400/);
  assert.match(txt, /\+11\.42%/);
  assert.match(txt, /-1\.55%/);
  assert.match(txt, /삼성전자/);
  assert.match(txt, /환산/, '환산값인데 그 사실을 안 밝혔다');
});

test('보유를 못 받았으면 그렇게 말한다 (빈 요약을 보내지 않는다)', () => {
  assert.match(telegram.formatPortfolio(null), /불러오지 못했/);
});
