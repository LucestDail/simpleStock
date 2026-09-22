const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * 🔴 `APP_ACCESS_TOKEN` 이 **없을 때** 서버가 열리지 않는가 (2026-09-21 신설)
 *
 * ## 무엇이 있었나
 *
 * ```js
 * function requireAccessToken(req, res, next) {
 *   if (!APP_ACCESS_TOKEN) return next();   // ← 설정 실수 = 전면 개방
 * ```
 * 토큰을 안 넣으면 **모든 API 가 무인증으로 열렸다.** 그리고 **아무 로그도 안 남는다** —
 * 운영자는 자기가 잠겨 있다고 믿는다. 이 서비스는 앞으로 자산·주문 제안을 다룬다.
 *
 * ## 왜 서버를 실제로 띄우나
 *
 * `requireAccessToken` 을 직접 호출하는 단위 테스트로는 **"기동 시 토큰이 어떻게 정해지는가"**
 * 를 못 본다. 그건 모듈 로드 시점에 결정된다 ⇒ **프로세스를 띄워야만** 보이는 축이다.
 * (workspace 규율: "코드가 있다 ≠ 그 경로가 실제로 그렇게 돈다")
 */

/**
 * ⚠️ **포트를 실행마다 달리한다** (2026-09-22 둘째 수정). 대기를 60초로 늘렸는데도
 *    간헐 실패가 남았다 — 고정 포트라 **직전 실행이 남긴 소켓(TIME_WAIT)** 과 충돌하면
 *    기동 자체가 실패한다. PID 기반이면 같은 순간의 병렬 파일끼리도 안 겹친다.
 */
const PORT = 53000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;

function spawnServer(env) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // ⚠️ 2026-09-21: LAN 면제가 기본 켜짐이라 127.0.0.1 에서 오는 이 테스트들은
    //    **전부 통과해 버린다**. 토큰 게이트 자체를 재려면 면제를 꺼야 한다.
    //    (끄는 걸 잊으면 "인증이 동작한다" 는 초록불이 사실은 LAN 면제였다)
    env: {
      ...process.env,
      PORT: String(PORT),
      // 🔴 실데이터 격리 — 안 주면 repo 의 data/ 를 읽고 **쓸 수도** 있다
      //    (테스트가 실제 watchlist.json 을 오염시킨 사고의 같은 계열)
      SIMPLESTOCK_DATA_DIR: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ss-spawn-')),
      NODE_ENV: 'test',
      SIMPLESTOCK_TRUST_LAN: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* 아직 안 떴다 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test('🔴 APP_ACCESS_TOKEN 미설정 — 열리지 않고, 무작위 토큰으로 잠그고, 그 사실을 말한다', async (t) => {
  // ⚠️ APP_ACCESS_TOKEN 을 **지운 채** 띄운다. `...process.env` 로 새어 들어오면
  //    이 테스트는 아무것도 검사하지 못한다.
  const child = spawnServer({ APP_ACCESS_TOKEN: '' });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  child.stdout.on('data', () => {});
  t.after(() => child.kill('SIGKILL'));

  const up = await waitUntilUp();
  assert.ok(up, `서버가 ${PORT} 에서 안 떴다 — 이 테스트는 아무것도 검사하지 못했다`);

  // ① 핵심: 인증 없이 API 가 열려 있으면 안 된다
  const api = await fetch(`${BASE}/api/watchlist`);
  assert.equal(
    api.status,
    401,
    '🔴 APP_ACCESS_TOKEN 이 없을 때 API 가 무인증으로 열렸다(fail-open). '
      + '설정 실수 한 번이 곧 전면 개방이다.'
  );

  // ② 조용히 잠그지 않는다 — 운영자가 값을 알 수 있어야 쓴다
  //    (안 그러면 잠긴 줄도 모르고 "앱이 고장났다" 로 읽는다)
  assert.match(
    stderr,
    /APP_ACCESS_TOKEN 미설정/,
    '토큰을 무작위로 만들었는데 기동 로그에 아무 말도 없다'
  );
  const m = stderr.match(/이번 기동 토큰:\s*([0-9a-f]{32,})/);
  assert.ok(m, '기동 로그에 이번 기동 토큰이 안 찍혔다 — 운영자가 들어갈 방법이 없다');

  // ③ 자의 판별력 — 그 토큰이 **실제로 통한다**(로그만 찍고 다른 값으로 잠근 게 아닌지)
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: m[1] }),
  });
  assert.equal(login.status, 200, '로그에 찍힌 토큰으로 로그인이 안 된다 — 로그가 거짓말이다');
});

