const STORAGE_KEY = 'simplestock.accessToken';

export function getAccessToken() {
  try {
    const injected =
      typeof window !== 'undefined' && window.__SIMPLESTOCK_ACCESS_TOKEN__
        ? String(window.__SIMPLESTOCK_ACCESS_TOKEN__)
        : '';
    return (
      injected ||
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
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
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
  const res = await fetch(url, withAuthHeaders(options));
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
  const url = new URL(path, window.location.origin);
  const token = getAccessToken();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}
