<script setup>
import { onMounted, computed, ref } from 'vue';
import { usePortfolio, formatKRW } from '../composables/usePortfolio';
import { useUi } from '../composables/useUi';

const {
  fetchPortfolio,
  total,
  categoryShares,
  lastSnapshot,
  dayOverDay,
  ai,
  system,
  runAiReview,
  loading,
  error,
} = usePortfolio();
const { notify } = useUi();
const aiBusy = ref(false);

onMounted(fetchPortfolio);

const donutGradient = computed(() => {
  const parts = categoryShares.value.filter((c) => c.amount > 0);
  if (!parts.length) {
    return 'conic-gradient(var(--color-surface-strong) 0deg 360deg)';
  }
  const colors = ['#16181c', '#5b616e', '#7c828a', '#a8acb3', '#0052ff'];
  let acc = 0;
  const segs = parts.map((c, i) => {
    const deg = (c.pct / 100) * 360;
    const start = acc;
    acc += deg;
    const col = colors[i % colors.length];
    return `${col} ${start}deg ${acc}deg`;
  });
  return `conic-gradient(${segs.join(', ')})`;
});

const latestAiReport = computed(() => ai.value?.latestReport || null);

async function generateAiBrief() {
  aiBusy.value = true;
  try {
    await runAiReview();
    notify({
      tone: 'success',
      message: 'AI 일일 브리핑을 생성했습니다.',
    });
  } catch (e) {
    notify({
      tone: 'error',
      message: e.message || 'AI 브리핑 생성에 실패했습니다.',
    });
  } finally {
    aiBusy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <p v-if="error" class="banner-error">{{ error }}</p>

    <section class="hero-dark">
      <div class="hero-inner">
        <div class="hero-copy">
          <p class="badge-pill">개인 자산</p>
          <h1 class="display">총 자산</h1>
          <p class="hero-total mono-num">{{ formatKRW(total) }}</p>
          <p v-if="lastSnapshot" class="sub">
            최근 스냅샷 {{ lastSnapshot.date }} · {{ formatKRW(lastSnapshot.total) }}
          </p>
          <p v-else class="sub">일별 기록에서 스냅샷을 저장하면 변동 추이를 볼 수 있습니다.</p>
          <p class="sub sub-meta">
            앱 기준 시간대 {{ system.timezone }} · 현재 {{ system.serverTimeLocal || '확인 중' }}
          </p>
          <div v-if="dayOverDay" class="delta-row">
            <span class="label">직전 스냅샷 대비</span>
            <span class="mono-num delta" :class="dayOverDay.delta >= 0 ? 'up' : 'down'">
              {{ dayOverDay.delta >= 0 ? '+' : '' }}{{ formatKRW(dayOverDay.delta) }}
              <template v-if="dayOverDay.pct != null">
                ({{ dayOverDay.delta >= 0 ? '+' : '' }}{{ dayOverDay.pct }}%)
              </template>
            </span>
          </div>
        </div>
        <div class="mock-stack">
          <div class="card-dark card-a">
            <p class="card-title">카테고리 비중</p>
            <div class="donut-wrap">
              <div class="donut" :style="{ background: donutGradient }" />
            </div>
          </div>
          <div class="card-dark card-b">
            <p class="card-title">요약</p>
            <ul class="mini-list">
              <li v-for="c in categoryShares" :key="c.id">
                <span>{{ c.label }}</span>
                <span class="mono-num">{{ c.pct }}%</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <section class="band-white">
      <div class="container">
        <div class="ai-head">
          <div>
            <h2 class="section-title">AI 일일 브리핑</h2>
            <p class="section-lead">
              Quant Manager 시스템 프롬프트를 바탕으로 오늘의 자산 관리 지시를 생성합니다.
            </p>
          </div>
          <button
            type="button"
            class="ai-button"
            :disabled="aiBusy || !system.aiConfigured"
            @click="generateAiBrief"
          >
            {{ aiBusy ? '생성 중…' : '지금 생성' }}
          </button>
        </div>

        <div v-if="!system.aiConfigured" class="ai-disabled">
          <p class="ai-disabled-title">Gemini 키가 아직 설정되지 않았습니다.</p>
          <p class="ai-disabled-body">
            `.env`에 `GEMINI_API_KEY`를 넣으면 KST 기준 일 1회 자동 실행되고, 수동 생성도 활성화됩니다.
          </p>
        </div>

        <div v-else-if="latestAiReport" class="ai-grid">
          <article class="feature-card ai-card">
            <p class="card-kicker">요약</p>
            <h3 class="title-md">오늘의 브리핑</h3>
            <p class="ai-summary">{{ latestAiReport.summary }}</p>
            <p class="ai-meta mono-num">
              {{ latestAiReport.targetDate }} · {{ latestAiReport.model }}
            </p>
          </article>

          <article class="feature-card ai-card">
            <p class="card-kicker">오늘의 목표</p>
            <h3 class="title-md">핵심 액션</h3>
            <p class="ai-summary">{{ latestAiReport.dailyObjective }}</p>
            <ul class="ai-list">
              <li v-for="item in latestAiReport.actionItems" :key="item">{{ item }}</li>
            </ul>
          </article>

          <article class="feature-card ai-card">
            <p class="card-kicker">리스크 체크</p>
            <h3 class="title-md">주의 포인트</h3>
            <ul class="ai-list">
              <li v-for="item in latestAiReport.riskChecks" :key="item">{{ item }}</li>
            </ul>
            <p class="card-kicker card-kicker-gap">비중 코멘트</p>
            <ul class="ai-list">
              <li v-for="item in latestAiReport.allocationNotes" :key="item">{{ item }}</li>
            </ul>
          </article>
        </div>

        <div v-else class="muted">아직 생성된 AI 브리핑이 없습니다.</div>
      </div>
    </section>

    <section class="band-soft">
      <div class="container">
        <h2 class="section-title">포트폴리오 비율</h2>
        <p class="section-lead">
          현재는 상품 분류 기준으로 예금 · 적금 · 주식 · 펀드 · 연금 비중을 보여줍니다.
        </p>

        <div v-if="loading" class="muted">불러오는 중…</div>
        <div v-else class="grid-cards">
          <article v-for="c in categoryShares" :key="c.id" class="feature-card">
            <div class="asset-plate">{{ c.label.charAt(0) }}</div>
            <h3 class="title-md">{{ c.label }}</h3>
            <p class="mono-num amount">{{ formatKRW(c.amount) }}</p>
            <p class="pct">{{ c.pct }}% of total</p>
            <div class="bar">
              <div class="bar-fill" :style="{ width: `${Math.min(100, c.pct)}%` }" />
            </div>
          </article>
        </div>
      </div>
    </section>

    <section class="band-white">
      <div class="container">
        <h2 class="section-title">자산 구성 (표)</h2>
        <div class="table-wrap">
          <div v-for="c in categoryShares" :key="c.id" class="asset-row">
            <div class="asset-plate sm">{{ c.label.charAt(0) }}</div>
            <div class="row-main">
              <span class="name">{{ c.label }}</span>
            </div>
            <span class="mono-num price">{{ formatKRW(c.amount) }}</span>
            <span class="mono-num change" :class="c.pct >= 50 ? 'up' : c.pct <= 0 ? 'muted' : ''">
              {{ c.pct }}%
            </span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page {
  padding-bottom: var(--space-section);
}

.banner-error {
  margin: 0;
  padding: var(--space-sm) var(--space-base);
  background: #fff5f5;
  color: var(--color-semantic-down);
  text-align: center;
  font-size: 14px;
}

.hero-dark {
  background: var(--color-surface-dark);
  color: var(--color-on-dark);
  padding: var(--space-section) var(--space-base);
}

.hero-inner {
  max-width: var(--content-max);
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-xxl);
  align-items: center;
}

.badge-pill {
  display: inline-block;
  margin: 0 0 var(--space-sm);
  padding: 6px 14px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-dark-elevated);
  color: var(--color-on-dark);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.display {
  margin: 0 0 var(--space-sm);
  font-size: clamp(36px, 6vw, 52px);
  font-weight: 400;
  line-height: 1;
  letter-spacing: -0.03em;
  color: var(--color-on-dark);
}

.hero-total {
  margin: 0 0 var(--space-sm);
  font-size: clamp(28px, 4vw, 36px);
  color: var(--color-on-dark);
}

.sub {
  margin: 0 0 var(--space-lg);
  color: var(--color-on-dark-soft);
  font-size: 16px;
  max-width: 48ch;
}

.sub-meta {
  margin-top: calc(var(--space-lg) * -0.5);
}

.delta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-sm);
}

