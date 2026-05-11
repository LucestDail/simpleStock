<script setup>
import { computed, ref } from 'vue';
import MarkdownIt from 'markdown-it';
import PanelShell from './PanelShell.vue';
import { useChat } from '../../composables/useChat';
import { formatKRW, usePortfolio } from '../../composables/usePortfolio';
import { useUi } from '../../composables/useUi';
import { useWorkspace } from '../../composables/useWorkspace';

const props = defineProps({
  panel: {
    type: Object,
    required: true,
  },
});

const {
  threads,
  activeThread,
  messages,
  system,
  loading,
  sending,
  error: chatError,
  createThread,
  selectThread,
  removeThread,
  sendMessageContent,
} = useChat();
const { total, system: portfolioSystem } = usePortfolio();
const { notify } = useUi();
const { applyWorkspacePatch, recordActivity, handleAssistantMetadata, openDrawer, selectThread: focusThread } = useWorkspace();
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const draft = ref('');
const canSend = computed(() => Boolean(draft.value.trim()) && !sending.value);
const visibleThreads = computed(() => threads.value.slice(0, 12));
const chatStatusItems = computed(() => [
  `스레드 ${threads.value.length}개`,
  `총 자산 ${formatKRW(total.value)}`,
  portfolioSystem.value.latestManagerReport ? '브리핑 반영됨' : '브리핑 대기',
]);
const composerNotice = computed(() => {
  if (sending.value) {
    return {
      tone: 'info',
      title: '응답 생성 중',
      message: '요청이 길어질 경우 자동 재시도 후 실패 사유를 안내합니다.',
    };
  }

  if (chatError.value) {
    return {
      tone: 'error',
      title: '전송 실패',
      message: chatError.value,
    };
  }

  return null;
});

function formatTimestamp(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function renderAssistantMessage(content) {
  return markdown.render(String(content || ''));
}

async function handleCreateThread() {
  try {
    const thread = await createThread();
    await selectThread(thread.id);
    focusThread(thread.id);
    recordActivity({
      type: 'chat',
      title: '새 대화 생성',
      description: thread.title,
      entityId: thread.id,
    });
    applyWorkspacePatch(
      {
        focusMode: 'chat',
        highlightPanelIds: ['chat', 'activity'],
        panelPatches: [
          { id: 'chat', column: 'center', span: 'full', priority: 20, visible: true },
        ],
        reason: '새 대화를 시작해 채팅 패널을 확장합니다.',
      },
      'local-action'
    );
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '새 대화 생성 실패',
    });
  }
}

async function activateThread(thread) {
  await selectThread(thread.id);
  focusThread(thread.id);
  applyWorkspacePatch(
    {
      focusMode: 'chat',
      highlightPanelIds: ['chat', 'activity'],
      panelPatches: [],
      reason: '활성 스레드에 맞춰 채팅 컨텍스트를 전면에 둡니다.',
    },
    'local-action'
  );
}

async function handleRemoveThread(thread, event) {
  event.stopPropagation();
  try {
    await removeThread(thread.id);
    recordActivity({
      type: 'chat',
      title: '대화 삭제',
      description: thread.title,
      entityId: thread.id,
      tone: 'warning',
    });
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '대화 삭제 실패',
    });
  }
}

