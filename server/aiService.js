const { randomUUID } = require('crypto');
const { z } = require('zod');
const { APP_TIMEZONE, getDateInTimezone } = require('./time');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const GEMINI_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'high';
const AI_DAILY_CRON = process.env.AI_DAILY_CRON || '5 21 * * *';

let googleGenAiCtorPromise = null;
let conversationGraphPromise = null;

const WORKSPACE_PATCH_SCHEMA = {
  type: 'object',
  properties: {
    focusMode: {
      type: 'string',
      enum: ['balanced', 'chat', 'rebalance', 'manager', 'research'],
    },
    highlightPanelIds: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'overview',
          'holdings',
          'snapshots',
          'chat',
          'activity',
          'managerBrief',
          'profile',
          'system',
        ],
      },
    },
    panelPatches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            enum: [
              'overview',
              'holdings',
              'snapshots',
              'chat',
              'activity',
              'managerBrief',
              'profile',
              'system',
            ],
          },
          column: {
            type: 'string',
            enum: ['left', 'center', 'right'],
          },
          span: {
            type: 'string',
            enum: ['sm', 'md', 'lg', 'xl', 'full'],
          },
          priority: {
            type: 'number',
          },
          visible: {
            type: 'boolean',
          },
        },
        required: ['id', 'column', 'span', 'priority', 'visible'],
      },
    },
    openDrawer: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['assetDetail', 'threadDetail', 'managerBrief', 'profile', 'system'],
        },
        entityId: {
          type: 'string',
        },
        title: {
          type: 'string',
        },
      },
      required: ['type', 'entityId', 'title'],
    },
    reason: {
      type: 'string',
    },
  },
  required: ['focusMode', 'highlightPanelIds', 'panelPatches', 'openDrawer', 'reason'],
};

const SUPERVISOR_SCHEMA = {
  type: 'object',
  properties: {
    personaLabel: { type: 'string' },
    personaSystemPrompt: { type: 'string' },
    synthesisInstructions: { type: 'string' },
    workspacePatch: WORKSPACE_PATCH_SCHEMA,
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          agentType: {
            type: 'string',
            enum: ['portfolio', 'memory', 'manager', 'research'],
          },
          title: { type: 'string' },
          objective: { type: 'string' },
          systemPrompt: { type: 'string' },
          needsSearch: { type: 'boolean' },
          searchQuery: { type: 'string' },
        },
        required: ['id', 'agentType', 'title', 'objective', 'systemPrompt', 'needsSearch', 'searchQuery'],
      },
    },
  },
  required: ['personaLabel', 'personaSystemPrompt', 'synthesisInstructions', 'workspacePatch', 'tasks'],
};

const THREAD_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    importantFacts: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    personaHints: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'importantFacts', 'unresolvedQuestions', 'personaHints', 'tags'],
};

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    inferredTraits: { type: 'array', items: { type: 'string' } },
    preferences: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'inferredTraits', 'preferences', 'concerns'],
};

const MANAGER_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    dailyObjective: { type: 'string' },
    actionItems: { type: 'array', items: { type: 'string' } },
    riskChecks: { type: 'array', items: { type: 'string' } },
    allocationNotes: { type: 'array', items: { type: 'string' } },
    conversationInsights: { type: 'array', items: { type: 'string' } },
    profileUpdates: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'summary',
    'dailyObjective',
    'actionItems',
    'riskChecks',
    'allocationNotes',
    'conversationInsights',
    'profileUpdates',
  ],
};

function isAiConfigured() {
  return Boolean(GEMINI_API_KEY);
}

function getAiSettings() {
  return {
    configured: isAiConfigured(),
    model: GEMINI_MODEL,
    thinkingLevel: GEMINI_THINKING_LEVEL,
    timezone: APP_TIMEZONE,
    dailyCron: AI_DAILY_CRON,
  };
}

async function getGoogleGenAI() {
  if (!googleGenAiCtorPromise) {
    googleGenAiCtorPromise = import('@google/genai').then((module) => module.GoogleGenAI);
  }
  return googleGenAiCtorPromise;
}

function buildEnvelope(systemPrompt, userPrompt) {
  return [
    'System instructions:',
    systemPrompt.trim(),
    '',
    'User request:',
    userPrompt.trim(),
  ].join('\n');
}

