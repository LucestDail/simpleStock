<script setup>
import { computed, ref } from 'vue';
import PanelShell from './PanelShell.vue';
import { CATEGORIES, formatKRW, usePortfolio } from '../../composables/usePortfolio';
import { useUi } from '../../composables/useUi';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { sortedSnapshots, addSnapshot, deleteSnapshot } = usePortfolio();
const { notify, confirmAction } = useUi();
const { applyWorkspacePatch, recordActivity } = useWorkspace();
const busy = ref(false);
const snapDate = ref(new Date().toISOString().slice(0, 10));

const rows = computed(() => {
  const list = [...sortedSnapshots.value].sort((a, b) => a.date.localeCompare(b.date));
  return list
    .map((item, index) => {
      const prev = index > 0 ? list[index - 1] : null;
      const delta = prev ? item.total - prev.total : null;
      const pct =
        prev && prev.total > 0 ? Math.round(((item.total - prev.total) / prev.total) * 1000) / 10 : null;
      return {
        ...item,
        delta,
        pct,
      };
    })
    .reverse();
});

function breakdownLine(byCategory) {
  return CATEGORIES.map((category) => `${category.label} ${formatKRW(byCategory?.[category.id] || 0)}`).join(' · ');
}

async function saveSnapshot() {
  busy.value = true;
  try {
    await addSnapshot(snapDate.value || undefined);
    notify({
      tone: 'success',
      message: `${snapDate.value || '오늘'} 스냅샷을 저장했습니다.`,
    });
    recordActivity({
      type: 'snapshot',
      title: '스냅샷 저장',
      description: snapDate.value || '오늘',
    });
    applyWorkspacePatch(
      {
        focusMode: 'balanced',
        highlightPanelIds: ['snapshots', 'overview', 'activity'],
        panelPatches: [],
        openDrawer: { type: 'system', entityId: '', title: '스냅샷 반영' },
        reason: '새 스냅샷이 저장되어 변동 패널을 강조합니다.',
      },
      'local-action'
    );
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '스냅샷 저장 실패',
    });
  } finally {
    busy.value = false;
  }
}

async function removeSnapshot(date) {
  const ok = await confirmAction({
    title: '스냅샷 삭제',
    message: `${date} 기록을 삭제할까요?`,
    confirmLabel: '삭제',
    cancelLabel: '취소',
    tone: 'danger',
  });
  if (!ok) return;

  busy.value = true;
  try {
    await deleteSnapshot(date);
    notify({
      tone: 'success',
      message: `${date} 스냅샷을 삭제했습니다.`,
    });
    recordActivity({
      type: 'snapshot',
      title: '스냅샷 삭제',
      description: date,
      tone: 'warning',
    });
    applyWorkspacePatch(
      {
        focusMode: 'balanced',
        highlightPanelIds: ['snapshots', 'activity'],
        panelPatches: [],
        openDrawer: { type: 'system', entityId: '', title: '스냅샷 상태' },
        reason: '스냅샷 삭제 후 기록 패널을 강조합니다.',
      },
      'local-action'
    );
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '스냅샷 삭제 실패',
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PanelShell
    title="스냅샷"
    subtitle="history"
    :span="panel.span"
    :highlighted="panel.highlighted"
    :loading="busy"
  >
    <div class="toolbar">
      <input v-model="snapDate" class="date-input" type="date" />
      <button type="button" class="btn-primary" :disabled="busy" @click="saveSnapshot">저장</button>
    </div>

    <div v-if="!rows.length" class="empty-box">스냅샷이 없습니다.</div>
    <div v-else class="snapshot-list">
      <article v-for="row in rows.slice(0, 8)" :key="row.date" class="snapshot-row">
        <div class="snapshot-main">
          <strong class="mono-num">{{ row.date }}</strong>
          <span>{{ breakdownLine(row.byCategory) }}</span>
        </div>
        <div class="snapshot-metrics">
          <strong class="mono-num">{{ formatKRW(row.total) }}</strong>
          <span
            v-if="row.delta != null"
            class="mono-num delta"
            :class="row.delta >= 0 ? 'up' : 'down'"
          >
            {{ row.delta >= 0 ? '+' : '' }}{{ formatKRW(row.delta) }}
          </span>
          <span v-else class="mono-num delta">—</span>
        </div>
        <button type="button" class="btn-text danger" :disabled="busy" @click="removeSnapshot(row.date)">
          삭제
        </button>
      </article>
    </div>
  </PanelShell>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: var(--space-sm);
}

.date-input {
  flex: 1;
  height: 44px;
  padding: 0 var(--space-base);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  background: var(--color-canvas);
  color: var(--color-ink);
  font: inherit;
}

.date-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(0, 82, 255, 0.08);
}

.btn-primary {
  height: 44px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 var(--space-md);
  background: var(--color-primary);
  color: var(--color-on-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary:disabled {
  background: var(--color-primary-disabled);
  cursor: not-allowed;
}

.empty-box {
  border: 1px dashed var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-lg);
  color: var(--color-muted);
}

.snapshot-list {
  display: grid;
  gap: var(--space-sm);
}

.snapshot-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: var(--space-base);
  align-items: center;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
}

.snapshot-main {
  display: grid;
  gap: 4px;
}

.snapshot-main strong {
  color: var(--color-ink);
}

.snapshot-main span {
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.5;
}

.snapshot-metrics {
  display: grid;
  gap: 4px;
  justify-items: end;
}

.snapshot-metrics strong {
  color: var(--color-ink);
}

.delta.up {
  color: var(--color-semantic-up);
}

.delta.down {
  color: var(--color-semantic-down);
}

.btn-text {
  border: none;
  background: transparent;
  color: var(--color-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.btn-text.danger {
  color: var(--color-semantic-down);
}

@media (max-width: 720px) {
  .toolbar,
  .snapshot-row {
    grid-template-columns: 1fr;
  }

  .snapshot-metrics {
    justify-items: start;
  }
}
</style>
