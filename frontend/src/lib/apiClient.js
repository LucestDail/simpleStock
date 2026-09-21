const STORAGE_KEY = 'simplestock.accessToken';

// 통합 nginx 게이트웨이 뒤에서 prefix(/simpleStock) 로 서빙되는 경우를 위해
// vite build --base 로 박힌 import.meta.env.BASE_URL 을 모든 API/스트림 URL 앞에 prepend 한다.
// 단독 실행 시 BASE_URL 이 "/" 이므로 사실상 no-op.
const RAW_BASE = String(import.meta.env.BASE_URL || '/');
const NORMALIZED_BASE = RAW_BASE.endsWith('/') ? RAW_BASE.slice(0, -1) : RAW_BASE;

export function apiUrl(path) {
  if (!path) return NORMALIZED_BASE || '/';
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = String(path).startsWith('/') ? path : `/${path}`;
  return `${NORMALIZED_BASE}${normalized}`;
}

export function getAccessToken() {
  try {
    // 🔴 2026-09-21: window.__SIMPLESTOCK_ACCESS_TOKEN__ 주입을 없앴다(서버가 더 안 심는다).
    //    이제 토큰은 **로그인 1회 교환용**이고, 그 뒤에는 httpOnly 쿠키가 인증을 맡는다.
    return (
      sessionStorage.getItem(STORAGE_KEY) ||
      import.meta.env.VITE_ACCESS_TOKEN ||
      ''
    );
  } catch {
    return import.meta.env.VITE_ACCESS_TOKEN || '';
  }
}

export function setAccessToken(token) {
  const value = String(token || '').trim();
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, value);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function bootstrapAccessTokenFromUrl() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('access_token') || params.get('token');
  if (!fromUrl) return;
  setAccessToken(fromUrl);
  params.delete('access_token');
  params.delete('token');
  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', next);
}

function withAuthHeaders(options = {}) {
  const headers = new Headers(options.headers || {});
  // ⚠️ 쿠키 세션이 주 경로다. same-origin 이라도 명시해 둔다(프록시/서브패스에서 빠지는 일이 있다).
  options = { credentials: 'same-origin', ...options };
  const token = getAccessToken();
  // 앱 토큰은 X-Access-Token 으로 전송(Authorization 은 게이트웨이 HTTP Basic 인증용으로 비움).
  // 외부(게이트웨이 Basic) 접근 시 브라우저가 Authorization: Basic 을 자동 첨부하므로,
  // 앱 토큰을 Authorization 에 실으면 nginx Basic 과 충돌한다. 서버는 x-access-token 도 인식한다.
  if (token) headers.set('X-Access-Token', token);
  return { ...options, headers };
}

export function hasAccessToken() {
  return Boolean(getAccessToken());
}

export async function readApiError(res, fallback = '요청에 실패했습니다.') {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    return '연결 인증에 실패했습니다. 페이지를 새로고침해 주세요.';
  }
  return data.error || fallback;
}

export async function apiFetch(url, options = {}) {
  const finalUrl = apiUrl(url);
  const res = await fetch(finalUrl, withAuthHeaders(options));
  if (res.status === 401) {
    const message = await readApiError(res);
    const error = new Error(message);
    error.status = 401;
    error.isAuthError = true;
    throw error;
  }
  return res;
}

export function apiStreamUrl(path = '/api/stream') {
  const url = new URL(apiUrl(path), window.location.origin);
  const token = getAccessToken();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/**
 * 토큰을 **한 번** 제출해 httpOnly 쿠키로 바꾼다.
 * 성공하면 sessionStorage 의 토큰을 지운다 — 토큰이 브라우저에 남아 있을 이유가 없다.
 */
export async function loginWithToken(token) {
  const res = await fetch(apiUrl('/auth/login'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: String(token || '').trim() }),
  });
  if (res.ok) {
    setAccessToken('');
    return { ok: true };
  }
  let message = '로그인에 실패했습니다.';
  try {
    message = (await res.json())?.error || message;
  } catch {
    // ignore
  }
  return { ok: false, status: res.status, message };
}

export async function fetchAuthStatus() {
  try {
    const res = await fetch(apiUrl('/auth/status'), { credentials: 'same-origin' });
    if (!res.ok) return false;
    return Boolean((await res.json())?.authenticated);
  } catch {
    return false;
  }
}
