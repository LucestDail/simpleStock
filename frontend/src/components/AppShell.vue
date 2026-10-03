<!--
  🤖 앱 셸 — 사이드 메뉴 + 상단 상태 바 (2026-10-03 와이어프레임 전면 준용)

  와이어프레임 공통 뼈대(10장 전부 동일):
    좌측  로고 · 페이지 내비(승인 대기 배지) · 연결 계좌 카드
    상단  [에이전트 운용 중 | 정지됨] · 자율 수준 · 장 세션 · 일일 손실/-한도 · [일시정지] [비상정지]

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
        <!-- ⚠️ 백엔드가 없는 둘은 **정직하게 준비 중** — 빈 화면을 파는 것보다 낫다 -->
        <span class="side__item side__item--off" title="백테스트·전략 배분 백엔드가 아직 없습니다">전략 연구소 <small>준비 중</small></span>
        <span class="side__item side__item--off" title="종목별 거래 이력 화면은 다음 단계입니다">종목 상세 <small>준비 중</small></span>
      </nav>
      <div class="side__acct">
        <small>연결 계좌</small>
        <b>토스증권</b>
        <!-- 🔴 실거래/모의 는 서버 모드에서 — 지어내지 않는다 -->
        <span class="side__mode" :class="{ 'side__mode--live': ordersLive }">{{ ordersLive ? '실거래' : '모의' }}</span>
      </div>
    </aside>

    <div class="shell__main">
      <header class="statusbar">
        <!-- 운용 상태 — 정지면 전체가 경고 톤으로 -->
        <span class="statusbar__state" :class="{ 'statusbar__state--paused': control?.paused }">
          {{ control?.paused ? `⏸ 정지됨 (${scopeLabel})` : '● 에이전트 운용 중' }}
        </span>
        <span class="statusbar__chip">{{ autonomy }}</span>
        <span v-if="control?.paused && control?.resumeAt" class="statusbar__chip">
          재개 예약 {{ new Date(control.resumeAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}
        </span>
        <span class="statusbar__spacer"></span>
        <!-- 일일 손익 / 한도 — 와이어프레임 "일일 손실 -0.7% / -2.0%" -->
        <span v-if="dailyPct != null" class="statusbar__chip mono-num" :class="dailyPct < 0 ? 'down' : 'up'">
          오늘 {{ dailyPct > 0 ? '+' : '' }}{{ dailyPct }}%
        </span>
        <button v-if="!control?.paused" class="btn btn--sm" @click="quickPause">일시정지</button>
        <button v-if="!control?.paused" class="btn btn--sm btn--danger" @click="stopOpen = true">비상정지</button>
        <button v-else class="btn btn--sm btn--primary" @click="resume">▶ 재개</button>
      </header>

      <main class="shell__page"><slot /></main>
    </div>

    <!-- 🛑 비상정지 모달 (D-4) — 범위 3단 + "정지" 타이핑 확인 -->
    <div v-if="stopOpen" class="stop__scrim" @click.self="stopOpen = false">
      <section class="stop" role="dialog" aria-modal="true">
        <h2>에이전트 비상정지</h2>
        <p class="stop__sub">정지 범위를 고르세요. 정지 중에는 어떤 자동 주문도 나가지 않습니다.</p>
        <label class="stop__opt"><input v-model="stopScope" type="radio" value="halt_new" />
          <span><b>신규 주문만 중단</b><small>보유 종목과 미체결 주문은 그대로 둡니다</small></span></label>
        <label class="stop__opt"><input v-model="stopScope" type="radio" value="halt_cancel" />
          <span><b>미체결 주문 취소 + 중단</b><small>대기 중인 제안을 모두 거절 처리합니다</small></span></label>
        <label class="stop__opt stop__opt--danger"><input v-model="stopScope" type="radio" value="halt_flatten" />
          <span><b>전 포지션 청산 요청 + 중단</b><small>⚠️ 청산 주문 자동 발사는 아직 막혀 있습니다 — 요청이 기록되고 사람이 집행합니다</small></span></label>
        <label class="stop__resume"><input v-model="stopResume" type="checkbox" /> 다음 거래일에 자동 재개</label>
        <!-- 🔴 타이핑 확인 — 실수 클릭으로 전 포지션이 멈추면 안 된다 (와이어프레임 그대로) -->
        <label class="stop__confirm">확인을 위해 "정지"를 입력하세요
          <input v-model="stopWord" class="input" placeholder="정지" />
        </label>
        <footer class="stop__foot">
          <small>정지·재개 기록은 활동 로그에 남습니다</small>
          <span style="flex:1"></span>
          <button class="btn" @click="stopOpen = false">취소</button>
          <button class="btn btn--danger" :disabled="stopWord !== '정지'" @click="doStop">에이전트 정지</button>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

const control = ref(null);
const autonomy = ref('승인 후 실행');
const pendingCount = ref(0);
const ordersLive = ref(false);
const dailyPct = ref(null);

const stopOpen = ref(false);
const stopScope = ref('halt_new');
const stopResume = ref(false);
const stopWord = ref('');

const scopeLabel = computed(() => ({
  halt_new: '신규 중단', halt_cancel: '미체결 취소', halt_flatten: '청산 요청',
}[control.value?.scope] || control.value?.scope || ''));

async function load() {
  try {
    const r = await apiFetch('/api/agent/status');
    const b = await r.json();
    control.value = b.control || null;
    autonomy.value = b.autonomy || '승인 후 실행';
  } catch { /* 상태를 못 읽어도 셸은 산다 — 페이지가 각자 오류를 말한다 */ }
  try {
    const r = await apiFetch('/api/orders/proposals');
    const b = await r.json();
    const rows = Array.isArray(b) ? b : (b.proposals || []);
    pendingCount.value = rows.filter((p) => p.status === 'PENDING').length;
    ordersLive.value = Boolean(b.mode === 'live' || b.ordersMode === 'live');
  } catch { /* 배지 없이 간다 */ }
  try {
    const r = await apiFetch('/api/portfolio');
    const b = await r.json();
    const v = Number(b?.summary?.dailyRate);
    dailyPct.value = Number.isFinite(v) ? v : null;
  } catch { dailyPct.value = null; }
}

async function quickPause() {
  // 일시정지 = 신규 중단 + 사유 고정. 비상정지 모달과 달리 한 번에 — 가장 흔한 동작이라 가볍게.
  await apiFetch('/api/agent/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'halt_new', reason: '상단 바 일시정지' }) });
  await load();
}
async function resume() {
  await apiFetch('/api/agent/resume', { method: 'POST' });
  await load();
}
async function doStop() {
  await apiFetch('/api/agent/pause', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: stopScope.value, reason: '비상정지', resumeNextDay: stopResume.value }),
  });
  stopOpen.value = false; stopWord.value = '';
  await load();
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
.side__acct {
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md);
  padding: var(--space-sm); display: flex; flex-direction: column; gap: 2px; font-size: var(--text-xs);
}
.side__acct small { color: var(--color-faint); }
.side__mode { color: var(--color-muted); }
.side__mode--live { color: var(--color-danger); font-weight: 700; }

