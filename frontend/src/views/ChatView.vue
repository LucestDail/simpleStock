<script setup>
import { computed, onMounted, ref } from 'vue';
import MarkdownIt from 'markdown-it';
import { useChat } from '../composables/useChat';
import { useUi } from '../composables/useUi';

const {
  threads,
  activeThread,
  messages,
  system,
  loading,
  sending,
  streamStatus,
  error,
  fetchThreads,
  createThread,
  selectThread,
  removeThread,
  sendMessageContent,
} = useChat();
const { confirmAction, notify } = useUi();

const draft = ref('');

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

function renderAssistantMessage(content) {
  return markdown.render(String(content || ''));
}

onMounted(async () => {
  try {
    await fetchThreads({ autoCreate: true });
  } catch (e) {
    notify({ tone: 'error', message: e.message || '대화 목록을 불러오지 못했습니다.' });
  }
});

const canSend = computed(() => Boolean(draft.value.trim()) && !sending.value);

function formatTimestamp(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

async function handleCreateThread() {
  try {
    const thread = await createThread();
    await selectThread(thread.id);
  } catch (e) {
    notify({ tone: 'error', message: e.message || '새 대화를 만들지 못했습니다.' });
  }
}

async function handleDeleteThread(thread) {
  const ok = await confirmAction({
    title: '대화 삭제',
    message: `${thread.title} 스레드를 삭제할까요? 요약과 장기 기억도 함께 정리됩니다.`,
    confirmLabel: '삭제',
    cancelLabel: '취소',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await removeThread(thread.id);
    notify({ tone: 'success', message: '대화를 삭제했습니다.' });
    if (!threads.value.length) {
      await handleCreateThread();
    }
  } catch (e) {
    notify({ tone: 'error', message: e.message || '대화 삭제에 실패했습니다.' });
  }
}

async function submit() {
  if (!canSend.value) return;
  const content = draft.value;
  draft.value = '';

  try {
    await sendMessageContent(content);
  } catch (e) {
    draft.value = content;
    notify({ tone: 'error', message: e.message || '메시지 전송에 실패했습니다.' });
  }
}

function onComposerKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="page">
    <div class="layout">
      <aside class="sidebar card">
        <div class="sidebar-head">
          <div>
            <h1 class="page-title">대화</h1>
            <p class="page-lead">자산, 기억, 사용자 성향을 함께 읽는 멀티턴 Quant Manager 채팅입니다.</p>
          </div>
          <button type="button" class="btn-primary" @click="handleCreateThread">새 대화</button>
        </div>

        <div v-if="!system.aiConfigured" class="disabled-box">
          <p class="disabled-title">Gemini 키가 없어서 답변 생성은 비활성화되어 있습니다.</p>
          <p class="disabled-body">키를 넣으면 LangGraph supervisor, memory, manager, search 흐름이 활성화됩니다.</p>
        </div>

        <p v-if="error" class="banner-error">{{ error }}</p>
        <p v-if="loading && !threads.length" class="muted">불러오는 중…</p>

        <div class="thread-list">
          <button
            v-for="thread in threads"
            :key="thread.id"
            type="button"
            class="thread-item"
            :class="{ active: activeThread?.id === thread.id }"
            @click="selectThread(thread.id)"
          >
            <div class="thread-main">
              <strong class="thread-title">{{ thread.title }}</strong>
              <span class="thread-summary">{{ thread.summary || '아직 요약이 없습니다.' }}</span>
            </div>
            <div class="thread-meta">
              <span class="thread-time">{{ formatTimestamp(thread.updatedAt) }}</span>
              <button
                type="button"
                class="btn-inline danger"
                @click.stop="handleDeleteThread(thread)"
              >
                삭제
              </button>
            </div>
          </button>
        </div>
      </aside>

      <section class="chat-panel card">
        <header class="chat-head">
          <div>
            <h2 class="chat-title">{{ activeThread?.title || '새 대화' }}</h2>
            <p class="chat-sub">
              {{ system.timezone }} 기준 · {{ system.serverTimeLocal || '시간 확인 중' }}
            </p>
          </div>
          <span class="status-pill">{{ sending ? (streamStatus || '답변 생성 중') : '준비됨' }}</span>
        </header>

        <div class="messages">
          <div v-if="!messages.length" class="empty-state">
            <p class="empty-title">대화를 시작해 보세요.</p>
            <p class="empty-body">
              자산 상태, 오늘 관리 우선순위, 리밸런싱 고민, 시장 조사 요청 등을 자연스럽게 입력하면 됩니다.
            </p>
          </div>

          <article
            v-for="message in messages"
            :key="message.id"
            class="message"
            :class="message.role === 'assistant' ? 'assistant' : 'user'"
          >
            <div class="message-label">
              {{ message.role === 'assistant' ? 'Quant Manager' : '나' }}
            </div>
            <div class="message-bubble">
              <template v-if="message.role === 'assistant'">
                <div
                  v-if="message.metadata?.streaming || message.metadata?.thinkingText"
                  class="stream-activity"
                >
                  <p v-if="message.metadata?.streamPhase" class="stream-phase">
                    {{ message.metadata.streamPhaseKey ? `[${message.metadata.streamPhaseKey}] ` : '' }}{{ message.metadata.streamPhase }}
                  </p>
                  <pre v-if="message.metadata?.thinkingText" class="stream-thinking">{{ message.metadata.thinkingText }}</pre>
                </div>
                <div class="message-md" v-html="renderAssistantMessage(message.content)" />
              </template>
              <p v-else class="message-text">{{ message.content }}</p>
              <ul
                v-if="message.role === 'assistant' && message.metadata?.citations?.length"
                class="citation-list"
              >
                <li v-for="item in message.metadata.citations" :key="item.url">
                  <a :href="item.url" target="_blank" rel="noreferrer">{{ item.title || item.url }}</a>
                </li>
              </ul>
            </div>
            <div class="message-time">{{ formatTimestamp(message.createdAt) }}</div>
          </article>
        </div>

        <footer class="composer">
          <textarea
            v-model="draft"
            class="composer-input"
            :disabled="sending || !system.aiConfigured"
            placeholder="Enter 전송, Shift+Enter 줄바꿈"
            rows="5"
            @keydown="onComposerKeydown"
          />
          <div class="composer-foot">
            <p v-if="sending && streamStatus" class="composer-stream">{{ streamStatus }}</p>
            <p class="composer-hint">
              현재 supervisor는 질문에 따라 portfolio, memory, manager, research agent를 동적으로 구성합니다.
            </p>
            <button type="button" class="btn-primary" :disabled="!canSend || !system.aiConfigured" @click="submit">
              {{ sending ? '전송 중…' : '보내기' }}
            </button>
          </div>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-xl) var(--space-base) var(--space-section);
}

