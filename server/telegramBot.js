const activity = require('./activityLog');
const { logInfo, logWarn, logError } = require('./logger');
const telegram = require('./telegramService');
const orderService = require('./orderService');

/**
 * 텔레그램 인라인 버튼 수신 (2026-09-21)
 *
 * 사용자: *"매수매도 제안같은경우에는 승인취소 버튼 주고 사용자가 승인하면 진행하고."*
 *
 * ## 🔴 이 파일은 **주문 승인 권한이 텔레그램으로 나간다**는 뜻이다
 *
 * 화면(LAN 전용)과 달리 텔레그램은 **인터넷 너머**다. 그래서 겹겹이 막는다:
 *
 * ```
 * ① 기본 꺼짐            TELEGRAM_BOT_ENABLED 없으면 폴링 자체를 안 한다
 * ② 발신자 고정          콜백이 **설정된 CHAT_ID 에서 온 것**이 아니면 버린다
 *                        (봇 토큰을 아는 누군가가 다른 대화에서 눌러도 안 먹는다)
 * ③ 승인 ≠ 실행          버튼은 `approve` 까지다. 실행은 여전히 `ORDERS_LIVE` 이고
 *                        지금은 no-op 이다 — **버튼 하나로 돈이 나가지 않는다**
 * ④ 만료                 제안에 TTL 이 있어 옛 메시지의 버튼은 실패한다
 * ⑤ 감사                 승인·거절이 `orders-audit.jsonl` 에 남는다(출처 telegram)
 * ```
 * ⚠️ ②가 이 파일에서 가장 중요하다. 없으면 **봇 토큰 유출 = 주문 승인 유출**이다.
 *
 * ## 폴링을 쓰는 이유
 *
 * 웹훅은 공개 HTTPS 엔드포인트가 필요한데 이 앱은 **LAN 전용**이다(사용자 결정).
 * 밖으로 구멍을 내는 것보다 **우리가 나가서 받아 오는** 롱폴링이 맞다.
 */

const ENABLED = String(process.env.TELEGRAM_BOT_ENABLED || '').trim().toLowerCase() === 'true';
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
/** 롱폴링 대기(초). 텔레그램 권장 범위 안에서 길게 잡아 호출 수를 줄인다 */
const POLL_SEC = Math.min(50, Math.max(5, Number(process.env.TELEGRAM_POLL_SEC) || 30));

let offset = 0;
let running = false;
let stopped = false;
let consecutiveErrors = 0;

function isConfigured() {
  return Boolean(ENABLED && TOKEN && CHAT_ID);
}

function status() {
  return {
    enabled: ENABLED,
    configured: isConfigured(),
    running,
    // 어느 쪽이 막고 있는지 화면·로그가 알 수 있어야 한다
    reason: !ENABLED ? 'disabled' : !TOKEN || !CHAT_ID ? 'token_or_chat_missing' : null,
    offset,
    consecutiveErrors,
  };
}

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // 롱폴링은 오래 기다린다 — 타임아웃을 대기시간보다 넉넉히
    signal: AbortSignal.timeout((POLL_SEC + 15) * 1000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.description || `HTTP ${res.status}`);
  return json.result;
}

/** 제안 하나를 **승인/거절 버튼과 함께** 보낸다 */
async function sendProposal(p) {
  const text = [
    '🟡 매매 제안 (승인 필요)',
    '',
    `${p.side === 'BUY' ? '매수' : '매도'} ${p.symbol}`,
    `수량 ${p.quantity}주 · 지정가 ${Number(p.price).toLocaleString('ko-KR')}`,
    `평가금액 ${Number(p.quantity * p.price).toLocaleString('ko-KR')}`,
    p.reason ? `\n${p.reason}` : '',
    '',
    `⏳ ${new Date(p.expiresAt).toLocaleTimeString('ko-KR')} 까지`,
  ].filter(Boolean).join('\n');

  return telegram.send(text, {
    reason: 'proposal',
    replyMarkup: {
      inline_keyboard: [[
        { text: '✅ 승인', callback_data: `ok:${p.id}` },
        { text: '✖️ 취소', callback_data: `no:${p.id}` },
      ]],
    },
  });
}

/** 버튼을 누른 사람에게 즉시 응답한다(안 하면 텔레그램이 로딩 표시를 계속 돌린다) */
async function answer(cbId, text) {
  try {
    await api('answerCallbackQuery', { callback_query_id: cbId, text: text.slice(0, 190) });
  } catch (e) {
    logWarn('tgbot.answer_failed', { message: e.message });
  }
}

