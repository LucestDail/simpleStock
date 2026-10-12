const activity = require('./activityLog');
const { logInfo, logWarn, logError } = require('./logger');
const telegram = require('./telegramService');

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
 * ③ (2026-10-12 제거) 승인·실행 버튼 — 주문 집행이 사라졌다. 남은 것은 알림·릴레이뿐이다.
 *    ⚠️ 옛 메시지의 버튼은 폰에 남아 있어 `handleCallback` 이 안내만 한다.
 * ③-구 승인 ≠ 실행          버튼은 `approve` 까지다. 실행은 여전히 `ORDERS_LIVE` 이고
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

/**
 * 🔴 **첫머리 메타 서술을 걷어낸다** (2026-10-02 실물).
 *    `"(사용자의 질문 \"금리상승기에는 주식 뭘 사야하지?\"에 대한 답을 준비 중입니다.)"` 로
 *    시작하는 답이 그대로 폰에 갔다. 모델이 **자기 사고 과정**을 답에 쓴 것이고,
 *    `isStubAnswer`(미완)에도 `fake`(도구 호출 흉내)에도 안 걸린다 — 새 축이다.
 *
 * ⚠️ **첫 줄의 괄호 블록만** 본다. 본문 중간의 괄호는 정상적인 보충 설명이다
 *    (예: "QLD(2배 레버리지)는…"). 넓게 잡으면 멀쩡한 답을 훼손한다.
 * ⚠️ 괄호를 떼고 **남는 게 없으면 원문을 돌려준다** — 답을 통째로 지우는 것보다
 *    메타 서술이 보이는 쪽이 낫다.
 */
function stripLeadingMeta(text) {
  const t = String(text || '').trimStart();
  const m = /^\((?:[^)]|\)(?!\s*$))*\)\s*/.exec(t);
  if (!m) return text;
  const head = m[0];
  // 메타로 읽히는 표현이 있을 때만 — 괄호로 시작한다고 전부 메타는 아니다
  if (!/준비 중|답변드리겠|답을 드리|생각해|정리하겠|분석 중|확인 중|사용자의 질문/.test(head)) return text;
  const rest = t.slice(head.length).trimStart();
  return rest.length >= 20 ? rest : text;
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



/**
 * 🔴 **주문 버튼은 2026-10-12 에 사라졌다 — 그런데 폰에는 옛 메시지가 남아 있다.**
 *
 * 조용히 무시하면 사용자는 **눌렀는데 아무 일도 안 일어나는** 화면을 본다(로딩만 돈다).
 * 그래서 콜백 자체는 계속 받고, **무엇이 바뀌었는지 말해 준다.**
 */
