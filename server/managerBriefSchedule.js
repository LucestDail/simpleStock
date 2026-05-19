const cron = require('node-cron');
const { mutateStore } = require('./dataStore');
const { APP_TIMEZONE } = require('./time');

/** 평일(월–금) Quant Manager 일일 보고 — Asia/Seoul 기준 */
const MANAGER_BRIEF_SCHEDULE_VERSION = 1;

const DEFAULT_MANAGER_BRIEF_TASKS = [
  {
    id: 'mgr-brief-us-open-22',
    title: '일일 보고 · 미국 장(22시)',
    taskType: 'managerBrief',
    cronExpression: '0 22 * * 1-5',
    description: '미국 시장 개장 직후·초반 안정화 구간 시황 국면',
    prompt:
      '미국 시장이 막 시작된 뒤 초반 변동이 잠잠해진 시점의 시황 국면을 요약하라. 보유 자산에 대한 영향, 오늘 밤~내일 아침까지 주의할 리스크와 관망/행동 힌트를 짧고 명확하게 제시하라.',
  },
  {
    id: 'mgr-brief-us-stable-23',
    title: '일일 보고 · 미국 장(23시)',
    taskType: 'managerBrief',
    cronExpression: '0 23 * * 1-5',
    description: '미국 시장 시작 및 안정화 이후 시황 국면',
    prompt:
      '미국 본장 초반 흐름이 어느 정도 안정된 시점의 시황 국면을 정리하라. 섹터·환율·보유 종목 관점의 영향도와 추가로 지켜볼 변수를 bullet로 제시하라.',
  },
  {
    id: 'mgr-brief-us-close-06',
    title: '일일 보고 · 미국 장 마감(06시)',
    taskType: 'managerBrief',
    cronExpression: '0 6 * * 1-5',
    description: '미국 시장 종료 및 일일 결과 브리핑',
    prompt:
      '미국 시장 일일 마감 결과를 중심으로 브리핑하라. 주요 지수·보유 미국/환노출 자산의 일일 성과, 환율 변화, 내일 한국 장에 넘길 리스크를 요약하라.',
  },
  {
    id: 'mgr-brief-kr-open-09',
    title: '일일 보고 · 한국 장(09시)',
    taskType: 'managerBrief',
    cronExpression: '0 9 * * 1-5',
    description: '한국 시장 시작 및 초반 시황 국면',
    prompt:
      '한국 시장 개장 직후 초반 흐름을 요약하라. 전일 미국 마감과 환율 맥락을 반영해 보유 한국/혼합 자산에 대한 영향과 오전 중 체크포인트를 제시하라.',
  },
  {
    id: 'mgr-brief-kr-stable-10',
    title: '일일 보고 · 한국 장(10시)',
    taskType: 'managerBrief',
    cronExpression: '0 10 * * 1-5',
    description: '한국 시장 시작 및 안정화 이후 시황 국면',
    prompt:
      '한국 시장이 어느 정도 안정된 시점(개장 약 1시간 후)의 시황 국면을 정리하라. 당일 포트폴리오 비중·리밸런싱 관점에서 주의할 점과 거래/예약 주문 점검 사항을 포함하라.',
  },
  {
    id: 'mgr-brief-kr-close-18',
    title: '일일 보고 · 한국 장 마감(18시)',
    taskType: 'managerBrief',
    cronExpression: '0 18 * * 1-5',
    description: '한국 시장 종료 및 일일 결과 브리핑',
    prompt:
      '한국 시장 일일 마감 결과를 중심으로 브리핑하라. 당일 손익·비중 이탈 여부, 예약 주문·루틴 준수 상태, 저녁~미국 개장 전까지 관망 포인트를 요약하라.',
  },
];

function buildTaskRecord(template, existing) {
  const now = new Date().toISOString();
  return {
    id: template.id,
    title: template.title,
    description: template.description,
    taskType: template.taskType,
    cronExpression: template.cronExpression,
    timezone: APP_TIMEZONE,
    nextRunLabel: '',
    prompt: template.prompt,
    indicatorName: '',
    enabled: true,
    source: 'system-preset',
    scheduleVersion: MANAGER_BRIEF_SCHEDULE_VERSION,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt || null,
    lastRunStatus: existing?.lastRunStatus || '',
    lastRunMessage: existing?.lastRunMessage || '',
  };
}

async function ensureManagerBriefSchedule() {
  let changed = false;
  await mutateStore((store) => {
    if (!Array.isArray(store.memory.scheduledTasks)) {
      store.memory.scheduledTasks = [];
    }
    const presetIds = new Set(DEFAULT_MANAGER_BRIEF_TASKS.map((task) => task.id));

    for (const template of DEFAULT_MANAGER_BRIEF_TASKS) {
      if (!cron.validate(template.cronExpression)) continue;
      const index = store.memory.scheduledTasks.findIndex((item) => item.id === template.id);
      const existing = index >= 0 ? store.memory.scheduledTasks[index] : null;
      const next = buildTaskRecord(template, existing);
      const needsUpdate =
        !existing ||
        existing.scheduleVersion !== MANAGER_BRIEF_SCHEDULE_VERSION ||
        existing.cronExpression !== next.cronExpression ||
        existing.title !== next.title ||
        existing.prompt !== next.prompt ||
        existing.description !== next.description ||
        existing.enabled !== true ||
        existing.source !== 'system-preset';

      if (needsUpdate) {
        if (index >= 0) {
          store.memory.scheduledTasks[index] = { ...existing, ...next };
        } else {
          store.memory.scheduledTasks.unshift(next);
        }
        changed = true;
      }
    }

    // 구 단일 일일 cron(21:05)과 겹치는 레거시 managerBrief 예약은 비활성화
    for (const task of store.memory.scheduledTasks) {
      if (presetIds.has(task.id)) continue;
      if (task.source === 'system-preset' && task.enabled) {
        task.enabled = false;
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (
        task.enabled &&
        task.taskType === 'managerBrief' &&
        task.cronExpression === '5 21 * * *' &&
        task.source !== 'system-preset'
      ) {
        task.enabled = false;
        task.lastRunMessage = '6회 평일 일일 보고 스케줄로 대체되어 비활성화됨';
        task.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
  });
  return changed;
}

module.exports = {
  MANAGER_BRIEF_SCHEDULE_VERSION,
  DEFAULT_MANAGER_BRIEF_TASKS,
  ensureManagerBriefSchedule,
};
