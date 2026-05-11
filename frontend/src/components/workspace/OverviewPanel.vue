<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio, formatKRW } from '../../composables/usePortfolio';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { total, categoryShares, dayOverDay, lastSnapshot, busyState } = usePortfolio();
const { selectCategory, openDrawer } = useWorkspace();

const summaryCards = computed(() => [
  {
    id: 'total',
    label: '총 자산',
    value: formatKRW(total.value),
  },
  {
    id: 'lastSnapshot',
    label: '최근 스냅샷',
    value: lastSnapshot.value ? formatKRW(lastSnapshot.value.total) : '없음',
  },
  {
    id: 'delta',
    label: '직전 대비',
    value: dayOverDay.value
      ? `${dayOverDay.value.delta >= 0 ? '+' : ''}${formatKRW(dayOverDay.value.delta)}`
      : '—',
  },
]);

function inspectCategory(categoryId) {
  selectCategory(categoryId);
  openDrawer('assetDetail', categoryId, '카테고리 상세');
}
</script>

<template>
  <PanelShell
    title="포트폴리오 개요"
    subtitle="overview"
    :span="panel.span"
    :highlighted="panel.highlighted"
    :loading="busyState.fetchPortfolio"
  >
    <div class="summary-grid">
      <article v-for="item in summaryCards" :key="item.id" class="summary-card">
        <span class="summary-label">{{ item.label }}</span>
        <strong class="summary-value mono-num">{{ item.value }}</strong>
      </article>
    </div>

    <div class="share-list">
      <button
        v-for="item in categoryShares"
        :key="item.id"
        type="button"
        class="share-item"
        @click="inspectCategory(item.id)"
      >
        <div class="share-head">
          <strong>{{ item.label }}</strong>
          <span class="mono-num">{{ item.pct }}%</span>
        </div>
        <span class="mono-num share-amount">{{ formatKRW(item.amount) }}</span>
        <div class="share-bar">
          <div class="share-bar__fill" :style="{ width: `${Math.min(100, item.pct)}%` }" />
        </div>
      </button>
    </div>
  </PanelShell>
</template>

<style scoped>
.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}

.summary-card {
  padding: 6px 8px;
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
  display: grid;
  gap: 2px;
}

.summary-label {
  color: var(--color-muted);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.summary-value {
  color: var(--color-ink);
  font-size: 11px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.share-list {
  display: grid;
  gap: 5px;
  min-height: 0;
  overflow: auto;
}

.share-item {
  border: 1px solid var(--color-hairline);
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--rounded-lg);
  padding: 6px 8px;
  text-align: left;
  cursor: pointer;
  display: grid;
  gap: 3px;
}

.share-item:hover {
  border-color: rgba(0, 82, 255, 0.35);
}

.share-head {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  align-items: center;
  color: var(--color-ink);
  font-size: 10px;
}

.share-amount {
  color: var(--color-body);
  font-size: 10px;
}

.share-bar {
  height: 4px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  overflow: hidden;
}

.share-bar__fill {
  height: 100%;
  background: var(--color-primary);
}

@media (max-width: 1280px) {
  .summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>
