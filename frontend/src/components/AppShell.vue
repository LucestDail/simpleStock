<!--
  📐 앱 셸 — 사이드 메뉴 (2026-10-12 개편 · `docs/wireframe-2026-10-12.html`)

  🔴 **승인 대기 배지가 사라졌다.** 주문 집행을 걷어내면서 "사용자가 결정해야 할 것" 이
     없어졌다 — 배지를 남겨 두면 영원히 0 을 가리키는 자리가 된다.

  ⚠️ 계좌 카드의 **'실거래/모의' 표시도 뺐다.** 주문을 못 내는데 그 말이 붙어 있으면
     거짓이 된다. 대신 **'읽기 전용'** 이라고 적는다 — 코드에서 주문 API 를 지우는 것과
     사용자가 그 사실을 아는 것은 다른 층이다.
-->
<template>
  <div class="shell">
    <aside class="side">
      <div class="side__brand">
        <span class="side__logo" aria-hidden="true"></span>
        <b>SimpleStock</b>
      </div>
      <nav class="side__nav">
        <RouterLink to="/" class="side__item" exact-active-class="side__item--on">포트폴리오</RouterLink>
        <RouterLink to="/analysis" class="side__item" active-class="side__item--on">분석 리포트</RouterLink>
        <RouterLink to="/lab" class="side__item" active-class="side__item--on">전략 연구소</RouterLink>
        <RouterLink to="/risk" class="side__item" active-class="side__item--on">리스크</RouterLink>
        <RouterLink to="/report" class="side__item" active-class="side__item--on">성과</RouterLink>
        <RouterLink to="/activity" class="side__item" active-class="side__item--on">활동 로그</RouterLink>
        <!-- 종목 상세는 종목을 클릭해 들어간다 — 메뉴 항목이 아니라 경로다 -->
        <!--
          🔴 **설정은 메뉴가 아니다** (2026-10-12 사용자: *"감시목록 이런거 다 설정창으로 빼.
             그냥 사이드 메뉴에서 나오게. 이런거 그냥 너가 설정값으로 가지는거지 내가 건들일
             이유가 없잖아."*) — 매일 보는 것과 한 번 정하는 것을 섞지 않는다.
        -->
        <span class="side__spacer"></span>
        <RouterLink to="/settings" class="side__item side__item--sub" active-class="side__item--on">⚙ 설정</RouterLink>
      </nav>
      <button class="side__theme" :title="theme === 'light' ? '어두운 테마로' : '밝은 테마로'" @click="toggleTheme">
        {{ theme === 'light' ? '☾ 다크 모드' : '☀ 라이트 모드' }}
      </button>
      <div class="side__acct">
        <small>연결 계좌</small>
        <b>토스증권</b>
        <span class="side__mode">읽기 전용</span>
      </div>
    </aside>

    <div class="shell__main">
      <main class="shell__page"><slot /></main>
    </div>

  </div>
</template>

<script setup>

// 🔴 테마는 셸이 적용한다 (2026-10-04) — 종전엔 WorkspaceView 청크만 import 해서,
//    다른 메뉴로 직행하면 data-theme 이 안 걸려 **페이지마다 테마가 달랐다**(사용자 지적).
import { useTheme } from '../composables/useTheme';

const { theme, toggle: toggleTheme } = useTheme();

/**
 * ⚠️ 폴링을 지웠다 (2026-10-12) — 종전에는 30초마다 `/api/orders/proposals` 를 쳐서
 *    승인 대기 배지를 채웠다. 그 라우트가 사라졌으므로 **남겨 두면 30초마다 404 를 만든다.**
 *    셸은 이제 내비만 맡는다.
 */
</script>

<style scoped>
.shell { display: flex; height: 100vh; overflow: hidden; background: var(--color-canvas); }
.side {
  width: 208px; flex-shrink: 0; display: flex; flex-direction: column;
  background: var(--color-surface); border-right: 1px solid var(--color-hairline);
  padding: var(--space-base) var(--space-sm);
  gap: var(--space-base);
}
.side__brand { display: flex; align-items: center; gap: var(--space-sm); padding: 0 var(--space-sm); color: var(--color-ink); }
.side__logo { width: 22px; height: 22px; border-radius: 6px; background: var(--color-primary); }
.side__nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.side__item {
  display: flex; align-items: center; gap: var(--space-xs);
  padding: 7px var(--space-sm); border-radius: var(--rounded-md);
  color: var(--color-body); text-decoration: none; font-size: var(--text-md);
}
.side__item:hover { background: var(--color-surface-hover); }
.side__item--on { background: var(--color-primary-soft); color: var(--color-primary); font-weight: 600; }
.side__spacer { flex: 1; }
.side__item--sub { color: var(--color-muted); font-size: var(--text-sm); }
.side__item--off { color: var(--color-faint); cursor: default; }
.side__item--off small { font-size: var(--text-2xs); border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 0 6px; }
.side__theme {
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md);
  background: none; color: var(--color-muted); font-size: var(--text-xs);
  padding: 6px var(--space-sm); cursor: pointer; text-align: left;
}
.side__theme:hover { color: var(--color-ink); border-color: var(--color-hairline-strong); }
.side__acct {
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md);
  padding: var(--space-sm); display: flex; flex-direction: column; gap: 2px; font-size: var(--text-xs);
}
.side__acct small { color: var(--color-faint); }
.side__mode { color: var(--color-muted); }

.shell__main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.shell__page { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

</style>
