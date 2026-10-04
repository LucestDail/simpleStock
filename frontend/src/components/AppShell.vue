<!--
  🤖 앱 셸 — 사이드 메뉴 + 상단 상태 바 (2026-10-03 와이어프레임 전면 준용)

  와이어프레임 공통 뼈대(10장 전부 동일):
    좌측  로고 · 페이지 내비(승인 대기 배지) · 연결 계좌 카드
    상단바 없음 — 운용 상태·정지 조작은 **운용 규칙 설정**에 있다(2026-10-04: 대시보드는 보기 전용)

  🔴 상태 바의 존재 이유: **"지금 에이전트가 무엇을 할 수 있는 상태인가"** 를 어느 페이지에서든
     한눈에. 자율 트레이딩에서 이게 안 보이면 사용자는 끊임없이 불안하거나, 더 나쁘게는 잊는다.
-->
<template>
  <div class="shell">
    <aside class="side">
      <div class="side__brand">
        <span class="side__logo" aria-hidden="true"></span>
        <b>SimpleStock</b>
      </div>
      <nav class="side__nav">
        <RouterLink to="/" class="side__item" exact-active-class="side__item--on">대시보드</RouterLink>
        <RouterLink to="/approvals" class="side__item" active-class="side__item--on">
          승인 대기
          <b v-if="pendingCount" class="side__badge mono-num">{{ pendingCount }}</b>
        </RouterLink>
        <RouterLink to="/activity" class="side__item" active-class="side__item--on">활동 로그</RouterLink>
        <RouterLink to="/risk" class="side__item" active-class="side__item--on">포트폴리오·리스크</RouterLink>
        <RouterLink to="/report" class="side__item" active-class="side__item--on">성과 리포트</RouterLink>
        <RouterLink to="/rules" class="side__item" active-class="side__item--on">운용 규칙 설정</RouterLink>
        <RouterLink to="/lab" class="side__item" active-class="side__item--on">전략 연구소</RouterLink>
        <!-- 종목 상세는 종목을 클릭해 들어간다 — 메뉴 항목이 아니라 경로다(와이어프레임도 breadcrumb) -->
      </nav>
      <button class="side__theme" :title="theme === 'light' ? '어두운 테마로' : '밝은 테마로'" @click="toggleTheme">
        {{ theme === 'light' ? '☾ 다크 모드' : '☀ 라이트 모드' }}
      </button>
      <div class="side__acct">
        <small>연결 계좌</small>
        <b>토스증권</b>
        <!-- 🔴 실거래/모의 는 서버 모드에서 — 지어내지 않는다 -->
        <span class="side__mode" :class="{ 'side__mode--live': ordersLive }">{{ ordersLive ? '실거래' : '모의' }}</span>
      </div>
    </aside>

    <div class="shell__main">
      <main class="shell__page"><slot /></main>
    </div>

  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { apiFetch } from '../lib/apiClient';
// 🔴 테마는 셸이 적용한다 (2026-10-04) — 종전엔 WorkspaceView 청크만 import 해서,
//    다른 메뉴로 직행하면 data-theme 이 안 걸려 **페이지마다 테마가 달랐다**(사용자 지적).
import { useTheme } from '../composables/useTheme';

/*
 * 2026-10-04 재편: 상단 상태바(운용 상태·오늘 손익·일시정지·비상정지)는 **운용 규칙 설정**으로
 * 이사했다 — 사용자: "대시보드는 순전히 보는 용도. 조작이 되면 안 돼." 셸은 내비와 배지만 맡는다.
 */
const { theme, toggle: toggleTheme } = useTheme();
const pendingCount = ref(0);
const ordersLive = ref(false);

async function load() {
  try {
    const r = await apiFetch('/api/orders/proposals');
    const b = await r.json();
    const rows = Array.isArray(b) ? b : (b.proposals || []);
    pendingCount.value = rows.filter((p) => p.status === 'PENDING').length;
    // 🔴 정본 필드는 status.effective 다 — 종전 b.mode 추정이 실거래를 '모의' 로 보여줬다
    //    (2026-10-04 CDP 검수에서 발견: 승인 대기의 실거래 배지와 사이드바가 서로 반대말을 했다)
    ordersLive.value = b?.status?.effective === 'live';
  } catch { /* 배지 없이 간다 */ }
}

let timer = null;
onMounted(() => { load(); timer = setInterval(load, 30_000); });
onUnmounted(() => clearInterval(timer));
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
.side__item--off { color: var(--color-faint); cursor: default; }
.side__item--off small { font-size: var(--text-2xs); border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 0 6px; }
.side__badge {
  margin-left: auto; min-width: 18px; text-align: center;
  background: var(--color-primary); color: var(--color-on-primary);
  border-radius: var(--rounded-pill); font-size: var(--text-2xs); padding: 1px 6px;
}
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
.side__mode--live { color: var(--color-danger); font-weight: 700; }

.shell__main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.shell__page { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

</style>