.layout {
  max-width: var(--content-max);
  margin: 0 auto;
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: var(--space-lg);
}

.card {
  background: var(--color-canvas);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xl);
}

.sidebar,
.chat-panel {
  min-height: 760px;
}

.sidebar {
  padding: var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-base);
}

.sidebar-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-base);
  align-items: flex-start;
}

.page-title {
  margin: 0 0 var(--space-xs);
  font-size: 32px;
  font-weight: 400;
  letter-spacing: -0.02em;
  color: var(--color-ink);
}

.page-lead {
  margin: 0;
  color: var(--color-muted);
  line-height: 1.6;
}

.btn-primary {
  height: 44px;
  padding: 0 var(--space-md);
  border: none;
  border-radius: var(--rounded-pill);
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-primary:disabled {
  background: var(--color-primary-disabled);
  cursor: not-allowed;
}

.disabled-box,
.banner-error {
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
}

.disabled-box {
  background: var(--color-surface-soft);
}

.disabled-title {
  margin: 0 0 var(--space-xs);
  font-size: 15px;
  font-weight: 600;
  color: var(--color-ink);
}

.disabled-body,
.muted {
  margin: 0;
  color: var(--color-muted);
}

.banner-error {
  background: #fff5f5;
  color: var(--color-semantic-down);
}

.thread-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  overflow: auto;
}

