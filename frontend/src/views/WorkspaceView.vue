<script setup>
import { computed, markRaw, onMounted, onUnmounted, ref } from 'vue';
import StatusStrip from '../components/workspace/StatusStrip.vue';
import DetailDrawer from '../components/workspace/DetailDrawer.vue';
import OverviewPanel from '../components/workspace/OverviewPanel.vue';
import HoldingsPanel from '../components/workspace/HoldingsPanel.vue';
import SnapshotsPanel from '../components/workspace/SnapshotsPanel.vue';
import ChatPanel from '../components/workspace/ChatPanel.vue';
import InsightsPanel from '../components/workspace/InsightsPanel.vue';
import ActivityPanel from '../components/workspace/ActivityPanel.vue';
import ManagerBriefPanel from '../components/workspace/ManagerBriefPanel.vue';
import ProfilePanel from '../components/workspace/ProfilePanel.vue';
import SystemPanel from '../components/workspace/SystemPanel.vue';
import { usePortfolio } from '../composables/usePortfolio';
import { useChat } from '../composables/useChat';
import { useProfile } from '../composables/useProfile';
import { useUi } from '../composables/useUi';
import { useWorkspace } from '../composables/useWorkspace';
import { useRealtimeSubscription } from '../composables/useRealtimeSubscription';

const { fetchPortfolio, holdings, manager, system } = usePortfolio();
const { fetchThreads } = useChat();
const { fetchProfile, profile } = useProfile();
const { notify } = useUi();
const { columns, focusMode, recordActivity, openDrawer, generatedInsights } = useWorkspace();
const { connect, disconnect } = useRealtimeSubscription();
const viewportWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth);

const panelComponents = {
  status: markRaw(StatusStrip),
  overview: markRaw(OverviewPanel),
  holdings: markRaw(HoldingsPanel),
  snapshots: markRaw(SnapshotsPanel),
  chat: markRaw(ChatPanel),
  insights: markRaw(InsightsPanel),
  activity: markRaw(ActivityPanel),
  managerBrief: markRaw(ManagerBriefPanel),
  profile: markRaw(ProfilePanel),
  system: markRaw(SystemPanel),
};

const workspaceClass = computed(() => `workspace-main--${focusMode.value || 'balanced'}`);
const isStackedLayout = computed(() => viewportWidth.value <= 980);
const hasManagerBrief = computed(() => Boolean(manager.value.latestReport));
const hasScheduledTasks = computed(() => (system.value.scheduledTasks || []).length > 0);
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
const hasInsights = computed(() => generatedInsights.value.length > 0 || holdings.value.length > 0);
const renderedColumns = computed(() => {
  const leftPanels = columns.value.left
    .map((panel) => {
      if (panel.id === 'status') {
        return { ...panel, span: columns.value.left.length <= 3 ? 'sm' : 'xs' };
      }
      if (panel.id === 'overview') {
        return { ...panel, span: 'sm' };
      }
      if (panel.id === 'system') {
        return { ...panel, span: hasManagerBrief.value || hasScheduledTasks.value ? 'xs' : 'sm' };
      }
      return panel;
    });

  const rightPanels = columns.value.right
    .filter((panel) => panel.id !== 'managerBrief' || hasManagerBrief.value)
    .filter((panel) => panel.id !== 'snapshots' || hasScheduledTasks.value)
    .filter((panel) => panel.id !== 'profile' || hasProfileContent.value)
    .filter((panel) => panel.id !== 'insights' || hasInsights.value)
    .map((panel, _, list) => {
      if (panel.id === 'profile') {
        return { ...panel, span: list.length <= 2 ? 'md' : 'sm' };
      }
      if (panel.id === 'insights') {
        return { ...panel, span: list.length <= 2 ? 'sm' : panel.span };
      }
      return panel;
    });

  return {
    left: leftPanels,
    center: columns.value.center,
    right: rightPanels,
  };
});
const finalColumns = computed(() => {
  const left = [...renderedColumns.value.left];
  const right = [...renderedColumns.value.right];

  if (!isStackedLayout.value) {
    const systemIndex = left.findIndex((panel) => panel.id === 'system');
    if (systemIndex >= 0) {
      const [systemPanel] = left.splice(systemIndex, 1);
      right.push({ ...systemPanel, column: 'right', span: 'sm' });
    }

    const statusIndex = left.findIndex((panel) => panel.id === 'status');
    if (statusIndex >= 0) {
      left[statusIndex] = { ...left[statusIndex], span: 'md' };
    }
  }

  return {
    left,
    center: renderedColumns.value.center,
    right,
  };
});
const workspaceGridStyle = computed(() => {
  if (isStackedLayout.value) {
    return {
      gridTemplateColumns: '1fr',
    };
  }

  const leftCount = finalColumns.value.left.length;
  const rightCount = finalColumns.value.right.length;
  const isChatMode = focusMode.value === 'chat';
  const leftTrack = leftCount
    ? `minmax(${leftCount >= 4 ? 250 : 270}px, ${isChatMode ? 2.55 : 2.95}fr)`
    : '0px';
  const centerTrack = `minmax(${isChatMode ? 430 : 380}px, ${isChatMode ? 5.5 : 5}fr)`;
  const rightTrack = rightCount
    ? `minmax(${rightCount <= 2 ? 250 : 230}px, ${rightCount <= 2 ? 2.7 : 2.45}fr)`
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
      description: '단일 화면 워크스페이스와 실시간 구독이 초기화되었습니다.',
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
    <header class="workspace-header">
      <div class="workspace-header__copy">
        <p class="workspace-kicker">SimpleStock Workspace</p>
        <h1 class="workspace-title">Quant Manager</h1>
      </div>
      <button type="button" class="workspace-settings-button" @click="openDrawer('settings', null, '설정')">
        설정
      </button>
    </header>

    <main class="workspace-main" :class="workspaceClass" :style="workspaceGridStyle">
      <section class="workspace-column" :class="{ 'workspace-column--stacked': isStackedLayout }">
        <component
          :is="panelComponents[panel.id]"
          v-for="panel in finalColumns.left"
          :key="panel.id"
          :panel="panel"
        />
      </section>

      <section class="workspace-column" :class="{ 'workspace-column--stacked': isStackedLayout }">
        <component
          :is="panelComponents[panel.id]"
          v-for="panel in finalColumns.center"
          :key="panel.id"
          :panel="panel"
        />
      </section>

      <section class="workspace-column" :class="{ 'workspace-column--stacked': isStackedLayout }">
        <component
          :is="panelComponents[panel.id]"
          v-for="panel in finalColumns.right"
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

.workspace-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-md);
  align-items: center;
  min-height: 0;
}

.workspace-header__copy {
  min-width: 0;
}

.workspace-kicker {
  margin: 0 0 2px;
  color: var(--color-primary);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.workspace-title {
  margin: 0;
  color: var(--color-ink);
  font-size: clamp(13px, 1.05vw, 16px);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.12;
}

.workspace-settings-button {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
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
