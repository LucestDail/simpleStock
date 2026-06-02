<script setup>
import { computed, markRaw, onMounted, onUnmounted, ref } from 'vue';
import LiveTickerBar from '../components/workspace/LiveTickerBar.vue';
import DetailDrawer from '../components/workspace/DetailDrawer.vue';
import OverviewPanel from '../components/workspace/OverviewPanel.vue';
import ChatPanel from '../components/workspace/ChatPanel.vue';
import ManagerHubPanel from '../components/workspace/ManagerHubPanel.vue';
import ProfilePanel from '../components/workspace/ProfilePanel.vue';
import SystemPanel from '../components/workspace/SystemPanel.vue';
import { usePortfolio } from '../composables/usePortfolio';
import { useChat } from '../composables/useChat';
import { useProfile } from '../composables/useProfile';
import { useUi } from '../composables/useUi';
import { useWorkspace } from '../composables/useWorkspace';
import { useRealtimeSubscription } from '../composables/useRealtimeSubscription';

const { fetchPortfolio } = usePortfolio();
const { fetchThreads } = useChat();
const { fetchProfile, profile } = useProfile();
const { notify } = useUi();
const { columns, focusMode, recordActivity, openDrawer } = useWorkspace();
const { connect, disconnect } = useRealtimeSubscription();
const viewportWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth);
const showExtras = ref(true);

const panelComponents = {
  status: markRaw(OverviewPanel),
  overview: markRaw(OverviewPanel),
  chat: markRaw(ChatPanel),
  managerHub: markRaw(ManagerHubPanel),
  profile: markRaw(ProfilePanel),
  system: markRaw(SystemPanel),
};

const workspaceClass = computed(() => `workspace-main--${focusMode.value || 'balanced'}`);
const isCompactLayout = computed(() => viewportWidth.value <= 1180);
const isStackedLayout = computed(() => viewportWidth.value <= 860);
const hasProfileContent = computed(() => {
  const userProfile = profile.value.userProfile || {};
  const aiProfile = profile.value.aiProfile || {};
  return Boolean(
    userProfile.displayName ||
      userProfile.investorType ||
      userProfile.investmentGoal ||
      userProfile.riskTolerance ||
      userProfile.notes ||
      aiProfile.summary ||
      (aiProfile.inferredTraits || []).length
  );
});

const finalColumns = computed(() => {
  const left = columns.value.left
    .filter((panel) => panel.id !== 'status')
    .map((panel) => {
    if (panel.id === 'overview') return { ...panel, span: 'xl' };
    return panel;
  });

  const right = columns.value.right
    .filter((panel) => panel.id === 'managerHub' || (panel.id === 'profile' && hasProfileContent.value))
    .map((panel) => {
      if (panel.id === 'managerHub') return { ...panel, span: 'full' };
      return panel;
    });


  return {
    left,
    center: columns.value.center.map((panel) => ({ ...panel, span: 'full' })),
    right,
  };
});

const orderedColumns = computed(() => {
  if (!showExtras.value) {
    return [{ key: 'center', panels: finalColumns.value.center, columnClass: 'workspace-column--chat' }];
  }
  if (isStackedLayout.value) {
    return [
      { key: 'center', panels: finalColumns.value.center, columnClass: 'workspace-column--chat' },
      { key: 'left', panels: finalColumns.value.left, columnClass: 'workspace-column--dashboard' },
      { key: 'right', panels: finalColumns.value.right, columnClass: 'workspace-column--manager' },
    ];
  }
  return [
    { key: 'left', panels: finalColumns.value.left, columnClass: 'workspace-column--dashboard' },
    { key: 'center', panels: finalColumns.value.center, columnClass: 'workspace-column--chat' },
    { key: 'right', panels: finalColumns.value.right, columnClass: 'workspace-column--manager' },
  ];
});

