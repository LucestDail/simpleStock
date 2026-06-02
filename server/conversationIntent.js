const MUTATION_PATTERNS = [
  /추가|등록|삭제|제거|갱신|업데이트|수정|변경|입력|저장|반영/,
  /매수|매도|샀|평단|수량|\d+\s*주/,
  /예수금|적금|펀드|IRP|연금|예약|브리핑|스케줄|cron/i,
  /(\d{1,3}(?:[,，]\d{3})+|\d{4,})\s*(?:원|₩)/,
  /티커|종목|주식|ETF|관제|관찰/,
];

const RESEARCH_PATTERNS = [
  /분석|전망|리서치|조사|왜\s|어떻게|추천|의견|시황|뉴스|비교|설명해|알려줘/,
  /전망|리스크|전략|포트폴리오\s*리뷰/,
];

function classifyConversationIntent(userInput) {
  const text = String(userInput || '').trim();
  if (!text) return 'general';

  const hasMutation = MUTATION_PATTERNS.some((pattern) => pattern.test(text));
  const hasResearch = RESEARCH_PATTERNS.some((pattern) => pattern.test(text));

  if (hasMutation && !hasResearch) return 'mutation';
  if (hasResearch && !hasMutation) return 'research';
  if (hasMutation) return 'mutation';
  return 'general';
}

function planNeedsResearch(supervisorPlan) {
  const tasks = Array.isArray(supervisorPlan?.tasks) ? supervisorPlan.tasks : [];
  return tasks.some((task) => task?.agentType === 'research' && task?.needsSearch !== false);
}

function shouldUseFastMutationPath(userInput, supervisorPlan) {
  const intent = classifyConversationIntent(userInput);
  const actions = Array.isArray(supervisorPlan?.actions) ? supervisorPlan.actions : [];
  if (!actions.length) return false;
  if (intent === 'research' && planNeedsResearch(supervisorPlan)) return false;
  if (planNeedsResearch(supervisorPlan)) return false;
  return intent === 'mutation' || actions.length > 0;
}

module.exports = {
  classifyConversationIntent,
  planNeedsResearch,
  shouldUseFastMutationPath,
};