.thread-item {
  width: 100%;
  padding: var(--space-base);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: var(--color-canvas);
  text-align: left;
  cursor: pointer;
}

.thread-item.active {
  border-color: var(--color-primary);
  background: rgba(0, 82, 255, 0.04);
}

.thread-main {
  display: grid;
  gap: 6px;
}

.thread-title {
  color: var(--color-ink);
  font-size: 15px;
}

.thread-summary {
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.thread-meta {
  margin-top: var(--space-sm);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-sm);
}

.thread-time,
.message-time {
  color: var(--color-muted);
  font-size: 12px;
}

.btn-inline {
  border: none;
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  padding: 0;
}

.btn-inline.danger {
  color: var(--color-semantic-down);
}

.chat-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
}

.chat-head {
  padding: var(--space-lg);
  border-bottom: 1px solid var(--color-hairline);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-base);
}

.chat-title {
  margin: 0 0 4px;
  font-size: 24px;
  font-weight: 500;
  color: var(--color-ink);
}

.chat-sub,
.composer-hint {
  margin: 0;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.5;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-soft);
  color: var(--color-body);
  font-size: 13px;
  font-weight: 600;
}

.messages {
  padding: var(--space-lg);
  overflow: auto;
  background: linear-gradient(180deg, rgba(0, 82, 255, 0.02), transparent 180px);
  display: grid;
  gap: var(--space-base);
}

.empty-state {
  align-self: center;
  justify-self: center;
  max-width: 520px;
  text-align: center;
}

.empty-title {
  margin: 0 0 var(--space-xs);
  font-size: 22px;
  font-weight: 500;
  color: var(--color-ink);
}

.empty-body {
  margin: 0;
  color: var(--color-muted);
  line-height: 1.7;
}

.message {
  display: grid;
  gap: 8px;
}

.message.user {
  justify-items: end;
}

.message.assistant {
  justify-items: start;
}

.message-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-muted);
}

.message-bubble {
  max-width: min(760px, 100%);
  padding: var(--space-base);
  border-radius: 20px;
  border: 1px solid var(--color-hairline);
  background: var(--color-canvas);
}

.message.user .message-bubble {
  background: var(--color-primary);
  border-color: transparent;
}

.message.user .message-text {
  color: var(--color-on-primary);
}

.message-text {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.7;
  color: var(--color-body);
}

.composer-stream {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--color-primary);
  font-weight: 600;
  line-height: 1.4;
}

.stream-activity {
  margin-bottom: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(0, 82, 255, 0.06);
  border: 1px solid rgba(0, 82, 255, 0.12);
}

.stream-phase {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink);
}

.stream-thinking {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.35;
  color: var(--color-muted);
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
}

.message-md {
  color: var(--color-body);
  line-height: 1.7;
  font-size: 14px;
}

.message-md :deep(p) {
  margin: 0 0 8px;
}

.message-md :deep(p:last-child) {
  margin-bottom: 0;
}

.message-md :deep(code) {
  font-size: 0.9em;
}

.citation-list {
  margin: var(--space-base) 0 0;
  padding-left: 18px;
}

.citation-list a {
  color: var(--color-primary);
  text-decoration: none;
}

.composer {
  border-top: 1px solid var(--color-hairline);
  padding: var(--space-lg);
  display: grid;
  gap: var(--space-sm);
}

.composer-input {
  width: 100%;
  resize: none;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  font: inherit;
  color: var(--color-ink);
  background: var(--color-canvas);
}

.composer-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(0, 82, 255, 0.08);
}

.composer-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-base);
}

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .sidebar,
  .chat-panel {
    min-height: auto;
  }
}

@media (max-width: 640px) {
  .sidebar-head,
  .chat-head,
  .composer-foot,
  .thread-meta {
    flex-direction: column;
    align-items: stretch;
  }

  .status-pill {
    width: fit-content;
  }
}
</style>
