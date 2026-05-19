<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { useChat } from '../../composables/useChat';
import { useProfile } from '../../composables/useProfile';
import { useWorkspace } from '../../composables/useWorkspace';
import { useInsightDetail } from '../../composables/useInsightDetail';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { activeThread, messages } = useChat();
const { profile } = useProfile();
const { openDrawer } = useWorkspace();
const { portfolioSignalCard, managerBriefSection, nextManagerBrief, aiInsightCards } = useInsightDetail();

const panelCard = computed(() => {
  if (aiInsightCards.value.length) {
    return {
      ...aiInsightCards.value[0],
      toneLabel:
        aiInsightCards.value[0].tone === 'warning'
          ? '주의'
          : aiInsightCards.value[0].tone === 'positive'
            ? '양호'
            : aiInsightCards.value[0].tone === 'primary'
              ? '핵심'
              : '실시간',
    };
  }
  const signal = portfolioSignalCard.value;
  const brief = managerBriefSection.value;
  return {
    id: signal.id,
    title: signal.title,
    summary: brief.available
      ? `${signal.summary} 최근 브리핑: ${String(brief.summary || '').slice(0, 72)}…`
      : signal.summary,
    tone: signal.tone,
    toneLabel: signal.toneLabel,
    metrics: signal.metrics.slice(0, 2),
    bullets: [
      nextManagerBrief.value
        ? `다음 보고 ${nextManagerBrief.value.label}`
        : signal.bullets[0],
    ],
  };
});

const conversationHint = computed(() => ({
  title: '대화 컨텍스트',
  summary: activeThread.value?.title || '활성 대화 없음',
  metrics: [
    { label: '메시지', value: `${messages.value.length}개` },
    {
      label: '프로필',
      value: profile.value.aiProfile?.summary ? 'AI 요약 반영' : '학습 중',
    },
  ],
}));
</script>

<template>
  <PanelShell
    title="라이브 인사이트"
    subtitle="insights"
    :span="panel.span"
    :highlighted="panel.highlighted"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('insight', null, '포트폴리오 인사이트')">
        상세
      </button>
    </template>

    <div class="insight-list">
      <article class="insight-card" :class="`insight-card--${panelCard.tone || 'default'}`">
        <div class="insight-head">
          <strong>{{ panelCard.title }}</strong>
          <span>{{ panelCard.toneLabel }}</span>
        </div>
        <p class="insight-summary">{{ panelCard.summary }}</p>
        <div v-if="panelCard.metrics?.length" class="metric-grid">
          <div
            v-for="metric in panelCard.metrics"
            :key="`${panelCard.id}-${metric.label}`"
            class="metric-card"
          >
            <span>{{ metric.label }}</span>
            <strong>{{ metric.value }}</strong>
          </div>
        </div>
        <ul v-if="panelCard.bullets?.length" class="bullet-list">
          <li v-for="bullet in panelCard.bullets" :key="bullet">{{ bullet }}</li>
        </ul>
      </article>

      <article class="insight-card insight-card--compact">
        <div class="insight-head">
          <strong>{{ conversationHint.title }}</strong>
        </div>
        <p class="insight-summary">{{ conversationHint.summary }}</p>
        <div class="metric-grid">
          <div
            v-for="metric in conversationHint.metrics"
            :key="metric.label"
            class="metric-card"
          >
            <span>{{ metric.label }}</span>
            <strong>{{ metric.value }}</strong>
          </div>
        </div>
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
  font-size: 12px;
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

.insight-card--compact {
  opacity: 0.92;
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
  font-size: 12px;
  overflow-wrap: anywhere;
}

.insight-head span {
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.insight-summary {
  margin: 0;
  color: var(--color-body);
  font-size: 11px;
  line-height: 1.2;
  display: -webkit-box;
  -webkit-line-clamp: 3;
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
  font-size: 10px;
}

.metric-card strong {
  color: var(--color-ink);
  font-size: 11px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.bullet-list {
  margin: 0;
  padding-left: 14px;
  color: var(--color-body);
  font-size: 11px;
  line-height: 1.2;
}

@media (max-width: 1280px) {
  .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>
