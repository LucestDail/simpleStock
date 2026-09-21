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
 * ## 🔴 2026-09-21 오후 정정 — 상태를 **없앴다**
 *
 * 처음에는 세션 id 를 **메모리 Map** 에 뒀다. 그래서 **재기동할 때마다 전부 로그아웃**됐고,
 * 그날만 배포가 네 번이라 사용자가 계속 토큰을 입력해야 했다("집인데 왜 또 묻지?").
 * 파일에 쓰는 것도 답이 아니다 — 백업(.25 → .23 → 맥)으로 **세션이 세 곳에 퍼진다**.
 *
 * ⇒ **서명 쿠키**로 바꿨다. 서버가 아무것도 기억하지 않는다:
 *   `v1.<만료epoch>.<HMAC-SHA256(APP_ACCESS_TOKEN, "v1.<만료epoch>")>`
 *   - 재기동해도 살아 있다(기억할 게 없으니까)
 *   - 위조 불가(토큰을 모르면 서명을 못 만든다) · 만료는 값 안에 들어 있다
 *   - **전체 무효화 = APP_ACCESS_TOKEN 교체**. 비밀이 새면 어차피 교체해야 하므로
 *     revoke 수단이 자연스럽게 하나로 모인다
 *   ⚠️ 개별 세션 강제 종료는 못 한다(상태가 없으니까). 단일 사용자 도구라 받아들인 대가다.
 */

/**
 * ⚠️ 2026-09-21 오후: 처음에 12시간으로 잡았더니 **하루에도 다시 묻는다**(사용자 지적).
 *    이건 보호가 아니라 마찰이다 — 성가신 인증은 결국 **인증 자체를 끄게 만든다**
 *    (워크스페이스 규율: "성가신 승인은 사용자가 게이트를 아예 끄게 만든다").
 *    개인용 단일 사용자 도구이므로 **30일**로 둔다. 보호는 그대로고 묻는 횟수만 준다.
 *    🔴 더 짧게 하려면 SESSION_TTL_MS 로 덮어라. 로그아웃은 언제든 세션을 즉시 끊는다.
 */
const SESSION_TTL_MS = Math.max(
  5 * 60_000,
  Number(process.env.SESSION_TTL_MS) || 30 * 24 * 60 * 60 * 1000
);
const COOKIE_NAME = 'simplestock_session';


/**
 * ## LAN 신뢰 (2026-09-21 사용자 결정)
 *
 * > "집에 있을때는 당연히 접근 토큰 안물어봐도 되지 lanonly 로 내부에서만 접근이 가능한데"
 *
 * nginx 가 `/simpleStock/` 을 **lanonly(외부 403)** 로 막았으므로, 앱까지 두 번 묻는 것은
 * 보호가 아니라 마찰이다. ⇒ **사설 대역에서 온 요청은 앱 로그인을 면제**한다.
 *
 * 🔴 위조를 막는 방법이 이 함수의 전부다:
 *  - **소켓 상대가 루프백이 아니면** 그게 진짜 상대다 → 헤더를 **아예 안 본다**
 *    (LAN 에서 앱 포트로 직접 오는 경우. 헤더는 누구나 지어낼 수 있다)
 *  - 루프백이면 nginx 를 거친 것이다 → nginx 가 **자기가 덮어쓰는** `X-Real-IP` 를 본다
 *    (`proxy_set_header X-Real-IP $remote_addr` — 클라이언트가 보낸 값은 버려진다)
 *  - 🔴 **알 수 없으면 면제하지 않는다.** 모르는 것을 LAN 으로 치면 그게 곧 구멍이다
 */
const TRUST_LAN = String(process.env.SIMPLESTOCK_TRUST_LAN ?? 'true').trim().toLowerCase() !== 'false';

function normalizeIp(ip) {
  const v = String(ip || '').trim();
  if (!v) return '';
  // ::ffff:192.168.0.1 형태를 벗긴다
  return v.startsWith('::ffff:') ? v.slice(7) : v;
}

function isLoopback(ip) {
  const v = normalizeIp(ip);
  return v === '127.0.0.1' || v === '::1' || v.startsWith('127.');
}

function isPrivateIp(ip) {
  const v = normalizeIp(ip);
  if (!v) return false;
  if (isLoopback(v)) return true;
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  const m = /^172\.(\d{1,3})\./.exec(v);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(v)) return true; // IPv6 ULA
  if (/^fe80:/i.test(v)) return true; // link-local
  return false;
}

/** @returns {string} 못 알아내면 빈 문자열 — 호출부는 그때 **면제하지 않는다** */
function clientIp(req) {
  const peer = normalizeIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
  if (!peer) return '';
  if (!isLoopback(peer)) return peer; // 직접 연결 — 헤더를 보지 않는다
  // nginx 경유: nginx 가 덮어쓰는 X-Real-IP 만 믿는다
  const real = normalizeIp(req?.headers?.['x-real-ip']);
  if (real) return real;
  // XFF 는 **마지막 항목**이 nginx 가 붙인 값이다(앞쪽은 클라이언트가 지어낼 수 있다)
  const xff = String(req?.headers?.['x-forwarded-for'] || '');
  if (xff) {
    const last = normalizeIp(xff.split(',').pop());
    if (last) return last;
  }
  return peer; // 프록시 없이 로컬에서 직접 온 것
}

function isTrustedLanRequest(req) {
  if (!TRUST_LAN) return false;
  const ip = clientIp(req);
  if (!ip) return false; // 🔴 모르면 면제하지 않는다
  return isPrivateIp(ip);
}

function secretKey() {
  // APP_ACCESS_TOKEN 을 그대로 쓰지 않고 파생한다 — 쿠키에서 원본을 역산할 여지를 줄인다
  return crypto.createHash('sha256').update(`simplestock/session/v1/${process.env.APP_ACCESS_TOKEN || ''}`).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', secretKey()).update(payload).digest('base64url');
}

function createSession(now = Date.now()) {
  const payload = `v1.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

function isValidSession(value, now = Date.now()) {
  if (!value) return false;
  const parts = String(value).split('.');
  if (parts.length !== 3) return false;
  const [v, expRaw, sig] = parts;
  if (v !== 'v1') return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = sign(`${v}.${expRaw}`);
  // 길이가 다르면 timingSafeEqual 이 던진다 — 먼저 거른다
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/**
 * ⚠️ 상태가 없으므로 서버가 특정 세션만 끊을 수는 없다.
 *    로그아웃은 **쿠키를 지우는 것**이고, 전체 무효화는 APP_ACCESS_TOKEN 교체다.
 */
function destroySession() {
  /* no-op — 상태 없음. 호출부가 쿠키를 지운다 */
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
  TRUST_LAN,
  clientIp,
  isPrivateIp,
  isTrustedLanRequest,
  SESSION_TTL_MS,
  createSession,
  isValidSession,
  destroySession,
  readCookie,
  buildSetCookie,
  buildClearCookie,
  safeEqual,
};
