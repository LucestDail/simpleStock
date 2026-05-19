<script setup>
import { computed, ref } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio, formatKRW, formatUSD } from '../../composables/usePortfolio';
import { useUi } from '../../composables/useUi';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const {
  total,
  categoryShares,
  dayOverDay,
  busyState,
  currentUsdKrwRate,
  holdings,
  sortedSnapshots,
  addSnapshot,
  system,
} = usePortfolio();
const { notify } = useUi();
const {
  selectedCategoryId,
  selectCategory,
  clearCategory,
  selectHolding,
  applyWorkspacePatch,
  openDrawer,
  recordActivity,
} = useWorkspace();
const snapshotBusy = ref(false);

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
    id: 'delta',
    label: '전일 대비',
    value: dayOverDay.value
      ? `${dayOverDay.value.delta >= 0 ? '+' : ''}${formatKRW(dayOverDay.value.delta)}`
      : '—',
    note: dayOverDay.value?.pct != null ? `${dayOverDay.value.pct >= 0 ? '+' : ''}${dayOverDay.value.pct}%` : '',
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
const trendSnapshots = computed(() =>
  [...sortedSnapshots.value]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-14)
);
const trendDeltas = computed(() => {
  const snaps = trendSnapshots.value;
  const deltas = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = Number(snaps[i - 1].total) || 0;
    const curr = Number(snaps[i].total) || 0;
    const delta = curr - prev;
    const pct = prev ? Math.round(((curr - prev) / prev) * 1000) / 10 : null;
    deltas.push({ date: snaps[i].date, delta, pct });
  }
  return deltas;
});
const trendDeltaMax = computed(() => {
  const absValues = trendDeltas.value.map((d) => Math.abs(d.delta));
  return Math.max(...absValues, 1);
});
const hasTodaySnapshot = computed(() => {
  const today = system.value.todayLocalDate;
  return Boolean(today && sortedSnapshots.value.some((item) => item.date === today));
});

async function saveTodaySnapshot() {
  snapshotBusy.value = true;
  try {
    await addSnapshot(system.value.todayLocalDate || undefined);
    notify({ tone: 'success', message: '오늘 스냅샷을 저장했습니다.' });
    recordActivity({
      type: 'portfolio',
      title: '스냅샷 저장',
      description: system.value.todayLocalDate || '오늘',
    });
  } catch (error) {
    notify({ tone: 'error', message: error.message || '스냅샷 저장 실패' });
  } finally {
    snapshotBusy.value = false;
  }
}

function formatSnapshotDate(date) {
  if (!date) return '';
  const [, month, day] = String(date).split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : date;
}


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
    title="포트폴리오 현황"
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

    <section v-if="trendDeltas.length" class="trend-section">
      <div class="trend-head">
        <strong>일별 증감</strong>
        <button
          type="button"
          class="btn-snapshot"
          :disabled="snapshotBusy || busyState.addSnapshot || hasTodaySnapshot"
          @click="saveTodaySnapshot"
        >
          {{ hasTodaySnapshot ? '오늘 저장됨' : snapshotBusy ? '저장 중…' : '기록' }}
        </button>
      </div>
      <div class="trend-chart" role="img" aria-label="일별 증감 막대 차트">
        <div
          v-for="item in trendDeltas"
          :key="item.date"
          class="trend-bar"
          :class="item.delta >= 0 ? 'is-up' : 'is-down'"
        >
          <div class="trend-bar__upper">
            <div
              v-if="item.delta >= 0"
              class="trend-bar__fill trend-bar__fill--up"
              :style="{ height: `${Math.max(6, Math.round((item.delta / trendDeltaMax) * 100))}%` }"
              :title="`${item.date}: +${formatKRW(item.delta)}`"
            />
          </div>
          <div class="trend-bar__lower">
            <div
              v-if="item.delta < 0"
              class="trend-bar__fill trend-bar__fill--down"
              :style="{ height: `${Math.max(6, Math.round((Math.abs(item.delta) / trendDeltaMax) * 100))}%` }"
              :title="`${item.date}: ${formatKRW(item.delta)}`"
            />
          </div>
          <span class="trend-bar__label mono-num">{{ formatSnapshotDate(item.date) }}</span>
          <span
            v-if="item.pct != null"
            class="trend-bar__pct mono-num"
            :class="item.delta >= 0 ? 'up' : 'down'"
          >
            {{ item.pct >= 0 ? '+' : '' }}{{ item.pct }}%
          </span>
        </div>
      </div>
    </section>

    <div class="section-head">
      <strong>{{ selectedCategoryLabel }}</strong>
      <span>
        {{ selectedCategoryId ? `${filteredHoldings.length}개 항목이 선택된 카테고리에 포함됩니다.` : `전체 ${filteredHoldings.length}개 자산을 현재 포트폴리오 기준으로 보여줍니다.` }}
      </span>
    </div>

    <div v-if="!filteredHoldings.length" class="empty-box">
      {{ selectedCategoryId ? '이 카테고리에 등록된 자산이 없습니다. Quant Manager 대화로 추가하세요.' : '등록된 자산이 없습니다. Quant Manager 대화로 말해 주세요. 예: 「KB주식 10주 추가」' }}
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
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-value {
  color: var(--color-ink);
  font-size: 15px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-note {
  color: var(--color-body);
  font-size: 11px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trend-section {
  display: grid;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: rgba(255, 255, 255, 0.02);
}

.trend-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.trend-head strong {
  color: var(--color-ink);
  font-size: 12px;
}

.btn-snapshot {
  margin-left: auto;
  height: 22px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}

.btn-snapshot:disabled {
  background: var(--color-surface-strong);
  color: var(--color-muted);
  cursor: not-allowed;
}

.trend-chart {
  display: flex;
  align-items: stretch;
  gap: 3px;
  height: 80px;
  overflow-x: auto;
}

.trend-bar {
  flex: 1 0 28px;
  max-width: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
}

.trend-bar__upper,
.trend-bar__lower {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.trend-bar__lower {
  align-items: flex-start;
  border-top: 1px solid var(--color-hairline);
}

.trend-bar__fill {
  width: 60%;
  min-height: 4px;
  border-radius: var(--rounded-xs);
}

.trend-bar__fill--up {
  background: var(--color-semantic-up);
  opacity: 0.8;
  border-radius: var(--rounded-xs) var(--rounded-xs) 0 0;
}

.trend-bar__fill--down {
  background: var(--color-semantic-down);
  opacity: 0.8;
  border-radius: 0 0 var(--rounded-xs) var(--rounded-xs);
}

.trend-bar__label {
  font-size: 8px;
  color: var(--color-muted);
  position: absolute;
  bottom: -14px;
}

.trend-bar__pct {
  font-size: 8px;
  position: absolute;
  top: -12px;
}

.trend-bar__pct.up {
  color: var(--color-semantic-up);
}

.trend-bar__pct.down {
  color: var(--color-semantic-down);
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
  font-size: 13px;
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
  font-size: 13px;
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
  font-size: 13px;
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
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-head span {
  color: var(--color-muted);
  font-size: 12px;
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
  font-size: 15px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.holding-main span {
  color: var(--color-muted);
  font-size: 12px;
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
  font-size: 13px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.holding-secondary {
  color: var(--color-muted);
  font-size: 11px;
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
  font-size: 12px;
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
