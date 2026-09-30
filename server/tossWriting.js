/**
 * 토스 라이팅 원칙으로 사용자 발화 직전 답변을 다듬는 공통 후처리 (2026-09-30, 사용자 지시).
 *
 * 사용자: "내부에 존재하는 모든 애널리스트, 모멘텀 분석가, 퀀트 분석가 등 모든 내부 분석
 * 시스템이 최종적으로 사용자한테 답변 나가기전에 해당 토스라이팅 프롬프트를 통해서
 * 답변이 정제되어서 나갈 수 있도록 최종 답변 시퀀스 전에 해당 로직 추가처리."
 *
 * ⇒ 각 시스템 프롬프트에 라이팅 규칙을 따로 복붙하지 않는다 — 흩어 두면 하나 고치고
 *    나머지를 놓치는 사고가 이 저장소에서 반복됐다("한 곳 고치면 저장소 전체를 스캔"
 *    이 코드가 아니라 사람 손에 맡겨져 있던 자리들). **보내기 직전 한 곳**에서 건다.
 *
 * ⚠️ **스트리밍 경로(`analystChat.chat()`)에는 안 쓴다** — 사용자에게 실시간으로 토큰이
 *    바로 나가는 구조라("이 구간이 REST 로 바뀌면 요구사항 위반이다" — 기존 주석) 다
 *    쓴 뒤에 다듬으면 **이미 화면에 나간 글은 못 되돌린다.** 그 경로는 프롬프트 자체를
 *    토스 라이팅으로 맞춰 스트리밍되는 문장 자체가 처음부터 그렇게 나오게 했다.
 *    이 모듈은 **한 번에 완성해서 보내는 경로**(정기 브리핑 텔레그램 발송 등) 전용이다.
 *
 * 🔴 **사실은 안 건드린다.** 이 패스는 문체·길이만 다듬는다 — 숫자·종목명·결론을 새로
 *    만들거나 바꾸면 "정제" 가 아니라 새 헛소리 생산이다. 실패하거나 의심스러우면
 *    원문을 그대로 돌려준다(정제 실패가 발송 자체를 막으면 안 된다).
 */
const { generateStructuredOutput } = require('./aiService');
const { logWarn } = require('./logger');

const REFINE_SYSTEM_PROMPT = [
  '당신은 토스(Toss)의 UX 라이터입니다. 아래 초안을 토스 라이팅 원칙으로 다듬으세요.',
  '',
  '## 코어밸류',
  '- Clear: 애매함 없이 한 번에 이해되게',
  '- Concise: 필요한 만큼만 — 잡초(빼도 뜻이 안 바뀌는 단어·문장)는 뽑는다',
  '- Casual: 친근하게, 어려운 금융·IT 용어는 쉽게 풀어',
  '- Respect: 과장·공포 조성 없이 사실대로',
  '- Emotional: 딱딱한 정보 나열이 아니라 사람에게 말하듯',
  '',
  '## 프린시플',
  '- Weed cutting: 넣으나 빼나 뜻이 안 바뀌는 단어는 뺀다',
  '- Remove empty sentences: 같은 말 반복·의미 없는 문장은 뺀다',
  '- Focus on key message: 정말 중요한 것만 남긴다 — 다 보여주려 하지 않는다',
  '- Easy to speak: 소리 내어 읽어 자연스러운 짧은 문장으로',
  '- Suggest over force: "~하세요" 강요·공포감 대신 판단 재료를 주고 선택은 사용자 몫으로',
  '',
  '## 🔴 절대 규칙 — 사실은 그대로',
  '- 원문에 있는 숫자·종목명·결론·판단을 **바꾸지 않는다.** 새로 지어내지 않는다.',
  '- 원문에 없는 정보를 추가하지 않는다.',
  '- 불필요한 헤더·구분선·과도한 절 구성은 없앤다. 서식은 꼭 필요한 곳만.',
  '- 결과는 **다듬은 본문만** 냅니다. "다듬었습니다" 같은 메타 발언을 하지 않습니다.',
].join('\n');

const REFINE_SCHEMA = {
  type: 'object',
  properties: { refined: { type: 'string' } },
  required: ['refined'],
};

/**
 * @param {string} draft 다듬을 원문(이미 사실관계가 확정된 완성 답변)
 * @param {{logLabel?: string}} [opts]
 * @returns {Promise<string>} 다듬어진 텍스트 — 실패/의심스러우면 원문 그대로
 */
async function refine(draft, { logLabel = 'toss_writing' } = {}) {
  const text = String(draft || '').trim();
  if (!text) return text;
  try {
    const out = await generateStructuredOutput(
      { systemPrompt: REFINE_SYSTEM_PROMPT, userPrompt: text, schema: REFINE_SCHEMA, logLabel },
      { refined: text } // 파싱 실패·모양 불일치면 generateStructuredOutput 이 이 폴백을 그대로 돌려준다
    );
    const refined = String(out?.refined || '').trim();
    /**
     * 방어: 정제 결과가 원문 대비 압도적으로 짧아지면(15% 미만) 다듬은 게 아니라
     * 잘려나간 것이다 — 원문을 쓴다. 길어지는 것은 허용한다(문체를 풀어 쓰며 늘 수 있다).
     */
    if (!refined || refined.length < text.length * 0.15) {
      logWarn('toss_writing.suspicious_shrink', { logLabel, originalLen: text.length, refinedLen: refined.length });
      return text;
    }
    return refined;
  } catch (e) {
    logWarn('toss_writing.failed', { logLabel, message: e.message });
    return text; // 정제 실패는 발송을 막지 않는다 — 원문 그대로 내보낸다
  }
}

module.exports = { refine, REFINE_SYSTEM_PROMPT };
