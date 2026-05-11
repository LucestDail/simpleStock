import { ref } from 'vue';

const threads = ref([]);
const activeThread = ref(null);
const messages = ref([]);
const system = ref({
  aiConfigured: false,
  serverTimeLocal: null,
  timezone: 'Asia/Seoul',
});
const loading = ref(false);
const sending = ref(false);
const error = ref(null);

function sortThreadsList(list = []) {
  return [...list].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function dedupeMessages(list = []) {
  const seen = new Set();
  return list.filter((message) => {
    if (!message?.id || seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function applySystemPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return;
  system.value = {
    ...system.value,
    ...payload,
  };
}

function syncActiveThread(threadId) {
  if (!threadId) return;
  if (activeThread.value?.id !== threadId) return;
  const next = threads.value.find((item) => item.id === threadId);
  if (next) {
    activeThread.value = {
      ...activeThread.value,
      ...next,
    };
  }
}

function upsertThread(thread) {
  if (!thread?.id) return;
  const next = [...threads.value];
  const index = next.findIndex((item) => item.id === thread.id);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...thread,
    };
  } else {
    next.unshift(thread);
  }
  threads.value = sortThreadsList(next);
  syncActiveThread(thread.id);
}

function applyThreadsPayload(payload = {}) {
  if (Array.isArray(payload.threads)) {
    threads.value = sortThreadsList(payload.threads);
    if (activeThread.value) {
      const nextActive = threads.value.find((item) => item.id === activeThread.value.id);
      if (nextActive) {
        activeThread.value = {
          ...activeThread.value,
          ...nextActive,
        };
      } else {
        activeThread.value = null;
        messages.value = [];
      }
    }
  }
  applySystemPayload(payload.system || {});
}

function replaceMessages(threadId, nextMessages = []) {
  const normalized = dedupeMessages(nextMessages);
  if (activeThread.value?.id === threadId) {
    messages.value = normalized;
    upsertThread({
      ...activeThread.value,
      messageCount: normalized.length,
    });
  }
}

function appendMessage({ threadId, message, thread } = {}) {
  if (!threadId || !message?.id) return;
  if (thread) {
    upsertThread(thread);
  }
  if (activeThread.value?.id !== threadId) {
    return;
  }
  if (messages.value.some((item) => item.id === message.id)) {
    return;
  }
  messages.value = [...messages.value, message];
  upsertThread({
    ...(thread || activeThread.value || {}),
    id: threadId,
    messageCount: messages.value.length,
    updatedAt: message.createdAt || thread?.updatedAt || activeThread.value?.updatedAt || null,
  });
}

function removeThreadLocal(threadId) {
  threads.value = threads.value.filter((item) => item.id !== threadId);
  if (activeThread.value?.id === threadId) {
    activeThread.value = threads.value[0] || null;
    messages.value = [];
  }
}

export function useChat() {
  async function fetchThreads({ autoCreate = false } = {}) {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/chat/threads');
      if (!res.ok) throw new Error('대화 목록을 불러오지 못했습니다.');
      const data = await res.json();
      applyThreadsPayload(data);

      const activeExists = activeThread.value
        ? threads.value.some((thread) => thread.id === activeThread.value.id)
        : false;

      if (threads.value.length === 0 && autoCreate) {
        const thread = await createThread();
        await selectThread(thread.id);
      } else if ((!activeThread.value || !activeExists) && threads.value.length) {
        await selectThread(threads.value[0].id);
      } else if (!threads.value.length) {
        activeThread.value = null;
        messages.value = [];
      }
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function createThread(title = '새 대화') {
    const res = await fetch('/api/chat/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '새 대화 생성 실패');
    }
    upsertThread(data.thread);
    activeThread.value = data.thread;
    messages.value = [];
    return data.thread;
  }

  async function selectThread(threadId) {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || '대화 내용을 불러오지 못했습니다.');
      }
      activeThread.value = data.thread;
      replaceMessages(threadId, data.messages || []);
      upsertThread({
        ...data.thread,
        messageCount: Array.isArray(data.messages) ? data.messages.length : data.thread?.messageCount,
      });
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function removeThread(threadId) {
    const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '대화 삭제 실패');
    }
    removeThreadLocal(threadId);
    if (activeThread.value?.id && !messages.value.length) {
      await selectThread(activeThread.value.id);
    }
    return data;
  }

  async function sendMessageContent(content) {
    let threadId = activeThread.value?.id;
    if (!threadId) {
      const thread = await createThread();
      threadId = thread.id;
    }

    sending.value = true;
    error.value = null;
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || '메시지 전송 실패');
      }

      activeThread.value = data.thread;
      replaceMessages(threadId, data.messages || messages.value);
      upsertThread({
        ...data.thread,
        messageCount: Array.isArray(data.messages) ? data.messages.length : data.thread?.messageCount,
      });
      return data.assistantMessage;
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      sending.value = false;
    }
  }

  return {
    threads,
    activeThread,
    messages,
    system,
    loading,
    sending,
    error,
    applySystemPayload,
    applyThreadsPayload,
    upsertThread,
    appendMessage,
    replaceMessages,
    removeThreadLocal,
    fetchThreads,
    createThread,
    selectThread,
    removeThread,
    sendMessageContent,
  };
}
