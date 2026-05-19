<script setup>
import PanelShell from './PanelShell.vue';
import { useScheduledTasks } from '../../composables/useScheduledTasks';
import { useWorkspace } from '../../composables/useWorkspace';

defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { displayTasks } = useScheduledTasks();
const { openDrawer } = useWorkspace();
</script>

<template>
  <PanelShell
    title="예정 작업"
    subtitle="schedule"
    :span="panel.span"
    :highlighted="panel.highlighted"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('settings', null, '설정')">설정</button>
    </template>

    <div v-if="displayTasks.length" class="snapshot-list">
      <article
        v-for="task in displayTasks"
        :key="task.id"
        class="snapshot-row"
      >
        <div class="snapshot-main">
          <strong>{{ task.title }}</strong>
          <span>{{ task.description || '자연어 대화로 반복 작업을 등록할 수 있습니다.' }}</span>
          <code v-if="task.cronExpression" class="cron">{{ task.cronExpression }}</code>
        </div>
        <div class="snapshot-metrics">
          <strong>{{ task.displayRunLabel }}</strong>
          <span class="mono-num delta" :class="task.enabled ? 'up' : 'down'">
            {{ task.enabled ? '활성' : '비활성' }} · {{ task.type || 'custom' }}
          </span>
        </div>
      </article>
    </div>
    <div v-else class="empty-box">등록된 예정 작업이 없습니다. 채팅에서 「매일 9시 브리핑」처럼 요청하세요.</div>
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
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}

.snapshot-list {
  display: grid;
  gap: 4px;
  min-height: 0;
  overflow: auto;
}

.empty-box {
  border: 1px dashed var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 8px;
  color: var(--color-muted);
  font-size: 10px;
}

.snapshot-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.02);
}

.snapshot-main {
  display: grid;
  gap: 2px;
}

.snapshot-main strong {
  color: var(--color-ink);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.snapshot-main span {
  color: var(--color-muted);
  font-size: 9px;
  line-height: 1.2;
}

.cron {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-body);
}

.snapshot-metrics {
  display: grid;
  gap: 2px;
  justify-items: end;
}

.snapshot-metrics strong {
  color: var(--color-ink);
  font-size: 9px;
  max-width: 130px;
  text-align: right;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.delta {
  font-size: 9px;
}

.delta.up {
  color: var(--color-semantic-up);
}

.delta.down {
  color: var(--color-semantic-down);
}

@media (max-width: 1280px) {
  .snapshot-row {
    grid-template-columns: 1fr;
  }

  .snapshot-metrics {
    justify-items: start;
  }
}
</style>
