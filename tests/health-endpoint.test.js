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
 *   ③ SPA 는 **여전히 앱을 서빙한다**  ④ /api 는 여전히 인증을 요구한다
 *
 * ⚠️ 2026-09-21 오후 — ②③ 의 판정 방법이 바뀌었다
 *   같은 날 인증을 세션 쿠키로 바꾸면서 **SPA 도 토큰을 주입하지 않게** 됐다. 그래서:
 *   - ③ 은 "주입한다" → **"주입하지 않는다 + 그래도 앱은 나온다"** 로 뒤집었다
 *   - 🔴 ② 의 탐지기를 바꿔야 했다. 종전에는 `__SIMPLESTOCK_ACCESS_TOKEN__` 문자열로
 *     "catch-all 로 떨어졌다" 를 판정했는데, **이제 SPA 에도 그 문자열이 없어서
 *     구분력이 0 이 된다** — /health 가 catch-all 로 떨어져도 조용히 통과했을 것이다.
 *     ⇒ **HTML 인가**로 판정한다. *가드를 고칠 때는 그 가드가 무엇으로 가르는지 다시 본다.*
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

/**
 * ⚠️ **60초인 이유** (2026-09-22): 단독 기동은 1.7초지만, 전체 스위트(557개)가 코어를 다 쓰는
 *    중에 서버 spawn 테스트 3개가 겹치면 15초를 넘겨 **flaky** 가 됐다(같은 테스트가 단독으론 통과).
 *    "서버가 안 떴다=실패" 원칙은 유지하되, **부하 때문에 늦는 것**을 실패로 읽지 않게 여유를 둔다.
 */
async function waitUntilUp(deadlineMs = 60000) {
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
      // 🔴 실데이터 격리 — 안 주면 repo 의 data/ 를 읽고 **쓸 수도** 있다
      //    (테스트가 실제 watchlist.json 을 오염시킨 사고의 같은 계열)
      SIMPLESTOCK_DATA_DIR: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ss-spawn-')),
      APP_ACCESS_TOKEN: TOKEN,
      // ⚠️ 2026-09-21: LAN 면제(기본 켜짐)를 끈다. 127.0.0.1 에서 오는 이 테스트는
      //    안 끄면 ④축(무인증 401)이 **면제 때문에 통과**해 아무것도 안 재게 된다.
      SIMPLESTOCK_TRUST_LAN: 'false',
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
  /**
   * ⚠️ **`'ok'` 를 단언하지 않는다** (2026-09-22 정정). 이 테스트의 존재 이유는
   *    **토큰이 안 새는가**이지 의존물 상태가 아니다. 데이터 격리(빈 tmpdir)를 넣자
   *    시세 성공 기록이 없어 헬스가 **정직하게** `degraded`(upstream unknown)를 냈고,
   *    `'ok'` 단언이 깨졌다 — 종전엔 repo 실데이터를 읽어 **우연히** ok 였던 것이다.
   *    목적과 무관한 과잉 단언은 다른 기능의 정직한 동작을 실패로 읽는다.
   */
  assert.ok(['ok', 'degraded'].includes(parsed.status), `모르는 상태: ${parsed.status}`);
  assert.equal(parsed.service, 'simplestock');

  // ② 토큰이 없다 — 이것이 이 테스트의 존재 이유다
  assert.ok(
    !health.body.includes(TOKEN),
    '🔴 /health 응답에 접근 토큰이 들어 있다. 이 경로는 외부에 무인증으로 공개된다',
  );
  assert.ok(
    !/<html/i.test(health.body),
    '🔴 /health 가 SPA catch-all 로 떨어졌다(HTML 이 나왔다) — /health 가 static 보다 뒤에 있는가?',
  );

  // ③ 과잉 수정 방지 — 토큰은 안 나가되 **앱은 여전히 나와야** 한다
  const spa = await get('/any-client-route');
  assert.equal(spa.status, 200);
  assert.ok(
    /<div id="app"|<script/i.test(spa.body),
    'SPA 가 안 나온다 — 토큰을 빼면서 앱을 고장 냈다',
  );
  assert.ok(
    !spa.body.includes(TOKEN) && !spa.body.includes('__SIMPLESTOCK_ACCESS_TOKEN__'),
    '🔴 SPA 가 아직 토큰을 주입한다 — HTML 에 비밀을 심지 않기로 했다(2026-09-21)',
  );

  // ⑤ 로그인 한 번으로 쿠키를 받고, 그 쿠키로 API 가 열린다
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(login.status, 200, '올바른 토큰인데 로그인이 안 된다');
  const cookie = String(login.headers.get('set-cookie') || '');
  assert.match(cookie, /HttpOnly/i, '세션 쿠키가 HttpOnly 가 아니다 — XSS 가 읽어 간다');
  assert.match(cookie, /SameSite=Strict/i, '세션 쿠키에 SameSite=Strict 가 없다');

  const withCookie = await fetch(`${BASE}/api/watchlist`, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(withCookie.status, 200, '쿠키 세션으로 API 가 안 열린다');

  // ⑥ 틀린 토큰은 안 된다 (자의 판별력 — ⑤가 "아무거나 통과" 인지 가른다)
  const bad = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'WRONG' }),
  });
  assert.equal(bad.status, 401, '틀린 토큰으로 로그인이 됐다');

  // ④ API 인증은 그대로다
  const api = await get('/api/watchlist');
  assert.equal(api.status, 401, 'API 가 인증 없이 열렸다');
});
