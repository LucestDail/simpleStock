<script setup>
import { ref } from 'vue';
import { useMarketHeatmap } from '../../composables/useMarketHeatmap';
import { useWorkspace } from '../../composables/useWorkspace';
import { useUi } from '../../composables/useUi';
import { heatmapStyleFromChangePct, formatChangePct } from '../../lib/heatmapColor';

const emit = defineEmits(['select-holding']);

const { marketGroups, hasHeatmap, marketRefreshLabel, busyState, refreshMarket } = useMarketHeatmap();
const { openDrawer, selectHolding } = useWorkspace();
const { notify } = useUi();
const refreshBusy = ref(false);

async function handleRefresh() {
  refreshBusy.value = true;
  try {
    await refreshMarket();
    notify({ tone: 'success', message: '시세를 갱신했습니다.' });
  } catch (error) {
    notify({ tone: 'error', message: error.message || '시세 갱신 실패' });
  } finally {
    refreshBusy.value = false;
  }
}

function openHolding(cell) {
  selectHolding(cell.holdingId);
  openDrawer('assetDetail', cell.holdingId, cell.label);
  emit('select-holding', cell);
}

function cellStyle(cell) {
  return {
    ...heatmapStyleFromChangePct(cell.changePct),
    flexGrow: cell.flexGrow,
    flexBasis: `${Math.max(28, Math.min(55, cell.weightPct || 25))}%`,
  };
}
</script>

<template>
  <section v-if="hasHeatmap" class="market-heatmap" aria-label="보유 종목 시장별 히트맵">
    <div class="market-heatmap__head">
      <div>
        <strong class="market-heatmap__title">시장 히트맵</strong>
        <span class="market-heatmap__hint">보유 비중·당일 등락률</span>
      </div>
      <button
        type="button"
        class="market-heatmap__refresh"
        :disabled="refreshBusy || busyState.refreshMarket"
        @click="handleRefresh"
      >
        {{ refreshBusy ? '갱신 중…' : marketRefreshLabel ? `${marketRefreshLabel} 갱신` : '시세 갱신' }}
      </button>
    </div>

    <div v-for="group in marketGroups" :key="group.id" class="market-group">
      <header class="market-group__head">
        <div class="market-group__label">
          <span class="market-group__name">{{ group.label }}</span>
          <span class="market-group__session" :class="`market-group__session--${group.sessionTone}`">
            {{ group.sessionLabel }}
          </span>
        </div>
        <span
          v-if="group.avgChange != null"
          class="market-group__avg mono-num"
          :class="group.avgChange >= 0 ? 'up' : 'down'"
        >
          평균 {{ formatChangePct(group.avgChange) }}
        </span>
      </header>

      <div class="market-group__grid">
        <button
          v-for="cell in group.cells"
          :key="cell.id"
          type="button"
          class="heatmap-cell"
          :style="cellStyle(cell)"
          :title="`${cell.label} ${cell.sub ? `(${cell.sub})` : ''} · ${formatChangePct(cell.changePct)}`"
          @click="openHolding(cell)"
        >
          <span class="heatmap-cell__label">{{ cell.label }}</span>
          <span v-if="cell.sub" class="heatmap-cell__sub">{{ cell.sub }}</span>
          <strong class="heatmap-cell__pct mono-num">{{ formatChangePct(cell.changePct) }}</strong>
          <span v-if="cell.priceLabel" class="heatmap-cell__price mono-num">{{ cell.priceLabel }}</span>
          <span v-if="cell.weightPct" class="heatmap-cell__weight mono-num">{{ cell.weightPct }}%</span>
        </button>
      </div>
    </div>

    <div class="market-heatmap__legend" aria-hidden="true">
      <span class="legend-item legend-item--down">하락</span>
      <span class="legend-item legend-item--flat">보합</span>
      <span class="legend-item legend-item--up">상승</span>
    </div>
  </section>
</template>

<style scoped>
.market-heatmap {
  display: grid;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
}

.market-heatmap__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}

.market-heatmap__title {
  display: block;
  color: var(--color-ink);
  font-size: 14px;
  font-weight: 600;
}

.market-heatmap__hint {
  display: block;
  color: var(--color-muted);
  font-size: 12px;
  margin-top: 2px;
}

.market-heatmap__refresh {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  color: var(--color-body);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}

.market-heatmap__refresh:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-ink);
}

.market-heatmap__refresh:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.market-group {
  display: grid;
  gap: 6px;
}

.market-group__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
}

.market-group__label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.market-group__name {
  color: var(--color-body-strong);
  font-size: 13px;
  font-weight: 600;
}

.market-group__session {
  padding: 1px 6px;
  border-radius: var(--rounded-pill);
  font-size: 10px;
  font-weight: 600;
}

.market-group__session--open {
  background: rgba(74, 158, 120, 0.18);
  color: var(--color-semantic-up);
}

.market-group__session--pre {
  background: rgba(201, 162, 74, 0.15);
  color: var(--color-accent-yellow);
}

.market-group__session--closed {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-muted);
}

.market-group__avg {
  font-size: 12px;
}

.market-group__avg.up {
  color: var(--color-semantic-up);
}

.market-group__avg.down {
  color: var(--color-semantic-down);
}

.market-group__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 72px;
}

.heatmap-cell {
  min-width: 68px;
  min-height: 64px;
  padding: 6px 7px;
  border: 1px solid transparent;
  border-radius: var(--rounded-md);
  display: grid;
  align-content: start;
  gap: 2px;
  text-align: left;
  cursor: pointer;
  transition: transform 0.12s ease, filter 0.12s ease;
}

.heatmap-cell:hover {
  transform: translateY(-1px);
  filter: brightness(1.06);
}

.heatmap-cell__label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.heatmap-cell__sub {
  font-size: 10px;
  opacity: 0.75;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.heatmap-cell__pct {
  font-size: 13px;
  font-weight: 600;
  margin-top: 2px;
}

.heatmap-cell__price {
  font-size: 11px;
  opacity: 0.85;
}

.heatmap-cell__weight {
  font-size: 10px;
  opacity: 0.65;
}

.market-heatmap__legend {
  display: flex;
  justify-content: center;
  gap: 10px;
  padding-top: 2px;
}

.legend-item {
  font-size: 10px;
  color: var(--color-muted);
  padding-left: 14px;
  position: relative;
}

.legend-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  transform: translateY(-50%);
}

.legend-item--down::before {
  background: rgba(184, 90, 98, 0.45);
}

.legend-item--flat::before {
  background: var(--heatmap-neutral-bg);
  border: 1px solid var(--color-hairline);
}

.legend-item--up::before {
  background: rgba(74, 158, 120, 0.45);
}
</style>