function extractTextFromResponse(response) {
  if (!response) return '';
  if (typeof response.text === 'string' && response.text.trim()) return response.text.trim();
  if (typeof response.outputText === 'string' && response.outputText.trim()) return response.outputText.trim();

  const text = response.candidates?.[0]?.content?.parts
    ?.map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || '';
}

function stripFence(value) {
  return value
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(stripFence(value));
  } catch {
    return fallback;
  }
}

function getGroundingSources(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return chunks
    .map((chunk) => ({
      title: chunk.web?.title || chunk.retrievedContext?.title || '참고 자료',
      url: chunk.web?.uri || chunk.retrievedContext?.uri || '',
    }))
    .filter((item) => item.url)
    .filter((item, index, array) => array.findIndex((x) => x.url === item.url) === index)
    .slice(0, 6);
}

async function generateContent({
  systemPrompt,
  userPrompt,
  schema = null,
  useGoogleSearch = false,
}) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 AI 기능이 비활성화되어 있습니다.');
  }

  const GoogleGenAI = await getGoogleGenAI();
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildEnvelope(systemPrompt, userPrompt),
    config: {
      thinkingConfig: {
        thinkingLevel: GEMINI_THINKING_LEVEL,
      },
      ...(schema
        ? {
            responseFormat: {
              text: {
                mimeType: 'application/json',
                schema,
              },
            },
          }
        : {}),
      ...(useGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
    },
  });

  return response;
}

async function generateStructuredOutput(options, fallback) {
  const response = await generateContent(options);
  return safeParseJson(extractTextFromResponse(response), fallback);
}

