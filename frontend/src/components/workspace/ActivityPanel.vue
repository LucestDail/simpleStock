<script setup>
import { ref } from 'vue';
import PanelShell from './PanelShell.vue';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { activityFeed } = useWorkspace();
const expandedId = ref(null);

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    timeStyle: 'medium',
  }).format(new Date(value));
}

function toggleExpand(id) {
  expandedId.value = expandedId.value === id ? null : id;
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
      <button
        v-for="item in activityFeed.slice(0, 12)"
        :key="item.id"
        type="button"
        class="activity-row"
        :class="{ 'activity-row--expanded': expandedId === item.id }"
        @click="toggleExpand(item.id)"
      >
        <div class="dot" :class="`dot--${item.tone}`" />
        <div class="activity-copy">
          <strong>{{ item.title }} · {{ item.description }}</strong>
          <p v-if="expandedId === item.id">{{ item.description }}</p>
        </div>
        <span class="mono-num time">{{ formatTime(item.createdAt) }}</span>
      </button>
    </div>
  </PanelShell>
</template>

<style scoped>
.empty-box {
  border: 1px dashed var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 12px;
  color: var(--color-muted);
  font-size: 12px;
}

.activity-list {
  display: grid;
  gap: var(--space-sm);
  min-height: 0;
  overflow: auto;
}

.activity-row {
  width: 100%;
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: var(--space-sm);
  align-items: start;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  text-align: left;
  cursor: pointer;
}

.activity-row--expanded {
  background: rgba(255, 255, 255, 0.04);
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
  font-size: 11px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-copy p {
  margin: 2px 0 0;
  color: var(--color-body);
  line-height: 1.4;
  font-size: 11px;
  white-space: pre-wrap;
}

.time {
  color: var(--color-muted);
  font-size: 11px;
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
