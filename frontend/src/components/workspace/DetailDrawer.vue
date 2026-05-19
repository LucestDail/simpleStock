<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { CATEGORIES, formatKRW, formatUSD, usePortfolio } from '../../composables/usePortfolio';
import { useChat } from '../../composables/useChat';
import { useProfile } from '../../composables/useProfile';
import { useWorkspace } from '../../composables/useWorkspace';
import { useUi } from '../../composables/useUi';
import { useMemory } from '../../composables/useMemory';
import { useSystemSettings } from '../../composables/useSystemSettings';
import { useInsightDetail } from '../../composables/useInsightDetail';

const { holdings, categoryShares, manager, system } = usePortfolio();
const { threads, activeThread, messages } = useChat();
const { profile } = useProfile();
const { drawer, closeDrawer } = useWorkspace();
const {
  portfolioSignalCard,
  visibleCategories,
  holdingsByCategory,
  snapshotTrend,
  managerBriefSection,
  marketPulse,
  nextManagerBrief,
  aiInsightCards,
} = useInsightDetail();
const { notify } = useUi();
const {
  longTermMemories,
  threadSummaries,
  fetchMemory,
  deleteMemory,
  togglePin,
  saveThreadSummary,
  loading: memoryLoading,
} = useMemory();
const { saveSettings, saving: savingSystemSettings } = useSystemSettings();
const editingSummaryId = ref('');
const editingSummaryText = ref('');
const marketProviderForm = reactive({
  usProvider: '',
  krProvider: '',
  fxProvider: '',
});

const activeHolding = computed(() =>
  holdings.value.find((item) => item.id === drawer.value.entityId) || null
);

const categoryDetail = computed(() => {
  if (activeHolding.value) return null;
  const category = CATEGORIES.find((item) => item.id === drawer.value.entityId);
  if (!category) return null;
  const rows = holdings.value.filter((item) => item.category === category.id);
  const summary = categoryShares.value.find((item) => item.id === category.id) || null;
  return {
    category,
    rows,
    summary,
  };
});

const activeThreadDetail = computed(() => {
  const thread = threads.value.find((item) => item.id === drawer.value.entityId) || activeThread.value;
  if (!thread) return null;
  return {
    thread,
    messages: messages.value,
  };
});

const latestManagerReport = computed(() => manager.value?.latestReport || null);
const drawerClass = computed(() => ({
  'drawer--asset': drawer.value.type === 'assetDetail',
  'drawer--thread': drawer.value.type === 'threadDetail',
}));
const activeHoldingMetaChips = computed(() => {
  if (!activeHolding.value) return [];
  const details = activeHolding.value.details || {};
  return [
    CATEGORIES.find((item) => item.id === activeHolding.value.category)?.label || '',
    details.account || '',
    details.market || '',
    details.ticker || '',
  ].filter(Boolean);
});
const activeHoldingDetailCards = computed(() => {
  if (!activeHolding.value) return [];
  const details = activeHolding.value.details || {};
  const cards = [
    ['평가 금액', formatHoldingPrimaryAmount(activeHolding.value)],
    formatHoldingSecondaryAmount(activeHolding.value)
      ? ['원화 환산', formatHoldingSecondaryAmount(activeHolding.value).replace(/^원화 환산\s*/, '')]
      : null,
    details.quantity != null ? ['수량', `${details.quantity}주`] : null,
    details.currentPrice != null ? ['현재가', formatPrice(details)] : null,
    details.priceChangePct != null ? ['등락', formatQuoteChange(details)] : null,
    details.lastQuoteAt ? ['시세 시각', formatTime(details.lastQuoteAt)] : null,
    details.fxRate != null && Number(details.fxRate) > 0
      ? ['환율', Number(details.fxRate).toLocaleString('ko-KR', { maximumFractionDigits: 2 })]
      : null,
    details.quoteSource ? ['출처', details.quoteSource] : null,
  ].filter(Boolean);
  return cards;
});
const activeHoldingSummaryText = computed(() => {
  if (!activeHolding.value) return '';
  const details = activeHolding.value.details || {};
  const summary = normalizeText(details.summary);
  if (!summary) return '';
  const redundantTokens = [
    details.account,
    details.market,
    details.ticker,
    details.quantity != null ? `${details.quantity}주` : '',
    details.currentPrice != null ? `현재가 ${formatPrice(details)}` : '',
    details.currentPrice != null ? formatPrice(details) : '',
  ]
    .map(normalizeText)
    .filter(Boolean);
  const summaryChunks = summary
    .split(/[·,/]/)
    .map(normalizeText)
    .filter(Boolean);
  if (summaryChunks.length && summaryChunks.every((chunk) => redundantTokens.includes(chunk))) {
    return '';
  }
  return details.summary || '';
});
const activeHoldingOrderLines = computed(() => activeHolding.value?.details?.orders || []);

