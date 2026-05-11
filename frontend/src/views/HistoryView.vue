<script setup>
import { ref, onMounted, computed } from 'vue';
import { usePortfolio, formatKRW, CATEGORIES } from '../composables/usePortfolio';
import { useUi } from '../composables/useUi';

const { sortedSnapshots, fetchPortfolio, addSnapshot, deleteSnapshot, loading, error } =
  usePortfolio();
const { confirmAction, notify } = useUi();

const snapDate = ref('');
const busy = ref(false);

onMounted(() => {
  fetchPortfolio();
  snapDate.value = new Date().toISOString().slice(0, 10);
});

const rows = computed(() => {
  const list = [...sortedSnapshots.value].sort((a, b) => a.date.localeCompare(b.date));
  return list.map((s, i) => {
    const prev = i > 0 ? list[i - 1] : null;
    const delta = prev ? s.total - prev.total : null;
    const pct =
      prev && prev.total > 0 ? Math.round(((s.total - prev.total) / prev.total) * 1000) / 10 : null;
    return { ...s, delta, pct };
  });
});

const rowsDesc = computed(() => [...rows.value].reverse());

async function saveSnapshot() {
  busy.value = true;
  try {
    await addSnapshot(snapDate.value || undefined);
    notify({
      tone: 'success',
      message: `${snapDate.value || '오늘'} 기준 스냅샷을 저장했습니다.`,
    });
  } catch (e) {
    notify({
      tone: 'error',
      message: e.message || '스냅샷 저장에 실패했습니다.',
    });
  } finally {
    busy.value = false;
  }
}

async function remove(date) {
  const ok = await confirmAction({
    title: '스냅샷 삭제',
    message: `${date} 기록을 삭제할까요? 삭제하면 전일 대비 계산에서도 제외됩니다.`,
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
  } catch (e) {
    notify({
      tone: 'error',
      message: e.message || '스냅샷 삭제에 실패했습니다.',
    });
  } finally {
    busy.value = false;
  }
}

function breakdownLine(by) {
  if (!by) return '';
  return CATEGORIES.map((c) => `${c.label} ${formatKRW(by[c.id] || 0)}`).join(' · ');
}
</script>

<template>
  <div class="page">
    <div class="container">
      <h1 class="page-title">일별 기록</h1>
      <p class="page-lead">
        특정 날짜의 총 자산을 하루 마감값처럼 고정 저장하는 기능입니다. 입력된 현재 보유 자산 합계를
        날짜별로 남겨 두면, 대시보드에서 전일 대비 증감을 계산할 수 있습니다.
      </p>

      <p v-if="error" class="banner-error">{{ error }}</p>

      <section class="card">
        <h2 class="card-h">스냅샷 저장</h2>
        <p class="hint">선택한 날짜의 합계가 이미 있으면 덮어씁니다. 일별 자산 마감 기록 용도입니다.</p>
        <div class="row-form">
          <input v-model="snapDate" type="date" class="input" />
          <button
            type="button"
            class="btn-primary"
            :disabled="loading || busy"
            @click="saveSnapshot"
          >
            저장
          </button>
        </div>
      </section>

      <section>
        <h2 class="section-h">기록 목록</h2>
        <p v-if="loading && !sortedSnapshots.length" class="muted">불러오는 중…</p>
        <p v-else-if="!sortedSnapshots.length" class="muted">스냅샷이 없습니다.</p>
        <div v-else class="table-wrap">
          <div class="head-row">
            <span>날짜</span>
            <span>총 자산</span>
            <span>전일 대비</span>
            <span />
          </div>
          <div v-for="r in rowsDesc" :key="r.date" class="data-row">
            <span class="mono-num date">{{ r.date }}</span>
            <span class="mono-num total">{{ formatKRW(r.total) }}</span>
            <span
              v-if="r.delta != null"
              class="mono-num delta"
              :class="r.delta >= 0 ? 'up' : 'down'"
            >
              {{ r.delta >= 0 ? '+' : '' }}{{ formatKRW(r.delta) }}
              <template v-if="r.pct != null"> ({{ r.delta >= 0 ? '+' : '' }}{{ r.pct }}%)</template>
            </span>
            <span v-else class="muted">—</span>
            <button
              type="button"
              class="btn-text danger"
              :disabled="busy"
              @click="remove(r.date)"
            >
              삭제
            </button>
          </div>
        </div>
      </section>

      <section v-if="rowsDesc.length" class="detail-section">
        <h2 class="section-h">카테고리별 (최근 스냅샷)</h2>
        <p class="breakdown">{{ breakdownLine(rowsDesc[0].byCategory) }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-xl) var(--space-base) var(--space-section);
}

.container {
  max-width: var(--content-max);
  margin: 0 auto;
}

.page-title {
  margin: 0 0 var(--space-xs);
  font-size: 32px;
  font-weight: 400;
  letter-spacing: -0.02em;
  color: var(--color-ink);
}

.page-lead {
  margin: 0 0 var(--space-xl);
  color: var(--color-muted);
  max-width: 60ch;
}

.banner-error {
  padding: var(--space-sm) var(--space-base);
  background: #fff5f5;
  color: var(--color-semantic-down);
  border-radius: var(--rounded-md);
  margin-bottom: var(--space-lg);
}

.card {
  background: var(--color-surface-soft);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
  margin-bottom: var(--space-xxl);
}

.card-h {
  margin: 0 0 var(--space-xs);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-ink);
}

.hint {
  margin: 0 0 var(--space-base);
  font-size: 14px;
  color: var(--color-muted);
}

.row-form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  align-items: center;
}

.input {
  height: 44px;
  padding: 0 var(--space-base);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  font-size: 16px;
  color: var(--color-ink);
  background: var(--color-canvas);
}

.input:focus {
  outline: none;
  border-width: 2px;
  border-color: var(--color-primary);
}

.btn-primary {
  height: 44px;
  padding: 0 var(--space-md);
  border: none;
  border-radius: var(--rounded-pill);
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-active);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.section-h {
  margin: 0 0 var(--space-base);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-ink);
}

.muted {
  color: var(--color-muted);
}

.table-wrap {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xl);
  overflow: hidden;
}

.head-row,
.data-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr auto;
  gap: var(--space-base);
  align-items: center;
  padding: var(--space-sm) var(--space-lg);
}

.head-row {
  background: var(--color-surface-strong);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
}

.data-row {
  border-top: 1px solid var(--color-hairline);
  background: var(--color-canvas);
}

.date,
.total {
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
  background: none;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.btn-text.danger {
  color: var(--color-semantic-down);
}

.detail-section {
  margin-top: var(--space-xxl);
}

.breakdown {
  font-size: 14px;
  color: var(--color-body);
  line-height: 1.6;
}

@media (max-width: 720px) {
  .head-row {
    display: none;
  }
  .data-row {
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
  }
  .data-row .date {
    grid-column: 1 / -1;
  }
}
</style>
