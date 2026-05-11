<script setup>
import { computed, reactive, watch } from 'vue';
import { CATEGORIES, formatKRW, usePortfolio } from '../../composables/usePortfolio';
import { useChat } from '../../composables/useChat';
import { useProfile } from '../../composables/useProfile';
import { useWorkspace } from '../../composables/useWorkspace';
import { useUi } from '../../composables/useUi';

const { holdings, categoryShares, manager, system } = usePortfolio();
const { threads, activeThread, messages } = useChat();
const { profile, saveProfile, loading: savingProfile } = useProfile();
const { drawer, closeDrawer, generatedInsights } = useWorkspace();
const { notify } = useUi();

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
const insightDetail = computed(() => generatedInsights.value);

const settingsForm = reactive({
  displayName: '',
  investorType: '',
  investmentGoal: '',
  riskTolerance: '',
  responseStyle: '',
});

watch(
  () => profile.value.userProfile,
  (next) => {
    Object.assign(settingsForm, {
      displayName: next?.displayName || '',
      investorType: next?.investorType || '',
      investmentGoal: next?.investmentGoal || '',
      riskTolerance: next?.riskTolerance || '',
      responseStyle: next?.responseStyle || '',
    });
  },
  { immediate: true, deep: true }
);

async function submitSettings() {
  try {
    await saveProfile({
      ...profile.value.userProfile,
      ...settingsForm,
    });
    notify({
      tone: 'success',
      message: '설정을 저장했습니다.',
    });
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '설정 저장 실패',
    });
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
      <section class="drawer" @click.stop>
        <header class="drawer-head">
          <div>
            <p class="drawer-kicker">detail</p>
            <h2 class="drawer-title">{{ drawer.title || '상세 정보' }}</h2>
          </div>
          <button type="button" class="drawer-close" @click="closeDrawer">닫기</button>
        </header>

        <div class="drawer-body">
          <template v-if="drawer.type === 'settings'">
            <section class="settings-section">
              <div class="section-head">
                <strong>사용자 입력 정보</strong>
                <button type="button" class="action-button primary" :disabled="savingProfile" @click="submitSettings">
                  {{ savingProfile ? '저장 중…' : '저장' }}
                </button>
              </div>
              <form class="settings-form" @submit.prevent="submitSettings">
                <input v-model="settingsForm.displayName" class="settings-input" type="text" placeholder="이름" />
                <input v-model="settingsForm.investorType" class="settings-input" type="text" placeholder="투자자 유형" />
                <input v-model="settingsForm.investmentGoal" class="settings-input" type="text" placeholder="투자 목표" />
                <input v-model="settingsForm.riskTolerance" class="settings-input" type="text" placeholder="리스크 허용도" />
                <input v-model="settingsForm.responseStyle" class="settings-input settings-input--full" type="text" placeholder="응답 스타일" />
              </form>
            </section>

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
              <pre class="prompt-box">{{ system.orchestrationNotes || '오케스트레이션 노트가 없습니다.' }}</pre>
            </section>
          </template>

          <template v-else-if="drawer.type === 'insight'">
            <div v-if="insightDetail.length" class="detail-block">
              <strong>실시간 인사이트</strong>
              <div class="insight-drawer-list">
                <article v-for="card in insightDetail" :key="card.id" class="insight-drawer-card">
                  <div class="insight-drawer-head">
                    <strong>{{ card.title }}</strong>
                    <span>{{ card.tone || 'default' }}</span>
                  </div>
                  <p>{{ card.summary }}</p>
                  <ul class="simple-list">
                    <li v-for="metric in card.metrics || []" :key="`${card.id}-${metric.label}`">
                      {{ metric.label }} · {{ metric.value }}
                    </li>
                  </ul>
                  <ul class="simple-list">
                    <li v-for="item in card.bullets || []" :key="item">{{ item }}</li>
                  </ul>
                </article>
              </div>
            </div>
            <p v-else class="empty-text">아직 생성된 인사이트가 없습니다.</p>
          </template>

          <template v-else-if="drawer.type === 'assetDetail'">
            <div v-if="activeHolding" class="detail-block">
              <strong>{{ activeHolding.name }}</strong>
              <p>분류: {{ CATEGORIES.find((item) => item.id === activeHolding.category)?.label }}</p>
              <p class="mono-num">{{ formatKRW(activeHolding.amount) }}</p>
              <div v-if="activeHolding.details" class="detail-grid">
                <div v-if="activeHolding.details.account" class="detail-card">
                  <span>계좌</span>
                  <strong>{{ activeHolding.details.account }}</strong>
                </div>
                <div v-if="activeHolding.details.market" class="detail-card">
                  <span>시장</span>
                  <strong>{{ activeHolding.details.market }}</strong>
                </div>
                <div v-if="activeHolding.details.ticker" class="detail-card">
                  <span>티커</span>
                  <strong>{{ activeHolding.details.ticker }}</strong>
                </div>
                <div v-if="activeHolding.details.quantity != null" class="detail-card">
                  <span>수량</span>
                  <strong>{{ activeHolding.details.quantity }}주</strong>
                </div>
                <div v-if="activeHolding.details.currentPrice != null" class="detail-card">
                  <span>현재가</span>
                  <strong>{{ formatPrice(activeHolding.details) }}</strong>
                </div>
                <div v-if="activeHolding.details.priceChangePct != null" class="detail-card">
                  <span>등락</span>
                  <strong>{{ formatQuoteChange(activeHolding.details) }}</strong>
                </div>
                <div v-if="activeHolding.details.fxRate != null" class="detail-card">
                  <span>환율</span>
                  <strong>{{ Number(activeHolding.details.fxRate).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) }}</strong>
                </div>
                <div v-if="activeHolding.details.lastQuoteAt" class="detail-card">
                  <span>시세 시각</span>
                  <strong>{{ formatTime(activeHolding.details.lastQuoteAt) }}</strong>
                </div>
                <div v-if="activeHolding.details.quoteSource" class="detail-card">
                  <span>출처</span>
                  <strong>{{ activeHolding.details.quoteSource }}</strong>
                </div>
              </div>
              <ul v-if="activeHolding.details?.orders?.length" class="simple-list">
                <li v-for="item in activeHolding.details.orders" :key="item">{{ item }}</li>
              </ul>
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
              <pre class="prompt-box">{{ system.orchestrationNotes }}</pre>
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
  top: var(--space-sm);
  right: var(--space-sm);
  bottom: var(--space-sm);
  width: min(420px, calc(100vw - 20px));
  border-radius: var(--rounded-xl);
  background: rgba(11, 16, 24, 0.98);
  border: 1px solid var(--color-hairline);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.38);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
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

.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 0.18s ease;
}

.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}
</style>