/** 버튼을 지운다 — 이미 처리된 제안에 버튼이 남아 있으면 두 번 누른다 */
async function stripButtons(chatId, messageId, suffix) {
  try {
    await api('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    if (suffix) await api('sendMessage', { chat_id: chatId, text: suffix });
  } catch (e) {
    logWarn('tgbot.strip_failed', { message: e.message });
  }
}

/**
 * 콜백 한 건 처리.
 * 🔴 **여기가 권한 경계다.** 발신 대화가 설정된 CHAT_ID 가 아니면 **아무것도 하지 않는다.**
 */
async function handleCallback(cb) {
  const fromChat = String(cb?.message?.chat?.id || '');
  if (fromChat !== CHAT_ID) {
    // ⚠️ 조용히 무시하지 않는다 — 누가 남의 봇에 버튼을 누르고 있다는 뜻이다
    logWarn('tgbot.rejected_foreign_chat', { fromChat: fromChat.slice(0, 6) + '…' });
    await answer(cb.id, '권한이 없습니다.');
    return { ok: false, reason: 'foreign_chat' };
  }

  const data = String(cb?.data || '');
  const m = /^(ok|no):(.+)$/.exec(data);
  if (!m) {
    await answer(cb.id, '알 수 없는 버튼입니다.');
    return { ok: false, reason: 'bad_data' };
  }
  const [, verb, id] = m;

  const r = verb === 'ok' ? orderService.approve(id) : orderService.reject(id, 'telegram');
  if (!r.ok) {
    await answer(cb.id, r.error);
    await stripButtons(cb.message.chat.id, cb.message.message_id, `⚠️ ${r.error}`);
    return { ok: false, reason: 'order_rejected', error: r.error };
  }

  const p = r.proposal;
  // 🔴 **승인은 실행이 아니다.** 그 사실을 사용자에게 그대로 말한다 —
  //    "승인했으니 샀겠지" 로 오해하면 그게 제일 위험하다.
  const note = verb === 'ok'
    ? `✅ 승인됨 — ${p.side === 'BUY' ? '매수' : '매도'} ${p.symbol} ${p.quantity}주\n`
      + `${orderService.status().effective === 'live' ? '주문을 보냅니다.' : '⚠️ 실거래는 꺼져 있어 실제 주문은 나가지 않습니다.'}`
    : `✖️ 취소됨 — ${p.symbol}`;

  await answer(cb.id, verb === 'ok' ? '승인했습니다' : '취소했습니다');
  await stripButtons(cb.message.chat.id, cb.message.message_id, note);
  logInfo('tgbot.callback', { verb, id, symbol: p.symbol });
  activity.record(verb === 'ok' ? 'approval' : 'rejection',
    `${verb === 'ok' ? '승인' : '취소'} — ${p.side === 'BUY' ? '매수' : '매도'} ${p.symbol} ${p.quantity}주 (텔레그램)`,
    { proposalId: p.id, symbol: p.symbol, via: 'telegram' });
  return { ok: true, verb, id };
}

async function pollOnce() {
  const updates = await api('getUpdates', { offset, timeout: POLL_SEC, allowed_updates: ['callback_query'] });
  for (const u of updates || []) {
    offset = Math.max(offset, Number(u.update_id) + 1);
    if (u.callback_query) {
      try {
        await handleCallback(u.callback_query);
      } catch (e) {
        logError('tgbot.handle_failed', e, {});
      }
    }
  }
  return (updates || []).length;
}

/** 폴링 루프. 🔴 실패해도 멈추지 않되 **물러서면서** 재시도한다 */
async function start() {
  if (!isConfigured()) {
    logInfo('tgbot.not_started', status());
    return false;
  }
  if (running) return true;
  running = true;
  stopped = false;
  logInfo('tgbot.started', { pollSec: POLL_SEC });

  (async () => {
    while (!stopped) {
      try {
        await pollOnce();
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors += 1;
        // ⚠️ 분모 없는 로그를 남기지 않는다 — 몇 번째 실패인지 함께 적는다
        logWarn('tgbot.poll_failed', { consecutiveErrors, message: e.message });
        // 지수 백오프(최대 5분) — 죽은 네트워크에 초당 한 번씩 던지지 않는다
        const wait = Math.min(300_000, 2000 * 2 ** Math.min(consecutiveErrors, 8));
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    running = false;
  })();
  return true;
}

function stop() {
  stopped = true;
}

function _resetForTest() {
  offset = 0;
  running = false;
  stopped = false;
  consecutiveErrors = 0;
}

module.exports = { start, stop, status, isConfigured, sendProposal, handleCallback, pollOnce, _resetForTest };