.shell__main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.statusbar {
  display: flex; align-items: center; gap: var(--space-sm);
  padding: var(--space-xs) var(--space-base);
  background: var(--color-surface); border-bottom: 1px solid var(--color-hairline);
  font-size: var(--text-xs);
}
.statusbar__state { font-weight: 700; color: var(--color-open); white-space: nowrap; }
.statusbar__state--paused { color: var(--color-danger); }
.statusbar__chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; color: var(--color-body); white-space: nowrap; }
.statusbar__spacer { flex: 1; }
.shell__page { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

/* 🛑 비상정지 모달 */
.stop__scrim { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 60; }
.stop {
  width: min(480px, 92vw); background: var(--color-surface); color: var(--color-body);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-lg);
  padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-sm);
  box-shadow: var(--shadow-pop);
}
.stop h2 { margin: 0; font-size: var(--text-lg); color: var(--color-danger); }
.stop__sub { margin: 0; font-size: var(--text-sm); }
.stop__opt {
  display: flex; gap: var(--space-sm); align-items: flex-start;
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm);
  cursor: pointer;
}
.stop__opt b { display: block; color: var(--color-ink); font-size: var(--text-sm); }
.stop__opt small { color: var(--color-muted); font-size: var(--text-xs); }
.stop__opt--danger { border-color: var(--color-danger-soft); }
.stop__resume, .stop__confirm { font-size: var(--text-xs); display: flex; align-items: center; gap: var(--space-xs); }
.stop__confirm .input { max-width: 120px; }
.stop__foot { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--text-2xs); color: var(--color-faint); }
</style>