test('세션 쿠키가 없거나 위조되면 API 가 안 열린다', async (t) => {
  const TOKEN = 'FAIL_CLOSED_TEST_TOKEN_0921';
  const child = spawnServer({ APP_ACCESS_TOKEN: TOKEN });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  t.after(() => child.kill('SIGKILL'));

  assert.ok(await waitUntilUp(), '서버가 안 떴다 — 검사하지 못했다');

  const none = await fetch(`${BASE}/api/watchlist`);
  assert.equal(none.status, 401, '쿠키·토큰 없이 API 가 열렸다');

  const forged = await fetch(`${BASE}/api/watchlist`, {
    headers: { Cookie: `simplestock_session=${'a'.repeat(64)}` },
  });
  assert.equal(forged.status, 401, '🔴 아무 세션 id 나 통과한다 — 세션 검증이 없다');

  // 헤더 토큰 경로는 남아 있어야 한다 (HARU 등 서버-대-서버 소비자가 쓴다)
  const header = await fetch(`${BASE}/api/watchlist`, { headers: { 'X-Access-Token': TOKEN } });
  assert.equal(header.status, 200, '헤더 토큰 경로가 죽었다 — HARU 주식 도구가 조용히 실패한다');
});

test('🔴 재기동해도 로그인이 유지된다 (배포마다 다시 묻지 않는다)', async (t) => {
  /*
   * 2026-09-21 사용자 지적: "집인데 왜 접근 토큰을 달라고 하는거지?"
   * 원인은 인증이 아니라 **세션을 메모리에 둔 것**이었다 — 그날만 배포가 네 번이라
   * 재기동마다 전부 로그아웃됐다. 서명 쿠키(무상태)로 바꿔 고쳤고, 이 테스트가 그것을 잠근다.
   *
   * ⚠️ 단위 테스트로는 **원리상** 못 잡는다. 프로세스를 실제로 죽였다 살려야 보이는 축이다.
   */
  const TOKEN = 'RESTART_TEST_TOKEN_0921';

  const first = spawnServer({ APP_ACCESS_TOKEN: TOKEN });
  first.stdout.on('data', () => {}); first.stderr.on('data', () => {});
  assert.ok(await waitUntilUp(), '1차 기동 실패 — 검사하지 못했다');

  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(login.status, 200);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];

  // 그 쿠키가 지금은 통한다 (기준선 — 안 찍으면 "원래 안 됐나" 를 못 가른다)
  const before = await fetch(`${BASE}/api/watchlist`, { headers: { Cookie: cookie } });
  assert.equal(before.status, 200, '로그인 직후인데 쿠키가 안 먹는다');

  // ── 재기동 ──
  first.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  const second = spawnServer({ APP_ACCESS_TOKEN: TOKEN });
  second.stdout.on('data', () => {}); second.stderr.on('data', () => {});
  t.after(() => second.kill('SIGKILL'));
  assert.ok(await waitUntilUp(), '2차 기동 실패');

  const after = await fetch(`${BASE}/api/watchlist`, { headers: { Cookie: cookie } });
  assert.equal(
    after.status,
    200,
    '🔴 재기동 후 같은 쿠키가 거부됐다 — 배포할 때마다 사용자가 토큰을 다시 넣어야 한다'
  );
});

test('★ 자의 판별력 — 토큰을 바꾸면 옛 쿠키는 무효가 된다 (전체 무효화 수단)', async (t) => {
  const A = 'ROTATE_TEST_TOKEN_AAAA';
  const B = 'ROTATE_TEST_TOKEN_BBBB';

  const first = spawnServer({ APP_ACCESS_TOKEN: A });
  first.stdout.on('data', () => {}); first.stderr.on('data', () => {});
  assert.ok(await waitUntilUp(), '1차 기동 실패');
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: A }),
  });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  first.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));

  const second = spawnServer({ APP_ACCESS_TOKEN: B }); // 토큰 교체
  second.stdout.on('data', () => {}); second.stderr.on('data', () => {});
  t.after(() => second.kill('SIGKILL'));
  assert.ok(await waitUntilUp(), '2차 기동 실패');

  const after = await fetch(`${BASE}/api/watchlist`, { headers: { Cookie: cookie } });
  assert.equal(after.status, 401, '🔴 토큰을 바꿨는데 옛 쿠키가 통한다 — 무효화 수단이 없다');
});

test('🔴 LAN 에서는 토큰을 묻지 않는다 (2026-09-21 사용자 결정)', async (t) => {
  /*
   * > "집에 있을때는 당연히 접근 토큰 안물어봐도 되지 lanonly 로 내부에서만 접근이 가능한데"
   * nginx 가 외부를 403 으로 막았으므로 앱까지 두 번 묻는 건 마찰이다.
   * ⚠️ 이 테스트는 **면제를 켠 채**(기본값) 돌린다 — 위의 다른 테스트들과 반대다.
   */
  const child = spawnServer({ APP_ACCESS_TOKEN: 'LAN_TEST_TOKEN', SIMPLESTOCK_TRUST_LAN: 'true' });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  t.after(() => child.kill('SIGKILL'));
  assert.ok(await waitUntilUp(), '서버가 안 떴다 — 검사하지 못했다');

  const api = await fetch(`${BASE}/api/watchlist`); // 127.0.0.1 에서 = LAN
  assert.equal(api.status, 200, 'LAN 인데 토큰을 요구한다');

  const status = await (await fetch(`${BASE}/auth/status`)).json();
  assert.equal(status.authenticated, true);
  assert.equal(status.via, 'lan', '화면이 로그인창을 안 띄우려면 이유를 알아야 한다');
});
