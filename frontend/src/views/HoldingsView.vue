<script setup>
import { ref, onMounted } from 'vue';
import { usePortfolio, formatKRW, CATEGORIES } from '../composables/usePortfolio';
import { useUi } from '../composables/useUi';

const { holdings, fetchPortfolio, saveHoldings, loading, error } = usePortfolio();
const { confirmAction, notify } = useUi();

const form = ref({
  name: '',
  category: 'deposit',
  amount: '',
});

const editingId = ref(null);
const formCard = ref(null);

onMounted(fetchPortfolio);

function resetForm() {
  form.value = { name: '', category: 'deposit', amount: '' };
  editingId.value = null;
}

function edit(h) {
  editingId.value = h.id;
  form.value = {
    name: h.name,
    category: h.category,
    amount: String(h.amount),
  };
  formCard.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submit() {
  const amount = Math.max(0, Math.round(Number(form.value.amount) || 0));
  const row = {
    id: editingId.value || undefined,
    name: form.value.name.trim() || '이름 없음',
    category: form.value.category,
    amount,
  };
  const next = editingId.value
    ? holdings.value.map((x) => (x.id === editingId.value ? { ...x, ...row, id: x.id } : x))
    : [...holdings.value, row];
  try {
    await saveHoldings(next);
    notify({
      tone: 'success',
      message: editingId.value ? '자산 정보를 수정했습니다.' : '자산 항목을 추가했습니다.',
    });
    resetForm();
  } catch (e) {
    notify({
      tone: 'error',
      message: e.message || '자산 저장에 실패했습니다.',
    });
  }
}

async function remove(target) {
  const ok = await confirmAction({
    title: '자산 삭제',
    message: `${target.name} 항목을 삭제할까요? 이 작업은 즉시 반영됩니다.`,
    confirmLabel: '삭제',
    cancelLabel: '취소',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await saveHoldings(holdings.value.filter((x) => x.id !== target.id));
    if (editingId.value === target.id) resetForm();
    notify({
      tone: 'success',
      message: '자산 항목을 삭제했습니다.',
    });
  } catch (e) {
    notify({
      tone: 'error',
      message: e.message || '자산 삭제에 실패했습니다.',
    });
  }
}
</script>

<template>
  <div class="page">
    <div class="container">
      <h1 class="page-title">자산 입력</h1>
      <p class="page-lead">
        예금·적금·주식·펀드·연금으로 나누어 보유 자산을 등록합니다. 금액은 원화 기준입니다.
      </p>

      <p v-if="error" class="banner-error">{{ error }}</p>

      <section ref="formCard" class="card form-card">
        <h2 class="card-h">{{ editingId ? '자산 수정' : '자산 추가' }}</h2>
        <form class="form" @submit.prevent="submit">
          <label class="field">
            <span class="label">이름</span>
            <input
              v-model="form.name"
              type="text"
              class="input"
              placeholder="예: 국민은행 정기예금"
              maxlength="200"
            />
          </label>
          <label class="field">
            <span class="label">분류</span>
            <select v-model="form.category" class="input">
              <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">
                {{ c.label }}
              </option>
            </select>
          </label>
          <label class="field">
            <span class="label">평가 금액 (원)</span>
            <input
              v-model="form.amount"
              type="number"
              min="0"
              step="1"
              class="input mono-num"
              placeholder="0"
            />
          </label>
          <div class="actions">
            <button type="submit" class="btn-primary" :disabled="loading">
              {{ editingId ? '저장' : '추가' }}
            </button>
            <button
              v-if="editingId"
              type="button"
              class="btn-secondary"
              @click="resetForm"
            >
              취소
            </button>
          </div>
        </form>
      </section>

      <section class="list-section">
        <h2 class="section-h">등록된 자산</h2>
        <p v-if="loading && !holdings.length" class="muted">불러오는 중…</p>
        <p v-else-if="!holdings.length" class="muted">등록된 자산이 없습니다.</p>
        <div v-else class="table-wrap">
          <div
            v-for="h in holdings"
            :key="h.id"
            class="row"
          >
            <div class="row-main">
              <span class="name">{{ h.name }}</span>
              <span class="cat">{{ CATEGORIES.find((c) => c.id === h.category)?.label }}</span>
            </div>
            <span class="mono-num amt">{{ formatKRW(h.amount) }}</span>
            <div class="row-actions">
              <button type="button" class="btn-text" @click="edit(h)">수정</button>
              <button type="button" class="btn-text danger" @click="remove(h)">삭제</button>
            </div>
          </div>
        </div>
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
  max-width: 52ch;
}

.banner-error {
  padding: var(--space-sm) var(--space-base);
  background: #fff5f5;
  color: var(--color-semantic-down);
  border-radius: var(--rounded-md);
  margin-bottom: var(--space-lg);
}

.card {
  background: var(--color-canvas);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
  margin-bottom: var(--space-xxl);
}

.card-h {
  margin: 0 0 var(--space-lg);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-ink);
}

.form {
  display: grid;
  gap: var(--space-lg);
  max-width: 480px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.label {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-ink);
}

.input {
  height: 48px;
  padding: 14px var(--space-base);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  font-size: 16px;
  color: var(--color-ink);
  background: var(--color-canvas);
  font-family: inherit;
}

.input:focus {
  outline: none;
  border-width: 2px;
  border-color: var(--color-primary);
  padding: 13px 15px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
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
  background: var(--color-primary-disabled);
  cursor: not-allowed;
}

.btn-secondary {
  height: 44px;
  padding: 0 var(--space-md);
  border: none;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
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

.row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: var(--space-base);
  align-items: center;
  padding: var(--space-base) var(--space-lg);
  border-bottom: 1px solid var(--color-hairline);
  background: var(--color-canvas);
}

.row:last-child {
  border-bottom: none;
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  font-weight: 600;
  color: var(--color-ink);
}

.cat {
  font-size: 13px;
  color: var(--color-muted);
}

.amt {
  font-size: 16px;
  color: var(--color-ink);
}

.row-actions {
  display: flex;
  gap: var(--space-sm);
}

.btn-text {
  border: none;
  background: none;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-primary);
  cursor: pointer;
  padding: var(--space-xs);
}

.btn-text.danger {
  color: var(--color-semantic-down);
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: 1fr;
  }
  .row-actions {
    justify-content: flex-start;
  }
}
</style>
