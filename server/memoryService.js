const crypto = require('crypto');
const { loadStore, mutateStore } = require('./dataStore');

function getMemoryState() {
  const store = loadStore();
  return {
    longTermMemories: (store.memory.longTermMemories || []).slice(0, 60),
    threadSummaries: (store.memory.threadSummaries || []).slice(0, 30),
    pinnedCount: (store.memory.longTermMemories || []).filter((item) => item.metadata?.pinned).length,
  };
}

async function deleteLongTermMemory(memoryId) {
  let removed = false;
  await mutateStore((store) => {
    const before = store.memory.longTermMemories.length;
    store.memory.longTermMemories = store.memory.longTermMemories.filter(
      (item) => item.id !== memoryId
    );
    removed = before !== store.memory.longTermMemories.length;
  });
  return removed;
}

async function setLongTermMemoryPinned(memoryId, pinned = true) {
  let updated = false;
  await mutateStore((store) => {
    const target = store.memory.longTermMemories.find((item) => item.id === memoryId);
    if (!target) return;
    target.metadata = {
      ...(target.metadata || {}),
      pinned: Boolean(pinned),
    };
    target.updatedAt = new Date().toISOString();
    updated = true;
  });
  return updated;
}

async function updateThreadSummary(summaryId, patch = {}) {
  let updated = null;
  await mutateStore((store) => {
    const target = store.memory.threadSummaries.find((item) => item.id === summaryId);
    if (!target) return;
    if (patch.summary !== undefined) {
      target.summary = String(patch.summary || '').slice(0, 2000);
    }
    if (Array.isArray(patch.importantFacts)) {
      target.importantFacts = patch.importantFacts.map(String).slice(0, 12);
    }
    target.updatedAt = new Date().toISOString();
    updated = { ...target };
  });
  return updated;
}

async function createLongTermMemory({ text, kind = 'insight', sourceThreadId = null } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('기억 내용이 비어 있습니다.');
  }
  const now = new Date().toISOString();
  const memory = {
    id: crypto.randomUUID(),
    kind: String(kind || 'insight').slice(0, 40),
    text: trimmed.slice(0, 1200),
    confidence: 'manual',
    sourceThreadId: sourceThreadId ? String(sourceThreadId) : null,
    createdAt: now,
    updatedAt: now,
    metadata: { pinned: false },
  };
  await mutateStore((store) => {
    store.memory.longTermMemories.unshift(memory);
    store.memory.longTermMemories = store.memory.longTermMemories.slice(0, 60);
  });
  return memory;
}

module.exports = {
  getMemoryState,
  deleteLongTermMemory,
  setLongTermMemoryPinned,
  updateThreadSummary,
  createLongTermMemory,
};
