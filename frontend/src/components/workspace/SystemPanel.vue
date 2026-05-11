<script setup>
import PanelShell from './PanelShell.vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { system } = usePortfolio();
const { openDrawer } = useWorkspace();
</script>

<template>
  <PanelShell
    title="시스템"
    subtitle="system"
    :span="panel.span"
    :highlighted="panel.highlighted"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('settings', null, '설정')">
        설정
      </button>
    </template>

    <ul class="meta-list">
      <li><span>시간대</span><strong>{{ system.timezone }}</strong></li>
      <li><span>Gemini</span><strong>{{ system.aiConfigured ? '활성' : '비활성' }}</strong></li>
      <li><span>모델</span><code>{{ system.ai?.model || '-' }}</code></li>
      <li><span>Thinking</span><code>{{ system.ai?.thinkingLevel || '-' }}</code></li>
      <li><span>Cron</span><code>{{ system.ai?.dailyCron || '-' }}</code></li>
    </ul>

    <pre class="prompt-box">{{ system.orchestrationNotes }}</pre>
  </PanelShell>
</template>

<style scoped>
.btn-secondary {
  height: 32px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 12px;
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.meta-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: var(--space-xs);
  min-height: 0;
}

.meta-list li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  border-bottom: 1px solid var(--color-hairline);
  padding-bottom: 6px;
  color: var(--color-body);
  font-size: 12px;
}

.meta-list strong {
  color: var(--color-ink);
}

.meta-list code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--color-surface-soft);
  border-radius: var(--rounded-xs);
  padding: 2px 6px;
}

.prompt-box {
  margin: 0;
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
  padding: 10px 12px;
  color: var(--color-body);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.45;
  white-space: pre-wrap;
  min-height: 0;
  overflow: auto;
}
</style>
