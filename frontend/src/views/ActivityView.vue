<!--
  D-5 활동 로그 (2026-10-03 와이어프레임 준용)
  두 원천을 한 시간축으로: 활동 기록(/api/activity — 분석·알림·제안·승인) +
  주문 감사(/api/orders/stats recent — proposed/rejected/executed/blocked).
  🔴 와이어프레임의 핵심은 "차단·보류도 행이다" — 일어나지 않게 막은 일이 보여야
     사용자가 가드를 신뢰한다.
-->
<template>
  <div class="page">
    <header class="page__head">
      <h1>활동 로그</h1>
      <select v-model="filter" class="input input--sel">
        <option value="">전체</option>
        <option value="proposed">제안</option>
        <option value="rejected">거절</option>
        <option value="approved">승인</option>
        <option value="blocked">차단</option>
        <option value="activity">분석·알림</option>
      </select>
      <span style="flex:1"></span>
      <span class="chip">총 <b class="mono-num">{{ merged.length }}</b>건</span>
    </header>
    <p v-if="error" class="banner banner--error">{{ error }}</p>
    <table v-else class="tbl">
      <thead><tr><th>시각</th><th>유형</th><th>종목</th><th>내용</th></tr></thead>
      <tbody>
        <tr v-for="(r, i) in shown" :key="i">
          <td class="mono-num">{{ when(r.at) }}</td>
          <td><span class="tag" :class="`tag--${r.kind}`">{{ label(r.kind) }}</span></td>
          <td class="mono-num">{{ r.symbol || '—' }}</td>
          <td class="tbl__text">{{ r.text }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

const acts = ref([]);
const audit = ref([]);
const error = ref('');
const filter = ref('');

const merged = computed(() => {
  const a = acts.value.map((x) => ({ at: x.at, kind: 'activity', symbol: x.symbol || null, text: x.title || x.text || '' }));
  const b = audit.value.map((x) => ({ at: x.at, kind: x.event, symbol: x.symbol, text: x.side ? `${x.side === 'BUY' ? '매수' : '매도'} 제안 ${label(x.event)}` : label(x.event) }));
  return [...a, ...b].sort((x, y) => String(y.at).localeCompare(String(x.at)));
});
const shown = computed(() => (filter.value ? merged.value.filter((r) => r.kind === filter.value) : merged.value).slice(0, 200));

const label = (k) => ({ proposed: '제안', approved: '승인', rejected: '거절', executed: '체결', expired: '만료', canceled: '취소', blocked: '차단', activity: '기록' }[k] || k);
const when = (at) => (at ? new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

onMounted(async () => {
  try {
    const [ra, rs] = await Promise.all([apiFetch('/api/activity'), apiFetch('/api/orders/stats')]);
    const ba = await ra.json(); const bs = await rs.json();
    acts.value = Array.isArray(ba) ? ba : (ba.items || ba.activity || []);
    audit.value = bs?.ok ? (bs.recent || []) : [];
  } catch (e) { error.value = `로그를 못 읽었습니다: ${e.message}`; }
});
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.input--sel { max-width: 140px; height: 32px; border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); background: var(--color-surface); color: var(--color-body); padding: 0 var(--space-sm); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.tbl { width: 100%; border-collapse: collapse; background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 6px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 5px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
.tbl__text { color: var(--color-body); }
.tag { font-size: var(--text-2xs); border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 1px 8px; }
.tag--rejected, .tag--blocked { color: var(--color-warn); border-color: var(--color-warn); }
.tag--executed, .tag--approved { color: var(--color-open); border-color: var(--color-open); }
</style>
