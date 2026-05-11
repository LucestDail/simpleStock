const { randomUUID } = require('crypto');
const { loadStore, mutateStore } = require('./dataStore');
const { buildConversationContext, formatMessagesForPrompt, getThreadMessages } = require('./contextBuilder');
const { isAiConfigured, runConversationGraph, summarizeThread, inferAiProfile } = require('./aiService');
const { applyConversationActions } = require('./actionService');
const { buildStructuredImportPlan } = require('./structuredImportService');
const { logInfo, logError } = require('./logger');
const { buildProfilePayload } = require('./payloadService');
const { broadcast } = require('./realtimeService');

function sanitizeMessage(content) {
  return String(content || '').replace(/\r\n/g, '\n').trim();
}

function buildThreadTitle(content) {
  const compact = sanitizeMessage(content).replace(/\s+/g, ' ');
  return compact ? compact.slice(0, 32) : '새 대화';
}

function getThreadIndex(threads, threadId) {
  return threads.findIndex((thread) => thread.id === threadId);
}

function sortThreads(threads) {
  return [...threads].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function isInvalidApiKeyError(error) {
  const message = String(error?.message || '');
  return /API_KEY_INVALID|API key not valid/i.test(message);
}

function normalizeActionKey(action = {}) {
  const type = String(action?.type || '').trim();
  if (action?.holding?.name) {
    return `${type || 'holding'}:${String(action.holding.name).trim().toLowerCase()}:${String(action.holding.category || '').trim()}`;
  }
  if (action?.profileChanges) return 'updateProfile';
  if (action?.scheduleTask?.title) {
    return `schedule:${String(action.scheduleTask.title).trim().toLowerCase()}:${String(action.scheduleTask.taskType || '').trim()}`;
  }
  if (action?.cancelTarget?.title) {
    return `cancel:${String(action.cancelTarget.title).trim().toLowerCase()}:${String(action.cancelTarget.taskType || '').trim()}`;
  }
  return `${type}:${JSON.stringify(action)}`;
}

function mergeConversationActions(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();

  for (const action of [...primary, ...secondary]) {
    if (!action || typeof action !== 'object') continue;
    const key = normalizeActionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(action);
  }

  return merged;
}

async function persistAssistantResponse(threadId, assistantMessage) {
  return mutateStore((store) => {
    const thread = store.chat.threads.find((item) => item.id === threadId);
    const messages = Array.isArray(store.chat.messagesByThread[threadId])
      ? store.chat.messagesByThread[threadId]
      : [];
    messages.push(assistantMessage);
    store.chat.messagesByThread[threadId] = messages;
    thread.messageCount = messages.length;
    thread.updatedAt = assistantMessage.createdAt;
    return {
      thread,
      messages,
      assistantMessage,
    };
  });
}

function listThreads() {
  const store = loadStore();
  return sortThreads(store.chat.threads);
}

async function createThread(title = '새 대화') {
  const now = new Date().toISOString();
  const thread = {
    id: randomUUID(),
    title: String(title || '새 대화').slice(0, 120),
    createdAt: now,
    updatedAt: now,
    summary: '',
    messageCount: 0,
    archived: false,
  };

  await mutateStore((store) => {
    store.chat.threads.unshift(thread);
    store.chat.messagesByThread[thread.id] = [];
  });

  logInfo('chat.thread.created', {
    threadId: thread.id,
    title: thread.title,
  });
  broadcast('chat.thread.created', { thread });
  return thread;
}

function getThread(threadId) {
  const store = loadStore();
  const thread = store.chat.threads.find((item) => item.id === threadId);
  if (!thread) return null;
  return {
    thread,
    messages: getThreadMessages(store.chat, threadId),
  };
}

async function deleteThread(threadId) {
  const removed = await mutateStore((store) => {
    const index = getThreadIndex(store.chat.threads, threadId);
    if (index < 0) return false;
    store.chat.threads.splice(index, 1);
    delete store.chat.messagesByThread[threadId];
    store.memory.threadSummaries = store.memory.threadSummaries.filter((item) => item.threadId !== threadId);
    store.memory.longTermMemories = store.memory.longTermMemories.filter(
      (item) => item.sourceThreadId !== threadId
    );
    return true;
  });
  logInfo('chat.thread.deleted', {
    threadId,
    removed,
  });
  if (removed) {
    broadcast('chat.thread.deleted', { threadId });
  }
  return removed;
}

function upsertThreadSummary(store, summary) {
  const index = store.memory.threadSummaries.findIndex((item) => item.threadId === summary.threadId);
  if (index >= 0) {
    store.memory.threadSummaries[index] = {
      ...store.memory.threadSummaries[index],
      ...summary,
      createdAt: store.memory.threadSummaries[index].createdAt || summary.createdAt,
    };
  } else {
    store.memory.threadSummaries.unshift(summary);
  }

  const thread = store.chat.threads.find((item) => item.id === summary.threadId);
  if (thread) {
    thread.summary = summary.summary;
    thread.updatedAt = new Date().toISOString();
  }
}

function upsertLongTermMemories(store, summary) {
  const candidates = [
    ...(summary.importantFacts || []).map((text) => ({ kind: 'fact', text })),
    ...(summary.personaHints || []).map((text) => ({ kind: 'preference', text })),
  ];

  for (const candidate of candidates) {
    const existing = store.memory.longTermMemories.find(
      (item) => item.kind === candidate.kind && item.text === candidate.text
    );

    if (existing) {
      existing.updatedAt = new Date().toISOString();
      continue;
    }

    store.memory.longTermMemories.unshift({
      id: randomUUID(),
      kind: candidate.kind,
      text: candidate.text,
      confidence: 'ai',
      sourceThreadId: summary.threadId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        sourceSummaryId: summary.id,
        tags: summary.tags || [],
      },
    });
  }

  store.memory.longTermMemories = store.memory.longTermMemories.slice(0, 60);
}

