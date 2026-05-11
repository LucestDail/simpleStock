<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { formatKRW, usePortfolio } from '../../composables/usePortfolio';
import { useChat } from '../../composables/useChat';
import { useProfile } from '../../composables/useProfile';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { total, dayOverDay, categoryShares, manager } = usePortfolio();
const { activeThread, messages } = useChat();
const { profile } = useProfile();
const { generatedInsights, openDrawer } = useWorkspace();

const fallbackCards = computed(() => {
  const dominant = [...categoryShares.value].sort((a, b) => b.amount - a.amount)[0] || null;
  return [
    {
      id: 'fallback-portfolio',
      title: '포트폴리오 시그널',
      summary: dominant
        ? `${dominant.label} 비중이 ${dominant.pct}%로 가장 큽니다.`
        : '등록된 자산이 적어 포트폴리오 시그널을 계산하는 중입니다.',
      tone: dominant && dominant.pct >= 55 ? 'warning' : 'positive',
      metrics: [
        { label: '총 자산', value: formatKRW(total.value) },
        {
          label: '직전 대비',
          value:
            dayOverDay.value && dayOverDay.value.delta != null
              ? `${dayOverDay.value.delta >= 0 ? '+' : ''}${formatKRW(dayOverDay.value.delta)}`
              : '데이터 없음',
        },
      ],
      bullets: [
        dominant ? `${dominant.label} 집중도를 우선 체크하세요.` : '자산 입력 후 집중도 분석이 더 정교해집니다.',
      ],
    },
    {
      id: 'fallback-conversation',
      title: '대화 컨텍스트',
      summary: activeThread.value?.title || '현재 활성 대화가 없습니다.',
      tone: 'primary',
      metrics: [
        { label: '최근 메시지', value: `${messages.value.length}개` },
        {
          label: '프로필 상태',
          value: profile.value.aiProfile?.summary ? 'AI 요약 반영됨' : '학습 중',
        },
      ],
      bullets: [
        manager.value.latestReport ? '최근 브리핑을 대화와 함께 참고하고 있습니다.' : '브리핑 생성 후 더 풍부한 카드가 나타납니다.',
      ],
    },
  ];
});

const cards = computed(() =>
  (generatedInsights.value.length ? generatedInsights.value : fallbackCards.value)
    .map((card) => ({
      ...card,
      metrics: (card.metrics || []).slice(0, 2),
      bullets: (card.bullets || []).slice(0, 2),
    }))
    .slice(0, 1)
);
</script>

<template>
  <PanelShell
    title="라이브 인사이트"
    subtitle="insights"
    :span="panel.span"
    :highlighted="panel.highlighted"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('insight', null, '실시간 인사이트')">
        상세
      </button>
    </template>

    <div class="insight-list">
      <article
        v-for="card in cards"
        :key="card.id"
        class="insight-card"
        :class="`insight-card--${card.tone || 'default'}`"
      >
        <div class="insight-head">
          <strong>{{ card.title }}</strong>
          <span>{{ card.tone === 'warning' ? '주의' : card.tone === 'positive' ? '양호' : card.tone === 'primary' ? '핵심' : '실시간' }}</span>
        </div>
        <p class="insight-summary">{{ card.summary }}</p>
        <div v-if="card.metrics?.length" class="metric-grid">
          <div v-for="metric in card.metrics" :key="`${card.id}-${metric.label}`" class="metric-card">
            <span>{{ metric.label }}</span>
            <strong>{{ metric.value }}</strong>
          </div>
        </div>
        <ul v-if="card.bullets?.length" class="bullet-list">
          <li v-for="bullet in card.bullets" :key="bullet">{{ bullet }}</li>
        </ul>
      </article>
    </div>
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
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}

.insight-list {
  display: grid;
  gap: 5px;
  min-height: 0;
  overflow: auto;
}

.insight-card {
  display: grid;
  gap: 4px;
  padding: 6px 8px;
  border-radius: var(--rounded-lg);
  border: 1px solid var(--color-hairline);
  background: rgba(255, 255, 255, 0.02);
}

.insight-card--primary {
  border-color: rgba(110, 123, 255, 0.18);
  background: rgba(110, 123, 255, 0.06);
}

.insight-card--positive {
  border-color: rgba(5, 177, 105, 0.28);
}

.insight-card--warning {
  border-color: rgba(244, 176, 0, 0.32);
  background: rgba(244, 176, 0, 0.06);
}

.insight-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: center;
}

.insight-head strong {
  color: var(--color-ink);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.insight-head span {
  color: var(--color-muted);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.insight-summary {
  margin: 0;
  color: var(--color-body);
  font-size: 9px;
  line-height: 1.2;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
}

.metric-card {
  display: grid;
  gap: 2px;
  padding: 4px 6px;
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.03);
}

.metric-card span {
  color: var(--color-muted);
  font-size: 8px;
}

.metric-card strong {
  color: var(--color-ink);
  font-size: 9px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.bullet-list {
  margin: 0;
  padding-left: 14px;
  color: var(--color-body);
  font-size: 9px;
  line-height: 1.2;
}

@media (max-width: 1280px) {
  .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>
