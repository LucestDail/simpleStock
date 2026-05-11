<script setup>
import { computed, ref } from 'vue';
import PanelShell from './PanelShell.vue';
import { useChat } from '../../composables/useChat';
import { formatKRW, usePortfolio } from '../../composables/usePortfolio';
import { useProfile } from '../../composables/useProfile';
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
  sendMessageContent,
} = useChat();
const { total, system: portfolioSystem, fetchPortfolio } = usePortfolio();
const { profile, fetchProfile } = useProfile();
const { notify } = useUi();
const { applyWorkspacePatch, recordActivity, handleAssistantMetadata, openDrawer, selectThread: focusThread } = useWorkspace();

const draft = ref('');
const canSend = computed(() => Boolean(draft.value.trim()) && !sending.value);
const headerStats = computed(() => [
  {
    label: '총 자산',
    value: formatKRW(total.value),
  },
  {
    label: '포커스',
    value: activeThread.value?.title || '새 대화',
  },
  {
    label: '브리핑',
    value: portfolioSystem.value.latestManagerReport ? '반영됨' : '대기',
  },
  {
    label: '설정 상태',
    value: profile.value.userProfile?.displayName || '미입력',
  },
]);

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
    await Promise.all([fetchPortfolio(), fetchProfile()]);
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
    tone="dark"
  >
    <template #actions>
      <button type="button" class="btn-secondary" @click="openDrawer('threadDetail', activeThread?.id || null, activeThread?.title || '대화 상세')">
        상세
      </button>
      <button type="button" class="btn-primary" @click="handleCreateThread">새 대화</button>
    </template>

    <div class="chat-stats">
      <article v-for="item in headerStats" :key="item.label" class="chat-stat">
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </article>
    </div>

    <div class="thread-strip">
      <button
        v-for="thread in threads.slice(0, 4)"
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
        자산 입력, 설정 변경, 반복 브리핑 등록도 자연어로 요청할 수 있습니다.
      </div>

      <article
        v-for="message in messages.slice(-8)"
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
  </PanelShell>
</template>

<style scoped>
.btn-primary,
.btn-secondary {
  height: 30px;
  border: none;
  border-radius: var(--rounded-pill);
  padding: 0 12px;
  font-size: 12px;
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

.chat-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-xs);
}

.chat-stat {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--rounded-md);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--color-hairline-soft);
}

.chat-stat span {
  color: var(--color-muted);
  font-size: 10px;
}

.chat-stat strong {
  color: var(--color-ink);
  font-size: 12px;
  line-height: 1.3;
}

.thread-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  overflow: hidden;
}

.thread-chip {
  border: 1px solid var(--color-hairline);
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--rounded-pill);
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-body);
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
}

.thread-chip.active {
  border-color: rgba(0, 82, 255, 0.4);
  background: rgba(0, 82, 255, 0.12);
  color: var(--color-primary);
}

.thread-chip span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.disabled-box,
.empty-box {
  border-radius: var(--rounded-lg);
  padding: 8px 10px;
  background: var(--color-surface-soft);
  font-size: 11px;
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
  padding: 8px 10px;
  display: grid;
  gap: 4px;
  background: rgba(255, 255, 255, 0.02);
}

.message.user {
  background: rgba(0, 82, 255, 0.08);
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
  font-size: 11px;
}

.message-text {
  margin: 0;
  white-space: pre-wrap;
  color: var(--color-body);
  line-height: 1.5;
  font-size: 11px;
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
  padding: 8px 10px;
  color: var(--color-ink);
  background: rgba(255, 255, 255, 0.02);
}

.composer-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(0, 82, 255, 0.08);
}

.composer-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  align-items: center;
}

@media (max-width: 720px) {
  .chat-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .composer-foot,
  .message-top {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
