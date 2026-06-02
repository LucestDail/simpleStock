<script setup>
import { computed, ref } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useUi } from '../../composables/useUi';
import { useWorkspace } from '../../composables/useWorkspace';
import { useScheduledTasks } from '../../composables/useScheduledTasks';
import { useSystemSettings } from '../../composables/useSystemSettings';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { system, refreshMarket, busyState } = usePortfolio();
const { displayTasks } = useScheduledTasks();
const { saveSettings, saving: savingSettings } = useSystemSettings();
const { notify } = useUi();
const { openDrawer, recordActivity } = useWorkspace();
const market = computed(() => system.value.market || {});

const marketSummary = computed(() => ({
  tracked: (market.value.trackedTickers || []).length,
  usdKrw: market.value.fx?.USDKRW?.rate,
  session: market.value.sessions?.us?.state || 'closed',
  lastRefreshAt: market.value.lastSuccessAt || market.value.lastRefreshAt,
}));
const aiPresets = computed(() => system.value.aiPresets || system.value.ai?.presets || []);
const selectedPresetId = computed(() => system.value.ai?.presetId || system.value.savedSettings?.ai?.presetId || '');
const tokenUsage = computed(() => system.value.tokenUsage?.current || null);
const marketHealth = computed(() => system.value.marketMatchHealth || {});
const marketProviders = computed(() => system.value.marketProviders || system.value.savedSettings?.market || {});

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

async function applyAiPreset(preset) {
  try {
    await saveSettings({ ai: { presetId: preset.id } });
    notify({
      tone: 'success',
      message: `${preset.label} 프리셋을 적용했습니다.`,
    });
  } catch (error) {
    notify({ tone: 'error', message: error.message || '프리셋 적용 실패' });
  }
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

    <section v-if="aiPresets.length" class="preset-section">
      <h3 class="section-title">AI 프리셋</h3>
      <div class="preset-row">
        <button
          v-for="preset in aiPresets"
          :key="preset.id"
          type="button"
          class="preset-chip"
          :class="{ active: selectedPresetId === preset.id }"
          :disabled="savingSettings"
          @click="applyAiPreset(preset)"
        >
          {{ preset.label }}
        </button>
      </div>
    </section>

    <section v-if="tokenUsage || marketHealth.krQuoteAttempts" class="stats-section">
      <h3 class="section-title">운영 지표</h3>
      <ul class="stats-list">
        <li v-if="tokenUsage">
          <span>이번 달 토큰</span>
          <strong class="mono-num">{{ tokenUsage.totalTokens?.toLocaleString('ko-KR') || 0 }}</strong>
        </li>
        <li v-if="marketHealth.krQuoteAttempts">
          <span>KR 시세 실패율</span>
          <strong class="mono-num">{{ marketHealth.krFailureRate ?? 0 }}%</strong>
        </li>
        <li v-if="marketProviders.us || marketProviders.kr">
          <span>시세 프로바이더</span>
          <code>US {{ marketProviders.us || '-' }} · KR {{ marketProviders.kr || '-' }}</code>
        </li>
      </ul>
    </section>

    <section v-if="displayTasks.length" class="tasks-section">
      <h3 class="tasks-title">예정 작업</h3>
      <ul class="tasks-list">
        <li v-for="task in displayTasks.slice(0, 4)" :key="task.id">
          <strong>{{ task.title }}</strong>
          <span>{{ task.displayRunLabel }}</span>
          <code v-if="task.cronExpression">{{ task.cronExpression }}</code>
        </li>
      </ul>
    </section>
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
  font-size: 14px;
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
  font-size: 13px;
}

.meta-list strong {
  color: var(--color-ink);
  font-size: 14px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-list code {
  font-family: var(--font-mono);
  font-size: 13px;
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
  font-size: 13px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-title {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--color-muted);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.preset-section,
.stats-section {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--color-hairline-soft);
}

.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.preset-chip {
  height: 22px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  background: rgba(255, 255, 255, 0.02);
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.preset-chip.active {
  border-color: rgba(110, 123, 255, 0.32);
  background: rgba(110, 123, 255, 0.1);
  color: var(--color-ink);
}

.stats-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 3px;
  font-size: 12px;
}

.stats-list li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.stats-list code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-body);
}

.tasks-section {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--color-hairline-soft);
}

.tasks-title {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--color-muted);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.tasks-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.tasks-list li {
  display: grid;
  gap: 1px;
  font-size: 12px;
}

.tasks-list strong {
  color: var(--color-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tasks-list span {
  color: var(--color-body);
}

.tasks-list code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-muted);
}

.access-token {
  margin-top: 8px;
  display: grid;
  gap: 4px;
}

.access-token__label {
  font-size: 13px;
  color: var(--color-body);
}

.access-token__input {
  width: 100%;
  height: 28px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xs);
  padding: 0 8px;
  font-size: 13px;
  font-family: var(--font-mono);
}
</style>