.delta-row .label {
  font-size: 14px;
  color: var(--color-on-dark-soft);
}

.delta {
  font-size: 18px;
}

.delta.up {
  color: var(--color-semantic-up);
}

.delta.down {
  color: var(--color-semantic-down);
}

.mock-stack {
  position: relative;
  min-height: 280px;
}

.card-dark {
  background: var(--color-surface-dark-elevated);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
  color: var(--color-on-dark);
  box-shadow: var(--shadow-soft);
}

.card-a {
  position: relative;
  z-index: 2;
  max-width: 280px;
}

.card-b {
  position: absolute;
  right: 0;
  bottom: 0;
  z-index: 1;
  max-width: 240px;
  transform: rotate(-3deg);
}

.card-title {
  margin: 0 0 var(--space-base);
  font-size: 16px;
  font-weight: 600;
}

.donut-wrap {
  display: flex;
  justify-content: center;
}

.donut {
  width: 140px;
  height: 140px;
  border-radius: var(--rounded-full);
}

.mini-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
}

.mini-list li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-base);
  padding: var(--space-xs) 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.band-soft {
  background: var(--color-surface-soft);
  padding: var(--space-section) var(--space-base);
}

.band-white {
  background: var(--color-canvas);
  padding: var(--space-section) var(--space-base);
}