function buildFallbackPlan(userInput, context) {
  const lowered = userInput.toLowerCase();
  const tasks = [
    {
      id: randomUUID(),
      agentType: 'portfolio',
      title: '포트폴리오 분석',
      objective: '보유 자산과 최근 변동을 요약한다.',
      systemPrompt:
        '당신은 한국 개인 투자자를 돕는 포트폴리오 분석가다. 수치와 분류 구조를 먼저 읽고, 실제 자산 상태를 간결하게 설명한다.',
      needsSearch: false,
      searchQuery: '',
    },
    {
      id: randomUUID(),
      agentType: 'memory',
      title: '대화 기억 정리',
      objective: '기존 대화와 사용자 성향에서 관련 맥락을 뽑아낸다.',
      systemPrompt:
        '당신은 장기 기억 관리자다. 최근 대화 요약, 장기 기억, 사용자 선호를 읽고 이번 질문에 필요한 맥락만 추린다.',
      needsSearch: false,
      searchQuery: '',
    },
  ];

  if (/(전략|리밸런싱|관리|지시|매니저|오늘)/.test(lowered)) {
    tasks.push({
      id: randomUUID(),
      agentType: 'manager',
      title: '매니저 시각',
      objective: '오늘의 실행 우선순위와 리스크 관리를 정리한다.',
      systemPrompt:
        '당신은 개인 자산 관리 매니저다. 단기 행동, 리스크 체크, 오늘의 우선순위를 제시한다.',
      needsSearch: false,
      searchQuery: '',
    });
  }

  if (/(뉴스|시장|시황|검색|찾아|외부|web|search)/.test(lowered)) {
    tasks.push({
      id: randomUUID(),
      agentType: 'research',
      title: '외부 조사',
      objective: '질문에 맞는 외부 시장 정보를 요약한다.',
      systemPrompt:
        '당신은 외부 시장 조사 에이전트다. 검색 질의를 재구성하고, 필요한 사실만 간결히 보고한다.',
      needsSearch: true,
      searchQuery: userInput,
    });
  }

  let workspacePatch = {
    focusMode: 'balanced',
    highlightPanelIds: ['overview', 'chat'],
    panelPatches: [
      { id: 'overview', column: 'left', span: 'lg', priority: 10, visible: true },
      { id: 'holdings', column: 'left', span: 'xl', priority: 20, visible: true },
      { id: 'snapshots', column: 'center', span: 'md', priority: 10, visible: true },
      { id: 'chat', column: 'center', span: 'xl', priority: 20, visible: true },
      { id: 'activity', column: 'center', span: 'md', priority: 30, visible: true },
      { id: 'managerBrief', column: 'right', span: 'lg', priority: 10, visible: true },
      { id: 'profile', column: 'right', span: 'md', priority: 20, visible: true },
      { id: 'system', column: 'right', span: 'md', priority: 30, visible: true },
    ],
    openDrawer: {
      type: 'threadDetail',
      entityId: context.messages?.length ? String(context.messages.at(-1)?.id || '') : '',
      title: '대화 상세',
    },
    reason: '기본 워크스페이스 레이아웃을 유지합니다.',
  };

  if (/(리밸런싱|비중|분산|재배치|재조정)/.test(lowered)) {
    workspacePatch = {
      focusMode: 'rebalance',
      highlightPanelIds: ['chat', 'managerBrief', 'holdings', 'overview'],
      panelPatches: [
        { id: 'overview', column: 'left', span: 'lg', priority: 10, visible: true },
        { id: 'holdings', column: 'left', span: 'xl', priority: 15, visible: true },
        { id: 'snapshots', column: 'center', span: 'md', priority: 10, visible: true },
        { id: 'chat', column: 'center', span: 'full', priority: 20, visible: true },
        { id: 'activity', column: 'center', span: 'md', priority: 30, visible: true },
        { id: 'managerBrief', column: 'right', span: 'xl', priority: 10, visible: true },
        { id: 'profile', column: 'right', span: 'md', priority: 20, visible: false },
        { id: 'system', column: 'right', span: 'md', priority: 30, visible: true },
      ],
      openDrawer: {
        type: 'managerBrief',
        entityId: '',
        title: '리밸런싱 컨텍스트',
      },
      reason: '리밸런싱 요청이라 채팅과 매니저 브리핑, 자산 패널을 확장합니다.',
    };
  } else if (/(전략|관리|지시|매니저|오늘)/.test(lowered)) {
    workspacePatch = {
      focusMode: 'manager',
      highlightPanelIds: ['managerBrief', 'chat', 'activity'],
      panelPatches: [
        { id: 'overview', column: 'left', span: 'md', priority: 10, visible: true },
        { id: 'holdings', column: 'left', span: 'lg', priority: 20, visible: true },
        { id: 'snapshots', column: 'center', span: 'md', priority: 10, visible: true },
        { id: 'chat', column: 'center', span: 'xl', priority: 20, visible: true },
        { id: 'activity', column: 'center', span: 'lg', priority: 30, visible: true },
        { id: 'managerBrief', column: 'right', span: 'full', priority: 10, visible: true },
        { id: 'profile', column: 'right', span: 'md', priority: 20, visible: false },
        { id: 'system', column: 'right', span: 'md', priority: 30, visible: true },
      ],
      openDrawer: {
        type: 'managerBrief',
        entityId: '',
        title: '매니저 브리핑 상세',
      },
      reason: '관리 지시 성격의 요청이라 매니저 브리핑과 활동 패널을 강조합니다.',
    };
  } else if (/(뉴스|시장|시황|검색|찾아|외부|web|search)/.test(lowered)) {
    workspacePatch = {
      focusMode: 'research',
      highlightPanelIds: ['chat', 'activity', 'system'],
      panelPatches: [
        { id: 'overview', column: 'left', span: 'md', priority: 10, visible: true },
        { id: 'holdings', column: 'left', span: 'lg', priority: 20, visible: true },
        { id: 'snapshots', column: 'center', span: 'sm', priority: 10, visible: true },
        { id: 'chat', column: 'center', span: 'full', priority: 20, visible: true },
        { id: 'activity', column: 'right', span: 'xl', priority: 10, visible: true },
        { id: 'managerBrief', column: 'right', span: 'md', priority: 20, visible: true },
        { id: 'profile', column: 'right', span: 'sm', priority: 30, visible: false },
        { id: 'system', column: 'right', span: 'md', priority: 40, visible: true },
      ],
      openDrawer: {
        type: 'system',
        entityId: '',
        title: '리서치 컨텍스트',
      },
      reason: '외부 검색/리서치 요청이라 대화와 실시간 활동, 시스템 컨텍스트를 강조합니다.',
    };
  } else if (/(프로필|성향|선호|응답 스타일|메모리)/.test(lowered)) {
    workspacePatch = {
      focusMode: 'balanced',
      highlightPanelIds: ['profile', 'chat', 'activity'],
      panelPatches: [
        { id: 'overview', column: 'left', span: 'md', priority: 10, visible: true },
        { id: 'holdings', column: 'left', span: 'lg', priority: 20, visible: true },
        { id: 'snapshots', column: 'center', span: 'md', priority: 10, visible: true },
        { id: 'chat', column: 'center', span: 'xl', priority: 20, visible: true },
        { id: 'activity', column: 'center', span: 'md', priority: 30, visible: true },
        { id: 'managerBrief', column: 'right', span: 'md', priority: 10, visible: true },
        { id: 'profile', column: 'right', span: 'full', priority: 20, visible: true },
        { id: 'system', column: 'right', span: 'sm', priority: 30, visible: true },
      ],
      openDrawer: {
        type: 'profile',
        entityId: '',
        title: '프로필 상세',
      },
      reason: '프로필/성향 요청이라 프로필 패널을 확장합니다.',
    };
  } else if (/(대화|채팅|상담|질문)/.test(lowered)) {
    workspacePatch = {
      focusMode: 'chat',
      highlightPanelIds: ['chat', 'activity'],
      panelPatches: [
        { id: 'overview', column: 'left', span: 'md', priority: 10, visible: true },
        { id: 'holdings', column: 'left', span: 'lg', priority: 20, visible: true },
        { id: 'snapshots', column: 'center', span: 'sm', priority: 10, visible: true },
        { id: 'chat', column: 'center', span: 'full', priority: 20, visible: true },
        { id: 'activity', column: 'center', span: 'lg', priority: 30, visible: true },
        { id: 'managerBrief', column: 'right', span: 'lg', priority: 10, visible: true },
        { id: 'profile', column: 'right', span: 'md', priority: 20, visible: true },
        { id: 'system', column: 'right', span: 'sm', priority: 30, visible: true },
      ],
      openDrawer: {
        type: 'threadDetail',
        entityId: '',
        title: '대화 상세',
      },
      reason: '대화 중심 요청이라 채팅과 활동 패널을 확장합니다.',
    };
  }

  return {
    personaLabel: 'Quant Manager',
    personaSystemPrompt: [
      '당신은 사용자의 자산·대화·성향을 모두 참조하는 개인 Quant Manager다.',
      '답변은 한국어로 작성한다.',
      '실행 가능한 제안, 리스크 체크, 숫자 근거를 우선한다.',
      context.profile.userProfile.responseStyle
        ? `사용자가 선호하는 응답 스타일: ${context.profile.userProfile.responseStyle}`
        : '사용자 응답 스타일 정보가 부족하면 지나친 추측 없이 차분하고 실무적으로 답한다.',
    ].join('\n'),
    synthesisInstructions:
      '전문가 출력들을 종합해서 하나의 최종 답변으로 정리하되, 필요한 경우 오늘 할 일과 주의사항을 분리한다.',
    tasks,
    workspacePatch,
  };
}

