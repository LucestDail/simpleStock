<script setup>
import { computed, ref, watch } from 'vue';
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

const { holdings, saveHoldings, busyState } = usePortfolio();
const { confirmAction, notify } = useUi();
const {
  applyWorkspacePatch,
  recordActivity,
  selectHolding,
  selectedCategoryId,
  selectCategory,
  clearCategory,
  openDrawer,
} = useWorkspace();

const form = ref({
  name: '',
  category: 'deposit',
  amount: '',
});
const editingId = ref(null);
const filteredHoldings = computed(() =>
  selectedCategoryId.value
    ? holdings.value.filter((item) => item.category === selectedCategoryId.value)
    : holdings.value
);
const selectedCategoryLabel = computed(
  () => CATEGORIES.find((item) => item.id === selectedCategoryId.value)?.label || '전체 자산'
);

function formatHoldingMeta(holding) {
  const details = holding.details || {};
  return (
    details.summary ||
    [
      details.account,
      details.ticker,
      Number.isFinite(Number(details.quantity)) ? `${details.quantity}주` : '',
    ]
      .filter(Boolean)
      .join(' · ') ||
    CATEGORIES.find((item) => item.id === holding.category)?.label
  );
}

function formatQuotePrice(holding) {
  const details = holding.details || {};
  if (!Number.isFinite(Number(details.lastQuote || details.currentPrice))) return '';
  const price = Number(details.lastQuote || details.currentPrice);
  return details.currency === 'USD' ? `$${price.toFixed(2)}` : `${Math.round(price).toLocaleString('ko-KR')}원`;
}

function formatQuoteChange(holding) {
  const details = holding.details || {};
  if (!Number.isFinite(Number(details.priceChangePct))) return '';
  const pct = Number(details.priceChangePct);
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function quoteTone(holding) {
  const change = Number(holding?.details?.priceChangePct);
  if (!Number.isFinite(change)) return '';
  return change >= 0 ? 'up' : 'down';
}

function formatUpdatedAt(holding) {
  const value = holding?.details?.lastQuoteAt;
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

watch(
  selectedCategoryId,
  (categoryId) => {
    if (!editingId.value && categoryId) {
      form.value.category = categoryId;
    }
  },
  { immediate: true }
);

function resetForm() {
  form.value = {
    name: '',
    category: selectedCategoryId.value || 'deposit',
    amount: '',
  };
  editingId.value = null;
}

function editHolding(holding) {
  editingId.value = holding.id;
  selectCategory(holding.category);
  form.value = {
    name: holding.name,
    category: holding.category,
    amount: String(holding.amount),
  };
  selectHolding(holding.id);
  openDrawer('assetDetail', holding.id, holding.name);
  applyWorkspacePatch(
    {
      focusMode: 'balanced',
      highlightPanelIds: ['holdings', 'overview'],
      panelPatches: [
        { id: 'holdings', column: 'left', span: 'xl', priority: 10, visible: true },
        { id: 'overview', column: 'left', span: 'lg', priority: 20, visible: true },
      ],
      openDrawer: { type: 'assetDetail', entityId: holding.id, title: holding.name },
      reason: '선택한 자산의 편집 흐름을 강조합니다.',
    },
    'local-action'
  );
}

async function submit() {
  const nextItem = {
    id: editingId.value || undefined,
    name: form.value.name.trim() || '이름 없음',
    category: form.value.category,
    amount: Math.max(0, Math.round(Number(form.value.amount) || 0)),
  };

  const next = editingId.value
    ? holdings.value.map((item) =>
        item.id === editingId.value ? { ...item, ...nextItem, id: item.id } : item
      )
    : [...holdings.value, nextItem];

  try {
    await saveHoldings(next);
    notify({
      tone: 'success',
      message: editingId.value ? '자산을 수정했습니다.' : '자산을 추가했습니다.',
    });
    recordActivity({
      type: 'portfolio',
      title: editingId.value ? '자산 수정' : '자산 추가',
      description: `${nextItem.name} · ${formatKRW(nextItem.amount)}`,
      entityId: editingId.value || nextItem.name,
    });
    applyWorkspacePatch(
      {
        focusMode: 'balanced',
        highlightPanelIds: ['holdings', 'overview', 'activity'],
        panelPatches: [],
        openDrawer: { type: 'assetDetail', entityId: editingId.value || '', title: nextItem.name },
        reason: '자산 변경이 즉시 반영되었습니다.',
      },
      'local-action'
    );
    resetForm();
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '자산 저장에 실패했습니다.',
    });
  }
}

