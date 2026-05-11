import { computed, ref } from 'vue';

const BASE_PANELS = [
  {
    id: 'overview',
    title: '포트폴리오 개요',
    column: 'left',
    span: 'lg',
    priority: 10,
    visible: true,
    detailType: 'assetDetail',
  },
  {
    id: 'holdings',
    title: '보유 자산',
    column: 'left',
    span: 'xl',
    priority: 20,
    visible: true,
    detailType: 'assetDetail',
  },
  {
    id: 'snapshots',
    title: '스냅샷',
    column: 'center',
    span: 'md',
    priority: 10,
    visible: true,
    detailType: 'system',
  },
  {
    id: 'chat',
    title: '대화',
    column: 'center',
    span: 'xl',
    priority: 20,
    visible: true,
    detailType: 'threadDetail',
  },
  {
    id: 'activity',
    title: '실시간 활동',
    column: 'center',
    span: 'md',
    priority: 30,
    visible: true,
    detailType: 'threadDetail',
  },
  {
    id: 'managerBrief',
    title: 'Quant Manager',
    column: 'right',
    span: 'lg',
    priority: 10,
    visible: true,
    detailType: 'managerBrief',
  },
  {
    id: 'profile',
    title: '프로필',
    column: 'right',
    span: 'md',
    priority: 20,
    visible: true,
    detailType: 'profile',
  },
  {
    id: 'system',
    title: '시스템',
    column: 'right',
    span: 'md',
    priority: 30,
    visible: true,
    detailType: 'system',
  },
];

const ALLOWED_COLUMNS = new Set(['left', 'center', 'right']);
const ALLOWED_SPANS = new Set(['sm', 'md', 'lg', 'xl', 'full']);
const PANEL_IDS = new Set(BASE_PANELS.map((panel) => panel.id));
const HIDEABLE_PANELS = new Set(['activity', 'profile', 'system', 'snapshots']);

const focusMode = ref('balanced');
const layoutReason = ref('기본 워크스페이스 레이아웃');
const selectedHoldingId = ref(null);
const selectedThreadId = ref(null);
const lastPatchSource = ref('system');
const layoutUpdatedAt = ref(null);
const activityFeed = ref([]);
const drawer = ref({
  open: false,
  type: null,
  entityId: null,
  title: '',
});
const panelState = ref(
  Object.fromEntries(
    BASE_PANELS.map((panel) => [
      panel.id,
      {
        column: panel.column,
        span: panel.span,
        priority: panel.priority,
        visible: panel.visible,
        highlighted: false,
      },
    ])
  )
);

function buildStateSnapshot() {
  return Object.fromEntries(
    BASE_PANELS.map((panel) => [
      panel.id,
      {
        column: panel.column,
        span: panel.span,
        priority: panel.priority,
        visible: panel.visible,
        highlighted: false,
      },
    ])
  );
}

function normalizePatch(patch) {
  if (!patch || typeof patch !== 'object') {
    return null;
  }

  const next = {
    focusMode: typeof patch.focusMode === 'string' ? patch.focusMode : null,
    reason: typeof patch.reason === 'string' ? patch.reason : '',
    highlightPanelIds: Array.isArray(patch.highlightPanelIds)
      ? patch.highlightPanelIds.filter((id) => PANEL_IDS.has(id))
      : [],
    openDrawer:
      patch.openDrawer && typeof patch.openDrawer === 'object'
        ? {
            type: typeof patch.openDrawer.type === 'string' ? patch.openDrawer.type : null,
            entityId:
              typeof patch.openDrawer.entityId === 'string' ? patch.openDrawer.entityId : null,
            title: typeof patch.openDrawer.title === 'string' ? patch.openDrawer.title : '',
          }
        : null,
    panelPatches: Array.isArray(patch.panelPatches)
      ? patch.panelPatches
          .filter((item) => item && PANEL_IDS.has(item.id))
          .map((item) => ({
            id: item.id,
            column: ALLOWED_COLUMNS.has(item.column) ? item.column : null,
            span: ALLOWED_SPANS.has(item.span) ? item.span : null,
            priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : null,
            visible:
              typeof item.visible === 'boolean' &&
              (item.visible || HIDEABLE_PANELS.has(item.id))
                ? item.visible
                : null,
          }))
      : [],
  };

  return next;
}

