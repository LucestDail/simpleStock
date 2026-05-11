<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useUi } from '../../composables/useUi';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { system, refreshMarket, busyState } = usePortfolio();
const { notify } = useUi();
const { openDrawer, recordActivity } = useWorkspace();
const market = computed(() => system.value.market || {});

const marketSummary = computed(() => ({
  tracked: (market.value.trackedTickers || []).length,
  usdKrw: market.value.fx?.USDKRW?.rate,
  session: market.value.sessions?.us?.state || 'closed',
  lastRefreshAt: market.value.lastSuccessAt || market.value.lastRefreshAt,
}));

function formatUsdKrw(rate) {
  return Number.isFinite(Number(rate)) ? Number(rate).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '-';
}

function formatTime(value) {
  if (!value) return '대기';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

async function handleRefreshMarket() {
  try {
    await refreshMarket();
    notify({
      tone: 'success',
      message: '미국 주식 시세와 USD/KRW 환율을 갱신했습니다.',
    });
    recordActivity({
      type: 'market',
      title: '시장 시세 수동 갱신',
      description: `${marketSummary.value.tracked}개 티커를 다시 확인했습니다.`,
      tone: 'info',
    });
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '시세 갱신 실패',
    });
  }
}
</script>

<template>
  <PanelShell
    title="시스템"
    subtitle="system"
    :span="panel.span"
    :highlighted="panel.highlighted"
  >
    <template #actions>
      <button type="button" class="btn-secondary" :disabled="busyState.refreshMarket" @click="handleRefreshMarket">
        {{ busyState.refreshMarket ? '갱신 중…' : '시세' }}
      </button>
      <button type="button" class="btn-secondary" @click="openDrawer('settings', null, '설정')">
        설정
      </button>
    </template>

    <ul class="meta-list">
      <li><span>시간대</span><strong>{{ system.timezone }}</strong></li>
      <li><span>Gemini</span><strong>{{ system.aiConfigured ? '활성' : '비활성' }}</strong></li>
      <li><span>모델</span><code>{{ system.ai?.model || '-' }}</code></li>
      <li><span>Thinking</span><code>{{ system.ai?.thinkingLevel || '-' }}</code></li>
      <li><span>브리핑</span><code>{{ system.ai?.dailyCron ? '예약됨' : '미설정' }}</code></li>
      <li><span>미국장</span><code>{{ marketSummary.session }}</code></li>
      <li><span>추적 티커</span><strong>{{ marketSummary.tracked }}개</strong></li>
      <li><span>USD/KRW</span><code>{{ formatUsdKrw(marketSummary.usdKrw) }}</code></li>
      <li><span>시세 갱신</span><strong>{{ formatTime(marketSummary.lastRefreshAt) }}</strong></li>
    </ul>
    <p v-if="market.lastError" class="market-error">{{ market.lastError }}</p>
  </PanelShell>
</template>

<style scoped>
.btn-secondary {
  height: 24px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary:disabled {
  opacity: 0.6;
  cursor: wait;
}

.meta-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 4px 8px;
  min-height: 0;
}

.meta-list li {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  align-items: start;
  gap: 4px 6px;
  border-bottom: 1px solid var(--color-hairline-soft);
  padding-bottom: 2px;
  color: var(--color-body);
  font-size: 12px;
}

.meta-list strong {
  color: var(--color-ink);
  font-size: 13px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-list code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-surface-soft);
  border-radius: var(--rounded-xs);
  padding: 1px 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-error {
  margin: 0;
  color: var(--color-accent-yellow);
  font-size: 12px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
