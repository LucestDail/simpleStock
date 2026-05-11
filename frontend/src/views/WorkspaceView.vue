<script setup>
import { computed, markRaw, onMounted } from 'vue';
import StatusStrip from '../components/workspace/StatusStrip.vue';
import DetailDrawer from '../components/workspace/DetailDrawer.vue';
import OverviewPanel from '../components/workspace/OverviewPanel.vue';
import HoldingsPanel from '../components/workspace/HoldingsPanel.vue';
import SnapshotsPanel from '../components/workspace/SnapshotsPanel.vue';
import ChatPanel from '../components/workspace/ChatPanel.vue';
import ActivityPanel from '../components/workspace/ActivityPanel.vue';
import ManagerBriefPanel from '../components/workspace/ManagerBriefPanel.vue';
import ProfilePanel from '../components/workspace/ProfilePanel.vue';
import SystemPanel from '../components/workspace/SystemPanel.vue';
import { usePortfolio } from '../composables/usePortfolio';
import { useChat } from '../composables/useChat';
import { useProfile } from '../composables/useProfile';
import { useUi } from '../composables/useUi';
import { useWorkspace } from '../composables/useWorkspace';

const { fetchPortfolio } = usePortfolio();
const { fetchThreads } = useChat();
const { fetchProfile } = useProfile();
const { notify } = useUi();
const { columns, focusMode, recordActivity } = useWorkspace();

const panelComponents = {
  overview: markRaw(OverviewPanel),
  holdings: markRaw(HoldingsPanel),
  snapshots: markRaw(SnapshotsPanel),
  chat: markRaw(ChatPanel),
  activity: markRaw(ActivityPanel),
  managerBrief: markRaw(ManagerBriefPanel),
  profile: markRaw(ProfilePanel),
  system: markRaw(SystemPanel),
};

const workspaceClass = computed(() => `workspace-main--${focusMode.value || 'balanced'}`);

onMounted(async () => {
  try {
    await Promise.all([fetchPortfolio(), fetchProfile(), fetchThreads({ autoCreate: true })]);
    recordActivity({
      type: 'system',
      title: '워크스페이스 로드',
      description: '단일 화면 워크스페이스가 초기화되었습니다.',
    });
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '워크스페이스 초기화에 실패했습니다.',
    });
  }
});
</script>

<template>
  <div class="workspace">
    <header class="workspace-header">
      <div>
        <p class="workspace-kicker">SimpleStock Workspace</p>
        <h1 class="workspace-title">한 화면에서 자산, 대화, 브리핑, 프로필을 함께 운영합니다.</h1>
      </div>
    </header>

    <StatusStrip />

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
  min-height: 100vh;
  padding: var(--space-lg);
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--space-lg);
  background:
    radial-gradient(circle at top left, rgba(0, 82, 255, 0.05), transparent 30%),
    var(--color-canvas);
}

.workspace-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-lg);
  align-items: flex-end;
}

.workspace-kicker {
  margin: 0 0 6px;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.workspace-title {
  margin: 0;
  color: var(--color-ink);
  font-size: clamp(24px, 3.4vw, 36px);
  font-weight: 500;
  letter-spacing: -0.03em;
  max-width: 26ch;
}

.workspace-main {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(360px, 1.28fr) minmax(280px, 1fr);
  gap: var(--space-lg);
  align-items: start;
  transition: grid-template-columns 0.22s ease;
}

.workspace-main--balanced {
  grid-template-columns: minmax(280px, 1fr) minmax(360px, 1.28fr) minmax(280px, 1fr);
}

.workspace-main--rebalance,
.workspace-main--manager {
  grid-template-columns: minmax(260px, 0.95fr) minmax(420px, 1.5fr) minmax(280px, 1.05fr);
}

.workspace-main--research {
  grid-template-columns: minmax(240px, 0.9fr) minmax(420px, 1.35fr) minmax(320px, 1.2fr);
}

.workspace-main--chat {
  grid-template-columns: minmax(240px, 0.85fr) minmax(460px, 1.7fr) minmax(260px, 0.95fr);
}

.workspace-column {
  min-height: 0;
  display: grid;
  gap: var(--space-lg);
  align-content: start;
}

@media (max-width: 1200px) {
  .workspace {
    padding: var(--space-base);
  }

  .workspace-main,
  .workspace-main--balanced,
  .workspace-main--rebalance,
  .workspace-main--manager,
  .workspace-main--research,
  .workspace-main--chat {
    grid-template-columns: 1fr;
  }
}
</style>
