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
      <li><span>브리핑</span><code>{{ system.ai?.dailyCron ? '예약됨' : '미설정' }}</code></li>
    </ul>
    <p class="system-note">
      {{ system.orchestrationNotes || '상세 오케스트레이션 정보는 설정 패널에서 확인할 수 있습니다.' }}
    </p>
  </PanelShell>
</template>

<style scoped>
.btn-secondary {
  height: 28px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 10px;
  background: var(--color-surface-strong);
  color: var(--color-ink);
  font-size: 11px;
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
  padding-bottom: 4px;
  color: var(--color-body);
  font-size: 11px;
}

.meta-list strong {
  color: var(--color-ink);
}

.meta-list code {
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--color-surface-soft);
  border-radius: var(--rounded-xs);
  padding: 1px 5px;
}

.system-note {
  margin: 0;
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
  padding: 8px 10px;
  color: var(--color-body);
  font-size: 10px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
</style>
