const crypto = require('crypto');

/**
 * 세션 (2026-09-21 신설)
 *
 * ## 왜
 *
 * 종전에는 `APP_ACCESS_TOKEN` 을 **`index.html` 에 스크립트로 주입**했다.
 * 그건 "인증" 이 아니라 **공유 비밀 배포**다 — 페이지를 받을 수 있는 누구나 토큰을 갖는다.
 * 실제로 2026-09-21 에 무인증 `/health` 가 catch-all 로 떨어지면서 **그 토큰이 외부로 샜다.**
 *
 * 앞으로 이 서버는 자산·주문 제안을 다룬다. 그래서:
 *  - 토큰은 **한 번만** 제출하고(로그인), 이후에는 **httpOnly 쿠키**로 다닌다
 *    ⇒ XSS 가 나도 **스크립트가 토큰을 읽을 수 없다**(localStorage 는 읽힌다)
 *  - 토큰 헤더 경로는 **남긴다** — HARU 등 서버-대-서버 소비자가 쓴다
 *
 * ⚠️ 세션은 **메모리에만** 둔다. 재기동하면 다시 로그인해야 한다.
 *    파일에 쓰면 백업(.25 → .23 → 맥)으로 **세션이 세 곳에 퍼진다** — 그게 더 나쁘다.
 */

const SESSION_TTL_MS = Math.max(
  5 * 60_000,
  Number(process.env.SESSION_TTL_MS) || 12 * 60 * 60 * 1000
);
const COOKIE_NAME = 'simplestock_session';
const MAX_SESSIONS = 50;

/** id → expiresAt */
const sessions = new Map();

function sweep(now = Date.now()) {
  for (const [id, exp] of sessions) if (exp <= now) sessions.delete(id);
}

function createSession() {
  sweep();
  // ⚠️ 상한이 없으면 로그인 반복이 메모리를 먹는다. 오래된 것부터 버린다.
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1] - b[1])[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  return id;
}

function isValidSession(id) {
  if (!id) return false;
  const exp = sessions.get(id);
  if (!exp) return false;
  if (exp <= Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

function destroySession(id) {
  if (id) sessions.delete(id);
}

/**
 * `Cookie` 헤더에서 값 하나를 뽑는다.
 * ⚠️ 의존성을 늘리지 않으려고 직접 판다(`cookie-parser` 미설치).
 *    값에 `=` 가 들어갈 수 있으므로 **첫 `=` 에서만** 자른다.
 */
function readCookie(req, name = COOKIE_NAME) {
  const raw = String(req.headers?.cookie || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const s = part.trim();
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    if (s.slice(0, eq) === name) return decodeURIComponent(s.slice(eq + 1));
  }
  return '';
}

/**
 * ⚠️ `Secure` 를 무조건 붙이면 **평문 LAN(http://192.168.x.x)에서 쿠키가 안 실린다.**
 *    이 서비스는 LAN 전용 평문으로 쓰이므로 TLS 일 때만 붙인다.
 */
function buildSetCookie(id, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(id)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** 타이밍 차이로 토큰을 알아내지 못하게 길이를 맞춰 비교한다 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  MAX_SESSIONS,
  createSession,
  isValidSession,
  destroySession,
  readCookie,
  buildSetCookie,
  buildClearCookie,
  safeEqual,
  _sessionsForTest: sessions,
};
