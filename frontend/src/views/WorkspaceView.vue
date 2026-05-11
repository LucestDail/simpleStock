<script setup>
import { computed, markRaw, onMounted } from 'vue';
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

const { fetchPortfolio } = usePortfolio();
const { fetchThreads } = useChat();
const { fetchProfile } = useProfile();
const { notify } = useUi();
const { columns, focusMode, recordActivity, openDrawer } = useWorkspace();

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
  padding: var(--space-md);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--space-md);
  overflow: hidden;
  background:
    radial-gradient(circle at top left, rgba(0, 82, 255, 0.14), transparent 32%),
    radial-gradient(circle at right top, rgba(35, 66, 120, 0.18), transparent 22%),
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
  margin: 0 0 4px;
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.workspace-title {
  margin: 0;
  color: var(--color-ink);
  font-size: clamp(18px, 1.9vw, 24px);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.12;
}

.workspace-settings-button {
  flex: 0 0 auto;
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.workspace-main {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(280px, 0.86fr) minmax(420px, 1.55fr) minmax(300px, 1fr);
  gap: var(--space-md);
  align-items: stretch;
  overflow: hidden;
  transition: grid-template-columns 0.22s ease;
}

.workspace-main--balanced {
  grid-template-columns: minmax(280px, 0.86fr) minmax(420px, 1.55fr) minmax(300px, 1fr);
}

.workspace-main--rebalance,
.workspace-main--manager {
  grid-template-columns: minmax(270px, 0.82fr) minmax(440px, 1.68fr) minmax(320px, 1.04fr);
}

.workspace-main--research {
  grid-template-columns: minmax(260px, 0.8fr) minmax(440px, 1.62fr) minmax(330px, 1.08fr);
}

.workspace-main--chat {
  grid-template-columns: minmax(260px, 0.78fr) minmax(460px, 1.78fr) minmax(320px, 0.98fr);
}

.workspace-column {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  overflow: hidden;
}

@media (max-width: 1200px) {
  .workspace {
    padding: var(--space-sm);
  }

  .workspace-main,
  .workspace-main--balanced,
  .workspace-main--rebalance,
  .workspace-main--manager,
  .workspace-main--research,
  .workspace-main--chat {
    grid-template-columns: minmax(220px, 0.8fr) minmax(340px, 1.5fr) minmax(240px, 0.9fr);
  }
}
</style>
