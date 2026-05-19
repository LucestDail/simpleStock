<script setup>
import { computed, ref } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useUi } from '../../composables/useUi';
import { useWorkspace } from '../../composables/useWorkspace';
import { useInsightDetail } from '../../composables/useInsightDetail';
import { useScheduledTasks } from '../../composables/useScheduledTasks';

defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { manager, system, runManagerReview } = usePortfolio();
const { notify } = useUi();
const { activityFeed, recordActivity, openDrawer, applyWorkspacePatch, generatedInsights } = useWorkspace();
const {
  portfolioSignalCard,
  managerBriefSection,
  nextManagerBrief,
  aiInsightCards,
  visibleCategories,
} = useInsightDetail();
const { displayTasks } = useScheduledTasks();

const busy = ref(false);
const expandedSection = ref('brief');

const latestReport = computed(() => manager.value?.latestReport || null);
const upcomingTasks = computed(() =>
  displayTasks.value
    .filter((task) => task.enabled)
    .slice(0, 5)
);
const recentActivities = computed(() => activityFeed.value.slice(0, 10));
const primaryAiCard = computed(() => aiInsightCards.value[0] || null);

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatBriefDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function toggleSection(id) {
  expandedSection.value = expandedSection.value === id ? '' : id;
}

async function generateBrief() {
  busy.value = true;
  try {
    await runManagerReview();
    notify({ tone: 'success', message: '브리핑을 생성했습니다.' });
    recordActivity({
      type: 'manager',
      title: '브리핑 생성',
      description: 'Quant Manager 일일 브리핑이 갱신되었습니다.',
    });
    expandedSection.value = 'brief';
    applyWorkspacePatch(
      {
        focusMode: 'manager',
        highlightPanelIds: ['managerHub', 'chat'],
        panelPatches: [{ id: 'managerHub', column: 'right', span: 'full', priority: 5, visible: true }],
        reason: '새 브리핑이 생성되어 매니저 허브를 갱신합니다.',
      },
      'local-action'
    );
  } catch (error) {
    notify({ tone: 'error', message: error.message || '브리핑 생성에 실패했습니다.' });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PanelShell
    title="매니저 허브"
    subtitle="quant ops"
    :span="panel.span"
    :highlighted="panel.highlighted"
    :loading="busy"
    fill
    class="manager-hub-shell"
  >
    <template #actions>
      <button type="button" class="hub-btn" @click="openDrawer('insight', null, '포트폴리오 인사이트')">
        인사이트
      </button>
      <button type="button" class="hub-btn" @click="openDrawer('settings', null, '설정')">설정</button>
      <button
        type="button"
        class="hub-btn hub-btn--primary"
        :disabled="busy || !system.aiConfigured"
        @click="generateBrief"
      >
        {{ busy ? '생성 중' : '브리핑' }}
      </button>
    </template>

    <section class="hub-block hub-block--signal">
      <button type="button" class="hub-block__head" @click="toggleSection('signal')">
        <span class="hub-block__label">포트폴리오 시그널</span>
        <span class="hub-badge" :class="`hub-badge--${portfolioSignalCard.tone}`">
          {{ portfolioSignalCard.toneLabel }}
        </span>
      </button>
      <div class="hub-block__body">
        <p class="hub-lead">{{ portfolioSignalCard.summary }}</p>
        <div class="hub-metrics">
          <div
            v-for="metric in portfolioSignalCard.metrics.slice(0, 3)"
            :key="metric.label"
            class="hub-metric"
          >
            <span>{{ metric.label }}</span>
            <strong>{{ metric.value }}</strong>
          </div>
        </div>
        <div v-if="visibleCategories.length" class="hub-chips">
          <span v-for="row in visibleCategories.slice(0, 4)" :key="row.id" class="hub-chip">
            {{ row.label }} {{ row.pct }}%
          </span>
        </div>
        <article v-if="primaryAiCard" class="hub-ai-card">
          <span class="hub-ai-card__tag">대화 인사이트</span>
          <strong>{{ primaryAiCard.title }}</strong>
          <p>{{ primaryAiCard.summary }}</p>
        </article>
        <p v-else-if="generatedInsights.length === 0" class="hub-hint">
          대화를 이어가면 AI가 이 구역에 맞춤 시그널을 채웁니다.
        </p>
      </div>
    </section>

    <section class="hub-block">
      <button type="button" class="hub-block__head" @click="toggleSection('brief')">
        <span class="hub-block__label">Quant Manager 브리핑</span>
        <span v-if="latestReport" class="hub-meta">{{ formatBriefDate(latestReport.createdAt) }}</span>
        <span v-else class="hub-meta">미생성</span>
      </button>
      <div v-show="expandedSection === 'brief'" class="hub-block__body">
        <div v-if="!system.aiConfigured" class="hub-empty">
          Gemini API 키가 없어 브리핑이 비활성화되어 있습니다.
        </div>
        <template v-else-if="managerBriefSection.available">
          <p class="hub-lead">{{ managerBriefSection.summary }}</p>
          <p v-if="managerBriefSection.dailyObjective" class="hub-copy">
            {{ managerBriefSection.dailyObjective }}
          </p>
          <ul v-if="managerBriefSection.actionItems.length" class="hub-list">
            <li v-for="item in managerBriefSection.actionItems.slice(0, 3)" :key="item">{{ item }}</li>
          </ul>
          <button type="button" class="hub-link" @click="openDrawer('managerBrief', null, '브리핑 상세')">
            전체 브리핑 보기 →
          </button>
        </template>
        <div v-else class="hub-empty">
          예약된 평일 6회 보고 또는 「브리핑」 버튼으로 첫 리포트를 생성하세요.
        </div>
      </div>
    </section>

    <section class="hub-block">
      <button type="button" class="hub-block__head" @click="toggleSection('schedule')">
        <span class="hub-block__label">예정 작업</span>
        <span class="hub-meta">{{ upcomingTasks.length }}건 활성</span>
      </button>
      <div v-show="expandedSection === 'schedule'" class="hub-block__body">
        <ul v-if="upcomingTasks.length" class="hub-schedule">
          <li v-for="task in upcomingTasks" :key="task.id">
            <div class="hub-schedule__main">
              <strong>{{ task.title }}</strong>
              <span>{{ task.displayRunLabel }}</span>
            </div>
            <span class="hub-schedule__type">{{ task.taskType || 'custom' }}</span>
          </li>
        </ul>
        <p v-else class="hub-empty">활성 예약이 없습니다. 대화로 「매일 9시 브리핑」처럼 요청하세요.</p>
      </div>
    </section>

    <section class="hub-block hub-block--activity">
      <button type="button" class="hub-block__head" @click="toggleSection('activity')">
        <span class="hub-block__label">실시간 활동</span>
        <span class="hub-meta">{{ recentActivities.length }}건</span>
      </button>
      <div v-show="expandedSection === 'activity'" class="hub-block__body hub-block__body--scroll">
        <ul v-if="recentActivities.length" class="hub-timeline">
          <li v-for="item in recentActivities" :key="item.id">
            <span class="hub-timeline__dot" :class="`hub-timeline__dot--${item.tone}`" />
            <div class="hub-timeline__copy">
              <strong>{{ item.title }}</strong>
              <p>{{ item.description }}</p>
            </div>
            <time>{{ formatTime(item.createdAt) }}</time>
          </li>
        </ul>
        <p v-else class="hub-empty">브리핑·대화·시세 갱신이 여기에 쌓입니다.</p>
      </div>
    </section>
  </PanelShell>
</template>

<style scoped>
.manager-hub-shell :deep(.panel-shell__title) {
  font-size: 14px;
}

.manager-hub-shell :deep(.panel-shell__subtitle) {
  font-size: 12px;
}

.manager-hub-shell :deep(.panel-shell__body) {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 0;
  overflow: auto;
}

.hub-btn {
  height: 22px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-pill);
  padding: 0 7px;
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.hub-btn--primary {
  border-color: transparent;
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.hub-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hub-status-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}

.hub-pill {
  padding: 2px 6px;
  border-radius: var(--rounded-pill);
  border: 1px solid var(--color-hairline-soft);
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.hub-pill--positive {
  border-color: rgba(5, 177, 105, 0.35);
  color: #05b169;
}

.hub-pill--warning {
  border-color: rgba(244, 176, 0, 0.35);
  color: #f4b000;
}

.hub-pill--accent {
  border-color: rgba(110, 123, 255, 0.28);
  color: #9aa8ff;
}

.hub-block {
  border: 1px solid var(--color-hairline-soft);
  border-radius: var(--rounded-lg);
  background: rgba(255, 255, 255, 0.015);
  overflow: hidden;
}

.hub-block--signal {
  border-color: rgba(110, 123, 255, 0.14);
}

.hub-block--activity {
  flex: 1;
  min-height: 120px;
  display: flex;
  flex-direction: column;
}

.hub-block__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: none;
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
  text-align: left;
}

.hub-block__label {
  flex: 1;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.hub-meta {
  color: var(--color-muted);
  font-size: 10px;
}

.hub-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.hub-badge--positive {
  color: #05b169;
}

.hub-badge--warning {
  color: #f4b000;
}

.hub-block__body {
  padding: 0 8px 8px;
  display: grid;
  gap: 6px;
}

.hub-block__body--scroll {
  max-height: 220px;
  overflow: auto;
}

.hub-lead {
  margin: 0;
  color: var(--color-ink);
  font-size: 12px;
  line-height: 1.35;
}

.hub-copy {
  margin: 0;
  color: var(--color-body);
  font-size: 12px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hub-hint,
.hub-empty {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.3;
}

.hub-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
}

.hub-metric {
  padding: 4px 6px;
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.03);
  display: grid;
  gap: 2px;
}

.hub-metric span {
  color: var(--color-muted);
  font-size: 10px;
}

.hub-metric strong {
  color: var(--color-ink);
  font-size: 12px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.hub-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.hub-chip {
  padding: 2px 6px;
  border-radius: var(--rounded-pill);
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-body);
  font-size: 10px;
}

.hub-ai-card {
  padding: 6px;
  border-radius: var(--rounded-md);
  border: 1px dashed rgba(110, 123, 255, 0.25);
  display: grid;
  gap: 3px;
}

.hub-ai-card__tag {
  font-size: 8px;
  color: #9aa8ff;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.hub-ai-card strong {
  font-size: 12px;
  color: var(--color-ink);
}

.hub-ai-card p {
  margin: 0;
  font-size: 12px;
  color: var(--color-body);
  line-height: 1.3;
}

.hub-list {
  margin: 0;
  padding-left: 14px;
  color: var(--color-body);
  font-size: 12px;
  line-height: 1.35;
}

.hub-link {
  justify-self: start;
  border: none;
  background: none;
  color: #9aa8ff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.hub-schedule {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 5px;
}

.hub-schedule li {
  display: grid;
  gap: 2px;
  padding: 5px 6px;
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.02);
}

.hub-schedule__main {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  align-items: baseline;
}

.hub-schedule__main strong {
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hub-schedule__main span {
  color: #9aa8ff;
  font-size: 10px;
  flex-shrink: 0;
}

.hub-schedule__type {
  color: var(--color-muted);
  font-size: 8px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.hub-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.hub-timeline li {
  display: grid;
  grid-template-columns: 6px minmax(0, 1fr) auto;
  gap: 6px;
  align-items: start;
}

.hub-timeline__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-top: 4px;
  background: var(--color-primary);
}

.hub-timeline__dot--warning {
  background: var(--color-accent-yellow);
}

.hub-timeline__dot--error {
  background: var(--color-semantic-down);
}

.hub-timeline__copy strong {
  display: block;
  color: var(--color-ink);
  font-size: 12px;
  line-height: 1.2;
}

.hub-timeline__copy p {
  margin: 2px 0 0;
  color: var(--color-muted);
  font-size: 10px;
  line-height: 1.25;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hub-timeline time {
  color: var(--color-muted-soft);
  font-size: 8px;
  font-variant-numeric: tabular-nums;
}
</style>
