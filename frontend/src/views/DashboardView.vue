<script setup>
import { onMounted, computed } from 'vue';
import { usePortfolio, formatKRW } from '../composables/usePortfolio';

const {
  fetchPortfolio,
  total,
  categoryShares,
  lastSnapshot,
  dayOverDay,
  loading,
  error,
} = usePortfolio();

onMounted(fetchPortfolio);

const donutGradient = computed(() => {
  const parts = categoryShares.value.filter((c) => c.amount > 0);
  if (!parts.length) {
    return 'conic-gradient(var(--color-surface-strong) 0deg 360deg)';
  }
  const colors = [
    '#16181c',
    '#5b616e',
    '#7c828a',
    '#a8acb3',
    '#0052ff',
  ];
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
          <div v-if="dayOverDay" class="delta-row">
            <span class="label">직전 스냅샷 대비</span>
            <span
              class="mono-num delta"
              :class="dayOverDay.delta >= 0 ? 'up' : 'down'"
            >
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

    <section class="band-soft">
      <div class="container">
        <h2 class="section-title">포트폴리오 비율</h2>
        <p class="section-lead">예금 · 적금 · 주식 · 펀드 · 연금별 자산 비중입니다.</p>

        <div v-if="loading" class="muted">불러오는 중…</div>
        <div v-else class="grid-cards">
          <article
            v-for="c in categoryShares"
            :key="c.id"
            class="feature-card"
          >
            <div class="asset-plate">{{ c.label.charAt(0) }}</div>
            <h3 class="title-md">{{ c.label }}</h3>
            <p class="mono-num amount">{{ formatKRW(c.amount) }}</p>
            <p class="pct">{{ c.pct }}% of total</p>
            <div class="bar">
              <div
                class="bar-fill"
                :style="{ width: `${Math.min(100, c.pct)}%` }"
              />
            </div>
          </article>
        </div>
      </div>
    </section>

    <section class="band-white">
      <div class="container">
        <h2 class="section-title">자산 구성 (표)</h2>
        <div class="table-wrap">
          <div
            v-for="c in categoryShares"
            :key="c.id"
            class="asset-row"
          >
            <div class="asset-plate sm">{{ c.label.charAt(0) }}</div>
            <div class="row-main">
              <span class="name">{{ c.label }}</span>
            </div>
            <span class="mono-num price">{{ formatKRW(c.amount) }}</span>
            <span
              class="mono-num change"
              :class="c.pct >= 50 ? 'up' : c.pct <= 0 ? 'muted' : ''"
            >
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

@media (max-width: 900px) {
  .hero-inner {
    grid-template-columns: 1fr;
  }
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
  max-width: 36ch;
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

@media (max-width: 900px) {
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
  margin: 0 0 var(--space-xl);
  color: var(--color-muted);
  font-size: 16px;
}

.muted {
  color: var(--color-muted);
}

.grid-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-lg);
}

@media (max-width: 1024px) {
  .grid-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .grid-cards {
    grid-template-columns: 1fr;
  }
}

.feature-card {
  background: var(--color-canvas);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
  border: 1px solid var(--color-hairline);
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

@media (max-width: 640px) {
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