async function refreshThreadMemory(threadId) {
  if (!isAiConfigured()) return null;

  const store = loadStore();
  const messages = getThreadMessages(store.chat, threadId);
  if (messages.length < 2) return null;

  const existingSummary = store.memory.threadSummaries.find((item) => item.threadId === threadId);
  const summary = await summarizeThread({
    threadId,
    recentTranscript: formatMessagesForPrompt(messages.slice(-16)),
    existingSummary: existingSummary?.summary || '',
    sourceMessageIds: messages.slice(-16).map((item) => item.id),
  });

  const nextThread = await mutateStore((draft) => {
    upsertThreadSummary(draft, summary);
    upsertLongTermMemories(draft, summary);
    return draft.chat.threads.find((item) => item.id === threadId) || null;
  });

  logInfo('chat.memory.summary_refreshed', {
    threadId,
    tagCount: summary.tags.length,
    factCount: summary.importantFacts.length,
  });
  broadcast('chat.memory.updated', {
    threadId,
    summary,
    thread: nextThread,
  });
  if (nextThread) {
    broadcast('chat.thread.updated', { thread: nextThread });
  }
  return summary;
}

async function refreshAiProfileSummary() {
  if (!isAiConfigured()) return null;

  const store = loadStore();
  const nextProfile = await inferAiProfile({
    userProfile: store.profile.userProfile,
    threadSummaries: store.memory.threadSummaries,
    longTermMemories: store.memory.longTermMemories,
    managerReports: store.memory.managerReports,
  });

  await mutateStore((draft) => {
    draft.profile.aiProfile = {
      ...draft.profile.aiProfile,
      ...nextProfile,
      sourceMemoryIds: draft.memory.longTermMemories.slice(0, 8).map((item) => item.id),
    };
    draft.profile.metadata.lastAiRefreshAt = new Date().toISOString();
  });

  logInfo('chat.profile.ai_refreshed', {
    inferredTraitCount: nextProfile.inferredTraits.length,
    preferenceCount: nextProfile.preferences.length,
  });
  broadcast('profile.ai.updated', buildProfilePayload());
  broadcast('activity.created', {
    activity: {
      type: 'profile',
      title: 'AI 프로필 갱신',
      description: '대화 맥락과 장기 기억을 기반으로 투자자 프로필을 다시 정리했습니다.',
      tone: 'info',
      metadata: {
        inferredTraitCount: nextProfile.inferredTraits.length,
        preferenceCount: nextProfile.preferences.length,
      },
    },
  });
  return nextProfile;
}

function queueConversationMaintenance(threadId) {
  if (!isAiConfigured()) return;

  setTimeout(async () => {
    try {
      await refreshThreadMemory(threadId);
      await refreshAiProfileSummary();
    } catch (error) {
      logError('chat.maintenance.failed', error, {
        threadId,
      });
    }
  }, 0);
}

function buildAssistantMessage({
  id = randomUUID(),
  createdAt = new Date().toISOString(),
  content = '',
  model = 'gemini',
  metadata = {},
}) {
  return {
    id,
    role: 'assistant',
    content,
    createdAt,
    model,
    metadata,
  };
}

