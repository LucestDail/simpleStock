<script setup>
import PanelShell from './PanelShell.vue';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { activityFeed } = useWorkspace();

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    timeStyle: 'medium',
  }).format(new Date(value));
}
</script>

<template>
  <PanelShell
    title="실시간 활동"
    subtitle="activity"
    :span="panel.span"
    :highlighted="panel.highlighted"
  >
    <div v-if="!activityFeed.length" class="empty-box">아직 기록된 활동이 없습니다.</div>
    <div v-else class="activity-list">
      <article v-for="item in activityFeed.slice(0, 12)" :key="item.id" class="activity-row">
        <div class="dot" :class="`dot--${item.tone}`" />
        <div class="activity-copy">
          <strong>{{ item.title }}</strong>
          <p>{{ item.description }}</p>
        </div>
        <span class="mono-num time">{{ formatTime(item.createdAt) }}</span>
      </article>
    </div>
  </PanelShell>
</template>

<style scoped>
.empty-box {
  border: 1px dashed var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-lg);
  color: var(--color-muted);
}

.activity-list {
  display: grid;
  gap: var(--space-sm);
}

.activity-row {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: var(--space-sm);
  align-items: start;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: var(--rounded-full);
  margin-top: 6px;
  background: var(--color-primary);
}

.dot--warning {
  background: var(--color-accent-yellow);
}

.dot--error {
  background: var(--color-semantic-down);
}

.activity-copy {
  display: grid;
  gap: 4px;
}

.activity-copy strong {
  color: var(--color-ink);
}

.activity-copy p {
  margin: 0;
  color: var(--color-body);
  line-height: 1.55;
}

.time {
  color: var(--color-muted);
  font-size: 12px;
}

@media (max-width: 720px) {
  .activity-row {
    grid-template-columns: 10px minmax(0, 1fr);
  }

  .time {
    grid-column: 2;
  }
}
</style>
