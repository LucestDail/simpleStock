<script setup>
import { computed, ref } from 'vue';
import PanelShell from './PanelShell.vue';
import { useChat } from '../../composables/useChat';
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
  createThread,
  selectThread,
  removeThread,
  sendMessageContent,
} = useChat();
const { confirmAction, notify } = useUi();
const { applyWorkspacePatch, recordActivity, handleAssistantMetadata, openDrawer, selectThread: focusThread } = useWorkspace();

const draft = ref('');
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
        openDrawer: { type: 'threadDetail', entityId: thread.id, title: thread.title },
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

async function handleDeleteThread(thread) {
  const ok = await confirmAction({
    title: '대화 삭제',
    message: `${thread.title} 스레드를 삭제할까요?`,
    confirmLabel: '삭제',
    cancelLabel: '취소',
    tone: 'danger',
  });
  if (!ok) return;

  try {
    await removeThread(thread.id);
    recordActivity({
      type: 'chat',
      title: '대화 삭제',
      description: thread.title,
      entityId: thread.id,
      tone: 'warning',
    });
    notify({
      tone: 'success',
      message: '대화를 삭제했습니다.',
    });
    if (!threads.value.length) {
      await handleCreateThread();
    }
  } catch (error) {
    notify({
      tone: 'error',
      message: error.message || '대화 삭제 실패',
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
      openDrawer: { type: 'threadDetail', entityId: thread.id, title: thread.title },
      reason: '활성 스레드에 맞춰 채팅 컨텍스트를 전면에 둡니다.',
    },
    'local-action'
  );
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
    draft.value = content;
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
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('threadDetail', activeThread?.id || null, activeThread?.title || '대화 상세')">
        상세
      </button>
      <button type="button" class="btn-primary" @click="handleCreateThread">새 대화</button>
    </template>

    <div class="thread-strip">
      <button
        v-for="thread in threads.slice(0, 6)"
        :key="thread.id"
        type="button"
        class="thread-chip"
        :class="{ active: activeThread?.id === thread.id }"
        @click="activateThread(thread)"
      >
        <span>{{ thread.title }}</span>
      </button>
    </div>

    <div v-if="!system.aiConfigured" class="disabled-box">
      <strong>Gemini 키가 없어서 대화 응답은 비활성화되어 있습니다.</strong>
      <p>키를 넣으면 대화와 함께 패널 배치 지시도 실시간으로 반영됩니다.</p>
    </div>

    <div class="messages">
      <div v-if="!messages.length" class="empty-box">
        자산 관리 요청을 입력하면 대화, 브리핑, 패널 크기와 강조 상태가 함께 바뀝니다.
      </div>

      <article
        v-for="message in messages.slice(-12)"
        :key="message.id"
        class="message"
        :class="message.role"
      >
        <div class="message-top">
          <strong>{{ message.role === 'assistant' ? 'Quant Manager' : '나' }}</strong>
          <span class="mono-num">{{ formatTimestamp(message.createdAt) }}</span>
        </div>
        <p class="message-text">{{ message.content }}</p>
      </article>
    </div>

    <div class="composer">
      <textarea
        v-model="draft"
        class="composer-input"
        rows="4"
        placeholder="Enter 전송, Shift+Enter 줄바꿈"
        :disabled="sending || !system.aiConfigured"
        @keydown="onComposerKeydown"
      />
      <div class="composer-foot">
        <button
          v-if="activeThread"
          type="button"
          class="btn-text danger"
          @click="handleDeleteThread(activeThread)"
        >
          현재 대화 삭제
        </button>
        <button type="button" class="btn-primary" :disabled="!canSend || !system.aiConfigured" @click="submit">
          {{ sending ? '전송 중…' : '보내기' }}
        </button>
      </div>
    </div>
  </PanelShell>
</template>

<style scoped>
.btn-primary,
.btn-secondary {
  height: 36px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 var(--space-sm);
  font: inherit;
  font-size: 13px;
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

.thread-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.thread-chip {
  border: 1px solid var(--color-hairline);
  background: var(--color-canvas);
  border-radius: var(--rounded-pill);
  padding: 8px 12px;
  font: inherit;
  font-size: 13px;
  color: var(--color-body);
  cursor: pointer;
}

.thread-chip.active {
  border-color: rgba(0, 82, 255, 0.4);
  background: rgba(0, 82, 255, 0.06);
  color: var(--color-primary);
}

.disabled-box,
.empty-box {
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  background: var(--color-surface-soft);
}

.disabled-box strong {
  color: var(--color-ink);
}

.disabled-box p {
  margin: var(--space-xs) 0 0;
  color: var(--color-body);
}

.messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  gap: var(--space-sm);
}

.message {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: grid;
  gap: var(--space-xs);
}

.message.user {
  background: rgba(0, 82, 255, 0.04);
}

.message-top {
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: center;
}

.message-top strong {
  color: var(--color-ink);
}

.message-top span {
  color: var(--color-muted);
  font-size: 12px;
}

.message-text {
  margin: 0;
  white-space: pre-wrap;
  color: var(--color-body);
  line-height: 1.7;
}

.composer {
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
  gap: var(--space-sm);
  align-items: center;
}

.btn-text {
  border: none;
  background: transparent;
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-text.danger {
  color: var(--color-semantic-down);
}

@media (max-width: 720px) {
  .composer-foot,
  .message-top {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
