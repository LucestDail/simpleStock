<script setup>
import { reactive, watch } from 'vue';
import PanelShell from './PanelShell.vue';
import { useProfile } from '../../composables/useProfile';
import { useUi } from '../../composables/useUi';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const { profile, saveProfile, loading } = useProfile();
const { notify } = useUi();
const { applyWorkspacePatch, recordActivity, openDrawer } = useWorkspace();

const form = reactive({
  displayName: '',
  investorType: '',
  investmentGoal: '',
  riskTolerance: '',
  responseStyle: '',
});

watch(
  () => profile.value.userProfile,
  (next) => {
    Object.assign(form, {
      displayName: next?.displayName || '',
      investorType: next?.investorType || '',
      investmentGoal: next?.investmentGoal || '',
      riskTolerance: next?.riskTolerance || '',
      responseStyle: next?.responseStyle || '',
    });
  },
  { immediate: true, deep: true }
);

async function submit() {
  try {
    await saveProfile({
      ...profile.value.userProfile,
      ...form,
    });
    notify({
      tone: 'success',
      message: '프로필을 저장했습니다.',
    });
    recordActivity({
      type: 'profile',
      title: '프로필 저장',
      description: `${form.displayName || '사용자'} · ${form.investorType || '성향 미입력'}`,
    });
    applyWorkspacePatch(
      {
        focusMode: 'balanced',
        highlightPanelIds: ['profile', 'activity', 'system'],
        panelPatches: [
          { id: 'profile', column: 'right', span: 'lg', priority: 15, visible: true },
        ],
        openDrawer: { type: 'profile', entityId: '', title: '프로필 상세' },
        reason: '프로필 저장이 완료되어 프로필 패널을 강조합니다.',
      },
      'local-action'
    );
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '프로필 저장 실패',
    });
  }
}
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
      <button type="button" class="btn-secondary" @click="openDrawer('profile', null, '프로필 상세')">
        상세
      </button>
    </template>

    <form class="profile-form" @submit.prevent="submit">
      <input v-model="form.displayName" class="input" type="text" placeholder="이름" />
      <input v-model="form.investorType" class="input" type="text" placeholder="투자자 유형" />
      <input v-model="form.investmentGoal" class="input" type="text" placeholder="투자 목표" />
      <input v-model="form.riskTolerance" class="input" type="text" placeholder="리스크 허용도" />
      <input v-model="form.responseStyle" class="input" type="text" placeholder="응답 스타일" />
      <button type="submit" class="btn-primary" :disabled="loading">저장</button>
    </form>

    <div class="summary-box">
      <strong>AI 요약</strong>
      <p>{{ profile.aiProfile?.summary || '아직 추론된 프로필 요약이 없습니다.' }}</p>
    </div>

    <div class="chip-row">
      <span v-for="item in profile.aiProfile?.inferredTraits || []" :key="item" class="chip">
        {{ item }}
      </span>
    </div>
  </PanelShell>
</template>

<style scoped>
.btn-primary,
.btn-secondary {
  height: 36px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 var(--space-sm);
  font: inherit;
  font-size: 13px;
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

.profile-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}

.input {
  height: 42px;
  padding: 0 var(--space-base);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  background: var(--color-canvas);
  color: var(--color-ink);
  font: inherit;
}

.input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(0, 82, 255, 0.08);
}

.summary-box {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  background: var(--color-surface-soft);
}

.summary-box strong {
  color: var(--color-ink);
}

.summary-box p {
  margin: var(--space-xs) 0 0;
  color: var(--color-body);
  line-height: 1.65;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.chip {
  padding: 8px 12px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-strong);
  color: var(--color-body-strong);
  font-size: 12px;
  font-weight: 700;
}

@media (max-width: 720px) {
  .profile-form {
    grid-template-columns: 1fr;
  }
}
</style>