function applyWorkspacePatch(patch, source = 'system') {
  const normalized = normalizePatch(patch);
  if (!normalized) return;

  const next = {
    ...panelState.value,
  };

  for (const panel of BASE_PANELS) {
    next[panel.id] = {
      ...next[panel.id],
      highlighted: normalized.highlightPanelIds.includes(panel.id),
    };
  }

  for (const item of normalized.panelPatches) {
    const prev = next[item.id];
    next[item.id] = {
      ...prev,
      column: item.column || prev.column,
      span: item.span || prev.span,
      priority: item.priority ?? prev.priority,
      visible: item.visible ?? prev.visible,
    };
  }

  panelState.value = next;
  if (normalized.focusMode) {
    focusMode.value = normalized.focusMode;
  }
  if (normalized.reason) {
    layoutReason.value = normalized.reason;
  }
  if (normalized.openDrawer?.type) {
    drawer.value = {
      open: true,
      type: normalized.openDrawer.type,
      entityId: normalized.openDrawer.entityId,
      title: normalized.openDrawer.title || drawer.value.title,
    };
  }
  layoutUpdatedAt.value = new Date().toISOString();
  lastPatchSource.value = source;
}

function resetWorkspaceLayout() {
  panelState.value = buildStateSnapshot();
  focusMode.value = 'balanced';
  layoutReason.value = '기본 워크스페이스 레이아웃';
  lastPatchSource.value = 'system';
  layoutUpdatedAt.value = new Date().toISOString();
}

function recordActivity({
  type = 'system',
  title = '',
  description = '',
  tone = 'info',
  entityId = null,
  metadata = {},
} = {}) {
  activityFeed.value.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    title,
    description,
    tone,
    entityId,
    metadata,
    createdAt: new Date().toISOString(),
  });
  activityFeed.value = activityFeed.value.slice(0, 60);
}

function openDrawer(type, entityId = null, title = '') {
  drawer.value = {
    open: true,
    type,
    entityId,
    title,
  };
}

function closeDrawer() {
  drawer.value = {
    open: false,
    type: null,
    entityId: null,
    title: '',
  };
}

function selectHolding(holdingId) {
  selectedHoldingId.value = holdingId;
}

function selectThread(threadId) {
  selectedThreadId.value = threadId;
}

function handleAssistantMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return;
  if (metadata.workspacePatch) {
    applyWorkspacePatch(metadata.workspacePatch, 'assistant');
  }
  recordActivity({
    type: 'assistant',
    title: '대화 응답 도착',
    description: metadata.workspacePatch?.reason || '레이아웃과 응답이 갱신되었습니다.',
    tone: 'info',
    metadata,
  });
}

const panels = computed(() =>
  BASE_PANELS.map((panel) => ({
    ...panel,
    ...panelState.value[panel.id],
  }))
);

const visiblePanels = computed(() => panels.value.filter((panel) => panel.visible));

const columns = computed(() => ({
  left: visiblePanels.value
    .filter((panel) => panel.column === 'left')
    .sort((a, b) => a.priority - b.priority),
  center: visiblePanels.value
    .filter((panel) => panel.column === 'center')
    .sort((a, b) => a.priority - b.priority),
  right: visiblePanels.value
    .filter((panel) => panel.column === 'right')
    .sort((a, b) => a.priority - b.priority),
}));

export function useWorkspace() {
  return {
    focusMode,
    layoutReason,
    layoutUpdatedAt,
    lastPatchSource,
    selectedHoldingId,
    selectedThreadId,
    drawer,
    panels,
    columns,
    activityFeed,
    applyWorkspacePatch,
    resetWorkspaceLayout,
    recordActivity,
    openDrawer,
    closeDrawer,
    selectHolding,
    selectThread,
    handleAssistantMetadata,
  };
}
