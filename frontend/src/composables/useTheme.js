import { ref, watch } from 'vue';

/**
 * 테마
 *
 * 🔴 **2026-10-12 — 기본이 다시 다크다.** 사용자가 *"와이어프레임처럼 다크로"* 를 골랐다.
 *    10-12 설계도(`docs/wireframe-2026-10-12.html`)와 제품 디자인 토큰이 같은 말을 한다 —
 *    *"오래 켜 두고 보는 화면이므로 바탕은 차분한 딥 슬레이트, 전압은 강조 하나에만."*
 *    (10-02 에 와이어프레임을 라이트로 그려 기본을 light 로 바꿨던 것을 되돌린다.)
 *
 * ⚠️ **저장 키를 올렸다**(`.v2`). 안 올리면 이미 light 를 저장한 브라우저가 **그대로 라이트**로
 *    떠서, 사용자는 *"바꿨다는데 안 바뀌었다"* 를 본다. 사람의 선택은 여전히 이긴다 —
 *    **이번 전환 한 번만** 기본값을 다시 적용하는 것이다.
 *
 * ⚠️ **사람이 고른 것이 시스템 설정을 이긴다.** 저장된 값이 있으면 그걸 쓰고,
 *    없을 때만 와이어프레임 기본(light)을 쓴다 — 매번 시스템을 따르면
 *    "분명 바꿨는데 되돌아간다" 가 된다.
 * ⚠️ `document.documentElement` 에 **속성으로** 건다 — 토큰이 `:root[data-theme='light']`
 *    로 덮이므로 컴포넌트 CSS 는 **한 줄도 안 바뀐다**(두 테마가 갈라지지 않는다).
 */
const KEY = 'simplestock.theme.v2';
const VALID = new Set(['light', 'dark']);

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (VALID.has(saved)) return saved;
  } catch { /* 사생활 모드 등 — 저장을 못 해도 화면은 산다 */ }
  // 🔴 기본 = **dark**(2026-10-12 사용자 선택 · 제품 토큰의 원래 정체성)
  return 'dark';
}

const theme = ref(initial());

function apply(v) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', v);
}
apply(theme.value);

watch(theme, (v) => {
  apply(v);
  try { localStorage.setItem(KEY, v); } catch { /* 저장 실패는 화면을 막지 않는다 */ }
});

export function useTheme() {
  return {
    theme,
    toggle() { theme.value = theme.value === 'light' ? 'dark' : 'light'; },
  };
}
