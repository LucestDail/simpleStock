<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio, formatKRW, formatUSD } from '../../composables/usePortfolio';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { total, categoryShares, dayOverDay, lastSnapshot, busyState, currentUsdKrwRate, holdings } = usePortfolio();
const {
  selectedCategoryId,
  selectCategory,
  clearCategory,
  selectHolding,
  applyWorkspacePatch,
  openDrawer,
} = useWorkspace();

const summaryCards = computed(() => [
  {
    id: 'total',
    label: '총 자산',
    value: formatKRW(total.value),
    note: currentUsdKrwRate.value
      ? `USD/KRW ${Number(currentUsdKrwRate.value).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} 기준 원화 환산`
      : '원화 자산 기준 합산',
    visible: true,
  },
  {
    id: 'lastSnapshot',
    label: '최근 스냅샷',
    value: lastSnapshot.value ? formatKRW(lastSnapshot.value.total) : '없음',
    note: '',
    visible: Boolean(lastSnapshot.value),
  },
  {
    id: 'delta',
    label: '직전 대비',
    value: dayOverDay.value
      ? `${dayOverDay.value.delta >= 0 ? '+' : ''}${formatKRW(dayOverDay.value.delta)}`
      : '—',
    note: '',
    visible: Boolean(dayOverDay.value),
  },
]);
const visibleSummaryCards = computed(() => summaryCards.value.filter((item) => item.visible !== false));
const visibleCategoryShares = computed(() => categoryShares.value.filter((item) => Number(item.amount) > 0));
const filteredHoldings = computed(() =>
  selectedCategoryId.value
    ? holdings.value.filter((item) => item.category === selectedCategoryId.value)
    : holdings.value
);
const selectedCategoryLabel = computed(
  () => visibleCategoryShares.value.find((item) => item.id === selectedCategoryId.value)?.label || '전체 자산'
);

function inspectCategory(categoryId) {
  if (selectedCategoryId.value === categoryId) {
    clearCategory();
    return;
  }
  selectCategory(categoryId);
}

function isUsdHolding(holding) {
  return String(holding?.details?.currency || '').toUpperCase() === 'USD';
}

function getConvertedKrwAmount(holding) {
  const details = holding.details || {};
  const nativeAmount = Number(details.nativeAmount);
  const rate = Number(currentUsdKrwRate.value);
  if (isUsdHolding(holding) && Number.isFinite(nativeAmount) && Number.isFinite(rate) && rate > 0) {
    return Math.round(nativeAmount * rate);
  }
  return Number(holding.amount) || 0;
}

function getDisplayAmount(holding) {
  const details = holding.details || {};
  const nativeAmount = Number(details.nativeAmount);
  if (isUsdHolding(holding) && Number.isFinite(nativeAmount)) {
    return formatUSD(nativeAmount);
  }
  return formatKRW(holding.amount);
}

function getDisplayAmountSecondary(holding) {
  if (!isUsdHolding(holding)) return '';
  return `환산 ${formatKRW(getConvertedKrwAmount(holding))}`;
}

