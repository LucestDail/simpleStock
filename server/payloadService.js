const { FILES, loadStore } = require('./dataStore');
const { getSystemStatus } = require('./managerService');

const ORCHESTRATION_NOTES = [
  'v3 종합 트래커: 관심종목(watchlist) 테마 그룹과 실시간 시세를 근거로 범용 시장 브리핑을 생성합니다.',
  '개인 자산/보유수량/매수단가/프로필 개념은 없으며, 브리핑은 시장 관찰 관점으로만 서술합니다.',
  '반복 브리핑/시황/indicator 예약 작업은 도래 시각에 실행되어 결과가 memory 에 기록됩니다.',
].join('\n');

function buildServerStatusPayload() {
  const store = loadStore();
  return {
    system: {
      ...getSystemStatus(),
      market: store.memory.market,
      dataFiles: FILES,
      orchestrationNotes: ORCHESTRATION_NOTES,
    },
  };
}

module.exports = {
  ORCHESTRATION_NOTES,
  buildServerStatusPayload,
};