async function submit() {
  if (!canSend.value) return;
  const content = draft.value;
  draft.value = '';
  try {
    const assistantMessage = await sendMessageContent(content);
    recordActivity({
      type: 'chat',
      title: '질문 전송',
      description: content.slice(0, 80),
      entityId: activeThread.value?.id || null,
    });
    handleAssistantMetadata(assistantMessage?.metadata);
  } catch (error) {
    if (error?.restoreDraft !== false) {
      draft.value = content;
    }
    notify({
      tone: 'error',
      message: error.message || '메시지 전송 실패',
    });
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
  <PanelShell
    title="Quant Manager 대화"
    subtitle="chat"
    :span="panel.span"
    :highlighted="panel.highlighted"
    :loading="loading || sending"
    tone="dark"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('threadDetail', activeThread?.id || null, activeThread?.title || '대화 상세')">
        상세
      </button>
      <button type="button" class="btn-primary" @click="handleCreateThread">새 대화</button>
    </template>

    <div class="chat-layout">
      <aside class="thread-panel">
        <div class="thread-panel__head">
          <strong>대화 목록</strong>
          <span>{{ chatStatusItems.join(' · ') }}</span>
        </div>
        <div class="thread-list">
          <article
            v-for="thread in visibleThreads"
            :key="thread.id"
            class="thread-item"
            :class="{ active: activeThread?.id === thread.id }"
          >
            <button
              type="button"
              class="thread-item__main"
              @click="activateThread(thread)"
            >
              <strong>{{ thread.title }}</strong>
              <span>{{ formatTimestamp(thread.updatedAt || thread.createdAt) }}</span>
              <em>{{ thread.messageCount || 0 }}개</em>
            </button>
            <button type="button" class="thread-item__delete" @click="handleRemoveThread(thread, $event)">삭제</button>
          </article>
        </div>
      </aside>

      <section class="chat-main">
        <div v-if="!system.aiConfigured" class="disabled-box">
          <strong>Gemini 키가 없어서 대화 응답은 비활성화되어 있습니다.</strong>
          <p>키를 넣으면 대화와 함께 패널 배치 지시도 실시간으로 반영됩니다.</p>
        </div>

        <div v-else class="conversation">
          <div class="conversation-head">
            <strong>{{ activeThread?.title || '새 대화' }}</strong>
            <span>{{ activeThread ? '목록에서 대화를 선택해 이어서 볼 수 있습니다.' : '처음 메시지를 보내면 Quant Manager가 대화를 시작합니다.' }}</span>
          </div>

          <div class="messages">
            <div v-if="!messages.length" class="empty-box">
              <strong>{{ activeThread?.title || '새 대화' }}</strong>
              <p>
                {{ activeThread ? '이 스레드에는 아직 저장된 대화 이력이 없습니다. 바로 새 메시지를 보내 이어서 사용할 수 있습니다.' : '자산 입력, 설정 변경, 반복 브리핑 등록도 자연어로 요청할 수 있습니다.' }}
              </p>
            </div>

            <article
              v-for="message in messages.slice(-12)"
              :key="message.id"
              class="message"
              :class="message.role"
            >
              <div class="message-meta">
                <strong>{{ message.role === 'assistant' ? 'Quant Manager' : '나' }}</strong>
                <span class="mono-num">{{ formatTimestamp(message.createdAt) }}</span>
              </div>
              <div
                v-if="message.role === 'assistant'"
                class="message-markdown"
                v-html="renderAssistantMessage(message.content)"
              />
              <p v-else class="message-text">{{ message.content }}</p>
            </article>
          </div>
        </div>

        <div class="composer">
          <div v-if="composerNotice" class="chat-notice" :class="composerNotice.tone">
            <strong>{{ composerNotice.title }}</strong>
            <p>{{ composerNotice.message }}</p>
          </div>
          <textarea
            v-model="draft"
            class="composer-input"
            rows="3"
            placeholder="Enter 전송, Shift+Enter 줄바꿈"
            :disabled="sending || !system.aiConfigured"
            @keydown="onComposerKeydown"
          />
          <div class="composer-foot">
            <button type="button" class="btn-primary" :disabled="!canSend || !system.aiConfigured" @click="submit">
              {{ sending ? '전송 중…' : '보내기' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </PanelShell>
</template>

<style scoped>
.btn-primary,
.btn-secondary {
  height: 24px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 8px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.btn-secondary {
  background: var(--color-surface-strong);
  color: var(--color-ink);
}

.chat-layout {
  display: grid;
  grid-template-columns: minmax(150px, 176px) minmax(0, 1fr);
  gap: 8px;
  min-height: 0;
  flex: 1;
}

.thread-panel,
.chat-main {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.thread-panel {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}

.thread-panel__head {
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-hairline-soft);
  display: grid;
  gap: 2px;
}

.thread-panel__head strong {
  color: var(--color-ink);
  font-size: 10px;
}

.thread-panel__head span {
  color: var(--color-muted);
  font-size: 8px;
  line-height: 1.2;
}

.thread-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  gap: 4px;
  padding: 4px;
}

.thread-item {
  border: 1px solid var(--color-hairline-soft);
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.015);
  color: var(--color-body);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px;
  align-items: start;
  padding: 5px 6px;
}

.thread-item__main {
  border: none;
  background: transparent;
  padding: 0;
  text-align: left;
  display: grid;
  gap: 2px;
  cursor: pointer;
}

.thread-item strong {
  color: inherit;
  font-size: 10px;
  line-height: 1.2;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.thread-item span,
.thread-item em {
  color: var(--color-muted);
  font-size: 8px;
  font-style: normal;
  line-height: 1.2;
}

.thread-item.active {
  border-color: rgba(0, 82, 255, 0.28);
  background: rgba(0, 82, 255, 0.12);
  color: var(--color-ink);
}

.thread-item__delete {
  border: none;
  background: transparent;
  color: var(--color-semantic-down);
  font-size: 8px;
  font-weight: 700;
  cursor: pointer;
  padding: 1px 0 0;
  white-space: nowrap;
}

.conversation {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.conversation-head {
  display: grid;
  gap: 2px;
}

.conversation-head strong {
  color: var(--color-ink);
  font-size: 11px;
  line-height: 1.2;
}

.conversation-head span {
  color: var(--color-muted);
  font-size: 8px;
  line-height: 1.2;
}

.disabled-box,
.empty-box {
  border-radius: var(--rounded-lg);
  padding: 7px 8px;
  background: var(--color-surface-soft);
  font-size: 10px;
}

.empty-box strong {
  display: block;
  color: var(--color-ink);
  margin-bottom: 4px;
  font-size: 10px;
}

.empty-box p,
.disabled-box p {
  margin: 0;
  color: var(--color-body);
  line-height: 1.3;
  font-size: 9px;
}

.disabled-box strong {
  color: var(--color-ink);
}

.messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 2px;
}

.message {
  max-width: min(88%, 720px);
  border-radius: 12px;
  padding: 7px 9px;
  display: grid;
  gap: 4px;
  border: 1px solid var(--color-hairline);
  background: rgba(255, 255, 255, 0.03);
}

.message.user {
  align-self: flex-end;
  background: rgba(0, 82, 255, 0.12);
}

.message.assistant {
  align-self: flex-start;
}

.message-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.message-meta strong {
  color: var(--color-ink);
  font-size: 9px;
}

.message-meta span {
  color: var(--color-muted);
  font-size: 8px;
}

.message-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--color-body-strong);
  line-height: 1.4;
  font-size: 10px;
}

.message-markdown {
  color: var(--color-body-strong);
  font-size: 10px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.message-markdown :deep(p),
.message-markdown :deep(ul),
.message-markdown :deep(ol),
.message-markdown :deep(blockquote),
.message-markdown :deep(pre) {
  margin: 0 0 6px;
}

.message-markdown :deep(p:last-child),
.message-markdown :deep(ul:last-child),
.message-markdown :deep(ol:last-child),
.message-markdown :deep(blockquote:last-child),
.message-markdown :deep(pre:last-child) {
  margin-bottom: 0;
}

.message-markdown :deep(h1),
.message-markdown :deep(h2),
.message-markdown :deep(h3),
.message-markdown :deep(h4) {
  margin: 0 0 6px;
  color: var(--color-ink);
  font-size: 11px;
  line-height: 1.3;
}

.message-markdown :deep(ul),
.message-markdown :deep(ol) {
  padding-left: 16px;
}

.message-markdown :deep(li) {
  margin: 0 0 2px;
}

.message-markdown :deep(code) {
  font-family: var(--font-mono);
  font-size: 9px;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 3px;
  border-radius: var(--rounded-xs);
}

.message-markdown :deep(pre) {
  overflow: auto;
  padding: 7px 8px;
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.05);
}

.message-markdown :deep(pre code) {
  background: transparent;
  padding: 0;
}

.message-markdown :deep(a) {
  color: var(--color-primary);
}

.composer {
  display: grid;
  gap: 5px;
  margin-top: 4px;
}

.chat-notice {
  border-radius: var(--rounded-lg);
  padding: 6px 8px;
  border: 1px solid var(--color-hairline);
  display: grid;
  gap: 3px;
  font-size: 9px;
}

.chat-notice.info {
  background: rgba(0, 82, 255, 0.08);
  border-color: rgba(0, 82, 255, 0.2);
}

.chat-notice.error {
  background: rgba(255, 92, 92, 0.08);
  border-color: rgba(255, 92, 92, 0.2);
}

.chat-notice strong {
  color: var(--color-ink);
  font-size: 9px;
}

.chat-notice p {
  margin: 0;
  color: var(--color-body);
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.composer-input {
  width: 100%;
  resize: none;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: 7px 8px;
  color: var(--color-ink);
  background: rgba(255, 255, 255, 0.02);
  min-height: 72px;
  font-size: 10px;
}

.composer-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(0, 82, 255, 0.08);
}

.composer-foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  align-items: center;
}

@media (max-width: 1180px) {
  .chat-layout {
    grid-template-columns: 1fr;
  }

  .thread-list {
    max-height: 120px;
  }

  .message {
    max-width: 100%;
  }
}

@media (max-width: 720px) {
  .message-meta,
  .composer-foot {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
