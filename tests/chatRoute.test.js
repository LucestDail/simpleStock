const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * 🔴 `/api/analyst/chat` 이 **SSE 로 나간다** (HTTP 층 회귀 가드) — 2026-09-21
 *
 * 사용자가 명시적으로 요구했다: *"스트리밍 형태로 출력되어야 함. **REST 형태로 안 나오게 주의**"*
 *
 * ## 왜 서비스 테스트로는 모자란가
 *
 * `analystChat.test.js` 는 **서비스가 조각을 흘리는지**를 본다. 그런데 라우트가 그 조각을
 * 모았다가 `res.json` 으로 내보내면 **서비스 테스트는 전부 초록인 채로 REST 가 된다.**
 * 워크스페이스 규율 그대로다 — *"순수 로직만 테스트하면 '로직은 맞는데 안 불린다' 를 못 잡는다."*
 * ⇒ 실제로 서버를 띄워 **응답 헤더와 본문 모양**을 본다.
 *
 * ## AI 를 설정하지 않고 돌린다
 *
 * 그래야 라우트가 **오류 경로**로 간다. 그리고 그 오류를 어떻게 내보내는지가 바로 요점이다:
 * REST 라면 `500 + {"error"}` 일 것이고, SSE 라면 **`200 + event: error`** 여야 한다
 * (헤더를 이미 보낸 뒤라 상태코드로는 못 알린다).
 * ★ 실패 경로를 고르면 **LLM 없이도** 전송 방식을 잴 수 있다.
 */

const TOKEN = 'CHAT_ROUTE_TEST_0921';
// ⚠️ 포트를 **다른 테스트 파일과 겹치지 않게** 잡는다 — `node --test` 는 파일을
//    병렬로 돌리므로 겹치면 남의 서버에 요청이 가고 **엉뚱한 401** 을 받는다
//    (실제로 50097 이 health-endpoint 와 겹쳐 그렇게 됐다).
const PORT = 50090;
const PORT_HISTORY = 50091;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitUntilUp(deadlineMs = 15000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* 아직 안 떴다 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test('채팅 응답은 SSE 다 (REST 로 돌아가지 않는다)', async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_ACCESS_TOKEN: TOKEN,
      SIMPLESTOCK_TRUST_LAN: 'false',
      MANAGER_BRIEF_PRESET_SCHEDULE: 'false',
      // 🔴 AI 를 **일부러** 안 붙인다 — 오류 경로로 보내 전송 방식을 잰다
      GEMINI_API_KEY: '',
      GEMINI_GATEWAY_BASE_URL: '',
      // 밖으로 나가는 것을 전부 막는다(테스트가 네트워크를 깨우면 안 된다)
      MARKET_DATA_ENABLED: 'false',
      MYCOMPUTER_MCP_ENABLED: 'false',
      TELEGRAM_SEND_ENABLED: 'false',
      ANALYST_DREAM_ENABLED: 'false',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  // 🔴 못 띄웠으면 통과가 아니라 실패다
  assert.ok(await waitUntilUp(), `서버가 ${PORT} 에서 안 떴다 — 아무것도 검사하지 못했다`);

  const res = await fetch(`${BASE}/api/analyst/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Access-Token': TOKEN },
    body: JSON.stringify({ message: '테스트' }),
  });

  // ① 전송 방식 자체가 스트리밍인가
  assert.equal(res.status, 200, 'SSE 는 실패해도 200 이다 — 헤더를 이미 보냈기 때문');
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  // ⚠️ nginx 가 버퍼링하면 **스트리밍이 REST 처럼 보인다** — 끄라고 말해 둬야 한다
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  assert.match(res.headers.get('cache-control') || '', /no-cache/);

  const body = await res.text();

  // ② 본문이 SSE 프레임인가 (JSON 한 덩어리가 아니라)
  assert.match(body, /^event: /m, `SSE 프레임이 아니다:\n${body.slice(0, 200)}`);
  assert.match(body, /^data: /m);
  assert.throws(() => JSON.parse(body), '본문이 통째로 JSON 이다 — REST 로 돌아갔다');

  // ③ 시작을 먼저 알리고, 오류도 **이벤트로** 온다
  assert.match(body, /event: start/);
  assert.match(body, /event: error/);
  // AI 미설정이 이유라는 것이 실려야 한다("왜 안 되는지" 가 화면에 닿아야 한다)
  assert.match(body, /AI/);
});

test('대화 이력 조회는 REST 가 맞다 (전부 스트리밍으로 만들지 않았다)', async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT_HISTORY),
      APP_ACCESS_TOKEN: TOKEN,
      SIMPLESTOCK_TRUST_LAN: 'false',
      MANAGER_BRIEF_PRESET_SCHEDULE: 'false',
      MARKET_DATA_ENABLED: 'false',
      ANALYST_DREAM_ENABLED: 'false',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  const until = Date.now() + 15000;
  let up = false;
  while (Date.now() < until && !up) {
    try { up = (await fetch(`http://127.0.0.1:${PORT_HISTORY}/health`)).ok; } catch { /* 대기 */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(up, '서버가 안 떴다');

  const res = await fetch(`http://127.0.0.1:${PORT_HISTORY}/api/analyst/chat/history`, {
    headers: { 'X-Access-Token': TOKEN },
  });
  assert.equal(res.status, 200);
  // ⚠️ 스트리밍이 좋다고 **전부** 스트리밍으로 만들면 화면 복원이 복잡해진다.
  //    흐를 이유가 없는 것은 REST 로 둔 판단을 여기에 못박는다.
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const b = await res.json();
  assert.ok(Array.isArray(b.items));
});
