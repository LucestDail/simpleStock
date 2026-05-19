import { ref } from 'vue';
import { apiFetch } from '../lib/apiClient';

const profile = ref({
  userProfile: {
    displayName: '',
    investorType: '',
    investmentGoal: '',
    riskTolerance: '',
    timeHorizon: '',
    liquidityNeeds: '',
    responseStyle: '',
    focusAreas: '',
    notes: '',
  },
  aiProfile: {
    summary: '',
    inferredTraits: [],
    preferences: [],
    concerns: [],
    updatedAt: null,
    sourceMemoryIds: [],
  },
  metadata: {
    lastManualUpdateAt: null,
    lastAiRefreshAt: null,
  },
});
const loading = ref(false);
const error = ref(null);

function applyProfilePayload(payload = {}) {
  profile.value = {
    ...profile.value,
    ...payload,
    userProfile: {
      ...profile.value.userProfile,
      ...(payload.userProfile || {}),
    },
    aiProfile: {
      ...profile.value.aiProfile,
      ...(payload.aiProfile || {}),
    },
    metadata: {
      ...profile.value.metadata,
      ...(payload.metadata || {}),
    },
  };
}

export function useProfile() {
  async function fetchProfile() {
    loading.value = true;
    error.value = null;
    try {
      const res = await apiFetch('/api/profile');
      if (!res.ok) throw new Error('프로필을 불러오지 못했습니다.');
      applyProfilePayload(await res.json());
    } catch (e) {
      error.value = e.message || '오류';
    } finally {
      loading.value = false;
    }
  }

  async function saveProfile(userProfile) {
    loading.value = true;
    error.value = null;
    try {
      const res = await apiFetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userProfile),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || '프로필 저장 실패');
      }
      applyProfilePayload(data);
      return data;
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  return {
    profile,
    loading,
    error,
    applyProfilePayload,
    fetchProfile,
    saveProfile,
  };
}
