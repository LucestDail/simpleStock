import { ref } from 'vue';
import { apiFetch } from '../lib/apiClient';

const longTermMemories = ref([]);
const threadSummaries = ref([]);
const pinnedCount = ref(0);
const loading = ref(false);
const error = ref(null);

function applyPayload(data = {}) {
  if (Array.isArray(data.longTermMemories)) {
    longTermMemories.value = data.longTermMemories;
  }
  if (Array.isArray(data.threadSummaries)) {
    threadSummaries.value = data.threadSummaries;
  }
  if (Number.isFinite(Number(data.pinnedCount))) {
    pinnedCount.value = Number(data.pinnedCount);
  }
}

export function useMemory() {
  async function fetchMemory() {
    loading.value = true;
    error.value = null;
    try {
      const res = await apiFetch('/api/memory');
      if (!res.ok) throw new Error('기억 목록을 불러오지 못했습니다.');
      applyPayload(await res.json());
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function deleteMemory(memoryId) {
    const res = await apiFetch(`/api/memory/long-term/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '기억 삭제 실패');
    applyPayload(data);
  }

  async function togglePin(memoryId, pinned) {
    const res = await apiFetch(`/api/memory/long-term/${encodeURIComponent(memoryId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '고정 상태 변경 실패');
    applyPayload(data);
  }

  async function saveThreadSummary(summaryId, patch) {
    const res = await apiFetch(`/api/memory/thread-summaries/${encodeURIComponent(summaryId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '스레드 요약 저장 실패');
    applyPayload(data);
  }

  async function addMemory(text, kind = 'insight') {
    const res = await apiFetch('/api/memory/long-term', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, kind }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '기억 추가 실패');
    applyPayload(data);
  }

  return {
    longTermMemories,
    threadSummaries,
    pinnedCount,
    loading,
    error,
    fetchMemory,
    deleteMemory,
    togglePin,
    saveThreadSummary,
    addMemory,
    applyPayload,
  };
}