watch(
  () => drawer.value.open && drawer.value.type === 'settings',
  (open) => {
    if (!open) return;
    fetchMemory().catch(() => {});
    Object.assign(marketProviderForm, {
      usProvider: system.value.marketProviders?.us || '',
      krProvider: system.value.marketProviders?.kr || '',
      fxProvider: system.value.marketProviders?.fx || '',
    });
  }
);

async function saveMarketProviders() {
  try {
    await saveSettings({ market: { ...marketProviderForm } });
    notify({ tone: 'success', message: '시세 프로바이더 설정을 저장했습니다.' });
  } catch (error) {
    notify({ tone: 'error', message: error.message || '저장 실패' });
  }
}

function startEditSummary(summary) {
  editingSummaryId.value = summary.id;
  editingSummaryText.value = summary.summary || '';
}

async function submitSummaryEdit() {
  try {
    await saveThreadSummary(editingSummaryId.value, { summary: editingSummaryText.value });
    editingSummaryId.value = '';
    notify({ tone: 'success', message: '스레드 요약을 저장했습니다.' });
  } catch (error) {
    notify({ tone: 'error', message: error.message || '요약 저장 실패' });
  }
}

function formatPrice(details) {
  if (!details || !Number.isFinite(Number(details.currentPrice ?? details.lastQuote))) return '-';
  const value = Number(details.currentPrice ?? details.lastQuote);
  return details.currency === 'USD' ? `$${value.toFixed(2)}` : `${Math.round(value).toLocaleString('ko-KR')}원`;
}

