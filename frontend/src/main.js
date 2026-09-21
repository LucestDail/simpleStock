import { createApp, h, ref } from 'vue';
import App from './App.vue';
import './styles/tokens.css';
import {
  bootstrapAccessTokenFromUrl,
  getAccessToken,
  loginWithToken,
  fetchAuthStatus,
} from './lib/apiClient';

/**
 * 진입 게이트 (2026-09-21)
 *
 * 🔴 종전에는 서버가 `index.html` 에 토큰을 스크립트로 주입했다 — 페이지를 받을 수 있는
 *    누구나 토큰을 가졌고, 실제로 무인증 /health 를 통해 외부로 샜다.
 *    이제 토큰은 **한 번만** 제출해 httpOnly 쿠키로 바꾸고, 브라우저에는 남기지 않는다.
 *
 * ⚠️ App.vue 는 건드리지 않는다 — 인증되면 **지금까지와 똑같이** App 을 마운트한다.
 *    (화면 회귀 위험을 이 파일 안으로 가둔다)
 */

function LoginGate(onDone) {
  const token = ref('');
  const error = ref('');
  const busy = ref(false);

  async function submit() {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    const r = await loginWithToken(token.value);
    busy.value = false;
    if (r.ok) onDone();
    else error.value = r.message;
  }

  return {
    render() {
      return h('div', { style: 'min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ee;font-family:system-ui,sans-serif' }, [
        h('form', {
          onSubmit: (e) => { e.preventDefault(); submit(); },
          style: 'width:min(360px,90vw);display:flex;flex-direction:column;gap:12px',
        }, [
          h('h1', { style: 'font-size:18px;margin:0 0 4px' }, 'simpleStock'),
          h('p', { style: 'margin:0;font-size:13px;opacity:.7;line-height:1.5' },
            '접근 토큰을 한 번 입력하면 이후에는 쿠키로 유지됩니다.'),
          h('input', {
            type: 'password',
            value: token.value,
            autofocus: true,
            placeholder: '접근 토큰',
            onInput: (e) => { token.value = e.target.value; },
            style: 'padding:10px 12px;border-radius:8px;border:1px solid #2a2f3a;background:#151822;color:inherit',
          }),
          error.value
            ? h('div', { style: 'font-size:12px;color:#ff8a8a' }, error.value)
            : null,
          h('button', {
            type: 'submit',
            disabled: busy.value,
            style: 'padding:10px 12px;border-radius:8px;border:0;background:#3b82f6;color:#fff;cursor:pointer',
          }, busy.value ? '확인 중…' : '들어가기'),
        ]),
      ]);
    },
  };
}

async function boot() {
  bootstrapAccessTokenFromUrl();

  // URL·sessionStorage 에 토큰이 있으면 **조용히 쿠키로 교환**하고 토큰은 지운다.
  const pending = getAccessToken();
  if (pending) await loginWithToken(pending);

  const authed = await fetchAuthStatus();
  if (authed) {
    createApp(App).mount('#app');
    return;
  }
  // ⚠️ 인증 실패를 조용히 넘기지 않는다 — 안 그러면 화면이 빈 채로 API 401 만 쌓인다.
  const app = createApp(LoginGate(() => {
    app.unmount();
    createApp(App).mount('#app');
  }));
  app.mount('#app');
}

boot();
