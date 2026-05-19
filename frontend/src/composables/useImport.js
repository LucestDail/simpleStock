import { ref } from 'vue';
import { apiFetch } from '../lib/apiClient';
import { usePortfolio } from './usePortfolio';

const preview = ref(null);
const busy = ref(false);
const error = ref(null);

export function useImport() {
  const { applyPortfolioPayload } = usePortfolio();

  async function loadPreview(content) {
    busy.value = true;
    error.value = null;
    try {
      const res = await apiFetch('/api/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '미리보기 실패');
      preview.value = data;
      return data;
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      busy.value = false;
    }
  }

  async function applyImport(content) {
    busy.value = true;
    error.value = null;
    try {
      const res = await apiFetch('/api/import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '적용 실패');
      applyPortfolioPayload(data);
      preview.value = data.preview || preview.value;
      return data;
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      busy.value = false;
    }
  }

  async function undoImport() {
    busy.value = true;
    error.value = null;
    try {
      const res = await apiFetch('/api/import/undo', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '되돌리기 실패');
      applyPortfolioPayload(data);
      return data;
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      busy.value = false;
    }
  }

  return {
    preview,
    busy,
    error,
    loadPreview,
    applyImport,
    undoImport,
  };
}
