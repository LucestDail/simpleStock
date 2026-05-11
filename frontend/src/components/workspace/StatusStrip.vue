<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { system, manager, holdings } = usePortfolio();
const { openDrawer } = useWorkspace();

const latestReportTime = computed(() => manager.value?.latestReport?.createdAt || null);
const latestMarketTime = computed(() => system.value.market?.lastSuccessAt || system.value.market?.lastRefreshAt || null);
const cards = computed(() => [
  { label: '현재', value: formatCurrentTime(system.value.serverTimeIso || system.value.serverTimeLocal), wide: true },
  { label: 'Gemini', value: system.value.aiConfigured ? '활성' : '비활성' },
  { label: '보유 자산', value: `${holdings.value.length}개` },
  {
    label: '추적 티커',
    value: `${(system.value.market?.trackedTickers || []).length}개`,
  },
  {
    label: 'USD/KRW',
    value: Number.isFinite(Number(system.value.market?.fx?.USDKRW?.rate))
      ? Number(system.value.market.fx.USDKRW.rate).toLocaleString('ko-KR', { maximumFractionDigits: 2 })
      : '대기',
  },
  { label: '예정 작업', value: `${(system.value.scheduledTasks || []).length}건` },
  { label: '최근 시세', value: formatTime(latestMarketTime.value), wide: true },
  { label: '최근 브리핑', value: formatTime(latestReportTime.value), wide: true },
]);

function formatTime(value) {
  if (!value) return '없음';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatCurrentTime(value) {
  if (!value) return '시간 확인 중';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
</script>

<template>
  <PanelShell
    title="운영 상태"
    subtitle="status"
    :span="panel.span"
    :highlighted="panel.highlighted"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('system', null, '운영 상태')">
        상세
      </button>
    </template>

    <div class="status-grid">
      <article
        v-for="item in cards"
        :key="item.label"
        class="status-item"
        :class="{ 'status-item--wide': item.wide }"
      >
        <span class="label">{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </article>
    </div>
  </PanelShell>
</template>

<style scoped>
.btn-secondary {
  height: 24px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
  gap: 5px;
  min-height: 0;
}

.status-item {
  min-height: 40px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: rgba(255, 255, 255, 0.02);
  padding: 5px 7px;
  display: grid;
  gap: 3px;
}

.status-item--wide {
  grid-column: 1 / -1;
}

.label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

strong {
  color: var(--color-ink);
  font-size: 12px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