.container {
  max-width: var(--content-max);
  margin: 0 auto;
}

.section-title {
  margin: 0 0 var(--space-xs);
  font-size: 32px;
  font-weight: 400;
  letter-spacing: -0.02em;
  color: var(--color-ink);
}

.section-lead {
  margin: 0;
  color: var(--color-muted);
  font-size: 16px;
}

.ai-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--space-base);
  margin-bottom: var(--space-xl);
}

.ai-button {
  height: 44px;
  padding: 0 var(--space-md);
  border: none;
  border-radius: var(--rounded-pill);
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.ai-button:disabled {
  background: var(--color-primary-disabled);
  cursor: not-allowed;
}

.ai-disabled {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
  background: var(--color-surface-soft);
}

.ai-disabled-title {
  margin: 0 0 var(--space-xs);
  color: var(--color-ink);
  font-size: 18px;
  font-weight: 600;
}

.ai-disabled-body {
  margin: 0;
  color: var(--color-body);
}

.ai-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-lg);
}

.muted {
  color: var(--color-muted);
}

.grid-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-lg);
}

.feature-card {
  background: var(--color-canvas);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
  border: 1px solid var(--color-hairline);
}

.ai-card {
  display: flex;
  flex-direction: column;
}

.card-kicker {
  margin: 0 0 var(--space-xs);
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.card-kicker-gap {
  margin-top: var(--space-lg);
}

.ai-summary {
  margin: 0 0 var(--space-base);
  color: var(--color-body);
  line-height: 1.6;
}

.ai-meta {
  margin: auto 0 0;
  color: var(--color-muted);
  font-size: 13px;
}

.ai-list {
  margin: 0;
  padding-left: 18px;
  color: var(--color-body);
}

.ai-list li + li {
  margin-top: var(--space-xs);
}

.asset-plate {
  width: 40px;
  height: 40px;
  border-radius: var(--rounded-full);
  background: var(--color-surface-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-ink);
  margin-bottom: var(--space-base);
}

.asset-plate.sm {
  width: 32px;
  height: 32px;
  font-size: 12px;
  margin-bottom: 0;
}

.title-md {
  margin: 0 0 var(--space-xs);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-ink);
}

.amount {
  margin: 0 0 var(--space-xxs);
  font-size: 18px;
  color: var(--color-ink);
}

.pct {
  margin: 0 0 var(--space-base);
  font-size: 13px;
  color: var(--color-muted);
}

.bar {
  height: 6px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: var(--rounded-pill);
  background: var(--color-primary);
}

.table-wrap {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xl);
  overflow: hidden;
}

.asset-row {
  display: grid;
  grid-template-columns: 32px 1fr auto auto;
  align-items: center;
  gap: var(--space-base);
  padding: var(--space-base) var(--space-lg);
  border-bottom: 1px solid var(--color-hairline);
  background: var(--color-canvas);
}

.asset-row:last-child {
  border-bottom: none;
}

.name {
  font-weight: 600;
  color: var(--color-ink);
}

.price {
  font-size: 16px;
  color: var(--color-ink);
}

.change {
  font-size: 16px;
  min-width: 4rem;
  text-align: right;
  color: var(--color-body);
}

.change.up {
  color: var(--color-semantic-up);
}

.change.muted {
  color: var(--color-muted);
}

@media (max-width: 1024px) {
  .grid-cards,
  .ai-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 900px) {
  .hero-inner {
    grid-template-columns: 1fr;
  }

  .mock-stack {
    min-height: auto;
  }

  .card-b {
    position: relative;
    right: auto;
    bottom: auto;
    transform: none;
    margin-top: var(--space-base);
    max-width: none;
  }
}

@media (max-width: 640px) {
  .grid-cards,
  .ai-grid {
    grid-template-columns: 1fr;
  }

  .ai-head {
    flex-direction: column;
    align-items: stretch;
  }

  .asset-row {
    grid-template-columns: 32px 1fr;
    grid-template-rows: auto auto;
  }

  .price,
  .change {
    grid-column: 2;
    text-align: left;
  }
}
</style>