async function removeHolding(target) {
  const ok = await confirmAction({
    title: '자산 삭제',
    message: `${target.name} 항목을 삭제할까요?`,
    confirmLabel: '삭제',
    cancelLabel: '취소',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await saveHoldings(holdings.value.filter((item) => item.id !== target.id));
    notify({
      tone: 'success',
      message: '자산을 삭제했습니다.',
    });
    recordActivity({
      type: 'portfolio',
      title: '자산 삭제',
      description: target.name,
      entityId: target.id,
      tone: 'warning',
    });
    applyWorkspacePatch(
      {
        focusMode: 'balanced',
        highlightPanelIds: ['holdings', 'activity'],
        panelPatches: [],
        openDrawer: { type: 'assetDetail', entityId: target.category, title: '카테고리 상세' },
        reason: '삭제 후 관련 자산 목록을 다시 확인하기 좋게 조정했습니다.',
      },
      'local-action'
    );
    if (editingId.value === target.id) {
      resetForm();
    }
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '자산 삭제에 실패했습니다.',
    });
  }
}

function inspectHolding(target) {
  selectHolding(target.id);
  selectCategory(target.category);
  openDrawer('assetDetail', target.id, target.name);
  applyWorkspacePatch(
    {
      focusMode: 'balanced',
      highlightPanelIds: ['holdings', 'overview'],
      panelPatches: [],
      openDrawer: { type: 'assetDetail', entityId: target.id, title: target.name },
      reason: '선택한 자산 상세를 열었습니다.',
    },
    'local-action'
  );
}
</script>

<template>
  <PanelShell
    title="자산 현황 / 입력"
    subtitle="holdings"
    :span="panel.span"
    :highlighted="panel.highlighted"
    :loading="busyState.fetchPortfolio || busyState.saveHoldings"
  >
    <div class="category-strip">
      <button
        type="button"
        class="chip"
        :class="{ active: !selectedCategoryId }"
        @click="clearCategory()"
      >
        전체
      </button>
      <button
        v-for="category in CATEGORIES"
        :key="category.id"
        type="button"
        class="chip"
        :class="{ active: selectedCategoryId === category.id }"
        @click="selectCategory(category.id)"
      >
        {{ category.label }}
      </button>
    </div>

    <div class="section-head">
      <strong>{{ selectedCategoryLabel }}</strong>
      <span>
        {{ selectedCategoryId ? '포트폴리오 개요에서 선택한 카테고리 기준으로 입력과 목록을 보여줍니다.' : '카테고리를 선택하면 해당 자산만 집중해서 볼 수 있습니다.' }}
      </span>
    </div>

    <form class="form-grid" @submit.prevent="submit">
      <input v-model="form.name" class="input" type="text" maxlength="200" placeholder="자산 이름" />
      <select v-model="form.category" class="input">
        <option v-for="category in CATEGORIES" :key="category.id" :value="category.id">
          {{ category.label }}
        </option>
      </select>
      <input
        v-model="form.amount"
        class="input mono-num"
        type="number"
        min="0"
        step="1"
        placeholder="평가 금액"
      />
      <div class="actions">
        <button type="submit" class="btn-primary" :disabled="busyState.saveHoldings">
          {{ editingId ? '저장' : '추가' }}
        </button>
        <button v-if="editingId" type="button" class="btn-secondary" @click="resetForm">취소</button>
      </div>
    </form>

    <div v-if="!filteredHoldings.length" class="empty-box">
      {{ selectedCategoryId ? '선택한 카테고리에 등록된 자산이 없습니다.' : '등록된 자산이 없습니다.' }}
    </div>
    <div v-else class="holding-list">
      <article v-for="holding in filteredHoldings" :key="holding.id" class="holding-row">
        <button type="button" class="holding-main" @click="inspectHolding(holding)">
          <strong>{{ holding.name }}</strong>
          <span>{{ formatHoldingMeta(holding) }}</span>
        </button>
        <div class="holding-value">
          <strong class="mono-num">{{ formatKRW(holding.amount) }}</strong>
          <span v-if="formatQuotePrice(holding)" class="quote-line">
            <em class="mono-num">{{ formatQuotePrice(holding) }}</em>
            <em v-if="formatQuoteChange(holding)" class="quote-chip" :class="quoteTone(holding)">
              {{ formatQuoteChange(holding) }}
            </em>
            <em v-if="formatUpdatedAt(holding)" class="quote-time mono-num">{{ formatUpdatedAt(holding) }}</em>
          </span>
        </div>
        <div class="row-actions">
          <button type="button" class="btn-text" @click="editHolding(holding)">수정</button>
          <button type="button" class="btn-text danger" @click="removeHolding(holding)">삭제</button>
        </div>
      </article>
    </div>
  </PanelShell>