const workspaceGridStyle = computed(() => {
  if (!showExtras.value) {
    return { gridTemplateColumns: '1fr' };
  }
  if (isStackedLayout.value) {
    return { gridTemplateColumns: '1fr' };
  }

  const leftCount = finalColumns.value.left.length;
  const rightCount = finalColumns.value.right.length;
  const isChatMode = focusMode.value === 'chat';
  const leftTrack = leftCount
    ? `minmax(${isCompactLayout.value ? 220 : 270}px, ${isCompactLayout.value ? (isChatMode ? 1.65 : 1.85) : (isChatMode ? 2.55 : 2.95)}fr)`
    : '0px';
  const centerTrack = `minmax(${isCompactLayout.value ? (isChatMode ? 420 : 360) : (isChatMode ? 430 : 380)}px, ${isCompactLayout.value ? (isChatMode ? 6.1 : 5.7) : (isChatMode ? 5.5 : 5)}fr)`;
  const rightTrack = rightCount
    ? `minmax(${isCompactLayout.value ? 200 : 260}px, ${isCompactLayout.value ? 1.35 : 2.4}fr)`
    : '0px';
  return {
    gridTemplateColumns: `${leftTrack} ${centerTrack} ${rightTrack}`,
  };
});

function handleResize() {
  viewportWidth.value = window.innerWidth;
}

onMounted(async () => {
  window.addEventListener('resize', handleResize, { passive: true });
  try {
    await Promise.all([fetchPortfolio(), fetchProfile(), fetchThreads({ autoCreate: true })]);
    await connect();
    recordActivity({
      type: 'system',
      title: '워크스페이스 로드',
      description: '대시보드·대화·매니저 허브가 준비되었습니다.',
    });
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '워크스페이스 초기화에 실패했습니다.',
    });
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  disconnect();
});
</script>

<template>
  <div class="workspace" :class="{ 'workspace--stacked': isStackedLayout }">
    <LiveTickerBar
      :show-extras="showExtras"
      @toggle-extras="showExtras = !showExtras"
      @open-settings="openDrawer('settings', null, '설정')"
    />

    <main class="workspace-main" :class="workspaceClass" :style="workspaceGridStyle">
      <section
        v-for="column in orderedColumns"
        :key="column.key"
        class="workspace-column"
        :class="[column.columnClass, { 'workspace-column--stacked': isStackedLayout }]"
      >
        <component
          :is="panelComponents[panel.id]"
          v-for="panel in column.panels"
          :key="panel.id"
          :panel="panel"
        />
      </section>
    </main>

    <DetailDrawer />
  </div>
</template>

<style scoped>
.workspace {
  height: 100dvh;
  padding: 6px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 6px;
  overflow: hidden;
  background:
    radial-gradient(circle at top left, rgba(110, 123, 255, 0.04), transparent 24%),
    radial-gradient(circle at right top, rgba(255, 255, 255, 0.02), transparent 18%),
    var(--color-canvas);
}

.workspace-main {
  min-height: 0;
  display: grid;
  gap: 6px;
  align-items: stretch;
  overflow: hidden;
  transition: grid-template-columns 0.22s ease;
}

.workspace-column {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}

/* 좌측: 대시보드 — 기존 패널 타이포 유지 */
.workspace-column--dashboard :deep(.panel-shell__title) {
  font-size: 16px;
}

.workspace-column--dashboard :deep(.panel-shell__subtitle) {
  font-size: 12px;
}

/* 중앙: 대화 — 보통 크기 */
.workspace-column--chat {
  font-size: 15px;
}

.workspace-column--chat :deep(.panel-shell__title) {
  font-size: 16px;
}

.workspace-column--chat :deep(.chat-bubble),
.workspace-column--chat :deep(.composer-input),
.workspace-column--chat :deep(.thread-item strong) {
  font-size: 15px;
}

/* 우측: 매니저 허브 — 작게(한 단계 상향) */
.workspace-column--manager {
  font-size: 13px;
}

.workspace-column--manager :deep(.panel-shell__body) {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 0;
}

.workspace-column--manager :deep(.manager-hub-shell) {
  flex: 1;
  min-height: 0;
}

.workspace--stacked {
  height: auto;
  min-height: 100dvh;
  overflow: auto;
}

.workspace--stacked .workspace-main {
  overflow: visible;
}

.workspace-column--stacked {
  overflow: visible;
}

.workspace-column--stacked :deep(.panel-shell) {
  flex: none;
}

@media (max-width: 1380px) {
  .workspace {
    padding: var(--space-sm);
  }
}
</style>
