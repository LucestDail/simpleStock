const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

/**
 * 🔴 **텔레그램 → 애널리스트 릴레이** (2026-09-22 사용자: "릴레이도 안 되는 거 같은데")
 *
 * 안 되던 이유가 코드 한 곳에 있었다 — `allowed_updates: ['callback_query']`.
 * **텍스트 메시지를 아예 안 받고 있었다.** 기능이 죽은 게 아니라 존재하지 않았다.
 */
process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-relay-${process.pid}.jsonl`);

const sent = [];
let chatCalls = [];

function fresh({ chatImpl } = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/telegramBot|analystChat|marketDataService|orderService/.test(k)) delete require.cache[k];
  }
  const acPath = require.resolve('../server/analystChat');
  require.cache[acPath] = { id: acPath, filename: acPath, loaded: true, exports: {
    chat: async ({ message, emit }) => {
      chatCalls.push(message);
      if (chatImpl) return chatImpl({ message, emit });
      emit('tool_call', { name: 'get_portfolio' });
      emit('text_delta', { text: 'RAM은 ' });
      emit('text_delta', { text: '-25.7%입니다.' });
      return { rounds: 1, toolCalls: 1 };
    },
  } };
  const mdPath = require.resolve('../server/marketDataService');
  require.cache[mdPath] = { id: mdPath, filename: mdPath, loaded: true, exports: {
    getMarketSnapshot: () => ({ fx: { USDKRW: { rate: 1360 } } }),
  } };
  return require('../server/telegramBot');
}

beforeEach(() => {
  sent.length = 0; chatCalls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    sent.push({ url: String(url), body });
    if (String(url).includes('getUpdates')) {
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
});

const texts = () => sent.filter((x) => x.url.includes('sendMessage')).map((x) => x.body.text);

test('🔴 폴링이 message 를 **받도록** 선언한다 (안 되던 원인 그 줄)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'telegramBot.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.match(src, /allowed_updates: \['callback_query', 'message'\]/,
    "🔴 message 가 allowed_updates 에 없다 — 릴레이가 존재할 수 없다");
});

test('🔴 내 채팅의 질문이 애널리스트로 릴레이되고 답이 돌아온다', async () => {
  const bot = fresh();
  await bot.handleUserMessage({ chat: { id: '999' }, text: 'RAM 지금 어때?' });
  assert.deepEqual(chatCalls, ['RAM 지금 어때?'], '🔴 chat 에 안 넘어갔다');
  const all = texts().join('\n');
  assert.match(all, /RAM은 -25\.7%입니다\./, `🔴 답이 안 돌아왔다: ${all}`);
  assert.match(all, /확인한 것: get_portfolio/, '어떤 도구를 썼는지 안 보인다');
});

test('🔴 남의 채팅은 릴레이하지 않는다', async () => {
  const bot = fresh();
  await bot.handleUserMessage({ chat: { id: '111' }, text: '포트폴리오 알려줘' });
  assert.equal(chatCalls.length, 0, '🔴 남의 질문이 내 계좌 데이터에 닿는다');
  assert.equal(texts().length, 0);
});

test('⚠️ 처리 중 새 질문은 "처리 중" 안내를 받는다 (낡은 답 연발 방지)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const bot = fresh({ chatImpl: async ({ emit }) => { await gate; emit('text_delta', { text: '늦은 답' }); return {}; } });
  const p1 = bot.handleUserMessage({ chat: { id: '999' }, text: '첫 질문' });
  await new Promise((r) => setTimeout(r, 30));
  await bot.handleUserMessage({ chat: { id: '999' }, text: '둘째 질문' });
  assert.match(texts().join('\n'), /앞 질문을 아직 처리 중/, '🔴 바쁜데 조용히 삼켰다');
  release(); await p1;
  assert.deepEqual(chatCalls, ['첫 질문'], '🔴 둘째 질문이 큐에 들어갔다 — 낡은 답이 연달아 온다');
});

test('🔴 chat 이 죽으면 오류를 **말한다** (읽씹이 최악이다)', async () => {
  const bot = fresh({ chatImpl: async () => { throw new Error('AI 가 설정되지 않았습니다.'); } });
  await bot.handleUserMessage({ chat: { id: '999' }, text: '안녕' });
  assert.match(texts().join('\n'), /🔴 답변 중 오류: AI 가 설정되지 않았습니다/);
});

test('⚠️ 긴 답은 잘리지 않고 나뉘어 온다', async () => {
  const bot = fresh({ chatImpl: async ({ emit }) => { emit('text_delta', { text: 'A'.repeat(8000) }); return {}; } });
  await bot.handleUserMessage({ chat: { id: '999' }, text: '길게 설명해줘' });
  const msgs = texts();
  assert.ok(msgs.length >= 3, `🔴 8000자가 ${msgs.length}건으로 왔다 — 잘리면 근거 숫자가 사라진다`);
  assert.equal(msgs.join('').replace(/[^A]/g, '').length, 8000, '🔴 내용이 유실됐다');
});

test('명령어(/)와 빈 텍스트는 릴레이하지 않는다', async () => {
  const bot = fresh();
  await bot.handleUserMessage({ chat: { id: '999' }, text: '/start' });
  await bot.handleUserMessage({ chat: { id: '999' }, text: '' });
  assert.equal(chatCalls.length, 0);
});