</template>

<style scoped>
.category-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  height: 22px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.02);
  color: var(--color-muted);
  font-size: 9px;
  font-weight: 700;
  cursor: pointer;
}

.chip.active {
  border-color: rgba(110, 123, 255, 0.32);
  background: rgba(110, 123, 255, 0.1);
  color: var(--color-ink);
}

.section-head {
  display: grid;
  gap: 3px;
}

.section-head strong {
  color: var(--color-ink);
  font-size: 11px;
}

.section-head span {
  color: var(--color-muted);
  font-size: 9px;
  line-height: 1.25;
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) 84px minmax(0, 1fr) minmax(64px, auto);
  gap: 5px;
  align-items: stretch;
}

.input {
  height: 26px;
  width: 100%;
  min-width: 0;
  padding: 0 7px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.02);
  color: var(--color-ink);
  font-size: 10px;
}

.input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(0, 82, 255, 0.08);
}

.actions {
  display: flex;
  gap: 4px;
  min-width: 64px;
  justify-content: flex-end;
}

.btn-primary,
.btn-secondary {
  height: 26px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  min-width: 56px;
}

.btn-primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.btn-secondary {
  background: var(--color-surface-strong);
  color: var(--color-ink);
}

.btn-primary:disabled {
  background: var(--color-primary-disabled);
  cursor: not-allowed;
}

.empty-box {
  border: 1px dashed var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 8px;
  color: var(--color-muted);
  font-size: 10px;
}

.holding-list {
  display: grid;
  gap: 5px;
  min-height: 0;
  overflow: auto;
}

.holding-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
  align-items: center;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.02);
}

.holding-main {
  border: none;
  background: transparent;
  text-align: left;
  padding: 0;
  cursor: pointer;
  display: grid;
  gap: 2px;
}

.holding-main strong {
  color: var(--color-ink);
  font-size: 11px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.holding-main span {
  color: var(--color-muted);
  font-size: 9px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.holding-value {
  display: grid;
  justify-items: end;
  gap: 2px;
  min-width: 88px;
}

.holding-value strong {
  font-size: 10px;
  line-height: 1.2;
}

.quote-line {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 3px;
  color: var(--color-muted);
  font-size: 9px;
  text-align: right;
}

.quote-line em {
  font-style: normal;
}

.quote-chip {
  padding: 1px 4px;
  border-radius: var(--rounded-pill);
  background: rgba(255, 255, 255, 0.04);
}

.quote-chip.up {
  color: var(--color-semantic-up);
}

.quote-chip.down {
  color: var(--color-semantic-down);
}

.quote-time {
  color: var(--color-muted-soft);
}

.row-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  flex: 0 0 auto;
}

.btn-text {
  border: none;
  background: transparent;
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.btn-text.danger {
  color: var(--color-semantic-down);
}

@media (max-width: 1280px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }

  .holding-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .row-actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }
}

@media (max-width: 720px) {
  .holding-row {
    grid-template-columns: 1fr;
  }

  .form-grid {
    grid-template-columns: minmax(0, 1fr) 88px;
  }

  .form-grid .input:first-child {
    grid-column: 1 / -1;
  }

  .form-grid .actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }

  .actions,
  .row-actions {
    flex-wrap: wrap;
  }

  .holding-value {
    justify-items: start;
  }

  .quote-line {
    justify-content: flex-start;
    text-align: left;
  }
}

@media (max-width: 480px) {
  .form-grid {
    grid-template-columns: 1fr;
  }

  .actions {
    justify-content: stretch;
  }

  .btn-primary,
  .btn-secondary {
    flex: 1 1 auto;
  }
}
</style>
