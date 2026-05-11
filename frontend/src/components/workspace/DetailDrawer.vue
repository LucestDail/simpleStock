<script setup>
import { computed } from 'vue';
import { CATEGORIES, formatKRW, usePortfolio } from '../../composables/usePortfolio';
import { useChat } from '../../composables/useChat';
import { useProfile } from '../../composables/useProfile';
import { useWorkspace } from '../../composables/useWorkspace';

const { holdings, categoryShares, manager, system } = usePortfolio();
const { threads, activeThread, messages } = useChat();
const { profile } = useProfile();
const { drawer, closeDrawer } = useWorkspace();

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
          <template v-if="drawer.type === 'assetDetail'">
            <div v-if="activeHolding" class="detail-block">
              <strong>{{ activeHolding.name }}</strong>
              <p>분류: {{ CATEGORIES.find((item) => item.id === activeHolding.category)?.label }}</p>
              <p class="mono-num">{{ formatKRW(activeHolding.amount) }}</p>
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
  background: rgba(10, 11, 13, 0.28);
}

.drawer {
  position: absolute;
  top: var(--space-base);
  right: var(--space-base);
  bottom: var(--space-base);
  width: min(420px, calc(100vw - 32px));
  border-radius: var(--rounded-xl);
  background: var(--color-canvas);
  border: 1px solid var(--color-hairline);
  box-shadow: 0 20px 56px rgba(0, 0, 0, 0.16);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.drawer-head {
  padding: var(--space-lg);
  border-bottom: 1px solid var(--color-hairline);
  display: flex;
  justify-content: space-between;
  gap: var(--space-base);
  align-items: flex-start;
}

.drawer-kicker {
  margin: 0 0 4px;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.drawer-title {
  margin: 0;
  color: var(--color-ink);
  font-size: 22px;
  font-weight: 600;
}

.drawer-close {
  border: none;
  background: var(--color-surface-strong);
  border-radius: var(--rounded-pill);
  padding: 10px 14px;
  color: var(--color-ink);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.drawer-body {
  padding: var(--space-lg);
  overflow: auto;
}

.detail-block {
  display: grid;
  gap: var(--space-sm);
  color: var(--color-body);
  line-height: 1.65;
}

.detail-block strong {
  color: var(--color-ink);
  font-size: 18px;
}

.simple-list,
.message-list {
  margin: 0;
  padding-left: 18px;
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
  padding: var(--space-base);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
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
