import { ref } from 'vue';
import { apiFetch, readApiError } from '../lib/apiClient';

// v3 종합 트래커 — 관심종목(watchlist) 상태 + 그룹/종목 CRUD.
// 서버(/api/watchlist/*)가 항상 전체 상태를 반환하므로 응답으로 그대로 갱신한다.

const groups = ref([]);
const fx = ref(null);
const sessions = ref(null);
const loading = ref(false);
const error = ref('');

function applyState(state) {
  if (!state) return;
  if (Array.isArray(state.groups)) groups.value = state.groups;
  if (state.fx !== undefined) fx.value = state.fx;
  if (state.sessions !== undefined) sessions.value = state.sessions;
}

async function request(method, path, body) {
  const res = await apiFetch(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json().catch(() => ({}));
}

export function useWatchlist() {
  async function load() {
    loading.value = true;
    error.value = '';
    try {
      applyState(await request('GET', '/api/watchlist'));
    } catch (e) {
      error.value = e.message || '관심종목을 불러오지 못했습니다.';
    } finally {
      loading.value = false;
    }
  }

  async function createGroup(name) {
    applyState(await request('POST', '/api/watchlist/groups', { name }));
  }
  async function renameGroup(id, name) {
    applyState(await request('PUT', `/api/watchlist/groups/${encodeURIComponent(id)}`, { name }));
  }
  async function deleteGroup(id) {
    applyState(await request('DELETE', `/api/watchlist/groups/${encodeURIComponent(id)}`));
  }
  async function reorder(orderedIds) {
    applyState(await request('POST', '/api/watchlist/groups/reorder', { orderedIds }));
  }
  async function addTicker(groupId, payload) {
    const r = await request('POST', `/api/watchlist/groups/${encodeURIComponent(groupId)}/tickers`, payload);
    applyState(r.watchlist || r);
    return r;
  }
  async function removeTicker(groupId, symbol) {
    applyState(
      await request('DELETE', `/api/watchlist/groups/${encodeURIComponent(groupId)}/tickers/${encodeURIComponent(symbol)}`)
    );
  }

  return {
    groups,
    fx,
    sessions,
    loading,
    error,
    load,
    createGroup,
    renameGroup,
    deleteGroup,
    reorder,
    addTicker,
    removeTicker,
    applyState,
  };
}
