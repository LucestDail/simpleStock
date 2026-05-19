import { ref } from 'vue';
import { apiFetch, readApiError } from '../lib/apiClient';
import { consumeNdjsonStream } from '../lib/ndjson';

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
const streamStatus = ref('');

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

function upsertMessage({ threadId, message, thread } = {}) {
  if (!threadId || !message?.id) return;
  if (thread) {
    upsertThread(thread);
  }
  if (activeThread.value?.id !== threadId) {
    return;
  }
  const next = [...messages.value];
  const index = next.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...message,
      content: message.content ?? next[index].content,
      metadata: {
        ...(next[index].metadata || {}),
        ...(message.metadata || {}),
      },
    };
  } else {
    next.push(message);
  }
  messages.value = dedupeMessages(next);
  upsertThread({
    ...(thread || activeThread.value || {}),
    id: threadId,
    messageCount: messages.value.length,
    updatedAt: message.createdAt || thread?.updatedAt || activeThread.value?.updatedAt || null,
  });
}

function appendMessage({ threadId, message, thread } = {}) {
  upsertMessage({ threadId, message, thread });
}

function applyMessageDelta({ threadId, messageId, delta, message, thread } = {}) {
  if (!threadId || !messageId || !delta) return;
  const existing = activeThread.value?.id === threadId
    ? messages.value.find((item) => item.id === messageId)
    : null;
  upsertMessage({
    threadId,
    thread,
    message: {
      ...(existing || {}),
      ...(message || {}),
      id: messageId,
      content: `${String(existing?.content || '')}${delta}`,
      metadata: {
        ...(existing?.metadata || {}),
        ...(message?.metadata || {}),
      },
    },
  });
}

function removeThreadLocal(threadId) {
  threads.value = threads.value.filter((item) => item.id !== threadId);
  if (activeThread.value?.id === threadId) {
    activeThread.value = threads.value[0] || null;
    messages.value = [];
  }
}