async function handleCallback(cb) {
  const fromChat = String(cb?.message?.chat?.id || '');
  if (fromChat !== CHAT_ID) {
    logWarn('tgbot.rejected_foreign_chat', { fromChat: fromChat.slice(0, 6) + '…' });
    await answer(cb.id, '권한이 없습니다.');
    return { ok: false, reason: 'foreign_chat' };
  }
  logInfo('tgbot.retired_button', { data: String(cb?.data || '').slice(0, 24) });
  await answer(cb.id, '주문 기능은 제거됐습니다. 이 버튼은 더 이상 동작하지 않습니다.');
  return { ok: false, reason: 'orders_removed' };
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








/**
 * 🔴 **텍스트 메시지 → 애널리스트 채팅 릴레이** (2026-09-22 사용자: *"해당 텔레그램을 통해서
 *    애널리스트랑 대화가 되어야 하는데 지금 릴레이도 안 되는 거 같은데"*)
 *
 * 안 되던 이유: `allowed_updates: ['callback_query']` — **텍스트 메시지를 아예 안 받고 있었다.**
 *
 * ## 안전 경계
 * - CHAT_ID 만 받는다(버튼과 같은 규율 — 남의 채팅은 기록하고 거절)
 * - 채팅이 부를 수 있는 도구는 **조회·분석뿐**이다(2026-10-12~ 제안 도구 제거) —
 *   대화로는 돈이 못 나간다
 * - 🔴 **한 번에 하나만** — chat 은 LLM+도구로 수십 초를 쓴다. 처리 중 새 질문이 오면
 *   "앞 질문 처리 중" 을 답한다(쌓으면 몇 분 뒤 낡은 답이 연달아 온다)
 */
let chatBusy = false;

/**
 * 🔴 **응답이 멈추면 봇이 통째로 죽는다** (2026-10-01).
 *
 * `chatBusy` 는 `finally` 에서 풀리지만, 최종 스트림에 **타임아웃이 없어서**
 * 상대가 응답을 끝내지 않으면 `await` 가 영영 안 돌아온다 ⇒ `finally` 도 안 돌고
 * `chatBusy` 가 **영구 true** 가 된다. 그 뒤로는 무엇을 물어도 *"앞 질문을 아직
 * 처리 중입니다"* 만 돌아온다 — **재기동 전까지 봇이 벽돌이 된다.**
 * ⚠️ 실패(throw)는 이미 잘 처리하고 있었다. 위험한 것은 **실패가 아니라 무응답**이다.
 * ⚠️ 상한은 넉넉하게 — 실측 정상 턴이 55초였다(도구 4개). 짧게 잡으면 멀쩡한 답을 끊는다.
 */
const CHAT_TIMEOUT_MS = Math.max(60_000, Number(process.env.TELEGRAM_CHAT_TIMEOUT_MS) || 5 * 60_000);

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 🔴 **텔레그램은 마크다운을 안 켜고 보낸다** — `parse_mode` 가 없다(MarkdownV2 는 이스케이프가
 *    까다로워 일부러 평문으로 보낸다, `telegramService.js:51`). 그런데 시스템 프롬프트와
 *    사용자 템플릿은 `**굵게**`·`## 제목` 을 **쓰라고 지시한다** ⇒ 사용자 화면에는
 *    별표와 우물정자가 **그대로 글자로** 보인다.
 * ⇒ 보내기 직전에 **표식만 걷어낸다.** 내용은 한 글자도 안 지운다.
 * ⚠️ 마크다운을 켜는 쪽은 고르지 않았다 — 모델이 쓰는 `_`·`[`·`(` 가 섞이면 텔레그램이
 *    **400 으로 거절**해서 답이 통째로 안 간다. 미관보다 도착이 중요하다.
 */
function toPlainText(s) {
  return String(s || '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')        // ## 제목 → 제목
    .replace(/\*\*(.+?)\*\*/gs, '$1')          // **굵게** → 굵게
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?]|$)/g, '$1$2')  // *기울임* → 기울임
    .replace(/^\s{0,3}[-*]\s+/gm, '· ');       // - 항목 → · 항목
}