async function prepareUserTurn(threadId, cleanContent) {
  let snapshot = null;
  const userMessage = {
    id: randomUUID(),
    role: 'user',
    content: cleanContent,
    createdAt: new Date().toISOString(),
    model: null,
    metadata: {},
  };

  const userState = await mutateStore((store) => {
    const thread = store.chat.threads.find((item) => item.id === threadId);
    if (!thread) {
      throw new Error('대화 스레드를 찾을 수 없습니다.');
    }

    const messages = Array.isArray(store.chat.messagesByThread[threadId])
      ? store.chat.messagesByThread[threadId]
      : [];
    messages.push(userMessage);
    store.chat.messagesByThread[threadId] = messages;

    if (thread.messageCount === 0 || thread.title === '새 대화') {
      thread.title = buildThreadTitle(cleanContent);
    }
    thread.messageCount = messages.length;
    thread.updatedAt = new Date().toISOString();

    snapshot = JSON.parse(JSON.stringify(store));
    return {
      thread: { ...thread },
      messages,
    };
  });

  broadcast('chat.message.created', {
    thread: userState.thread,
    message: userMessage,
  });
  broadcast('chat.thread.updated', {
    thread: userState.thread,
  });

  const context = buildConversationContext({
    portfolio: snapshot.portfolio,
    profile: snapshot.profile,
    memory: snapshot.memory,
    chat: snapshot.chat,
    threadId,
  });

  logInfo('chat.message.start', {
    threadId,
    userMessageId: userMessage.id,
    contentPreview: cleanContent.slice(0, 160),
    existingMessageCount: context.messages.length,
  });

  return {
    snapshot,
    userMessage,
    userState,
    context,
  };
}

function buildAssistantMetadata(aiResult, actionState, workspacePatch, extra = {}) {
  return {
    citations: aiResult?.citations || [],
    supervisorPlan: aiResult?.supervisorPlan || null,
    specialistOutputs: aiResult?.specialistOutputs || [],
    actionResults: actionState?.actionResults || [],
    workspacePatch: workspacePatch || null,
    focusEntities: workspacePatch?.openDrawer?.entityId ? [workspacePatch.openDrawer.entityId] : [],
    reason: workspacePatch?.reason || '',
    ...extra,
  };
}

async function resolveAssistantTurn({
  cleanContent,
  threadId,
  context,
  assistantMessageId = randomUUID(),
  assistantCreatedAt = new Date().toISOString(),
  onAnswerChunk = null,
  onStage = null,
}) {
  let aiResult = null;
  let actionState = null;
  let assistantMessage = null;
  let skipMaintenance = false;
  const structuredImportPlan = buildStructuredImportPlan(cleanContent);

  try {
    aiResult = await runConversationGraph({
      userInput: cleanContent,
      threadId,
      context,
      onAnswerChunk,
      onStage,
    });

    if (structuredImportPlan?.actions?.length) {
      aiResult = {
        ...aiResult,
        actions: mergeConversationActions(structuredImportPlan.actions, aiResult.actions || []),
        workspacePatch: structuredImportPlan.workspacePatch || aiResult.workspacePatch || null,
      };
      logInfo('chat.actions.structured_import_supplemented', {
        threadId,
        structuredActionCount: structuredImportPlan.actions.length,
        aiActionCount: Array.isArray(aiResult.actions) ? aiResult.actions.length : 0,
      });
    }

    actionState = await applyConversationActions(aiResult.actions || []);
    logInfo('chat.actions.applied', {
      threadId,
      actionCount: Array.isArray(aiResult.actions) ? aiResult.actions.length : 0,
      appliedCount: actionState.actionResults.filter((item) => item.status === 'applied').length,
      ignoredCount: actionState.actionResults.filter((item) => item.status !== 'applied').length,
      results: actionState.actionResults,
    });
    if (actionState.changedProfile) {
      refreshAiProfileSummary().catch((error) => {
        logError('chat.profile_refresh_after_action.failed', error, {
          threadId,
        });
      });
    }

    assistantMessage = buildAssistantMessage({
      id: assistantMessageId,
      createdAt: assistantCreatedAt,
      content: aiResult.answer,
      model: 'gemini',
      metadata: buildAssistantMetadata(aiResult, actionState, aiResult.workspacePatch || null),
    });
  } catch (error) {
    const structuredImport = structuredImportPlan;
    if (structuredImport) {
      actionState = await applyConversationActions(structuredImport.actions || []);
      assistantMessage = buildAssistantMessage({
        id: assistantMessageId,
        createdAt: assistantCreatedAt,
        content: structuredImport.answer,
        model: 'fallback-import',
        metadata: buildAssistantMetadata(null, actionState, structuredImport.workspacePatch || null, {
          fallbackImport: true,
        }),
      });
      skipMaintenance = true;
      logInfo('chat.message.fallback_import', {
        threadId,
        actionCount: Array.isArray(structuredImport.actions) ? structuredImport.actions.length : 0,
        appliedCount: actionState.actionResults.filter((item) => item.status === 'applied').length,
      });
    } else if (isInvalidApiKeyError(error)) {
      assistantMessage = buildAssistantMessage({
        id: assistantMessageId,
        createdAt: assistantCreatedAt,
        content: '현재 Gemini API 키가 유효하지 않아 AI 응답을 생성하지 못했습니다. 키를 점검한 뒤 다시 시도해 주세요.',
        model: 'system',
        metadata: buildAssistantMetadata(null, null, null, {
          reason: 'AI 키 오류로 응답이 중단되었습니다.',
          aiError: 'invalid_api_key',
        }),
      });
      skipMaintenance = true;
      logInfo('chat.message.ai_key_invalid', {
        threadId,
      });
    } else {
      throw error;
    }
  }

  return {
    assistantMessage,
    skipMaintenance,
  };
}

