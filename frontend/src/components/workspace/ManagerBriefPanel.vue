<script setup>
import { computed, ref } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useUi } from '../../composables/useUi';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { manager, system, runManagerReview } = usePortfolio();
const { notify } = useUi();
const { applyWorkspacePatch, recordActivity, openDrawer } = useWorkspace();
const busy = ref(false);
const latestManagerReport = computed(() => manager.value?.latestReport || null);
const effectiveSpan = computed(() => (latestManagerReport.value ? props.panel.span : 'xs'));

async function generateBrief() {
  busy.value = true;
  try {
    await runManagerReview();
    notify({
      tone: 'success',
      message: 'Quant Manager 브리핑을 생성했습니다.',
    });
    recordActivity({
      type: 'manager',
      title: '브리핑 생성',
      description: '최신 Quant Manager 브리핑이 갱신되었습니다.',
    });
    applyWorkspacePatch(
      {
        focusMode: 'manager',
        highlightPanelIds: ['managerBrief', 'activity', 'chat'],
        panelPatches: [
          { id: 'managerBrief', column: 'right', span: 'full', priority: 10, visible: true },
          { id: 'profile', column: 'right', span: 'md', priority: 20, visible: false },
        ],
        openDrawer: { type: 'managerBrief', entityId: '', title: '브리핑 상세' },
        reason: '새 브리핑이 생성되어 매니저 패널을 확장합니다.',
      },
      'local-action'
    );
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '브리핑 생성에 실패했습니다.',
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PanelShell
    title="Quant Manager"
    subtitle="brief"
    :span="effectiveSpan"
    :highlighted="panel.highlighted"
    :loading="busy"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('managerBrief', null, '브리핑 상세')">
        상세
      </button>
      <button type="button" class="btn-primary" :disabled="busy || !system.aiConfigured" @click="generateBrief">
        {{ busy ? '생성 중…' : '생성' }}
      </button>
    </template>

    <div v-if="!system.aiConfigured" class="disabled-box">
      <strong>Gemini 키가 없어서 브리핑이 비활성화되어 있습니다.</strong>
      <p>키를 넣으면 채팅과 레이아웃 지시, 브리핑이 함께 활성화됩니다.</p>
    </div>

    <div v-else-if="latestManagerReport" class="brief-layout">
      <article class="brief-card">
        <span class="kicker">요약</span>
        <p class="summary">{{ latestManagerReport.summary }}</p>
      </article>
      <article class="brief-card">
        <span class="kicker">오늘의 목표</span>
        <p class="summary">{{ latestManagerReport.dailyObjective }}</p>
      </article>
      <article class="brief-card">
        <span class="kicker">핵심 액션</span>
        <ul class="list">
          <li v-for="item in latestManagerReport.actionItems" :key="item">{{ item }}</li>
        </ul>
      </article>
    </div>

    <div v-else class="empty-box">아직 생성된 브리핑이 없습니다.</div>
  </PanelShell>
</template>

<style scoped>
.btn-primary,
.btn-secondary {
  height: 24px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.btn-secondary {
  background: var(--color-surface-strong);
  color: var(--color-ink);
}

.btn-primary:disabled {
  background: var(--color-primary-disabled);
  cursor: not-allowed;
}

.disabled-box,
.empty-box {
  border-radius: var(--rounded-lg);
  padding: 6px 8px;
  background: var(--color-surface-soft);
  font-size: 10px;
}

.disabled-box strong,
.summary {
  color: var(--color-ink);
}

.disabled-box p {
  margin: var(--space-xs) 0 0;
  color: var(--color-body);
}

.brief-layout {
  display: grid;
  gap: 5px;
  min-height: 0;
  overflow: auto;
}

.brief-card {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 6px 8px;
  display: grid;
  gap: 3px;
  background: rgba(255, 255, 255, 0.02);
}

.kicker {
  font-size: 8px;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
}

.summary {
  margin: 0;
  line-height: 1.2;
  font-size: 9px;
}

.list {
  margin: 0;
  padding-left: 14px;
  color: var(--color-body);
  font-size: 9px;
  line-height: 1.2;
}
</style>