function formatHoldingMeta(holding) {
  const details = holding.details || {};
  return (
    details.summary ||
    [details.account, details.ticker, Number.isFinite(Number(details.quantity)) ? `${details.quantity}주` : '']
      .filter(Boolean)
      .join(' · ')
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

function inspectHolding(holding) {
  selectHolding(holding.id);
  openDrawer('assetDetail', holding.id, holding.name);
  applyWorkspacePatch(
    {
      focusMode: 'balanced',
      highlightPanelIds: ['overview'],
      panelPatches: [],
      openDrawer: { type: 'assetDetail', entityId: holding.id, title: holding.name },
      reason: '선택한 자산 상세를 열었습니다.',
    },
    'local-action'
  );
}
</script>

<template>
  <PanelShell
    title="포트폴리오 개요 / 자산 현황"
    subtitle="overview"
    :span="panel.span"
    :highlighted="panel.highlighted"
    :loading="busyState.fetchPortfolio"
  >
    <div class="summary-grid">
      <article v-for="item in visibleSummaryCards" :key="item.id" class="summary-card">
        <span class="summary-label">{{ item.label }}</span>
        <strong class="summary-value mono-num">{{ item.value }}</strong>
        <small v-if="item.note" class="summary-note">{{ item.note }}</small>
      </article>
    </div>

    <div v-if="visibleCategoryShares.length" class="share-list">
      <button
        v-for="item in visibleCategoryShares"
        :key="item.id"
        type="button"
        class="share-item"
        :class="{ 'share-item--active': selectedCategoryId === item.id }"
        @click="inspectCategory(item.id)"
      >
        <div class="share-head">
          <strong>{{ item.label }}</strong>
          <span class="mono-num">{{ item.pct }}%</span>
        </div>
        <span class="mono-num share-amount">{{ formatKRW(item.amount) }}</span>
        <div class="share-bar">
          <div class="share-bar__fill" :style="{ width: `${Math.min(100, item.pct)}%` }" />
        </div>
      </button>
    </div>
    <div v-else class="empty-box">표시할 카테고리 요약이 아직 없습니다.</div>

    <div class="section-head">
      <strong>{{ selectedCategoryLabel }}</strong>
      <span>
        {{ selectedCategoryId ? `${filteredHoldings.length}개 항목이 선택된 카테고리에 포함됩니다.` : `전체 ${filteredHoldings.length}개 자산을 현재 포트폴리오 기준으로 보여줍니다.` }}
      </span>
    </div>

    <div v-if="!filteredHoldings.length" class="empty-box">
      {{ selectedCategoryId ? '선택한 카테고리에 등록된 자산이 없습니다.' : '등록된 자산이 없습니다.' }}
    </div>
    <div v-else class="asset-list">
      <article v-for="holding in filteredHoldings" :key="holding.id" class="holding-row">
        <button type="button" class="holding-main" @click="inspectHolding(holding)">
          <strong>{{ holding.name }}</strong>
          <span>{{ formatHoldingMeta(holding) || '상세 정보 없음' }}</span>
        </button>
        <div class="holding-value">
          <strong class="mono-num">{{ getDisplayAmount(holding) }}</strong>
          <span v-if="getDisplayAmountSecondary(holding)" class="holding-secondary mono-num">{{ getDisplayAmountSecondary(holding) }}</span>
          <span v-if="formatQuotePrice(holding)" class="quote-line">
            <em class="mono-num">{{ formatQuotePrice(holding) }}</em>
            <em v-if="formatQuoteChange(holding)" class="quote-chip" :class="quoteTone(holding)">
              {{ formatQuoteChange(holding) }}
            </em>
            <em v-if="formatUpdatedAt(holding)" class="quote-time mono-num">{{ formatUpdatedAt(holding) }}</em>
          </span>
        </div>
      </article>
    </div>
  </PanelShell>
</template>

<style scoped>
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 5px;
}

.summary-card {
  padding: 6px 8px;
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
  display: grid;
  gap: 2px;
}

.summary-label {
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-value {
  color: var(--color-ink);
  font-size: 13px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-note {
  color: var(--color-body);
  font-size: 10px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-list {
  display: grid;
  gap: 5px;
}

.empty-box {
  border: 1px dashed var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 8px;
  color: var(--color-muted);
  font-size: 12px;
}

.share-item {
  border: 1px solid var(--color-hairline);
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--rounded-lg);
  padding: 6px 8px;
  text-align: left;
  cursor: pointer;
  display: grid;
  gap: 3px;
}

.share-item:hover {
  border-color: rgba(0, 82, 255, 0.35);
}

.share-item--active {
  border-color: rgba(110, 123, 255, 0.28);
  background: rgba(110, 123, 255, 0.08);
}

.share-head {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  align-items: center;
  color: var(--color-ink);
  font-size: 12px;
  min-width: 0;
}

.share-head strong,
.share-head span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-amount {
  color: var(--color-body);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-bar {
  height: 4px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  overflow: hidden;
}

.share-bar__fill {
  height: 100%;
  background: var(--color-primary);
}

.section-head {
  display: grid;
  gap: 3px;
}

.section-head strong {
  color: var(--color-ink);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-head span {
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-list {
  display: grid;
  gap: 5px;
}

.holding-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
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
  font-size: 13px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.holding-main span {
  color: var(--color-muted);
  font-size: 11px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.holding-value {
  display: grid;
  justify-items: end;
  gap: 2px;
  min-width: 92px;
}

.holding-value strong {
  font-size: 12px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.holding-secondary {
  color: var(--color-muted);
  font-size: 10px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quote-line {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 3px;
  color: var(--color-muted);
  font-size: 11px;
  text-align: right;
  min-width: 0;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 720px) {
  .holding-row {
    grid-template-columns: 1fr;
  }

  .holding-value {
    justify-items: start;
  }

  .quote-line {
    justify-content: flex-start;
    text-align: left;
  }
}

</style>