async function buildSupervisorPlan(userInput, context) {
  if (!isAiConfigured()) {
    return buildFallbackPlan(userInput, context);
  }

  const fallback = buildFallbackPlan(userInput, context);
  return generateStructuredOutput(
    {
      systemPrompt: [
        '당신은 multi-agent supervisor 이다.',
        '사용자 질문, 자산 데이터, 장기 기억, 사용자 프로필을 읽고 매 턴마다 새로운 persona/system prompt 와 specialized agent 작업 목록을 생성한다.',
        '전문화된 agent 는 고정된 집합이 아니라 이번 질의에 맞게 동적으로 구성한다.',
        '외부 조사가 필요한 경우 research task 를 포함하고 searchQuery 를 한국어 또는 영어 혼합으로 더 검색 친화적으로 재작성한다.',
        'task 는 portfolio, memory, manager, research 타입만 사용한다.',
        '추가로 workspacePatch 를 반환해 어떤 패널을 강조/확장/숨김/이동할지 제안한다.',
        'workspacePatch 는 허용된 panel id 와 제한된 focusMode/column/span 값만 사용한다.',
        '반드시 JSON 으로만 답한다.',
      ].join('\n'),
      userPrompt: JSON.stringify(
        {
          userInput,
          context,
        },
        null,
        2
      ),
      schema: SUPERVISOR_SCHEMA,
    },
    fallback
  );
}

async function runTaskPrompt(task, taskContext, useGoogleSearch = false) {
  const response = await generateContent({
    systemPrompt: task.systemPrompt,
    userPrompt: taskContext,
    useGoogleSearch,
  });

  return {
    text: extractTextFromResponse(response),
    citations: getGroundingSources(response),
  };
}

