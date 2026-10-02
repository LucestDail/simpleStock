import { ref, watch } from 'vue';

/**
 * 테마 (2026-10-02 — 와이어프레임 수용)
 *
 * 와이어프레임은 **밝은 바탕에 흰 카드**이고 상단 우측에 **테마 토글(☀)** 이 있다.
 * 종전 화면은 **다크 고정**이었다 — 사용자: *"와이어프레임 디자인이 하나도 반영 안된거
 * 같은데?"* 맞는 지적이었고, 그 중 가장 큰 것이 이것이다.
 *
 * ⚠️ **사람이 고른 것이 시스템 설정을 이긴다.** 저장된 값이 있으면 그걸 쓰고,
 *    없을 때만 와이어프레임 기본(light)을 쓴다 — 매번 시스템을 따르면
 *    "분명 바꿨는데 되돌아간다" 가 된다.
 * ⚠️ `document.documentElement` 에 **속성으로** 건다 — 토큰이 `:root[data-theme='light']`
 *    로 덮이므로 컴포넌트 CSS 는 **한 줄도 안 바뀐다**(두 테마가 갈라지지 않는다).
 */
const KEY = 'simplestock.theme';
const VALID = new Set(['light', 'dark']);

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (VALID.has(saved)) return saved;
  } catch { /* 사생활 모드 등 — 저장을 못 해도 화면은 산다 */ }
  // 🔴 와이어프레임 기본은 **light** 다(종전 다크 고정에서 바뀐 지점)
  return 'light';
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
