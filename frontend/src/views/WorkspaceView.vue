<script setup>
import { computed, markRaw, onMounted, onUnmounted } from 'vue';
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

const { fetchPortfolio } = usePortfolio();
const { fetchThreads } = useChat();
const { fetchProfile } = useProfile();
const { notify } = useUi();
const { columns, focusMode, recordActivity, openDrawer } = useWorkspace();
const { connect, disconnect } = useRealtimeSubscription();

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

onMounted(async () => {
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
  disconnect();
});
</script>

<template>
  <div class="workspace">
    <header class="workspace-header">
      <div class="workspace-header__copy">
        <p class="workspace-kicker">SimpleStock Workspace</p>
        <h1 class="workspace-title">Quant Manager</h1>
      </div>
      <button type="button" class="workspace-settings-button" @click="openDrawer('settings', null, '설정')">
        설정
      </button>
    </header>

    <main class="workspace-main" :class="workspaceClass">
      <section class="workspace-column">
        <component
          :is="panelComponents[panel.id]"
          v-for="panel in columns.left"
          :key="panel.id"
          :panel="panel"
        />
      </section>

      <section class="workspace-column">
        <component
          :is="panelComponents[panel.id]"
          v-for="panel in columns.center"
          :key="panel.id"
          :panel="panel"
        />
      </section>

      <section class="workspace-column">
        <component
          :is="panelComponents[panel.id]"
          v-for="panel in columns.right"
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
  grid-template-columns: minmax(200px, 2.55fr) minmax(360px, 4.8fr) minmax(220px, 2.65fr);
  gap: 6px;
  align-items: stretch;
  overflow: hidden;
  transition: grid-template-columns 0.22s ease;
}

.workspace-main--balanced {
  grid-template-columns: minmax(200px, 2.55fr) minmax(360px, 4.8fr) minmax(220px, 2.65fr);
}

.workspace-main--rebalance,
.workspace-main--manager {
  grid-template-columns: minmax(200px, 2.5fr) minmax(360px, 4.9fr) minmax(220px, 2.6fr);
}

.workspace-main--research {
  grid-template-columns: minmax(200px, 2.5fr) minmax(360px, 4.9fr) minmax(220px, 2.6fr);
}

.workspace-main--chat {
  grid-template-columns: minmax(200px, 2.35fr) minmax(420px, 5.25fr) minmax(210px, 2.4fr);
}

.workspace-column {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}

@media (max-width: 1380px) {
  .workspace {
    padding: var(--space-sm);
  }

  .workspace-main,
  .workspace-main--balanced,
  .workspace-main--rebalance,
  .workspace-main--manager,
  .workspace-main--research,
  .workspace-main--chat {
    grid-template-columns: minmax(190px, 2.4fr) minmax(320px, 4.6fr) minmax(200px, 2.5fr);
  }
}
</style>
