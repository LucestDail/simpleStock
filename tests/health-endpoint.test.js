const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * 🔴 `/health` 가 접근 토큰을 흘리지 않는가 (2026-09-21 실결함 회귀 가드)
 *
 * 무엇이 있었나
 *   게이트웨이(nginx)가 `location = /simpleStock/health` 를 **무인증으로** 노출하는데
 *   서버에 `/health` 라우트가 없어서 요청이 SPA catch-all 로 떨어졌다. 그 catch-all 은
 *   `index.html` 에 **접근 토큰을 주입**한다(`window.__SIMPLESTOCK_ACCESS_TOKEN__`).
 *   ⇒ 인터넷에서 `GET /simpleStock/health` 로 **토큰을 그대로 받을 수 있었다**(실측).
 *   같은 이유로 **헬스가 헬스가 아니었다** — 아무 경로나 200+HTML 이라 정적 파일만
 *   서빙되면 통과했고, 그 뒤가 다 죽어도 허브는 "정상" 으로 보였다.
 *
 * 왜 서버를 실제로 띄우나
 *   이건 **라우트 순서** 결함이다. `/health` 핸들러가 존재해도 static/catch-all **뒤에**
 *   놓이면 다시 샌다. 순수 단위 테스트는 핸들러를 직접 부르므로 **원리상 순서를 못 본다**
 *   (workspace 규율: "순수 클래스만 테스트하면 로직은 맞는데 안 불린다를 못 잡는다").
 *
 * 네 축을 함께 본다 — 셋만 보면 과잉 수정을 놓친다
 *   ① /health 가 JSON 이다            ② /health 에 토큰이 없다
 *   ③ SPA 는 여전히 토큰을 주입한다     ④ /api 는 여전히 인증을 요구한다
 *   ③이 핵심이다: catch-all 을 망가뜨려 토큰 주입을 없애도 ①②④는 통과한다.
 *   그건 결함을 고친 게 아니라 **앱을 고장 낸 것**이다.
 */

const TOKEN = 'TEST_TOKEN_DO_NOT_LEAK_0921';
const PORT = 50097;
const BASE = `http://127.0.0.1:${PORT}`;

function get(pathname) {
  return fetch(`${BASE}${pathname}`).then(async (res) => ({
    status: res.status,
    body: await res.text(),
  }));
}

async function waitUntilUp(deadlineMs = 15000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      await get('/health');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

test('/health 는 토큰을 흘리지 않는다 (라우트 순서 회귀 가드)', async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_ACCESS_TOKEN: TOKEN,
      // 테스트가 외부 호출·스케줄을 깨우지 않게 한다.
      MANAGER_BRIEF_PRESET_SCHEDULE: 'false',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  const up = await waitUntilUp();
  // 🔴 못 띄웠으면 통과가 아니라 실패다 — "검사 못 함" 을 초록불로 만들지 않는다.
  assert.ok(up, `서버가 ${PORT} 포트에서 안 떴다 — 이 테스트는 아무것도 검사하지 못했다`);

  const health = await get('/health');

  // ① JSON 이다 (HTML 이면 catch-all 로 떨어진 것)
  assert.equal(health.status, 200);
  const parsed = JSON.parse(health.body);
  assert.equal(parsed.status, 'ok');

  // ② 토큰이 없다 — 이것이 이 테스트의 존재 이유다
  assert.ok(
    !health.body.includes(TOKEN),
    '🔴 /health 응답에 접근 토큰이 들어 있다. 이 경로는 외부에 무인증으로 공개된다',
  );
  assert.ok(
    !health.body.includes('__SIMPLESTOCK_ACCESS_TOKEN__'),
    '🔴 /health 가 SPA catch-all 로 떨어졌다 — /health 라우트가 static 보다 뒤에 있는가?',
  );

  // ③ 과잉 수정 방지 — SPA 는 여전히 토큰을 주입해야 한다
  const spa = await get('/any-client-route');
  assert.equal(spa.status, 200);
  assert.ok(
    spa.body.includes('__SIMPLESTOCK_ACCESS_TOKEN__'),
    'SPA 경로에서 토큰 주입이 사라졌다 — 결함을 고친 게 아니라 앱을 고장 냈다',
  );

  // ④ API 인증은 그대로다
  const api = await get('/api/watchlist');
  assert.equal(api.status, 401, 'API 가 인증 없이 열렸다');
});