async function executeSpecialistTasks(plan, context, userInput) {
  const outputs = await Promise.all(
    (plan.tasks || []).map(async (task) => {
      let taskContext = '';
      if (task.agentType === 'portfolio') {
        taskContext = JSON.stringify(
          {
            userInput,
            objective: task.objective,
            portfolio: context.portfolio,
          },
          null,
          2
        );
      } else if (task.agentType === 'memory') {
        taskContext = JSON.stringify(
          {
            userInput,
            objective: task.objective,
            profile: context.profile,
            memory: context.memory,
            recentTranscript: context.recentTranscript,
          },
          null,
          2
        );
      } else if (task.agentType === 'manager') {
        taskContext = JSON.stringify(
          {
            userInput,
            objective: task.objective,
            portfolio: context.portfolio,
            profile: context.profile,
            memory: context.memory,
          },
          null,
          2
        );
      } else {
        taskContext = JSON.stringify(
          {
            userInput,
            objective: task.objective,
            tunedSearchQuery: task.searchQuery || userInput,
            profile: context.profile,
            recentTranscript: context.recentTranscript,
          },
          null,
          2
        );
      }

      const result = await runTaskPrompt(task, taskContext, task.needsSearch);
      return {
        id: task.id,
        agentType: task.agentType,
        title: task.title,
        objective: task.objective,
        text: result.text,
        citations: result.citations,
      };
    })
  );

  return {
    outputs,
    citations: outputs.flatMap((item) => item.citations || []),
  };
}

async function synthesizeFinalAnswer({ userInput, context, plan, specialistOutputs }) {
  const response = await generateContent({
    systemPrompt: [
      plan.personaSystemPrompt,
      '',
      '추가 지시:',
      plan.synthesisInstructions,
      '최종 답변은 한국어로 작성하고, 필요한 경우 짧은 섹션 제목을 사용한다.',
      '숫자/우선순위/리스크/후속 행동을 최대한 구조적으로 정리한다.',
    ].join('\n'),
    userPrompt: JSON.stringify(
      {
        userInput,
        context,
        specialistOutputs,
      },
      null,
      2
    ),
  });

  return {
    answer: extractTextFromResponse(response),
  };
}

async function buildConversationGraph() {
  if (!conversationGraphPromise) {
    conversationGraphPromise = (async () => {
      const { StateGraph, StateSchema, START, END } = await import('@langchain/langgraph');

      const GraphState = new StateSchema({
        userInput: z.string(),
        threadId: z.string(),
        context: z.any(),
        supervisorPlan: z.any(),
        specialistOutputs: z.array(z.any()).default(() => []),
        citations: z.array(z.any()).default(() => []),
        answer: z.string().default(''),
      });

      return new StateGraph(GraphState)
        .addNode('supervisor', async (state) => ({
          supervisorPlan: await buildSupervisorPlan(state.userInput, state.context),
        }))
        .addNode('specialists', async (state) => {
          const result = await executeSpecialistTasks(
            state.supervisorPlan,
            state.context,
            state.userInput
          );
          return {
            specialistOutputs: result.outputs,
            citations: result.citations,
          };
        })
        .addNode('synthesizer', async (state) => {
          const result = await synthesizeFinalAnswer({
            userInput: state.userInput,
            context: state.context,
            plan: state.supervisorPlan,
            specialistOutputs: state.specialistOutputs,
          });
          return {
            answer: result.answer,
          };
        })
        .addEdge(START, 'supervisor')
        .addEdge('supervisor', 'specialists')
        .addEdge('specialists', 'synthesizer')
        .addEdge('synthesizer', END)
        .compile();
    })();
  }

  return conversationGraphPromise;
}

async function runConversationGraph({ userInput, threadId, context }) {
  if (!isAiConfigured()) {
    throw new Error('GEMINI_API_KEY가 설정되지 않아 채팅 기능이 비활성화되어 있습니다.');
  }

  const graph = await buildConversationGraph();
  const result = await graph.invoke({
    userInput,
    threadId,
    context,
  });

  return {
    answer: result.answer,
    supervisorPlan: result.supervisorPlan,
    specialistOutputs: result.specialistOutputs,
    citations: result.citations || [],
    workspacePatch: result.supervisorPlan?.workspacePatch || null,
  };
}

