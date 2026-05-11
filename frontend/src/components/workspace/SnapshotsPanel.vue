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

const { system, snapshots } = usePortfolio();
const { openDrawer } = useWorkspace();
const scheduledTasks = computed(() => system.value.scheduledTasks || []);
const fallbackTask = computed(() => ({
  id: 'default-manager-brief',
  title: '기본 Quant Manager 브리핑',
  description: '시스템 기본 브리핑 스케줄입니다.',
  cronExpression: system.value.ai?.dailyCron || '-',
  nextRunLabel: system.value.ai?.dailyCron ? `cron ${system.value.ai.dailyCron}` : '미설정',
  taskType: 'managerBrief',
  enabled: Boolean(system.value.ai?.dailyCron),
}));
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

    <div class="snapshot-list">
      <article
        v-for="task in (scheduledTasks.length ? scheduledTasks : [fallbackTask]).slice(0, 6)"
        :key="task.id"
        class="snapshot-row"
      >
        <div class="snapshot-main">
          <strong>{{ task.title }}</strong>
          <span>{{ task.description || '자연어 대화로 반복 작업을 등록할 수 있습니다.' }}</span>
        </div>
        <div class="snapshot-metrics">
          <strong>{{ task.nextRunLabel || task.cronExpression || '대기' }}</strong>
          <span class="mono-num delta" :class="task.enabled ? 'up' : 'down'">
            {{ task.enabled ? '활성' : '비활성' }}
          </span>
        </div>
      </article>
    </div>

    <div class="snapshot-note">
      스냅샷은 내부적으로 일별 자산 변동 기준선을 보존하기 위한 기록이며, 메인 화면에서는 예정 작업 중심으로 노출합니다.
      현재 저장된 스냅샷 {{ snapshots.length }}건
    </div>
  </PanelShell>
</template>

<style scoped>
.btn-secondary {
  height: 30px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 12px;
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.snapshot-list {
  display: grid;
  gap: var(--space-xs);
  min-height: 0;
  overflow: auto;
}

.snapshot-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-sm);
  align-items: center;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
}

.snapshot-main {
  display: grid;
  gap: 4px;
}

.snapshot-main strong {
  color: var(--color-ink);
  font-size: 12px;
}

.snapshot-main span {
  color: var(--color-muted);
  font-size: 10px;
  line-height: 1.35;
}

.snapshot-metrics {
  display: grid;
  gap: 4px;
  justify-items: end;
}

.snapshot-metrics strong {
  color: var(--color-ink);
  font-size: 11px;
}

.delta.up {
  color: var(--color-semantic-up);
}

.delta.down {
  color: var(--color-semantic-down);
}

.snapshot-note {
  padding: 8px 10px;
  border-radius: var(--rounded-lg);
  background: rgba(255, 255, 255, 0.02);
  color: var(--color-muted);
  font-size: 10px;
  line-height: 1.4;
}

@media (max-width: 720px) {
  .snapshot-row {
    grid-template-columns: 1fr;
  }

  .snapshot-metrics {
    justify-items: start;
  }
}
</style>