async function syncThreadState(threadId) {
  if (!threadId) return null;
  const res = await apiFetch(`/api/chat/threads/${encodeURIComponent(threadId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || '대화 상태를 다시 불러오지 못했습니다.');
  }
  activeThread.value = data.thread;
  replaceMessages(threadId, data.messages || []);
  upsertThread({
    ...data.thread,
    messageCount: Array.isArray(data.messages) ? data.messages.length : data.thread?.messageCount,
  });
  return data;
}

export function useChat() {
  async function fetchThreads({ autoCreate = false } = {}) {
    loading.value = true;
    error.value = null;
    try {
      const res = await apiFetch('/api/chat/threads');
      if (!res.ok) throw new Error(await readApiError(res, '대화 목록을 불러오지 못했습니다.'));
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
    const res = await apiFetch('/api/chat/threads', {
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
      await syncThreadState(threadId);
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function removeThread(threadId) {
    const res = await apiFetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, {
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
    streamStatus.value = '';
    try {
      let res;
      try {
        res = await apiFetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
      } catch {
        const nextError = new Error('메시지 요청을 전송하지 못했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.');
        nextError.restoreDraft = true;
        throw nextError;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const nextError = new Error(data.error || '메시지 전송 실패');
        nextError.restoreDraft = res.status < 500;
        if (res.status >= 500) {
          try {
            await syncThreadState(threadId);
            nextError.restoreDraft = false;
          } catch {
            nextError.restoreDraft = false;
          }
        }
        throw nextError;
      }
      if (!res.body) {
        throw new Error('스트리밍 응답 본문이 비어 있습니다.');
      }

      let assistantMessage = null;
      await consumeNdjsonStream(res.body, (event) => {
        if (!event || typeof event !== 'object') return;

        if (event.type === 'start') {
          streamStatus.value = event.message || '대화 맥락을 정리하고 있습니다.';
          if (event.thread) {
            activeThread.value = event.thread;
            upsertThread(event.thread);
          }
          const tid = event.threadId || event.thread?.id || threadId;
          if (tid && event.assistantMessageId) {
            upsertMessage({
              threadId: tid,
              thread: event.thread,
              message: {
                id: event.assistantMessageId,
                role: 'assistant',
                content: '',
                createdAt: event.assistantCreatedAt,
                model: 'gemini',
                metadata: {
                  streaming: true,
                  streamPhase: event.message,
                  thinkingText: '',
                },
              },
            });
          }
          return;
        }

        if (event.type === 'stage') {
          const tid = event.threadId || threadId;
          const mid = event.assistantMessageId;
          const phase = event.phase ? String(event.phase) : '';
          const msg = event.message || '응답 생성 중';
          streamStatus.value = phase ? `${phase} · ${msg}` : msg;
          if (tid && mid) {
            const existing = messages.value.find((m) => m.id === mid);
            upsertMessage({
              threadId: tid,
              message: {
                id: mid,
                role: 'assistant',
                content: existing?.content || '',
                createdAt: existing?.createdAt,
                model: 'gemini',
                metadata: {
                  ...(existing?.metadata || {}),
                  streaming: true,
                  streamPhase: msg,
                  streamPhaseKey: phase,
                },
              },
            });
          }
          return;
        }

        if (event.type === 'thinking_delta') {
          const tid = event.threadId || threadId;
          const mid = event.assistantMessageId;
          const delta = String(event.delta || '');
          if (!tid || !mid || !delta) return;
          const existing = messages.value.find((m) => m.id === mid);
          const nextThinking = `${String(existing?.metadata?.thinkingText || '')}${delta}`.slice(0, 12000);
          if (event.source === 'model') {
            streamStatus.value = '모델 추론 중…';
          }
          upsertMessage({
            threadId: tid,
            message: {
              id: mid,
              role: 'assistant',
              content: existing?.content || '',
              createdAt: existing?.createdAt,
              model: 'gemini',
              metadata: {
                ...(existing?.metadata || {}),
                streaming: true,
                thinkingText: nextThinking,
              },
            },
          });
          return;
        }

        if (event.type === 'delta') {
          streamStatus.value = '답변을 작성하고 있습니다.';
          applyMessageDelta({
            threadId,
            messageId: event.assistantMessageId,
            delta: event.delta,
            message: event.message,
            thread: event.thread,
          });
          return;
        }

        if (event.type === 'done') {
          streamStatus.value = '';
          if (event.thread) {
            activeThread.value = event.thread;
            upsertThread(event.thread);
          }
          if (event.assistantMessage) {
            upsertMessage({
              threadId,
              thread: event.thread,
              message: {
                ...event.assistantMessage,
                metadata: {
                  ...(event.assistantMessage.metadata || {}),
                  streaming: false,
                },
              },
            });
            assistantMessage = event.assistantMessage;
          }
          return;
        }

        if (event.type === 'error') {
          const nextError = new Error(event.error || '메시지 스트리밍 전송 실패');
          nextError.restoreDraft = false;
          throw nextError;
        }
      });

      if (!assistantMessage) {
        await syncThreadState(threadId);
        assistantMessage = messages.value.at(-1) || null;
      }
      return assistantMessage;
    } catch (e) {
      error.value = e.message || '오류';
      throw e;
    } finally {
      streamStatus.value = '';
      sending.value = false;
    }
  }

  function getLastUserMessageContent() {
    const userMessages = messages.value.filter((message) => message.role === 'user');
    return String(userMessages.at(-1)?.content || '').trim();
  }

  async function retryLastMessage() {
    const content = getLastUserMessageContent();
    if (!content) {
      throw new Error('다시 보낼 사용자 메시지가 없습니다.');
    }
    return sendMessageContent(content);
  }

  return {
    threads,
    activeThread,
    messages,
    system,
    loading,
    sending,
    error,
    streamStatus,
    getLastUserMessageContent,
    retryLastMessage,
    applySystemPayload,
    applyThreadsPayload,
    upsertThread,
    appendMessage,
    upsertMessage,
    applyMessageDelta,
    replaceMessages,
    removeThreadLocal,
    fetchThreads,
    createThread,
    selectThread,
    removeThread,
    sendMessageContent,
  };
}