async function summarizeThread({ threadId, recentTranscript, existingSummary, sourceMessageIds }) {
  const fallback = {
    summary: existingSummary || '요약을 생성하지 못했습니다.',
    importantFacts: [],
    unresolvedQuestions: [],
    personaHints: [],
    tags: [],
  };

  const result = await generateStructuredOutput(
    {
      systemPrompt: [
        '당신은 대화 장기기억 정리 담당자다.',
        '최근 대화를 읽고 장기적으로 유용한 사실, 사용자 선호, 미해결 질문을 추린다.',
        '투자 조언을 새로 만들지 말고 대화에서 드러난 정보만 정리한다.',
      ].join('\n'),
      userPrompt: JSON.stringify(
        {
          threadId,
          existingSummary,
          recentTranscript,
        },
        null,
        2
      ),
      schema: THREAD_SUMMARY_SCHEMA,
    },
    fallback
  );

  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    threadId,
    summary: result.summary,
    importantFacts: result.importantFacts || [],
    unresolvedQuestions: result.unresolvedQuestions || [],
    personaHints: result.personaHints || [],
    tags: result.tags || [],
    createdAt: now,
    updatedAt: now,
    sourceMessageIds,
  };
}

async function inferAiProfile({ userProfile, threadSummaries, longTermMemories, managerReports }) {
  const fallback = {
    summary: '',
    inferredTraits: [],
    preferences: [],
    concerns: [],
  };

  const result = await generateStructuredOutput(
    {
      systemPrompt: [
        '당신은 사용자 프로필 추론기다.',
        '명시적 사용자 입력과 대화 기억을 바탕으로 투자 성향, 응답 선호, 우려 요소를 요약한다.',
        '과도한 추측은 피하고 근거가 부족한 항목은 생략한다.',
      ].join('\n'),
      userPrompt: JSON.stringify(
        {
          userProfile,
          threadSummaries: (threadSummaries || []).slice(0, 6),
          longTermMemories: (longTermMemories || []).slice(0, 10),
          managerReports: (managerReports || []).slice(0, 3),
        },
        null,
        2
      ),
      schema: PROFILE_SCHEMA,
    },
    fallback
  );

  return {
    summary: result.summary,
    inferredTraits: result.inferredTraits || [],
    preferences: result.preferences || [],
    concerns: result.concerns || [],
    updatedAt: new Date().toISOString(),
  };
}

async function buildManagerReport({ portfolio, profile, memory, trigger }) {
  const fallback = {
    summary: 'AI 브리핑을 생성하지 못했습니다.',
    dailyObjective: '',
    actionItems: [],
    riskChecks: [],
    allocationNotes: [],
    conversationInsights: [],
    profileUpdates: [],
  };

  const targetDate = getDateInTimezone(new Date(), APP_TIMEZONE);
  const result = await generateStructuredOutput(
    {
      systemPrompt: [
        '당신은 개인 자산 운영을 돕는 Quant Manager다.',
        '보유 자산, 최근 스냅샷, 대화 기억, 사용자 성향을 함께 읽고 오늘의 관리 지시를 만든다.',
        '실행 항목은 과장 없이 현실적인 수준으로 작성한다.',
      ].join('\n'),
      userPrompt: JSON.stringify(
        {
          targetDate,
          trigger,
          portfolio,
          profile,
          memory,
        },
        null,
        2
      ),
      schema: MANAGER_REPORT_SCHEMA,
    },
    fallback
  );

  return {
    id: randomUUID(),
    targetDate,
    createdAt: new Date().toISOString(),
    trigger,
    model: GEMINI_MODEL,
    summary: result.summary,
    dailyObjective: result.dailyObjective,
    actionItems: result.actionItems || [],
    riskChecks: result.riskChecks || [],
    allocationNotes: result.allocationNotes || [],
    conversationInsights: result.conversationInsights || [],
    profileUpdates: result.profileUpdates || [],
  };
}

module.exports = {
  AI_DAILY_CRON,
  GEMINI_MODEL,
  GEMINI_THINKING_LEVEL,
  APP_TIMEZONE,
  isAiConfigured,
  getAiSettings,
  runConversationGraph,
  summarizeThread,
  inferAiProfile,
  buildManagerReport,
};
