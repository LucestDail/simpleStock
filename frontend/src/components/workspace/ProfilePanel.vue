<script setup>
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { useProfile } from '../../composables/useProfile';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { profile, loading } = useProfile();
const { openDrawer } = useWorkspace();
const profileFields = computed(() => {
  const userProfile = profile.value.userProfile || {};
  const entries = [
    ['이름', userProfile.displayName],
    ['투자자 유형', userProfile.investorType],
    ['투자 목표', userProfile.investmentGoal],
    ['리스크 허용도', userProfile.riskTolerance],
  ].filter(([, value]) => value);

  return entries.length ? entries : [['이름', '미입력']];
});
const summaryText = computed(() => profile.value.aiProfile?.summary || profile.value.userProfile?.notes || '');
const traitChips = computed(() => (profile.value.aiProfile?.inferredTraits || []).filter(Boolean));
</script>

<template>
  <PanelShell
    title="사용자 프로필"
    subtitle="profile"
    :span="panel.span"
    :highlighted="panel.highlighted"
    :loading="loading"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('settings', null, '설정')">
        설정
      </button>
    </template>

    <div class="profile-grid">
      <div v-for="[label, value] in profileFields" :key="label" class="mini-field">
        <span>{{ label }}</span>
        <strong>{{ value }}</strong>
      </div>
    </div>

    <div v-if="summaryText" class="summary-box">
      <strong>{{ profile.aiProfile?.summary ? 'AI 요약' : '운용 메모' }}</strong>
      <p>{{ summaryText }}</p>
    </div>

    <div v-if="traitChips.length" class="chip-row">
      <span v-for="item in traitChips" :key="item" class="chip">
        {{ item }}
      </span>
    </div>
  </PanelShell>
</template>

<style scoped>
.btn-secondary {
  height: 24px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary {
  background: var(--color-surface-strong);
  color: var(--color-ink);
}

.profile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 5px;
}

.mini-field {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  padding: 6px 8px;
  display: grid;
  gap: 2px;
  background: rgba(255, 255, 255, 0.02);
}

.mini-field span {
  color: var(--color-muted);
  font-size: 9px;
}

.mini-field strong {
  color: var(--color-ink);
  font-size: 10px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.summary-box {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 6px 8px;
  background: var(--color-surface-soft);
}

.summary-box strong {
  color: var(--color-ink);
}

.summary-box p {
  margin: 4px 0 0;
  color: var(--color-body);
  line-height: 1.2;
  font-size: 9px;
  overflow-wrap: anywhere;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  padding: 4px 8px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  color: var(--color-body-strong);
  font-size: 9px;
  font-weight: 700;
}

</style>
