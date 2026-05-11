import { ref } from 'vue';
import { usePortfolio } from './usePortfolio';
import { useChat } from './useChat';
import { useProfile } from './useProfile';
import { useWorkspace } from './useWorkspace';
import { useUi } from './useUi';

const EVENT_TYPES = [
  'hello',
  'server.status',
  'portfolio.updated',
  'snapshots.updated',
  'profile.user.updated',
  'profile.ai.updated',
  'chat.thread.created',
  'chat.thread.updated',
  'chat.thread.deleted',
  'chat.message.created',
  'chat.memory.updated',
  'manager.report.created',
  'schedule.updated',
  'schedule.run.updated',
  'workspace.patch',
  'activity.created',
  'market.quote.updated',
  'market.session.updated',
  'fx.rate.updated',
];

const connectionState = ref('idle');
const lastEventAt = ref(null);
const reconnectAttempt = ref(0);
const lastConnectedAt = ref(null);

let source = null;
let reconnectTimer = null;
let manualDisconnect = false;
let pendingBaselineRefetch = false;
const recentEventIds = [];
const recentEventIdSet = new Set();

function rememberEventId(eventId) {
  if (!eventId || recentEventIdSet.has(eventId)) return false;
  recentEventIds.push(eventId);
  recentEventIdSet.add(eventId);
  if (recentEventIds.length > 120) {
    const removed = recentEventIds.shift();
    recentEventIdSet.delete(removed);
  }
  return true;
}

export function useRealtimeSubscription() {
  const { applyPortfolioPayload, fetchPortfolio } = usePortfolio();
  const {
    activeThread,
    applySystemPayload,
    upsertThread,
    appendMessage,
    removeThreadLocal,
    selectThread,
    fetchThreads,
  } = useChat();
  const { applyProfilePayload, fetchProfile } = useProfile();
  const { applyWorkspacePatch, recordActivity } = useWorkspace();
  const { notify } = useUi();

  async function refetchBaseline(reason = 'reconnect') {
    await Promise.all([fetchPortfolio(), fetchProfile(), fetchThreads({ autoCreate: false })]);
    recordActivity({
      type: 'system',
      title: '실시간 동기화 복구',
      description:
        reason === 'reconnect'
          ? '재연결 후 기준 데이터를 다시 불러왔습니다.'
          : '실시간 기준 데이터를 다시 불러왔습니다.',
      tone: 'info',
      metadata: { reason },
    });
  }

  async function dispatchEnvelope(envelope = {}) {
    const eventType = String(envelope.type || '');
    const payload = envelope.payload || {};
    const eventId = envelope.id || null;

    if (eventId && !rememberEventId(eventId)) {
      return;
    }

    lastEventAt.value = envelope.emittedAt || new Date().toISOString();

    switch (eventType) {
      case 'hello':
        return;
      case 'server.status':
        applyPortfolioPayload(payload);
        applySystemPayload(payload.system || {});
        return;
      case 'portfolio.updated':
      case 'snapshots.updated':
      case 'schedule.updated':
      case 'schedule.run.updated':
        applyPortfolioPayload(payload);
        applySystemPayload(payload.system || {});
        return;
      case 'profile.user.updated':
      case 'profile.ai.updated':
        applyProfilePayload(payload);
        return;
      case 'chat.thread.created':
      case 'chat.thread.updated':
        upsertThread(payload.thread);
        return;
      case 'chat.thread.deleted': {
        const wasActive = activeThread.value?.id === payload.threadId;
        removeThreadLocal(payload.threadId);
        if (wasActive && activeThread.value?.id) {
          await selectThread(activeThread.value.id);
        }
        return;
      }
      case 'chat.message.created':
        appendMessage({
          threadId: payload.thread?.id || payload.threadId,
          thread: payload.thread,
          message: payload.message,
        });
        return;
      case 'chat.memory.updated':
        upsertThread(payload.thread);
        return;
      case 'manager.report.created':
        applyPortfolioPayload(payload);
        applySystemPayload(payload.system || {});
        return;
      case 'workspace.patch':
        if (payload.workspacePatch) {
          applyWorkspacePatch(payload.workspacePatch, 'realtime');
        }
        return;
      case 'activity.created':
        if (payload.activity) {
          recordActivity({
            id: eventId,
            ...payload.activity,
          });
        }
        return;
      case 'market.quote.updated':
      case 'market.session.updated':
      case 'fx.rate.updated':
        applyPortfolioPayload(payload);
        if (payload.reason === 'manual') {
          recordActivity({
            id: eventId,
            type: 'market',
            title: '시장 시세 갱신',
            description: '미국 주식과 환율 데이터를 수동으로 다시 불러왔습니다.',
            tone: 'info',
            metadata: payload,
          });
        }
        return;
      default:
    }
  }

  function scheduleReconnect() {
    if (manualDisconnect || reconnectTimer) return;
    reconnectAttempt.value += 1;
    pendingBaselineRefetch = true;
    connectionState.value = 'reconnecting';
    const delay = Math.min(1000 * 2 ** (reconnectAttempt.value - 1), 15000);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function attachListeners(eventSource) {
    for (const eventType of EVENT_TYPES) {
      eventSource.addEventListener(eventType, async (event) => {
        try {
          const envelope = JSON.parse(event.data);
          await dispatchEnvelope(envelope);
        } catch (error) {
          notify({
            tone: 'error',
            message: error.message || '실시간 이벤트 처리 중 오류가 발생했습니다.',
          });
        }
      });
    }
  }

  async function connect() {
    if (source) return;
    manualDisconnect = false;
    connectionState.value = reconnectAttempt.value > 0 ? 'reconnecting' : 'connecting';

    const eventSource = new EventSource('/api/stream');
    source = eventSource;
    attachListeners(eventSource);

    eventSource.onopen = async () => {
      connectionState.value = 'connected';
      lastConnectedAt.value = new Date().toISOString();
      if (pendingBaselineRefetch) {
        pendingBaselineRefetch = false;
        try {
          await refetchBaseline('reconnect');
        } catch (error) {
          notify({
            tone: 'error',
            message: error.message || '재연결 후 상태 복구에 실패했습니다.',
          });
        }
      }
      reconnectAttempt.value = 0;
    };

    eventSource.onerror = () => {
      if (source) {
        source.close();
        source = null;
      }
      if (manualDisconnect) {
        connectionState.value = 'idle';
        return;
      }
      scheduleReconnect();
    };
  }

  function disconnect() {
    manualDisconnect = true;
    pendingBaselineRefetch = false;
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (source) {
      source.close();
      source = null;
    }
    connectionState.value = 'idle';
  }

  return {
    connectionState,
    lastEventAt,
    lastConnectedAt,
    reconnectAttempt,
    connect,
    disconnect,
    refetchBaseline,
  };
}
