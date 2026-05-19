const crypto = require('crypto');
const { loadStore, mutateStore, CATEGORIES } = require('./dataStore');
const { buildStructuredImportPlan } = require('./structuredImportService');
const { applyConversationActions } = require('./actionService');

function formatKrw(amount) {
  return `${Math.round(Number(amount) || 0).toLocaleString('ko-KR')}원`;
}

function describeHoldingDiff(action, holdings = []) {
  const payload = action?.holding || {};
  const name = String(payload.name || '').trim();
  const category = CATEGORIES.includes(payload.category) ? payload.category : 'deposit';
  const nextAmount = Math.max(0, Math.round(Number(payload.amount) || 0));
  const index = holdings.findIndex(
    (item) =>
      String(item.name || '').trim().toLowerCase() === name.toLowerCase() &&
      (!payload.category || item.category === category)
  );
  if (index < 0) {
    return {
      type: action.type,
      status: 'create',
      label: name || '이름 없음',
      before: null,
      after: formatKrw(nextAmount),
      message: `${name || '자산'} 신규 추가 · ${formatKrw(nextAmount)}`,
    };
  }
  const current = holdings[index];
  const beforeAmount = Math.round(Number(current.amount) || 0);
  if (beforeAmount === nextAmount) {
    return {
      type: action.type,
      status: 'update',
      label: name,
      before: formatKrw(beforeAmount),
      after: formatKrw(nextAmount),
      message: `${name} 금액 유지 · ${formatKrw(nextAmount)}`,
    };
  }
  return {
    type: action.type,
    status: 'update',
    label: name,
    before: formatKrw(beforeAmount),
    after: formatKrw(nextAmount),
    message: `${name} ${formatKrw(beforeAmount)} → ${formatKrw(nextAmount)}`,
  };
}

function describeActionDiff(action, store) {
  const type = String(action?.type || '');
  if (type === 'upsertHolding') {
    return describeHoldingDiff(action, store.portfolio.holdings || []);
  }
  if (type === 'removeHolding') {
    const name = String(action?.holding?.name || '').trim();
    return {
      type,
      status: 'delete',
      label: name || '자산',
      before: '존재',
      after: null,
      message: `${name || '자산'} 삭제`,
    };
  }
  if (type === 'updateProfile') {
    const keys = Object.keys(action.profileChanges || {});
    return {
      type,
      status: 'update',
      label: '프로필',
      before: null,
      after: keys.join(', ') || '변경',
      message: `프로필 필드 갱신: ${keys.join(', ') || '없음'}`,
    };
  }
  if (type === 'scheduleTask') {
    const title = String(action?.scheduleTask?.title || '예약 작업');
    return {
      type,
      status: 'create',
      label: title,
      before: null,
      after: String(action?.scheduleTask?.cronExpression || ''),
      message: `예약 작업 추가 · ${title}`,
    };
  }
  return {
    type: type || 'unknown',
    status: 'update',
    label: type || '액션',
    before: null,
    after: null,
    message: action?.rationale || '변경 예정',
  };
}

function buildImportPreview(content) {
  const plan = buildStructuredImportPlan(content);
  if (!plan?.actions?.length) {
    return {
      available: false,
      reason: '구조화 가능한 자산/설정 패턴을 찾지 못했습니다.',
      plan: null,
      diff: [],
    };
  }
  const store = loadStore();
  const diff = plan.actions.map((action) => describeActionDiff(action, store));
  return {
    available: true,
    reason: plan.usedFallback ? 'AI 없이 구조화 import 규칙으로 해석합니다.' : '구조화 import 미리보기',
    plan: {
      actionCount: plan.actions.length,
      answerPreview: String(plan.answer || '').slice(0, 400),
      usedFallback: Boolean(plan.usedFallback),
    },
    diff,
  };
}

async function applyImportWithUndo(content) {
  const preview = buildImportPreview(content);
  if (!preview.available) {
    throw new Error(preview.reason || '적용할 import 계획이 없습니다.');
  }
  const plan = buildStructuredImportPlan(content);
  const undoId = crypto.randomUUID();
  const storeBefore = loadStore();

  await mutateStore((store) => {
    store.memory.lastImportUndo = {
      id: undoId,
      createdAt: new Date().toISOString(),
      portfolioHoldings: JSON.parse(JSON.stringify(store.portfolio.holdings || [])),
      profileUser: JSON.parse(JSON.stringify(store.profile.userProfile || {})),
    };
  });

  const actionState = await applyConversationActions(plan.actions || []);
  return {
    undoId,
    preview,
    actionState,
    answer: plan.answer,
    workspacePatch: plan.workspacePatch || null,
  };
}

async function undoLastImport() {
  const store = loadStore();
  const snapshot = store.memory.lastImportUndo;
  if (!snapshot?.portfolioHoldings) {
    throw new Error('되돌릴 import 작업이 없습니다.');
  }

  await mutateStore((draft) => {
    draft.portfolio.holdings = JSON.parse(JSON.stringify(snapshot.portfolioHoldings));
    if (snapshot.profileUser) {
      draft.profile.userProfile = JSON.parse(JSON.stringify(snapshot.profileUser));
    }
    draft.memory.lastImportUndo = null;
  });

  return { ok: true, restoredAt: new Date().toISOString() };
}

function hasImportUndo() {
  return Boolean(loadStore().memory?.lastImportUndo?.portfolioHoldings);
}

module.exports = {
  buildImportPreview,
  applyImportWithUndo,
  undoLastImport,
  hasImportUndo,
};