async function handleUserMessage(msg) {
  const fromChat = String(msg?.chat?.id || '');
  const text = String(msg?.text || '').trim();
  if (fromChat !== CHAT_ID) {
    logWarn('tgbot.rejected_foreign_chat', { fromChat: fromChat.slice(0, 6) + '…', kind: 'message' });
    return;
  }
  /**
   * 🔴 **조용히 버리지 않는다** (2026-10-01). 종전 주석은 *"조용히 무시하지 않고 아래에서
   *    안내"* 라고 적혀 있었는데 **그 "아래" 가 없었다** — 그냥 `return` 이었다.
   *    주석이 약속한 동작이 코드에 없는 자리(이 워크스페이스가 반복해 밟은 모양).
   *
   *    사용자가 겪는 것: 사진·음성·스티커를 보내거나 `/start` 를 눌러도 **아무 반응이
   *    없다.** "봇이 죽었나" 와 "그건 못 받는다" 가 구분되지 않는다.
   * ⚠️ 로그도 안 남아 **얼마나 자주 일어나는지조차** 알 수 없었다.
   */
  if (!text) {
    logInfo('tgbot.non_text_ignored', { kinds: Object.keys(msg || {}).filter((k) => k !== 'chat' && k !== 'from' && k !== 'date' && k !== 'message_id').slice(0, 5) });
    await api('sendMessage', { chat_id: CHAT_ID, text: '글로 물어봐 주세요 — 사진·음성·파일은 아직 못 읽습니다.' }).catch(() => {});
    return;
  }
  if (text.startsWith('/')) {
    logInfo('tgbot.command_ignored', { cmd: text.split(/\s+/)[0].slice(0, 32) });
    await api('sendMessage', { chat_id: CHAT_ID, text: '명령어는 없습니다 — 그냥 평소 말투로 물어보시면 됩니다.' }).catch(() => {});
    return;
  }
  if (chatBusy) {
    await api('sendMessage', { chat_id: CHAT_ID, text: '⏳ 앞 질문을 아직 처리 중입니다 — 끝나면 이어서 물어봐 주세요.' });
    return;
  }
  chatBusy = true;
  try {
    await api('sendChatAction', { chat_id: CHAT_ID, action: 'typing' });
    const analystChat = require('./analystChat');
    const { getMarketSnapshot } = require('./marketDataService');
    const mkt = getMarketSnapshot();
    const rate = Number(mkt?.fx?.USDKRW?.rate) || 0;
    let answer = '';
    const toolsUsed = [];
    /**
     * 🔴 **자기고발 신호를 사용자에게 전달한다** (2026-10-01).
     *
     * 종전 `emit` 은 `text_delta`·`tool_call` **둘만** 처리하고 나머지를 버렸다. 그래서
     * `analystChat` 이 공들여 만든 경고가 **텔레그램에서 전부 0** 이 됐다:
     *   · 도구 바퀴 상한(6)에 걸려 멈춤          → 폰에는 매끈한 답만
     *   · 도구 판단기가 죽어 도구 없이 답함        → 폰에는 매끈한 답만
     *   · 도구 호출이 실패함                     → 폰에는 매끈한 답만
     * ★ 서버 로그에는 있는데 **결정을 내리는 사람에게는 없었다.** 매매 판단을 받는
     *   화면에서 "이 답은 데이터 없이 썼다" 를 숨기는 것이 이 결함의 값이다.
     * ⚠️ 본문에 섞지 않고 **꼬리에 모아** 붙인다 — 답 중간에 끼면 읽는 흐름이 끊긴다.
     */
    const notices = [];
    const keepTyping = setInterval(() => {
      api('sendChatAction', { chat_id: CHAT_ID, action: 'typing' }).catch(() => {});
    }, 5000);
    try {
      await withTimeout(analystChat.chat({
        message: text,
        userInstruction: require('./settingsService').getDashboardSettings().briefingPrompt,
        contextNote: '텔레그램에서 온 질문이다. 답은 채팅 메시지로 전달되므로 간결하게 쓰되, 근거 숫자는 유지하라. '
          + '🔴 도구 실행 여부를 묻지 마라 — 텔레그램은 왕복이 느려 "실행해 드릴까요?" 는 사용자를 두 번 기다리게 한다. 바로 실행하고 종합 소견으로 답하라.',
        fx: rate ? { rate } : null,
        emit: (event, data) => {
          if (event === 'text_delta') answer += data?.text || '';
          /**
           * 🔴 **재시도가 시작되면 지금까지 쌓은 것을 버린다** (2026-10-01 실사고).
           *
           * `analystChat` 은 재시도 때 자기 `answer` 를 비우는데 **여기는 안 비웠다** ⇒
           * pass1 + pass2 가 **둘 다** 발송됐다. 사용자가 받은 것:
           * ```
           * (도구 호출)
           * [도구 결과] get_portfolio({"summary":{...계좌 전체 JSON...}})   ← pass1
           * 내 포트폴리오 — 3종목 …                                        ← pass2
           * ```
           * 하필 pass1 이 **도구 결과 원문**(잔고·보유 전량)이라 그냥 미관 문제가 아니었다.
           * ⚠️ 스트리밍이면 못 되돌리지만 **텔레그램은 다 모았다가 한 번에 보낸다** —
           *    보내기 전이라 **여기서는 되돌릴 수 있다.**
           */
          else if (event === 'answer_restart') {
            logWarn('tgbot.answer_discarded', { chars: answer.length, reason: data?.reason || null });
            answer = '';
          }
          else if (event === 'tool_call') toolsUsed.push(data?.name);
          else if (event === 'notice') notices.push(String(data?.text || '').slice(0, 200));
          else if (event === 'tool_result' && data?.ok === false) {
            notices.push(`${data?.name || '도구'} 실패: ${String(data?.error || '').slice(0, 120)}`);
          }
        },
      }), CHAT_TIMEOUT_MS, '모델 응답이 제한 시간을 넘겼습니다');
    } finally {
      clearInterval(keepTyping);
    }
    if (!answer.trim()) answer = '(모델이 빈 답을 냈습니다 — 다시 물어봐 주세요)';
    /**
     * 🔴 **성공한 도구 목록은 보내지 않는다** (2026-10-02 사용자 지적:
     *    *"계속 지금 도구 목록 보여주고 난리났는데"*).
     *
     * 매 답변 끝에 `🔧 확인한 것: get_portfolio · get_candles · …` 가 붙고 있었다.
     * `get_portfolio` 는 **내부 식별자**라 사용자에게 아무 뜻이 없고, 정상 회차마다
     * 붙으니 **답을 읽는 데 방해만** 된다(실측: 280자 답에 59자가 이 꼬리였다).
     *
     * ⚠️ **없애는 게 아니라 조건을 바꾼다.** 어제 *"텔레그램이 자기고발을 삼킨다"* 를
     *    고친 취지(실패를 숨기지 않는다)는 그대로다 — **실패가 하나라도 있을 때만** 보여준다.
     *    그때는 "무엇을 보고 답했나" 가 판단에 필요하다. 전부 성공이면 그건 소음이다.
     * ★ *"경고를 새로 만들면 빈도를 재라"*(09-30)의 같은 가족 — 매번 뜨는 것은 안 읽힌다.
     */
    if (toolsUsed.length && notices.length) {
      answer += `\n\n🔧 확인한 것: ${[...new Set(toolsUsed)].join(' · ')}`;
    }
    // 🔴 경고는 **답 뒤에** 붙인다 — 답을 가리지 않으면서 숨기지도 않는다
    if (notices.length) answer += `\n\n⚠️ ${[...new Set(notices)].join('\n⚠️ ')}`;
    answer = stripLeadingMeta(answer);
    answer = toPlainText(answer);
    // 텔레그램 한 메시지 상한 4096 — 자르지 말고 나눠 보낸다(잘리면 근거 숫자가 사라진다)
    for (let i = 0; i < answer.length; i += 3800) {
      await api('sendMessage', { chat_id: CHAT_ID, text: answer.slice(i, i + 3800) });
    }
    logInfo('tgbot.chat_relayed', { chars: answer.length, tools: toolsUsed.length });
  } catch (e) {
    logError('tgbot.chat_failed', e, {});
    // 🔴 실패를 삼키지 않는다 — 사용자는 "읽씹" 을 가장 나쁘게 겪는다
    await api('sendMessage', { chat_id: CHAT_ID, text: `🔴 답변 중 오류: ${e.message}` }).catch(() => {});
  } finally {
    chatBusy = false;
  }
}

async function pollOnce() {
  const updates = await api('getUpdates', { offset, timeout: POLL_SEC, allowed_updates: ['callback_query', 'message'] });
  for (const u of updates || []) {
    offset = Math.max(offset, Number(u.update_id) + 1);
    if (u.callback_query) {
      try {
        await handleCallback(u.callback_query);
      } catch (e) {
        logError('tgbot.handle_failed', e, {});
      }
    } else if (u.message) {
      /**
       * ⚠️ 릴레이는 **기다리지 않는다** — chat 이 수십 초라 await 하면 그동안
       *    getUpdates 가 멈춰 **가격 알림까지 같이 늦는다**.
       */
      handleUserMessage(u.message).catch((e) => logError('tgbot.msg_failed', e, {}));
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

module.exports = { stripLeadingMeta,
  handleUserMessage, // 릴레이 검증용
  start, stop, status, isConfigured, handleCallback, pollOnce, _resetForTest };
