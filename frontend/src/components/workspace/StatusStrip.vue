<script setup>
import { computed } from 'vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useChat } from '../../composables/useChat';
import { useWorkspace } from '../../composables/useWorkspace';

const { system, manager, holdings, snapshots } = usePortfolio();
const { activeThread } = useChat();
const { focusMode, layoutReason } = useWorkspace();

const latestReportTime = computed(() => manager.value?.latestReport?.createdAt || null);

function formatTime(value) {
  if (!value) return '없음';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
</script>

<template>
  <div class="status-strip">
    <div class="status-item">
      <span class="label">현재</span>
      <strong>{{ system.serverTimeLocal || '시간 확인 중' }}</strong>
    </div>
    <div class="status-item">
      <span class="label">포커스</span>
      <strong>{{ focusMode }}</strong>
    </div>
    <div class="status-item">
      <span class="label">활성 스레드</span>
      <strong>{{ activeThread?.title || '없음' }}</strong>
    </div>
    <div class="status-item">
      <span class="label">보유 자산</span>
      <strong>{{ holdings.length }}개</strong>
    </div>
    <div class="status-item">
      <span class="label">스냅샷</span>
      <strong>{{ snapshots.length }}건</strong>
    </div>
    <div class="status-item">
      <span class="label">최근 브리핑</span>
      <strong>{{ formatTime(latestReportTime) }}</strong>
    </div>
    <div class="status-item status-item--wide">
      <span class="label">레이아웃 사유</span>
      <strong>{{ layoutReason }}</strong>
    </div>
  </div>
</template>

<style scoped>
.status-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-sm);
}

.status-item {
  min-height: 72px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: var(--color-canvas);
  padding: var(--space-sm) var(--space-base);
  display: grid;
  gap: 8px;
}

.status-item--wide {
  grid-column: span 2;
}

.label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-muted);
}

strong {
  color: var(--color-ink);
  font-size: 14px;
  line-height: 1.45;
}

@media (max-width: 1200px) {
  .status-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .status-item--wide {
    grid-column: span 3;
  }
}

@media (max-width: 720px) {
  .status-strip {
    grid-template-columns: 1fr;
  }

  .status-item--wide {
    grid-column: span 1;
  }
}
</style>
