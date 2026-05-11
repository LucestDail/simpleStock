import { computed, ref } from 'vue';

const BASE_PANELS = [
  {
    id: 'status',
    title: '운영 상태',
    column: 'left',
    span: 'xs',
    priority: 5,
    visible: true,
    detailType: 'system',
  },
  {
    id: 'overview',
    title: '포트폴리오 개요',
    column: 'left',
    span: 'xs',
    priority: 10,
    visible: true,
    detailType: 'assetDetail',
  },
  {
    id: 'holdings',
    title: '보유 자산',
    column: 'left',
    span: 'md',
    priority: 20,
    visible: true,
    detailType: 'assetDetail',
  },
  {
    id: 'chat',
    title: '대화',
    column: 'center',
    span: 'full',
    priority: 100,
    visible: true,
    detailType: 'threadDetail',
  },
  {
    id: 'insights',
    title: '라이브 인사이트',
    column: 'right',
    span: 'xs',
    priority: 5,
    visible: true,
    detailType: 'insight',
  },
  {
    id: 'managerBrief',
    title: 'Quant Manager',
    column: 'right',
    span: 'xs',
    priority: 10,
    visible: true,
    detailType: 'managerBrief',
  },
  {
    id: 'snapshots',
    title: '예정 작업',
    column: 'right',
    span: 'xs',
    priority: 20,
    visible: true,
    detailType: 'system',
  },
  {
    id: 'activity',
    title: '실시간 활동',
    column: 'right',
    span: 'xs',
    priority: 30,
    visible: true,
    detailType: 'threadDetail',
  },
  {
    id: 'profile',
    title: '프로필',
    column: 'right',
    span: 'xs',
    priority: 40,
    visible: true,
    detailType: 'profile',
  },
  {
    id: 'system',
    title: '시스템',
    column: 'left',
    span: 'xs',
    priority: 30,
    visible: true,
    detailType: 'system',
  },
];

const ALLOWED_COLUMNS = new Set(['left', 'center', 'right']);
const ALLOWED_SPANS = new Set(['xs', 'sm', 'md', 'lg', 'xl', 'full']);
const PANEL_IDS = new Set(BASE_PANELS.map((panel) => panel.id));
const HIDEABLE_PANELS = new Set(['activity', 'profile', 'system', 'snapshots', 'insights', 'managerBrief']);

const focusMode = ref('balanced');
const layoutReason = ref('기본 워크스페이스 레이아웃');
const selectedHoldingId = ref(null);
const selectedCategoryId = ref(null);
const selectedThreadId = ref(null);
const lastPatchSource = ref('system');
const layoutUpdatedAt = ref(null);
const activityFeed = ref([]);
const generatedInsights = ref([]);
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
    hasGeneratedInsights: Array.isArray(patch.generatedInsights),
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
    generatedInsights: Array.isArray(patch.generatedInsights)
      ? patch.generatedInsights
          .map((item, index) => ({
            id:
              typeof item?.id === 'string' && item.id.trim()
                ? item.id.trim()
                : `insight-${index + 1}`,
            title: typeof item?.title === 'string' ? item.title.trim() : '',
            summary: typeof item?.summary === 'string' ? item.summary.trim() : '',
            tone:
              item?.tone === 'primary' || item?.tone === 'positive' || item?.tone === 'warning'
                ? item.tone
                : 'default',
            metrics: Array.isArray(item?.metrics)
              ? item.metrics
                  .map((metric) => ({
                    label: typeof metric?.label === 'string' ? metric.label.trim() : '',
                    value: typeof metric?.value === 'string' ? metric.value.trim() : '',
                  }))
                  .filter((metric) => metric.label && metric.value)
                  .slice(0, 4)
              : [],
            bullets: Array.isArray(item?.bullets)
              ? item.bullets
                  .map((bullet) => (typeof bullet === 'string' ? bullet.trim() : ''))
                  .filter(Boolean)
                  .slice(0, 4)
              : [],
          }))
          .filter((item) => item.title || item.summary || item.metrics.length || item.bullets.length)
          .slice(0, 4)
      : [],
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
    const isChatPanel = item.id === 'chat';
    const nextColumn = isChatPanel
      ? 'center'
      : item.column === 'center'
        ? prev.column
        : (item.column || prev.column);
    next[item.id] = {
      ...prev,
      column: nextColumn,
      span: isChatPanel ? 'full' : (item.span || prev.span),
      priority: isChatPanel ? 100 : (item.priority ?? prev.priority),
      visible: isChatPanel ? true : (item.visible ?? prev.visible),
    };
  }

  panelState.value = next;
  if (normalized.hasGeneratedInsights) {
    generatedInsights.value = normalized.generatedInsights;
  }
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
  id = null,
  type = 'system',
  title = '',
  description = '',
  tone = 'info',
  entityId = null,
  metadata = {},
} = {}) {
  const activityId = id || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (activityFeed.value.some((item) => item.id === activityId)) {
    return;
  }
  activityFeed.value.unshift({
    id: activityId,
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

function selectCategory(categoryId) {
  selectedCategoryId.value = categoryId;
}

function clearCategory() {
  selectedCategoryId.value = null;
}

function selectThread(threadId) {
  selectedThreadId.value = threadId;
}

function handleAssistantMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return;
  if (metadata.workspacePatch) {
    applyWorkspacePatch(metadata.workspacePatch, 'assistant');
  }
  for (const item of metadata.actionResults || []) {
    if (item?.status !== 'applied') continue;
    recordActivity({
      type: 'assistant-action',
      title: '대화 액션 반영',
      description: item.message || '자연어 요청이 데이터에 반영되었습니다.',
      tone: 'info',
      metadata: item,
    });
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
    selectedCategoryId,
    selectedThreadId,
    drawer,
    panels,
    columns,
    activityFeed,
    generatedInsights,
    applyWorkspacePatch,
    resetWorkspaceLayout,
    recordActivity,
    openDrawer,
    closeDrawer,
    selectHolding,
    selectCategory,
    clearCategory,
    selectThread,
    handleAssistantMetadata,
  };
}
