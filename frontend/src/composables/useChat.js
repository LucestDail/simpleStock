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

function upsertThread(thread) {
  const next = [...threads.value];
  const index = next.findIndex((item) => item.id === thread.id);
  if (index >= 0) next[index] = thread;
  else next.unshift(thread);
  threads.value = next.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function useChat() {
  async function fetchThreads({ autoCreate = false } = {}) {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/chat/threads');
      if (!res.ok) throw new Error('대화 목록을 불러오지 못했습니다.');
      const data = await res.json();
      threads.value = data.threads || [];
      system.value = data.system || system.value;

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
      messages.value = data.messages || [];
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
    threads.value = threads.value.filter((item) => item.id !== threadId);
    if (activeThread.value?.id === threadId) {
      activeThread.value = null;
      messages.value = [];
      if (threads.value.length) {
        await selectThread(threads.value[0].id);
      }
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
      messages.value = data.messages || messages.value;
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
    fetchThreads,
    createThread,
    selectThread,
    removeThread,
    sendMessageContent,
  };
}
