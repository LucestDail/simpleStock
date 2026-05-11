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
      <button type="button" class="btn-secondary" @click="openDrawer('system', null, '시스템 상세')">
        상세
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
  height: 36px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 var(--space-sm);
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.meta-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: var(--space-xs);
}

.meta-list li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-base);
  border-bottom: 1px solid var(--color-hairline);
  padding-bottom: var(--space-xs);
  color: var(--color-body);
}

.meta-list strong {
  color: var(--color-ink);
}

.meta-list code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-surface-soft);
  border-radius: var(--rounded-xs);
  padding: 2px 6px;
}

.prompt-box {
  margin: 0;
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
  padding: var(--space-base);
  color: var(--color-body);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}
</style>
