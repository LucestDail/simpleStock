<!--
  D-3 승인 대기 (2026-10-03 와이어프레임 준용)
  목록(대기·오늘 처리·만료) + 선택 상세(OrderTicket 재사용 — 사전점검·체결 후 비교).
  🔴 와이어프레임의 "일괄 모두 거절" 은 **남긴다** — 자율 트레이딩에서 사람이 피곤하면
     승인 대신 방치가 일어난다. 방치보다 일괄 거절이 낫다.
-->
<template>
  <div class="page">
    <header class="page__head">
      <h1>승인 대기</h1>
      <span class="chip">대기 <b class="mono-num">{{ pending.length }}</b></span>
      <span class="chip">오늘 처리 <b class="mono-num">{{ todayDone }}</b></span>
      <span class="chip">만료 <b class="mono-num">{{ expired.length }}</b></span>
      <span style="flex:1"></span>
      <button v-if="pending.length" class="btn btn--sm" @click="rejectAll">모두 거절</button>
    </header>

    <p v-if="error" class="banner banner--error">{{ error }}</p>
    <p v-else-if="!pending.length" class="banner banner--empty">승인 대기 중인 제안이 없습니다.</p>

    <div class="list">
      <article v-for="p in pending" :key="p.id" class="rowcard" :class="{ 'rowcard--on': picked?.id === p.id }" @click="picked = p">
        <b :class="p.side === 'BUY' ? 'up' : 'down'">{{ p.side === 'BUY' ? '매수' : '매도' }}</b>
        <span class="rowcard__sym">{{ p.symbol }}</span>
        <span class="mono-num">{{ p.quantity }}주 @ {{ p.price ?? '시장가' }}</span>
        <span class="rowcard__why">{{ p.reason }}</span>
        <!-- ⚠️ 마감까지 남은 시간 — 와이어프레임 "응답 마감 04:12". 지나면 자동 만료라 알려야 한다 -->
        <span class="rowcard__ttl mono-num">{{ ttl(p) }}</span>
        <button class="btn btn--xs btn--primary" @click.stop="picked = p">검토</button>
      </article>
    </div>

    <!-- 상세 = 기존 OrderTicket 모달 (사전점검·체결 후 포트폴리오·근거) -->
    <OrderTicket v-if="picked" :proposal="picked" :fetch-precheck="fetchPrecheck"
      @close="picked = null" @approve="decide($event, 'approve')" @reject="decide($event, 'reject')" @trim="trim" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiFetch } from '../lib/apiClient';
import OrderTicket from '../components/OrderTicket.vue';

const rows = ref([]);
const error = ref('');
const picked = ref(null);

const pending = computed(() => rows.value.filter((p) => p.status === 'PENDING'));
const expired = computed(() => rows.value.filter((p) => p.status === 'EXPIRED'));
const todayDone = computed(() => {
  const today = new Date().toISOString().slice(0, 10);
  return rows.value.filter((p) => ['APPROVED', 'REJECTED', 'EXECUTED'].includes(p.status)
    && String(p.decidedAt || p.at || '').startsWith(today)).length;
});

function ttl(p) {
  const exp = Date.parse(p.expiresAt || 0);
  if (!exp) return '';
  const s = Math.max(0, Math.round((exp - Date.now()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function load() {
  try {
    const r = await apiFetch('/api/orders/proposals');
    const b = await r.json();
    rows.value = Array.isArray(b) ? b : (b.proposals || []);
    error.value = '';
  } catch (e) { error.value = `목록을 못 읽었습니다: ${e.message}`; }
}
async function fetchPrecheck(p) {
  const r = await apiFetch(`/api/orders/proposals/${p.id}/precheck`);
  return r.json();
}
async function decide(p, action) {
  picked.value = null;
  await apiFetch(`/api/orders/proposals/${p.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'approvals-page' }) });
  await load();
}
async function trim({ proposal, quantity }) {
  await apiFetch(`/api/orders/proposals/${proposal.id}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: `수량 조정 ${quantity}주로 재제안 요청` }) });
  picked.value = null; await load();
}
async function rejectAll() {
  for (const p of pending.value) {
    await apiFetch(`/api/orders/proposals/${p.id}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '일괄 거절' }) });
  }
  await load();
}

let timer = null;
onMounted(() => { load(); timer = setInterval(load, 15_000); });
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.list { display: flex; flex-direction: column; gap: var(--space-xs); }
.rowcard {
  display: flex; align-items: center; gap: var(--space-sm);
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base);
  cursor: pointer; font-size: var(--text-sm);
}
.rowcard:hover { background: var(--color-surface-hover); }
.rowcard--on { border-color: var(--color-primary-line); }
.rowcard__sym { font-weight: 700; color: var(--color-ink); }
.rowcard__why { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-size: var(--text-xs); }
.rowcard__ttl { color: var(--color-warn); font-size: var(--text-xs); }
</style>