function formatQuoteChange(details) {
  if (!details || !Number.isFinite(Number(details.priceChangePct))) return '변동 정보 없음';
  const pct = Number(details.priceChangePct);
  const raw = Number.isFinite(Number(details.priceChange)) ? Number(details.priceChange) : 0;
  const amount =
    details.currency === 'USD'
      ? `${raw >= 0 ? '+' : '-'}$${Math.abs(raw).toFixed(2)}`
      : `${raw >= 0 ? '+' : '-'}${Math.abs(raw).toLocaleString('ko-KR')}원`;
  return `${amount} · ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function formatHoldingPrimaryAmount(holding) {
  const details = holding?.details || {};
  if (String(details.currency || '').toUpperCase() === 'USD' && Number.isFinite(Number(details.nativeAmount))) {
    return formatUSD(details.nativeAmount);
  }
  return formatKRW(holding?.amount);
}

function formatHoldingSecondaryAmount(holding) {
  const details = holding?.details || {};
  const liveFxRate = Number(system.value?.market?.fx?.USDKRW?.rate);
  if (String(details.currency || '').toUpperCase() === 'USD' && Number.isFinite(Number(details.nativeAmount))) {
    const converted =
      Number.isFinite(liveFxRate) && liveFxRate > 0
        ? Math.round(Number(details.nativeAmount) * liveFxRate)
        : holding.amount;
    return `원화 환산 ${formatKRW(converted)}`;
  }
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
</script>

<template>
  <transition name="drawer-fade">
    <aside v-if="drawer.open" class="drawer-backdrop" @click="closeDrawer">
      <section class="drawer" :class="drawerClass" @click.stop>
        <header class="drawer-head">
          <div>
            <p class="drawer-kicker">detail</p>
            <h2 class="drawer-title">{{ drawer.title || '상세 정보' }}</h2>
          </div>
          <button type="button" class="drawer-close" @click="closeDrawer">닫기</button>
        </header>

        <div class="drawer-body">
          <template v-if="drawer.type === 'settings'">
            <p class="settings-chat-note">
              자산·설정·예약 작업은 Quant Manager 대화로 요청하세요. 이 화면에서는 기억 정리와 시스템 정보만 다룹니다.
            </p>

            <section class="settings-section">
              <div class="section-head">
                <strong>시스템 상태</strong>
              </div>
              <div class="detail-grid">
                <div class="detail-card">
                  <span>시간대</span>
                  <strong>{{ system.timezone }}</strong>
                </div>
                <div class="detail-card">
                  <span>서버 시간</span>
                  <strong>{{ system.serverTimeLocal || '-' }}</strong>
                </div>
                <div class="detail-card">
                  <span>모델</span>
                  <strong>{{ system.ai?.model || '-' }}</strong>
                </div>
                <div class="detail-card">
                  <span>사고 수준</span>
                  <strong>{{ system.ai?.thinkingLevel || '-' }}</strong>
                </div>
              </div>
            </section>

            <section class="settings-section">
              <div class="section-head">
                <strong>시세 프로바이더 (파일 설정)</strong>
                <button type="button" class="action-button" :disabled="savingSystemSettings" @click="saveMarketProviders">
                  저장
                </button>
              </div>
              <div class="settings-form settings-form--providers">
                <input v-model="marketProviderForm.usProvider" class="settings-input" type="text" placeholder="US (finnhub / yahoo-finance)" />
                <input v-model="marketProviderForm.krProvider" class="settings-input" type="text" placeholder="KR (public-data-portal)" />
                <input v-model="marketProviderForm.fxProvider" class="settings-input" type="text" placeholder="FX (yahoo-finance)" />
              </div>
            </section>

            <section class="settings-section">
              <div class="section-head">
                <strong>기억 관리</strong>
                <span v-if="memoryLoading">불러오는 중…</span>
              </div>
              <ul v-if="longTermMemories.length" class="memory-list">
                <li v-for="memory in longTermMemories.slice(0, 12)" :key="memory.id">
                  <p>{{ memory.text }}</p>
                  <div class="memory-actions">
                    <button type="button" class="action-button" @click="togglePin(memory.id, !memory.metadata?.pinned)">
                      {{ memory.metadata?.pinned ? '고정 해제' : '고정' }}
                    </button>
                    <button type="button" class="action-button danger" @click="deleteMemory(memory.id)">삭제</button>
                  </div>
                </li>
              </ul>
              <p v-else class="empty-text">저장된 장기 기억이 없습니다.</p>

              <ul v-if="threadSummaries.length" class="memory-list memory-list--summaries">
                <li v-for="summary in threadSummaries.slice(0, 6)" :key="summary.id">
                  <template v-if="editingSummaryId === summary.id">
                    <textarea v-model="editingSummaryText" class="import-textarea" rows="3" />
                    <button type="button" class="action-button primary" @click="submitSummaryEdit">요약 저장</button>
                  </template>
                  <template v-else>
                    <p>{{ summary.summary || '요약 없음' }}</p>
                    <button type="button" class="action-button" @click="startEditSummary(summary)">요약 편집</button>
                  </template>
                </li>
              </ul>
            </section>
          </template>

          <template v-else-if="drawer.type === 'insight'">
            <div class="insight-detail">
              <section class="insight-section">
                <div class="section-head">
                  <strong>{{ portfolioSignalCard.title }}</strong>
                  <span class="tone-chip" :class="`tone-chip--${portfolioSignalCard.tone}`">
                    {{ portfolioSignalCard.toneLabel }}
                  </span>
                </div>
                <p class="insight-lead">{{ portfolioSignalCard.summary }}</p>
                <div class="detail-grid detail-grid--insight">
                  <div
                    v-for="metric in portfolioSignalCard.metrics"
                    :key="metric.label"
                    class="detail-card"
                  >
                    <span>{{ metric.label }}</span>
                    <strong class="mono-num">{{ metric.value }}</strong>
                  </div>
                </div>
                <ul v-if="portfolioSignalCard.bullets?.length" class="simple-list insight-bullets">
                  <li v-for="item in portfolioSignalCard.bullets" :key="item">{{ item }}</li>
                </ul>
              </section>

              <section class="insight-section">
                <div class="section-head"><strong>시장·환율</strong></div>
                <div class="detail-grid detail-grid--insight">
                  <div class="detail-card"><span>한국 장</span><strong>{{ marketPulse.kr }}</strong></div>
                  <div class="detail-card"><span>미국 장</span><strong>{{ marketPulse.us }}</strong></div>
                  <div class="detail-card"><span>USD/KRW</span><strong class="mono-num">{{ marketPulse.fxRate }}</strong></div>
                  <div class="detail-card"><span>환율 등락</span><strong class="mono-num">{{ marketPulse.fxChangePct }}</strong></div>
                </div>
                <p v-if="nextManagerBrief" class="insight-note">
                  다음 예약 보고: {{ nextManagerBrief.title }} · {{ nextManagerBrief.label }}
                </p>
              </section>

              <section v-if="visibleCategories.length" class="insight-section">
                <div class="section-head"><strong>카테고리 비중</strong></div>
                <div class="category-bars">
                  <div v-for="row in visibleCategories" :key="row.id" class="category-bar">
                    <div class="category-bar__meta">
                      <span>{{ row.label }}</span>
                      <strong class="mono-num">{{ row.pct }}% · {{ formatKRW(row.amount) }}</strong>
                    </div>
                    <div class="category-bar__track">
                      <div class="category-bar__fill" :style="{ width: `${Math.min(100, row.pct)}%` }" />
                    </div>
                  </div>
                </div>
              </section>

              <section
                v-for="group in holdingsByCategory"
                :key="group.id"
                class="insight-section insight-section--nested"
              >
                <div class="section-head">
                  <strong>{{ group.label }} 보유</strong>
                  <span class="mono-num">{{ group.pct }}%</span>
                </div>
                <ul class="holding-mini-list">
                  <li v-for="row in group.rows" :key="row.id">
                    <span>{{ row.name }}</span>
                    <strong class="mono-num">{{ formatKRW(row.amountKrw) }}</strong>
                    <span v-if="row.ticker" class="holding-mini-meta">{{ row.ticker }}</span>
                    <span
                      v-if="row.priceChangePct != null"
                      class="holding-mini-meta"
                      :class="Number(row.priceChangePct) >= 0 ? 'up' : 'down'"
                    >
                      {{ Number(row.priceChangePct) >= 0 ? '+' : '' }}{{ row.priceChangePct }}%
                    </span>
                  </li>
                </ul>
              </section>

              <section class="insight-section">
                <div class="section-head"><strong>스냅샷 추이</strong></div>
                <p class="insight-note">
                  브리핑 실행 시 당일 합계가 자동 저장됩니다. 「포트폴리오 현황」에서 수동 저장도 가능합니다.
                </p>
                <div v-if="snapshotTrend.length" class="snapshot-table">
                  <div class="snapshot-table__head">
                    <span>일자</span><span>총 자산</span><span>전일 대비</span>
                  </div>
                  <div
                    v-for="row in snapshotTrend"
                    :key="row.date"
                    class="snapshot-table__row"
                  >
                    <span>{{ row.dateLabel }}</span>
                    <strong class="mono-num">{{ row.total }}</strong>
                    <span class="mono-num">{{ row.deltaLabel }}</span>
                  </div>
                </div>
                <p v-else class="empty-text">저장된 스냅샷이 없습니다.</p>
              </section>

              <section class="insight-section">
                <div class="section-head"><strong>Quant Manager 브리핑</strong></div>
                <template v-if="managerBriefSection.available">
                  <p class="insight-meta">
                    {{ managerBriefSection.targetDate || '오늘' }} · {{ managerBriefSection.createdAtLabel }}
                    <span v-if="managerBriefSection.trigger"> · {{ managerBriefSection.trigger }}</span>
                  </p>
                  <p class="insight-lead">{{ managerBriefSection.summary }}</p>
                  <p v-if="managerBriefSection.dailyObjective" class="insight-body">
                    {{ managerBriefSection.dailyObjective }}
                  </p>
                  <div v-if="managerBriefSection.actionItems.length" class="insight-subblock">
                    <span>액션</span>
                    <ul class="simple-list">
                      <li v-for="item in managerBriefSection.actionItems" :key="item">{{ item }}</li>
                    </ul>
                  </div>
                  <div v-if="managerBriefSection.riskChecks.length" class="insight-subblock">
                    <span>리스크 체크</span>
                    <ul class="simple-list">
                      <li v-for="item in managerBriefSection.riskChecks" :key="item">{{ item }}</li>
                    </ul>
                  </div>
                  <div v-if="managerBriefSection.allocationNotes.length" class="insight-subblock">
                    <span>배분 메모</span>
                    <ul class="simple-list">
                      <li v-for="item in managerBriefSection.allocationNotes" :key="item">{{ item }}</li>
                    </ul>
                  </div>
                </template>
                <p v-else class="empty-text">{{ managerBriefSection.emptyMessage }}</p>
              </section>

              <section v-if="aiInsightCards.length" class="insight-section">
                <div class="section-head"><strong>대화 기반 AI 인사이트</strong></div>
                <div class="insight-drawer-list">
                  <article
                    v-for="card in aiInsightCards"
                    :key="card.id"
                    class="insight-drawer-card"
                  >
                    <div class="insight-drawer-head">
                      <strong>{{ card.title }}</strong>
                      <span>{{ card.toneLabel }}</span>
                    </div>
                    <p>{{ card.summary }}</p>
                    <ul v-if="card.metrics?.length" class="simple-list">
                      <li v-for="metric in card.metrics" :key="`${card.id}-${metric.label}`">
                        {{ metric.label }} · {{ metric.value }}
                      </li>
                    </ul>
                    <ul v-if="card.bullets?.length" class="simple-list">
                      <li v-for="item in card.bullets" :key="item">{{ item }}</li>
                    </ul>
                  </article>
                </div>
              </section>
            </div>
          </template>


          <template v-else-if="drawer.type === 'assetDetail'">
            <div v-if="activeHolding" class="detail-block">
              <div class="asset-summary-card">
                <div class="asset-summary-card__head">
                  <strong>{{ activeHolding.name }}</strong>
                </div>
                <div class="asset-summary-card__amounts">
                  <strong class="mono-num">{{ formatHoldingPrimaryAmount(activeHolding) }}</strong>
                  <span v-if="formatHoldingSecondaryAmount(activeHolding)" class="mono-num">{{ formatHoldingSecondaryAmount(activeHolding) }}</span>
                </div>
                <div v-if="activeHoldingMetaChips.length" class="asset-chip-row">
                  <span v-for="item in activeHoldingMetaChips" :key="item" class="asset-chip">{{ item }}</span>
                </div>
              </div>
              <div v-if="activeHoldingDetailCards.length" class="detail-grid detail-grid--asset">
                <div v-for="[label, value] in activeHoldingDetailCards" :key="label" class="detail-card">
                  <span>{{ label }}</span>
                  <strong>{{ value }}</strong>
                </div>
              </div>
              <div v-if="activeHoldingSummaryText" class="detail-note-block">
                <strong>자산 요약</strong>
                <p>{{ activeHoldingSummaryText }}</p>
              </div>
              <div v-if="activeHoldingOrderLines.length" class="detail-note-block">
                <strong>예약/메모</strong>
                <ul class="simple-list">
                  <li v-for="item in activeHoldingOrderLines" :key="item">{{ item }}</li>
                </ul>
              </div>
            </div>
            <div v-else-if="categoryDetail" class="detail-block">
              <strong>{{ categoryDetail.category.label }}</strong>
              <p class="mono-num">
                {{ formatKRW(categoryDetail.summary?.amount || 0) }} · {{ categoryDetail.summary?.pct || 0 }}%
              </p>
              <ul class="simple-list">
                <li v-for="row in categoryDetail.rows" :key="row.id">
                  <span>{{ row.name }}</span>
                  <span class="mono-num">{{ formatKRW(row.amount) }}</span>
                </li>
              </ul>
            </div>
            <p v-else class="empty-text">선택된 자산 정보가 없습니다.</p>
          </template>

          <template v-else-if="drawer.type === 'threadDetail'">
            <div v-if="activeThreadDetail" class="detail-block">
              <strong>{{ activeThreadDetail.thread.title }}</strong>
              <p>메시지 {{ activeThreadDetail.messages.length }}개</p>
              <ul class="message-list">
                <li v-for="message in activeThreadDetail.messages.slice(-8)" :key="message.id">
                  <strong>{{ message.role === 'assistant' ? 'AI' : '나' }}</strong>
                  <p>{{ message.content }}</p>
                </li>
              </ul>
            </div>
            <p v-else class="empty-text">선택된 대화가 없습니다.</p>
          </template>

          <template v-else-if="drawer.type === 'managerBrief'">
            <div v-if="latestManagerReport" class="detail-block">
              <strong>{{ latestManagerReport.summary }}</strong>
              <p>{{ latestManagerReport.dailyObjective }}</p>
              <ul class="simple-list">
                <li v-for="item in latestManagerReport.actionItems" :key="item">{{ item }}</li>
              </ul>
              <ul class="simple-list">
                <li v-for="item in latestManagerReport.riskChecks" :key="item">{{ item }}</li>
              </ul>
            </div>
            <p v-else class="empty-text">브리핑 데이터가 없습니다.</p>
          </template>

          <template v-else-if="drawer.type === 'profile'">
            <div class="detail-block">
              <strong>{{ profile.userProfile?.displayName || '사용자' }}</strong>
              <p>{{ profile.aiProfile?.summary || '프로필 요약이 없습니다.' }}</p>
              <ul class="simple-list">
                <li v-for="item in profile.aiProfile?.preferences || []" :key="item">{{ item }}</li>
              </ul>
            </div>
          </template>

          <template v-else>
            <div class="detail-block">
              <strong>시스템 상태</strong>
              <p>{{ system.serverTimeLocal }}</p>
              <p>시간대: {{ system.timezone }}</p>
              <p>모델: {{ system.ai?.model || '-' }}</p>
            </div>
          </template>
        </div>
      </section>
    </aside>
  </transition>
</template>

<style scoped>
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(5, 8, 13, 0.58);
}

.drawer {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  width: min(760px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  border-radius: var(--rounded-xl);
  background: rgba(11, 16, 24, 0.98);
  border: 1px solid var(--color-hairline);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.38);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.drawer--thread {
  width: min(980px, calc(100vw - 24px));
}

.drawer--asset {
  width: min(780px, calc(100vw - 24px));
}

.drawer-head {
  padding: var(--space-base);
  border-bottom: 1px solid var(--color-hairline);
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: flex-start;
}

.drawer-kicker {
  margin: 0 0 4px;
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.drawer-title {
  margin: 0;
  color: var(--color-ink);
  font-size: 18px;
  font-weight: 600;
}

.drawer-close {
  border: none;
  background: var(--color-surface-strong);
  border-radius: var(--rounded-pill);
  padding: 8px 12px;
  color: var(--color-ink);
  font-weight: 600;
  cursor: pointer;
}

.drawer-body {
  padding: var(--space-base);
  overflow: auto;
  display: grid;
  gap: var(--space-base);
}

.detail-block {
  display: grid;
  gap: var(--space-sm);
  color: var(--color-body);
  line-height: 1.65;
}

.detail-block strong {
  color: var(--color-ink);
  font-size: 16px;
}

.asset-summary-card {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: rgba(255, 255, 255, 0.02);
  padding: 12px 14px;
  display: grid;
  gap: 6px;
}

.asset-summary-card__head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.asset-summary-card__amounts {
  display: grid;
  gap: 2px;
}

.asset-summary-card__amounts strong {
  font-size: 24px;
  line-height: 1.15;
}

.asset-summary-card__amounts span {
  color: var(--color-body);
  font-size: 12px;
}

.asset-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.asset-chip {
  border-radius: var(--rounded-pill);
  background: rgba(255, 255, 255, 0.05);
  padding: 4px 9px;
  color: var(--color-body-strong);
  font-size: 11px;
  line-height: 1.2;
}

.detail-note-block {
  display: grid;
  gap: 6px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: rgba(255, 255, 255, 0.02);
  padding: 12px 14px;
}

.detail-note-block strong {
  font-size: 13px;
}

.detail-note-block p {
  margin: 0;
  color: var(--color-body);
  font-size: 12px;
  line-height: 1.5;
}

.settings-chat-note {
  margin: 0 0 var(--space-sm);
  padding: 8px 10px;
  border-radius: var(--rounded-md);
  background: rgba(0, 82, 255, 0.08);
  border: 1px solid rgba(0, 82, 255, 0.18);
  color: var(--color-body);
  font-size: 12px;
  line-height: 1.4;
}

.settings-section {
  display: grid;
  gap: var(--space-sm);
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: center;
}

.section-head strong {
  color: var(--color-ink);
}

.settings-form,
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.detail-grid--asset {
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.settings-input,
.detail-card {
  min-height: 42px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.02);
}

.settings-input {
  padding: 0 12px;
  color: var(--color-ink);
}

.settings-input--full {
  grid-column: 1 / -1;
}

.detail-card {
  padding: 10px 12px;
  display: grid;
  gap: 4px;
}

.detail-card span {
  color: var(--color-muted);
  font-size: 11px;
}

.detail-card strong {
  color: var(--color-ink);
  font-size: 13px;
  line-height: 1.35;
}

.action-button {
  height: 34px;
  padding: 0 12px;
  border: none;
  border-radius: var(--rounded-pill);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.action-button.primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.simple-list,
.message-list {
  margin: 0;
  padding-left: 18px;
}

.insight-detail {
  display: grid;
  gap: var(--space-md);
}

.insight-section {
  display: grid;
  gap: var(--space-sm);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-hairline);
}

.insight-section:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.insight-section--nested {
  padding-left: 4px;
}

.insight-lead {
  margin: 0;
  color: var(--color-ink);
  font-size: 13px;
  line-height: 1.45;
}

.insight-body,
.insight-note,
.insight-meta {
  margin: 0;
  color: var(--color-body);
  font-size: 12px;
  line-height: 1.45;
}

.insight-meta {
  color: var(--color-muted);
}

.insight-bullets {
  margin-top: 2px;
}

.insight-subblock {
  display: grid;
  gap: 4px;
}

.insight-subblock > span {
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.tone-chip {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.tone-chip--positive {
  color: var(--color-positive, #05b169);
}

.tone-chip--warning {
  color: #f4b000;
}

.tone-chip--primary {
  color: #6e7bff;
}

.detail-grid--insight {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.category-bars {
  display: grid;
  gap: 8px;
}

.category-bar {
  display: grid;
  gap: 4px;
}

.category-bar__meta {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  font-size: 12px;
}

.category-bar__track {
  height: 6px;
  border-radius: var(--rounded-pill);
  background: rgba(255, 255, 255, 0.06);
  overflow: hidden;
}

.category-bar__fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(110, 123, 255, 0.85), rgba(5, 177, 105, 0.75));
}

.holding-mini-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}

.holding-mini-list li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  align-items: baseline;
  font-size: 12px;
}

.holding-mini-list li > span:first-child {
  color: var(--color-ink);
}

.holding-mini-meta {
  grid-column: 1 / -1;
  color: var(--color-muted);
  font-size: 11px;
}

.holding-mini-meta.up {
  color: #05b169;
}

.holding-mini-meta.down {
  color: #e5484d;
}

.snapshot-table {
  display: grid;
  gap: 4px;
  font-size: 12px;
}

.snapshot-table__head,
.snapshot-table__row {
  display: grid;
  grid-template-columns: 72px 1fr 1fr;
  gap: 8px;
  align-items: center;
}

.snapshot-table__head {
  color: var(--color-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.snapshot-table__row {
  padding: 6px 8px;
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.03);
}

.insight-drawer-list {
  display: grid;
  gap: var(--space-sm);
}

.insight-drawer-card {
  display: grid;
  gap: var(--space-sm);
  padding: 10px 12px;
  border-radius: var(--rounded-lg);
  border: 1px solid var(--color-hairline);
  background: rgba(255, 255, 255, 0.02);
}

.insight-drawer-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: center;
}

.insight-drawer-head span {
  color: var(--color-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.simple-list li,
.message-list li {
  display: grid;
  gap: 4px;
  margin-bottom: var(--space-sm);
}

.message-list p {
  margin: 0;
  white-space: pre-wrap;
}

.prompt-box {
  margin: 0;
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.empty-text {
  margin: 0;
  color: var(--color-muted);
}

.settings-form--providers {
  grid-template-columns: 1fr;
}

.import-textarea {
  width: 100%;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  padding: 8px;
  color: var(--color-ink);
  background: rgba(255, 255, 255, 0.02);
  font-size: 12px;
  resize: vertical;
}

.import-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.diff-list,
.memory-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.diff-list li,
.memory-list li {
  border: 1px solid var(--color-hairline-soft);
  border-radius: var(--rounded-md);
  padding: 8px;
  font-size: 12px;
}

.diff-list span {
  display: inline-block;
  margin-right: 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--color-muted);
}

.memory-list p {
  margin: 0 0 6px;
  line-height: 1.4;
}

.memory-actions {
  display: flex;
  gap: 6px;
}

.action-button.danger {
  color: var(--color-semantic-down);
  background: rgba(255, 92, 92, 0.08);
}

@media (max-width: 720px) {
  .drawer {
    top: 10px;
    width: calc(100vw - 20px);
    max-height: calc(100dvh - 20px);
  }

  .detail-grid,
  .detail-grid--asset,
  .settings-form {
    grid-template-columns: 1fr;
  }

  .asset-summary-card__head {
    flex-direction: column;
    align-items: flex-start;
  }
}

.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 0.18s ease;
}

.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}
</style>
