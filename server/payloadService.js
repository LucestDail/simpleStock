const { FILES, loadStore } = require('./dataStore');
const { getSystemStatus } = require('./managerService');

const ORCHESTRATION_NOTES = [
  'Supervisor는 매 턴마다 사용자 질문, 장기 기억, 사용자 프로필, 자산 데이터를 읽고 동적으로 persona/system prompt와 specialist task를 생성합니다.',
  'Specialist는 portfolio, memory, manager, research 역할 중 필요한 조합으로 동적으로 생성되며, research는 Gemini googleSearch 툴만 사용합니다.',
  '자산 입력, 설정 변경, 반복 브리핑/시황/indicator 예약 요청은 conversation action으로 해석되면 실제 JSON 데이터와 예약 작업에 반영됩니다.',
  '대화 후에는 thread summary, long-term memory, inferred profile이 JSON 파일로 갱신됩니다.',
].join('\n');

function buildPortfolioPayload(store = loadStore()) {
  return {
    holdings: store.portfolio.holdings,
    snapshots: store.portfolio.snapshots,
    manager: {
      latestReport: store.memory.managerReports[0] || null,
      history: store.memory.managerReports.slice(0, 10),
    },
    system: {
      ...getSystemStatus(),
      dataFiles: FILES,
      orchestrationNotes: ORCHESTRATION_NOTES,
    },
  };
}

function buildProfilePayload(store = loadStore()) {
  return store.profile;
}

function buildChatThreadsPayload(store = loadStore()) {
  return {
    threads: [...store.chat.threads].sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    ),
    system: getSystemStatus(),
  };
}

function buildServerStatusPayload() {
  return {
    system: {
      ...getSystemStatus(),
      dataFiles: FILES,
      orchestrationNotes: ORCHESTRATION_NOTES,
    },
  };
}

module.exports = {
  ORCHESTRATION_NOTES,
  buildPortfolioPayload,
  buildProfilePayload,
  buildChatThreadsPayload,
  buildServerStatusPayload,
};
