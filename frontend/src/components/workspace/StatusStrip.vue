<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useChat } from '../../composables/useChat';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { system, manager, holdings } = usePortfolio();
const { activeThread } = useChat();
const { focusMode, layoutReason, openDrawer } = useWorkspace();

const latestReportTime = computed(() => manager.value?.latestReport?.createdAt || null);
const cards = computed(() => [
  { label: '현재', value: system.value.serverTimeLocal || '시간 확인 중' },
  { label: '포커스', value: focusMode.value || 'balanced' },
  { label: '활성 스레드', value: activeThread.value?.title || '없음' },
  { label: '보유 자산', value: `${holdings.value.length}개` },
  { label: '예정 작업', value: `${(system.value.scheduledTasks || []).length}건` },
  { label: '최근 브리핑', value: formatTime(latestReportTime.value) },
  { label: '레이아웃 사유', value: layoutReason.value || '기본 레이아웃', wide: true },
]);

function formatTime(value) {
  if (!value) return '없음';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
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
  height: 28px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 10px;
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
  min-height: 0;
}

.status-item {
  min-height: 44px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: rgba(255, 255, 255, 0.02);
  padding: 7px 9px;
  display: grid;
  gap: 4px;
  overflow: hidden;
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
}

strong {
  color: var(--color-ink);
  font-size: 11px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