async function finalizeAssistantTurn(threadId, assistantMessage, { skipMaintenance = false } = {}) {
  const response = await persistAssistantResponse(threadId, assistantMessage);
  broadcast('chat.message.created', {
    thread: response.thread,
    message: assistantMessage,
  });
  broadcast('chat.thread.updated', {
    thread: response.thread,
  });
  if (assistantMessage.metadata?.workspacePatch) {
    broadcast('workspace.patch', {
      threadId,
      workspacePatch: assistantMessage.metadata.workspacePatch,
    });
  }

  logInfo('chat.message.finish', {
    threadId,
    assistantMessageId: assistantMessage.id,
    answerPreview: assistantMessage.content.slice(0, 180),
    focusMode: assistantMessage.metadata.workspacePatch?.focusMode || '',
    messageCount: response.messages.length,
  });
  if (!skipMaintenance) {
    queueConversationMaintenance(threadId);
  }
  return response;
}

async function sendMessage(threadId, content) {
  const cleanContent = sanitizeMessage(content);
  if (!cleanContent) {
    throw new Error('보낼 메시지를 입력해 주세요.');
  }
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 채팅 기능이 비활성화되어 있습니다.');
  }

  const { context } = await prepareUserTurn(threadId, cleanContent);
  const { assistantMessage, skipMaintenance } = await resolveAssistantTurn({
    cleanContent,
    threadId,
    context,
  });
  return finalizeAssistantTurn(threadId, assistantMessage, { skipMaintenance });
}

async function sendMessageStream(threadId, content, emit = () => {}) {
  const cleanContent = sanitizeMessage(content);
  if (!cleanContent) {
    throw new Error('보낼 메시지를 입력해 주세요.');
  }
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 채팅 기능이 비활성화되어 있습니다.');
  }

  const assistantMessageId = randomUUID();
  const assistantCreatedAt = new Date().toISOString();
  const { userState, context } = await prepareUserTurn(threadId, cleanContent);

  emit({
    type: 'start',
    thread: userState.thread,
    assistantMessageId,
    assistantCreatedAt,
    message: '대화 맥락을 정리하고 있습니다.',
  });

  const { assistantMessage, skipMaintenance } = await resolveAssistantTurn({
    cleanContent,
    threadId,
    context,
    assistantMessageId,
    assistantCreatedAt,
    onStage: async (stage) => {
      emit({
        type: 'stage',
        ...stage,
      });
    },
    onAnswerChunk: async (delta) => {
      emit({
        type: 'delta',
        threadId,
        assistantMessageId,
        delta,
        message: {
          id: assistantMessageId,
          role: 'assistant',
          createdAt: assistantCreatedAt,
          model: 'gemini',
          metadata: {
            streaming: true,
          },
        },
      });
    },
  });

  const response = await finalizeAssistantTurn(threadId, assistantMessage, { skipMaintenance });
  emit({
    type: 'done',
    thread: response.thread,
    assistantMessage,
  });
  return response;
}

module.exports = {
  listThreads,
  createThread,
  getThread,
  deleteThread,
  sendMessage,
  sendMessageStream,
  refreshThreadMemory,
  refreshAiProfileSummary,
};
