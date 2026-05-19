import { ref } from 'vue';
import { apiFetch } from '../lib/apiClient';
import { usePortfolio } from './usePortfolio';

const saving = ref(false);
const error = ref(null);

export function useSystemSettings() {
  const { system, fetchPortfolio } = usePortfolio();

  async function saveSettings(patch) {
    saving.value = true;
    error.value = null;
    try {
      const res = await apiFetch('/api/system/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '설정 저장 실패');
      await fetchPortfolio();
      return data;
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      saving.value = false;
    }
  }

  return {
    saving,
    error,
    saveSettings,
  };
}
