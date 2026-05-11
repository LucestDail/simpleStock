<script setup>
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
      <div class="mini-field">
        <span>이름</span>
        <strong>{{ profile.userProfile?.displayName || '미입력' }}</strong>
      </div>
      <div class="mini-field">
        <span>투자자 유형</span>
        <strong>{{ profile.userProfile?.investorType || '미입력' }}</strong>
      </div>
      <div class="mini-field">
        <span>투자 목표</span>
        <strong>{{ profile.userProfile?.investmentGoal || '미입력' }}</strong>
      </div>
      <div class="mini-field">
        <span>리스크 허용도</span>
        <strong>{{ profile.userProfile?.riskTolerance || '미입력' }}</strong>
      </div>
    </div>

    <div class="summary-box">
      <strong>{{ profile.aiProfile?.summary ? 'AI 요약' : '운용 메모' }}</strong>
      <p>{{ profile.aiProfile?.summary || profile.userProfile?.notes || '아직 추론된 프로필 요약이 없습니다.' }}</p>
    </div>

    <div class="chip-row">
      <span v-for="item in profile.aiProfile?.inferredTraits || []" :key="item" class="chip">
        {{ item }}
      </span>
    </div>
  </PanelShell>
</template>

<style scoped>
.btn-secondary {
  height: 36px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 var(--space-sm);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary {
  background: var(--color-surface-strong);
  color: var(--color-ink);
}

.profile-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.mini-field {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  padding: 10px 12px;
  display: grid;
  gap: 4px;
  background: rgba(255, 255, 255, 0.02);
}

.mini-field span {
  color: var(--color-muted);
  font-size: 11px;
}

.mini-field strong {
  color: var(--color-ink);
  font-size: 13px;
  line-height: 1.3;
}

.summary-box {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 10px 12px;
  background: var(--color-surface-soft);
}

.summary-box strong {
  color: var(--color-ink);
}

.summary-box p {
  margin: 6px 0 0;
  color: var(--color-body);
  line-height: 1.45;
  font-size: 12px;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.chip {
  padding: 6px 10px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  color: var(--color-body-strong);
  font-size: 11px;
  font-weight: 700;
}

@media (max-width: 720px) {
  .profile-form {
    grid-template-columns: 1fr;
  }
}
</style>
