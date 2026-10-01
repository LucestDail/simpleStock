const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGeminiClient, isAiConfigured } = require('./geminiClient');
const { getEffectiveAiConfig } = require('./settingsService');
const { generateStructuredOutput } = require('./aiService');
const { logInfo, logWarn, logError } = require('./logger');
const toss = require('./tossClient');
const tossPortfolio = require('./tossPortfolio');
const mcp = require('./mcpClient');
const orderService = require('./orderService');
const rating = require('./stockRating');

/**
 * 애널리스트 채팅 — 스트리밍 + 툴 콜링 (2026-09-21)
 *
 * 사용자(스크린샷 주석): *"애널리스트와 채팅 — **스트리밍 형태로 출력되어야 함.
 * REST 형태로 안 나오게 주의**"* · *"툴 콜링, 관련 스트리밍 처리 및 thinking_delta,
 * tool-calling, tool-result 다 구현하고, 기존 대화 이력 기반 recall 구현, dreaming 구현"*
 *
 * ## 왜 별도 파일인가
 *
 * `aiService.generateContentStream` 은 **한 번 물어보고 한 번 답하는** 구조다(툴 없음).
 * 툴 콜링은 *모델 → 도구 → 모델* 로 **여러 바퀴**를 돌아야 해서 흐름 자체가 다르다.
 * 기존 함수를 비틀면 브리핑·리포트까지 같이 흔들리므로 **여기서 따로 돈다.**
 *
 * ## 🔴 REST 로 새지 않게 하는 것이 요구사항이다
 *
 * 모델이 다 말할 때까지 모았다가 한 번에 주면 **겉보기 결과는 같고 체감만 나빠진다** —
 * 그래서 조용히 그렇게 되기 쉽다. 이 파일은 **콜백으로만** 밖에 내보내고
 * 전체 문자열을 반환하지 않는다(마지막에 요약만 돌려준다).
 * 라우트도 `res.write` 로 흘리고, 테스트가 **조각이 2개 이상 도착했는지**를 본다.
 *
 * ## 도구는 **읽기 전용**이다
 *
 * 주문은 여기서 내지 않는다. 사용자 결정(09-21): *"주문은 제안만 · 실행은 항상 사람 승인."*
 * 매매는 `orderService` 의 제안·승인 경로로만 간다.
 */

/**
 * ⚠️ 경로를 환경변수로 뺄 수 있게 한다.
 *    이유는 운영이 아니라 **테스트**다 — `node --test` 는 파일을 **병렬로** 돌리는데
 *    채팅 테스트와 dreaming 테스트가 같은 파일을 쓰면 서로의 이력을 지운다.
 *    실제로 단독 실행은 통과하고 전체 실행에서만 2건이 깨졌다
 *    (워크스페이스 규율: *"실행 중인 작업의 파일을 지우지 말 것"* 의 테스트 판본).
 */
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = process.env.ANALYST_CHAT_FILE || path.join(DATA_DIR, 'analyst-chat.jsonl');

/** 도구 바퀴 상한. 🔴 없으면 무한 루프가 밤새 토큰을 태운다(Probius 선례) */
const MAX_ROUNDS = Math.max(1, Number(process.env.ANALYST_MAX_TOOL_ROUNDS) || 6);
/** 한 바퀴 안에서 부를 수 있는 도구 수 */
const MAX_CALLS_PER_ROUND = 4;
const RECALL_LIMIT = 6;

/**
 * 🔴🔴 **대화 세션 경계** (2026-10-01 — 라이브 실사고로 추가)
 *
 * 종전에는 `recent = history.slice(-8)` 로 **시간을 보지 않고** 최근 8턴을 실었다.
 * 이 봇의 이력은 **몇 주에 걸친 한 줄**이라, 8일 전 다른 종목 얘기가 **지금 하고 있는
 * 대화인 것처럼** 모델에게 전달됐다.
 *
 * 실사고(실측):
 * ```
 * 09-24 08:30  "아이온큐 프리장 상승 이유"        → 아이온큐 답변 ✅
 * 09-26 21:03  "다음주 주말 시황 정리해줘"        → **아이온큐 프리장 상승** 🔴
 * 09-30 07:49  "내 보유주식상황 분석해"           → QLD + **"아이온큐가 고베타 성장주라"** 🔴
 * 10-01 15:37  "리얼티인컴 매수 매력 판단해줘"     → **아이온큐 프리장 급등 이유** 🔴
 * ```
 * ★ **한 번 오염되면 스스로 되먹임한다** — 빗나간 답변이 다음 턴의 "최근 대화" 가 되어
 *   또 같은 주제를 끌어낸다. 09-24 의 아이온큐가 **8일을 살아남았다.**
 * ★ 더 나쁜 것: 그 턴에 **웹검색은 정확히 돌았다**(`리얼티인컴 최근 하락 이유` 5건 ·
 *   toolFailed 0). **도구는 맞았고 낡은 맥락이 그 결과를 덮었다.**
 *
 * ⇒ 마지막 턴에서 거꾸로 걸어 **간격이 이보다 벌어지면 거기서 끊는다.**
 * ⚠️ 시각이 아니라 **간격**으로 끊는다 — "오늘 09:00 질문, 14:00 후속" 은 이어지는 대화이고
 *    "어제 질문, 오늘 질문" 은 아니다. 자정 기준으로 자르면 전자가 끊긴다.
 * ⚠️ 6시간은 **넉넉한 쪽**으로 골랐다. 짧게 잡아 정당한 후속 질문의 맥락을 잃는 것이
 *    길게 잡아 가끔 한 턴 더 보는 것보다 나쁘다 — 관측된 오염은 전부 **1일 이상** 간격이었다.
 */
const SESSION_GAP_MS = Math.max(0, Number(process.env.ANALYST_CHAT_SESSION_GAP_MS) || 6 * 60 * 60_000);

/** 이력의 도구 결과 줄 표식 — **대화가 아니라 그 턴에만 유효한 휘발성 데이터**다 */
const TOOL_RESULT_PREFIX = '[도구 결과]';

// ── 도구 선언 ────────────────────────────────────────────────

const TOOL_DECLARATIONS = [
  {
    name: 'get_portfolio',
    description: '사용자의 실제 보유 종목과 평가금액·손익을 가져온다. 인자 없음.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_candles',
    description: '종목의 일봉/분봉을 가져온다. 추세·이동평균 판단에 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '종목 코드 또는 티커 (예: 005930, QLD)' },
        interval: { type: 'string', description: "'1d'(일봉) 또는 '1m'(분봉)" },
        count: { type: 'number', description: '봉 개수 (최대 200)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_rankings',
    description: '급등·급락·거래대금 랭킹을 가져온다.',
    parameters: {
      type: 'object',
      properties: {
        country: { type: 'string', description: "'KR' 또는 'US'" },
        type: { type: 'string', description: 'TOP_GAINERS · TOP_LOSERS · MARKET_TRADING_AMOUNT 등' },
      },
      required: ['country', 'type'],
    },
  },
  {
    name: 'get_warnings',
    description: '종목의 투자주의·경고·위험 지정 여부를 확인한다.',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  },
  {
    name: 'web_search',
    description: '최신 뉴스·시장 정보를 웹에서 찾는다. 🔴 티커가 아니라 **정식 종목명**으로 검색하라(get_portfolio 의 officialName — "QLD" 는 호주 퀸즐랜드가, "RAM" 은 PC 램이 이긴다).',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '검색어. 보유 수량·금액은 절대 넣지 않는다.' } },
      required: ['query'],
    },
  },
  {
    /**
     * 🔴 사용자 지시로 만든 **계층 평가** 도구 — 10항목 100점 + 투자의견 + 확신도.
     * ⚠️ 이건 **기업의 질**을 재는 것이지 "지금 사라" 가 아니다.
     */
    name: 'rate_stock',
    description:
      '종목을 10개 항목 100점으로 평가한다(Yahoo Statistics Current 값 기준). 유형(대형주/중소형 성장주/'
      + '대형배당주)을 자동 판정하고 총점·투자의견·확신도를 낸다. **기업의 질** 평가이며 매매 타이밍이 아니다.',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string', description: '종목 티커. 한국 종목은 6자리 코드' } },
      required: ['symbol'],
    },
  },
  {
    /**
     * 🔴 **유일하게 쓰기 비슷한 도구다.** 사용자 지시(스크린샷):
     *    *"상단 매매 분석 및 주식 관련 내용 발생시 상단 HITL 에 토픽으로 등록 ·
     *      사용자 승인시 매수/매도 실행"*
     * ⚠️ 그래도 **주문이 아니다** — `PENDING` 제안을 하나 만들 뿐이고,
     *    승인·실행은 여전히 사람이 화면에서 누른다. 이 도구는 승인도 실행도 못 한다.
     */
    name: 'propose_order',
    description:
      '매수/매도 제안을 상단 HITL 목록에 등록한다. 주문이 아니라 **제안**이며 사람이 승인해야 한다.'
      + ' 종목·방향·수량·지정가를 전부 확신할 때만 쓴다. 하나라도 모르면 쓰지 말고 사람에게 물어라.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '종목 코드 또는 티커' },
        side: { type: 'string', description: 'BUY 또는 SELL' },
        quantity: { type: 'number', description: '수량(주). 매도는 보유 수량 이내' },
        price: { type: 'number', description: '지정가' },
        reason: { type: 'string', description: '왜 이 제안인지 한두 문장' },
      },
      required: ['symbol', 'side', 'quantity', 'price', 'reason'],
    },
  },
  {
    name: 'propose_conditional_order',
    description:
      '예약(조건부) 매매 제안을 등록한다 — "가격이 X에 도달하면 Y에 매도/매수" 형태.'
      + ' 즉시 주문이 아니라 거래소가 감시가를 지켜보다 발동한다. 사람이 승인해야 예약이 등록된다.'
      + ' 예: "100불 도달하면 100.5 지정가로 전량 매도" → triggerPrice 100, orderPrice 100.5, side SELL.'
      + ' 값을 하나라도 모르면 지어내지 말고 사람에게 물어라(특히 expireDate — 사용자가 기간을 안 줬으면 물어라).',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '종목 코드 또는 티커' },
        side: { type: 'string', description: 'BUY 또는 SELL' },
        quantity: { type: 'number', description: '수량(주). 매도는 보유 수량 이내' },
        triggerPrice: { type: 'number', description: '감시가 — 이 가격에 닿으면 주문이 나간다' },
        orderPrice: { type: 'number', description: '주문가(지정가). 시장가면 생략' },
        orderType: { type: 'string', description: 'LIMIT(기본) 또는 MARKET' },
        expireDate: { type: 'string', description: '예약 만료일 YYYY-MM-DD — 사용자가 말한 기간. 없으면 묻는다' },
        reason: { type: 'string', description: '왜 이 예약인지 한두 문장' },
      },
      required: ['symbol', 'side', 'quantity', 'triggerPrice', 'expireDate', 'reason'],
    },
  },
  {
    name: 'list_conditional_orders',
    description: '등록된 예약(조건부) 주문 목록을 본다. "내 예약 주문 뭐 있어" 류 질문에 쓴다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_orders',
    description: '내 계좌의 주문 내역(접수·체결·취소 상태)을 본다. "내 주문 어떻게 됐어"·"체결됐어?" 류 질문에 쓴다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_trades',
    description: '한 종목의 최근 시장 체결 틱(최대 50건)을 본다 — 체결 방향·강도 판단용. ⚠️ 내 계좌 체결이 아니다(그건 get_my_orders).',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string', description: '종목 코드 또는 티커' } },
      required: ['symbol'],
    },
  },
  {
    name: 'read_article',
    description: '뉴스 검색 결과의 URL 에서 **기사 본문**을 읽는다. 헤드라인 요약만으로 부족할 때 — 본문 근거로 판단·인용하라. 실패(JS 렌더링·봇 차단)하면 본문 없이 판단하지 말 것.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'web_search 결과에 나온 기사 URL' } },
      required: ['url'],
    },
  },
  {
    name: 'recall',
    description: '과거 대화에서 관련된 내용을 찾아온다. 사용자가 전에 한 말·판단을 확인할 때 쓴다.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '찾을 주제어' } },
      required: ['query'],
    },
  },
];

/**
 * 🔴 **네이티브 function calling 을 쓰지 않는다 — 게이트웨이가 안 넘긴다.**
 *
 * 실측(2026-09-21): `tools: [{functionDeclarations}]` 를 실어 osh-ai-gateway 로 보냈더니
 * **31청크가 전부 `text`** 였고 `functionCall` 파트는 **0개**였다. 모델은 도구가 있는 줄도
 * 모르고 *"저는 사용자의 보유 종목을 확인할 수 없습니다"* 라고 답했다.
 * (채팅으로도 같은 증상 — *"포트폴리오를 확인할게요"* 라고 **말만 하고** 아무 일도 안 일어났다.)
 *
 * ⇒ 이 생태계 표준대로 **프롬프트 기반**으로 간다(Probius 도 같은 이유로 그렇게 한다 —
 *   폐쇄망·로컬 모델에도 그대로 붙는다는 부수 이점이 있다).
 * ⚠️ 네이티브 경로는 **지우지 않는다** — `GEMINI_API_KEY` 직결이면 실제로 동작하고,
 *    게이트웨이가 나중에 지원해도 그대로 받는다. 둘 다 받게 열어 둔다.
 */
function toolCatalog() {
  return TOOL_DECLARATIONS.map((t) => {
    const props = Object.entries(t.parameters?.properties || {})
      .map(([k, v]) => `${k}: ${v.type}${(t.parameters.required || []).includes(k) ? ' (필수)' : ''} — ${v.description || ''}`)
      .join(' · ');
    return `- \`${t.name}\` — ${t.description}${props ? `\n    인자: ${props}` : '\n    인자: 없음'}`;
  }).join('\n');
}

const SYSTEM_PROMPT = [
  '당신은 사용자의 주식 포트폴리오를 함께 보는 매수·매도 애널리스트입니다.',
  '',
  '## 도구',
  '',
  toolCatalog(),
  '',
  '도구는 **시스템이 대신 실행해서 결과를 넣어 줍니다.** 당신은 도구를 부르는 글을',
  '쓰지 않습니다 — 결과가 `[도구 결과]` 로 들어오면 그것만 근거로 답하세요.',
  '- 도구가 실패했다고 적혀 있으면 **실패했다고 말합니다.** 값을 지어내지 않습니다.',
  '',
  '## 답하는 방식 — 토스 라이팅 원칙 (2026-09-30, 사용자 지적: "너무 장황하고 헛소리가 가득해")',
  '- **Concise·Weed cutting**: 필요한 만큼만 씁니다. 넣으나 빼나 뜻이 안 바뀌는 문장·수식어는',
  '  뺍니다. **질문이 단순하면 답도 짧게** — 헤더·구분선·표를 매번 쓰지 않습니다.',
  '- **Focus on key message**: 결론부터 말하고, 근거는 결론을 뒷받침하는 만큼만 뒤에 붙입니다.',
  '  아는 걸 다 보여주려 하지 않습니다.',
  '- **Easy to speak**: 소리 내어 읽어 자연스러운 짧은 문장으로 씁니다. 한자어·번역투를 피합니다.',
  '- **Suggest over force**: "~하세요" 로 강요하지 않고 판단 재료를 주고 선택은 사용자에게',
  '  맡깁니다. 공포감을 조성해 특정 행동으로 몰지 않습니다.',
  '- **제공된 숫자를 인용**합니다. 근거 없는 수치는 쓰지 않습니다.',
  '- 재무제표·DCF·PER/PBR·기관 수급·내부자 거래·옵션 IV 는 이 시스템에 **없습니다** —',
  '  필요하면 "그 데이터는 없다" 한 줄로 말합니다.',
  '- 뭉뚱그리지 않습니다. 판단이 안 서면 "판단 못 하겠다" 고 그렇게 말합니다.',
  '',
  '## 결과를 그대로 나열하지 않는다',
  '- 🔴 **도구 실행 여부를 사용자에게 묻지 않는다.** "실행해 드릴까요?" "확인해 볼까요?" 금지 —',
  '  필요한 도구는 **당신이 지금 부른다.** 사용자가 원한 것은 답이지 계획이 아니다.',
  '- 🔴 검색·도구 결과를 **늘어놓고 끝내지 않는다.** 결론 한 줄 → 근거(숫자 인용) 순으로 종합한다.',
  '- "반대 시나리오"·"확인 못 한 것" 같은 절은 **판단이 갈릴 만할 때만** 한두 줄로 — 매 답마다',
  '  정해진 틀을 채우지 않는다.',
  '',
  '## 🔴 지금 질문이 과거 대화를 이깁니다 (2026-10-01 실사고)',
  '- 사용자가 **새 조건**을 걸면("공격적으로", "보수적으로", "현금 늘려") 그게 기준입니다.',
  '  몇 시간 전 대화에서 정한 방향과 어긋나면 **지금 질문을 따릅니다.**',
  '- 🔴 과거 답변의 "제안 요약" 을 **그대로 다시 쓰지 않습니다.** 그건 그때 질문에 대한 답입니다.',
  '  (실측: "공격적으로 투자한다면 자산비율 조정?" 에 3시간 전 "전량 청산" 요약을 그대로 재탕했다.)',
  '- 숫자는 `## 계좌` 절만 근거입니다. 과거 대화에 적힌 수량·가격은 **낡은 값**입니다.',
  '',
  '## 🔴 주문은 내지 않습니다',
  '매수/매도가 필요하다고 판단되면 **제안으로 등록**됩니다(상단 HITL 목록).',
  '그건 주문이 아닙니다 — **사람이 승인해야** 진행되고, 당신은 승인도 실행도 할 수 없습니다.',
  '제안을 등록했으면 사용자에게 **"상단에서 승인해 달라"** 고 안내하세요.',
].join('\n');

/**
 * ── 도구 판단기 ─────────────────────────────────────────────
 *
 * 🔴 **왜 대화와 분리했나 — 실측 세 번의 결과다(2026-09-21).**
 *
 * ```
 * ① 네이티브 function calling      게이트웨이가 안 넘긴다 (31청크 전부 text · functionCall 0)
 * ② 프롬프트로 "JSON 만 내라"       모델이 **서술을 택한다**
 *                                  ("포트폴리오를 조회할게요" 라고 말만 하고 끝)
 * ③ systemInstruction 이 안 닿나?  **닿는다** (구분력 있는 지시로 확인: 양쪽 다 따랐다)
 * ④ 스키마로 강제                  ✅ **된다** — 보유 질문→get_portfolio ·
 *                                  "고마워"→[] · "20일선 위야?"→get_candles(005930,1d,30)
 * ```
 * ⇒ ②를 프롬프트로 더 밀어붙이지 않는다. 워크스페이스 규율 그대로다 —
 *   *"프롬프트로 못 고치는 것을 프롬프트로 고치려 하지 말 것."* **구조를 바꾼다.**
 *
 * ⚠️ 대가: 라운드마다 **짧은 호출이 하나 더** 든다(실측 1.3~2.9초).
 *    대신 사람에게 보이는 답은 **여전히 스트리밍**이고, 도구가 **실제로 불린다.**
 * ★ ④ 검증에서 "고마워" 에 `[]` 가 나온 것이 중요하다 — 도구를 **안 쓸 줄도 알아야**
 *   판단기이지, 늘 부르면 그냥 낭비다(자의 판별력을 함께 잰 것).
 */
const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // ⚠️ enum 을 줘도 **키 이름은 모델이 바꾼다** — 아래 파서가 값으로 판정한다
          name: { type: 'string', enum: TOOL_DECLARATIONS.map((d) => d.name) },
          // ⚠️ 인자는 **JSON 문자열**로 받는다 — 도구마다 모양이 달라 한 스키마로 못 쓴다
          argsJson: { type: 'string' },
        },
        required: ['name', 'argsJson'],
      },
    },
  },
  required: ['tools'],
};

/**
 * 🔴 **계좌 정본을 매 턴 프롬프트에 싣는다** (2026-10-01 라이브 실사고)
 *
 * 분석 경로(`analystService.analyze`)는 `## 계좌` 를 **매 회차** 싣는데 채팅만 안 실었다
 * — *형제 중 하나만 빠진* 전형. 그 결과 채팅은 **도구를 안 부른 턴에서 과거 대화의
 * 숫자를 그대로 인용**했다(17:41 "지금 2주 남은 걸" ← 실제 90주 · 20:57 3시간 12분 묵은 표).
 *
 * ★ **금지가 아니라 대체다.** 09-30 에 *"과거 숫자를 재사용하지 마라"* 는 프롬프트 가드를
 *   넣었고 네 턴 전부 라이브였는데 **모델이 네 번 다 무시했다.** 모델에게 쓸 숫자가
 *   과거 대화밖에 없으면 그걸 쓴다 — 막을 게 아니라 **맞는 숫자를 줘야** 한다.
 *
 * ⚠️ 실패해도 절을 **지우지 않는다**. 절이 사라지면 모델은 "계좌 얘기가 없네" 가 아니라
 *    "과거 대화에 있네" 로 간다 — 조용한 실패가 가장 나쁜 모양이다.
 */
function accountTruthSection(snap, err) {
  const head = '## 계좌 (지금 조회한 값 — 보유·현금 숫자는 이 절만 근거다)';
  if (err) {
    return [
      head,
      `🔴 조회 실패: ${err}`,
      '→ 보유 수량·평단·현재가·비중·현금을 **답에 쓰지 마라.** 과거 대화에 적힌 숫자도 낡았다.',
      '   "지금 계좌를 확인하지 못했다" 고 밝히고, 숫자가 필요 없는 선에서만 답하라.',
    ].join('\n');
  }
  const num = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
  const items = Array.isArray(snap?.items) ? snap.items : [];
  const s = snap?.summary || {};
  const lines = [head];
  if (!items.length) {
    lines.push('보유 종목 **없음**(0종목) — 매도할 것이 없다.');
  } else {
    for (const it of items) {
      /**
       * 🔴 **정체(정식명·레버리지)를 함께 준다** (2026-10-01 배포 직후 실물에서 발견).
       *    `name` 이 티커와 같은 종목이 있어 `QLD QLD`·`RAM RAM` 으로 나왔다 —
       *    **도구 0회 턴에서는 이 절이 유일한 출처**라, 빠지면 모델은 RAM 이 2배
       *    레버리지라는 것도, QLD 가 QQQ 2배라는 것도 모른 채 비중을 논한다.
       *    (종전엔 `get_portfolio` 도구가 줬다 — 도구를 안 부르는 턴이 생기면서 구멍이 됐다.)
       */
      const name = it.officialName || it.name || '';
      const lev = Number(it.leverageFactor) > 1 ? ` [${it.leverageFactor}배 레버리지]` : '';
      lines.push(
        `- ${it.symbol} ${name === it.symbol ? '' : name}${lev} — **${num(it.quantity, 0)}주**`
        + ` · 평단 ${num(it.avgPrice)} · 현재 ${num(it.lastPrice)}`
        + ` (손익 ${num(it.profitRate)}% · 당일 ${num(it.dailyRate)}%)`
      );
    }
  }
  lines.push(`가용 현금 — USD ${num(s?.cash?.usd?.amount)} · KRW ${num(s?.cash?.krw?.amount, 0)}`);
  /**
   * 🔴 두 수익률이 다르면 **둘 다** 준다 — 분석 경로와 같은 규율(2026-10-01).
   *    안 주면 모델이 스스로 다시 계산하고, 사용자는 화면과 답이 다른 것을 본다.
   */
  if (Number.isFinite(Number(s?.profitRateDerived)) && Number.isFinite(Number(s?.profitRate))
      && Math.abs(Number(s.profitRateDerived) - Number(s.profitRate)) > 0.5) {
    lines.push(`⚠️ 평가손익률이 두 값으로 온다 — 증권사 보고 ${num(s.profitRate)}% ·`
      + ` **금액에서 계산하면 ${num(s.profitRateDerived)}%**. 금액과 일관된 쪽은 계산값이다.`);
  } else if (Number.isFinite(Number(s?.profitRate))) {
    lines.push(`평가손익률 ${num(s.profitRate)}% · 당일 ${num(s?.dailyRate)}%`);
  }
  lines.push('🔴 과거 대화에 다른 수량·가격·비중이 적혀 있으면 **그것은 낡은 값이다 — 이 절이 맞다.**');
  return lines.join('\n');
}

/**
 * 답이 *"제안을 등록했다"* 고 주장하는가.
 *
 * 🔴 2026-10-01 20:57 턴이 **"RAM 400주 전량 매도 제안을 등록합니다"** 라고 써서 보냈는데
 *    실제 등록은 **0건**이었다(그날 등록된 제안 2건은 12:19 분이고 둘 다 사용자가 거절).
 *    사용자는 승인 버튼을 찾으러 가고, 없으면 **시스템이 고장 난 것으로 읽는다.**
 * ★ 2026-08-04 *"메일 발송했습니다"* 와 같은 가족이다 — **말과 행동이 갈리는 것**은
 *   기능이 없는 것보다 나쁘다. 없으면 포기하지만, 있다고 하면 믿고 기다린다.
 */
const PROPOSAL_CLAIMED = new RegExp([
  '(제안|주문)\\s*(을|를)?\\s*(등록|접수)(했|합니다|하겠|해)',
  // 🔴 "등록" 을 안 쓰고 **결과만** 말하는 쪽이 실제로 더 흔했다 (2026-10-01 E2E 실물:
  //    "상단 HITL에서 승인해 주세요" — 등록은 0건인데 가드가 못 봤다).
  //    ★ 내가 판단기의 열거 비대칭을 지적해 놓고 **내 가드가 똑같이** 열거하고 있었다.
  '상단[^.\\n]{0,10}(HITL|목록)',
  'HITL[^.\\n]{0,10}(에서|에)?\\s*승인',
  '승인(해|을)\\s*(주세요|해\\s*주세요|하시면|부탁)',
].join('|'));

/**
 * 🔴 **보유 방침을 채팅의 제안 경로에서도 막는다** (2026-10-01).
 *
 * 방침 게이트는 16:44 에 분석 경로(`analyze`·`decideOnContext`)에만 붙었다. 채팅에도
 * `propose_order`·`propose_conditional_order` 라는 **같은 문이 둘 더** 있었다 —
 * *"문이 셋인데 둘만 막으면 안 막는 것"*(이 파일이 계좌 한도에 대해 이미 적어 둔 말).
 *
 * ⚠️ **조건부 주문은 발동가로 판정한다.** 현재가로 보면 *"RAM 을 16.0 에 팔아줘"*
 *    (= 방침이 **허용한 바로 그 조건**)가 현재가 13.98 때문에 막힌다. 발동가가
 *    곧 체결 조건이므로 그것이 맞는 자다.
 * ⚠️ 당일 등락률은 **지금 값**을 쓴다 — 발동 시점의 등락률은 알 수 없다. 느슨한 쪽이라
 *    기록해 둔다(막는 가드가 오탐하면 사용자가 정당한 매도를 못 한다).
 */
function policyBlock(args, ctx, atPrice) {
  const sym = String(args?.symbol || '').toUpperCase();
  const held = (ctx?.account?.items || []).find((h) => String(h.symbol || '').toUpperCase() === sym);
  let gate;
  try {
    gate = require('./analystService').holdingPolicyGate(
      { symbol: args?.symbol, side: String(args?.side || '').toUpperCase(), price: atPrice },
      held ? { ...held, lastPrice: Number.isFinite(Number(atPrice)) ? Number(atPrice) : held.lastPrice } : held
    );
  } catch (e) {
    // ⚠️ 방침을 못 읽은 것은 **통과가 아니다** — 다만 제안을 막지도 않는다(모르는 것이다)
    logWarn('chat.policy_gate_failed', { message: e.message });
    return null;
  }
  if (!gate || gate.ok !== false) return null;
  logWarn('chat.policy_blocked', { symbol: sym, side: String(args?.side || '').toUpperCase(), atPrice });
  return {
    ok: false,
    error: '사용자가 정한 보유 방침',
    blockedBy: 'holding-policy',
    note: `${gate.why} 제안을 만들지 않았다. 사용자에게 **방침을 그대로 알리고**,`
      + ' 방침을 바꿀 생각인지 물어라. 추측해서 다시 시도하지 마라.',
  };
}

function decidePrompt() {
  return [
    '당신은 **도구 사용 여부만** 정하는 판단기입니다. 사람에게 하는 답은 쓰지 않습니다.',
    '',
    '## 쓸 수 있는 도구',
    toolCatalog(),
    '',
    '',
    '## 🔴 전제 — 답하는 쪽은 **아무 데이터도 없습니다**',
    '보유 종목·시세·차트·뉴스는 **도구를 부르지 않으면 존재하지 않습니다.** 모델의 사전 지식으로',
    '답할 수 없는 것들입니다. 사용자가 그런 것을 물었는데 도구를 안 부르면,',
    '답하는 쪽은 **모른다고 하거나 지어냅니다.**',
    '',
    '- 필요한 도구를 `tools` 에 담습니다. `argsJson` 은 인자를 담은 **JSON 문자열**입니다(없으면 "{}").',
    '- `[도구 결과]` 가 **아직 없는데** 사용자가 아래를 물으면 반드시 도구를 부릅니다:',
    '    · 보유·잔고·평가금액·손익 → get_portfolio',
    '    🔴 · 매도/정리/청산/손절 여부를 판단해야 할 때(예: "다 팔까","다 털까","정리할까",',
    '      "손절해야하나") → **반드시 get_portfolio 먼저**. 무엇을 얼마나 들고 있는지 모르고는',
    '      "털어라/버텨라" 를 답할 수 없다(2026-09-30 실측: 이걸 놓쳐 도구 없이 답하다',
    '      보유수량·평단·현재가를 전부 지어냈다).',
    '    · 주가·추세·이동평균·차트 → get_candles',
    '    · 급등·급락·랭킹 → get_rankings',
    '    · 뉴스·최근 소식·전망 → web_search',
    '    · 예전에 한 얘기 → recall',
    '    · 매수/매도를 **하자고 정했을 때** → propose_order (주문이 아니라 제안 등록이다)',
    '    🔴 propose 계열은 사용자가 **명시적으로 요청**했을 때만("사줘/팔아줘/제안해줘/걸어줘").',
    '      "뭘 사겠냐/어떻게 생각하냐/판다면 뭘로" 는 **질문**이다 — 답만 하고 제안을 만들지 마라.',
    '      (실측 2026-09-23: 가정형 질문에 제안 3건을 등록해 사용자 폰에 승인 버튼이 갔다)',
    '    · "X 도달하면/떨어지면 사줘·팔아줘" 같은 **조건이 붙은 매매** → propose_conditional_order',
    '      (만료일을 사용자가 안 줬으면 도구를 부르지 말고 먼저 물어라)',
    '    · "예약 주문 뭐 있어" → list_conditional_orders · "내 주문 체결됐어?" → get_my_orders',
    '    · 한 종목의 단기 체결 강도가 필요할 때 → get_trades',
    '    · 검색 헤드라인만으로 부족하면 → read_article(URL) 로 **본문**을 읽고 판단하라',
    '    · 기업의 질·밸류·점수 → rate_stock (10항목 100점 · 유형별 기준)',
    /**
     * 🔴 **기본값을 뒤집는다** (2026-10-01). 위 목록은 **열거**라서, 사용자가 열거 안 된
     *    표현 하나만 쓰면 도구가 0이 된다. 라이브 실측 — *"내 자산 비중 어때?"* 는 걸리는데
     *    **"공격적으로 투자한다면 내 자산비율 조정 어떻게?"** 는 안 걸렸다(A 판 **0/5회**).
     *    이 저장소가 셸 가드·MCP 이름·HTML 태그에서 이미 세 번 진 그 비대칭이다.
     * 📊 A/B 실측(진짜 프롬프트 3회씩): 그 질의 **0/5 → 6/7**, 잡담·메타 **오탐 0/3 유지**.
     * ⚠️ 나머지 질의는 회차마다 갈려 **개선을 주장하지 않는다** — 이득은 저 한 축이다.
     *    데이터 정합성 자체는 `## 계좌` 정본이 지키고, 이건 최신 시세·뉴스를 더 받는 쪽이다.
     */
    '- 🔴 **기본값은 부르는 쪽입니다.** 위 목록은 예시이지 전부가 아닙니다 — 사용자의 말이',
    '  **자기 돈·보유·종목·시장**에 관한 것이면 열거에 없어도 필요한 도구를 고르세요.',
    '  자산 배분·비중·비율·리밸런싱·"공격적으로/보수적으로"·"줄일까/늘릴까" 는 **전부',
    '  get_portfolio 가 필요합니다** — 무엇을 얼마나 들고 있는지 모르면 답할 수 없습니다.',
    '- 🔴 잡담·인사·감사이거나 **시스템 사용법을 묻는 메타 질문**이거나',
    '  **이미 `[도구 결과]` 로 받은 것**이면 `tools` 를 **빈 배열**로 둡니다.',
  ].join('\n');
}

/**
 * 어떤 도구를 부를지 정한다.
 * 🔴 실패하면 **빈 배열**을 돌려준다 — 판단기가 죽었다고 대화까지 죽이지 않는다.
 *    다만 조용하지는 않다(로그 + 호출자가 notice 로 알린다).
 */
async function decideTools(transcript, injected = null) {
  let out = injected;
  try {
    if (out) return shapeToolCalls(out);
    out = await generateStructuredOutput(
      {
        systemPrompt: decidePrompt(),
        userPrompt: transcript,
        schema: DECIDE_SCHEMA,
        logLabel: 'analyst_decide',
      },
      { tools: [] }
    );
  } catch (e) {
    logWarn('chat.decide_failed', { message: e.message });
    return { tools: [], error: e.message };
  }
  return shapeToolCalls(out);
}

/**
 * 모델이 준 덩어리에서 도구 호출을 **모양으로** 읽어낸다(키 이름을 믿지 않는다).
 *
 * 🔴 **층마다 땜질하다 세 번 놓쳤다.** 실측된 모양들:
 * ```
 * {"tools":[{"name":"get_portfolio"}]}                    1회차
 * {"tools":[{"tool":"..."}]}  ·  {"tools":[{"id":"..."}]}  2·3회차 (항목 키가 바뀐다)
 * {"tool_requests":[...]}                                  4회차 (목록 키가 바뀐다)
 * {"tool_name":"get_portfolio","argsJson":"{}"}            **배열이 아예 없다**
 * {"tool_calls":[{"function":{"name":"...","arguments":…}}]} OpenAI 형식 — **한 겹 더**
 * ```
 * 앞의 넷을 하나씩 막다가 뒤의 둘을 또 맞았다. ★ **깊이도 열거의 대상이 된다** —
 * 그래서 이번엔 **재귀로 끝까지** 훑는다. 판정 근거는 여전히 하나뿐이다:
 * **값이 우리가 아는 도구 이름인가**(도구 목록은 우리가 정하는 **닫힌 집합**이다).
 *
 * ⚠️ 도구 이름을 찾은 객체 **안쪽으로는 더 내려가지 않는다** — 같은 호출을 두 번 세지 않으려고.
 */
function collectCallNodes(node, known, out, depth = 0) {
  if (depth > 6 || out.length >= MAX_CALLS_PER_ROUND * 2) return;
  if (Array.isArray(node)) {
    for (const n of node) collectCallNodes(n, known, out, depth + 1);
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const v of Object.values(node)) {
    if (typeof v === 'string' && known.has(v.trim())) {
      out.push({ node, name: v.trim() });
      return; // 이 객체가 호출이다 — 안으로 더 안 내려간다
    }
  }
  for (const v of Object.values(node)) collectCallNodes(v, known, out, depth + 1);
}

/** 호출 객체에서 인자를 꺼낸다 — 키가 아니라 **모양**으로(객체이거나 JSON 문자열) */
function argsOf(node, name) {
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && v.trim() === name) continue; // 이름 칸
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string' && /^\s*\{/.test(v)) {
      try {
        return JSON.parse(v);
      } catch {
        logWarn('chat.bad_args', { name, key: k, raw: v.slice(0, 120) });
      }
    }
  }
  return {};
}

function shapeToolCalls(out) {
  const known = new Set(TOOL_DECLARATIONS.map((d) => d.name));
  const found = [];
  collectCallNodes(out, known, found);

  if (!found.length && out && typeof out === 'object') {
    // 🔴 "도구 없음" 과 "내가 못 읽음" 을 구분해 남긴다.
    //    빈 배열은 정상(잡담)이므로, **뭔가 들어 있는데 못 읽은 경우만** 경고한다.
    const hasContent = JSON.stringify(out).length > 20 && !/"tools"\s*:\s*\[\s*\]/.test(JSON.stringify(out));
    if (hasContent) logWarn('chat.unknown_tool_shape', { raw: JSON.stringify(out).slice(0, 300) });
  }

  const calls = [];
  const seenNames = new Set();
  for (const { node, name } of found) {
    const args = argsOf(node, name);
    const safeArgs = args && typeof args === 'object' ? args : {};
    /**
     * 🔴 **이름이 아니라 이름+인자로 중복을 가른다** (2026-10-01).
     *
     * 종전엔 `seenNames.has(name)` 이라 **같은 도구를 다른 종목에 부르는 것이 버려졌다.**
     * 두 종목을 비교해 달라는 질문(`"QLD 랑 리얼티인컴 중 뭐가 나아"`)에서
     * `get_candles(QLD)` + `get_candles(O)` 를 요청하면 **둘째가 조용히 사라지고**,
     * 모델은 한쪽 데이터만 받은 채 둘을 비교한다 ⇒ 없는 쪽을 **지어낸다.**
     * ⚠️ 로그도 없어서 **그런 일이 있었는지조차** 알 수 없었다.
     *
     * ★ 바로 아래 라운드 간 중복 차단(`calledKeys`)은 **처음부터 이름+인자**였다
     *   (*"`get_candles` 를 종목 둘에 부르는 것은 정당하다"* 라고 주석까지 달려 있다).
     *   **형제 중 하나만 느슨했다** — 같은 판정이 두 곳에 복제돼 갈라진 전형.
     */
    const key = `${name}(${JSON.stringify(safeArgs)})`;
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    calls.push({ name, args: safeArgs });
  }
  return { tools: calls };
}

// ── 이력 (append-only) ───────────────────────────────────────

/**
 * 🔴 **덮어쓰지 않고 이어붙인다.** 대화는 '현재 상태' 가 아니라 **'일어난 일의 목록'** 이다
 *    (Probius `AuditStore` 와 같은 이유). 통째로 다시 쓰면 동시 쓰기에 한쪽이 사라진다.
 */
/**
 * ⚠️ 상한 (2026-09-22): 이 파일은 감사가 아니라 **대화 맥락**이다 — 무한히 자라면
 *    recall 이 전체를 읽는 비용만 는다. `activityLog.js` 와 같은 방식(한 세대만 민다).
 *    🔴 `orders-audit.jsonl` 은 이 규율의 대상이 **아니다**(돈 기록은 지우지 않는다).
 */
const HISTORY_MAX_BYTES = Math.max(256 * 1024, Number(process.env.CHAT_HISTORY_MAX_BYTES) || 4 * 1024 * 1024);

function appendHistory(entry) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
    if (fs.statSync(HISTORY_FILE).size > HISTORY_MAX_BYTES) {
      // ⚠️ 한 세대만 민다 — 여러 세대를 쌓으면 디스크를 조용히 먹는다
      fs.renameSync(HISTORY_FILE, `${HISTORY_FILE}.1`);
      logWarn('chat.history_rotated', { file: HISTORY_FILE });
    }
  } catch (e) {
    // 기록 실패가 대화를 멈추지는 않지만 **조용하지도 않다**
    logError('chat.history_append_failed', e, {});
  }
}

function readHistory({ limit = 400 } = {}) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    logWarn('chat.history_read_failed', { message: e.message });
    return [];
  }
}

/**
 * 이력을 통째로 지운다.
 * ⚠️ 되돌릴 수 없다. 다만 **대화는 감사 기록이 아니다** — 주문 감사(`orders-audit.jsonl`)는
 *    별도 파일이고 **여기서 안 건드린다**(그건 지우면 안 되는 것이다).
 */
function clearHistory() {
  try {
    const had = fs.existsSync(HISTORY_FILE);
    if (had) fs.rmSync(HISTORY_FILE);
    logInfo('chat.history_cleared', { had });
    return { ok: true, cleared: had };
  } catch (e) {
    logError('chat.history_clear_failed', e, {});
    return { ok: false, error: e.message };
  }
}

/**
 * 이 턴들이 **한 대화**인가 — 마지막 턴에서 거꾸로 걸으며 간격이 벌어지는 지점에서 끊는다.
 *
 * 🔴 `slice(-N)` 과의 차이가 이 함수의 존재 이유다. `slice` 는 **개수**만 보므로
 *    8일 전 대화도 "최근 8턴" 에 들어온다(위 SESSION_GAP_MS 주석의 실사고).
 * ⚠️ 시각을 못 읽는 줄은 **경계로 쓰지 않는다** — 모르는 것을 "오래됐다" 로도
 *    "최근이다" 로도 단정하지 않고, 간격 계산에서만 건너뛴다.
 */
function currentSession(rows, { gapMs = SESSION_GAP_MS, max = 8 } = {}) {
  /**
   * 🔴 **도구 결과 줄을 대화로 싣지 않는다** (2026-10-01 실측으로 추가).
   *
   * 이력에는 `[도구 결과] get_candles({...}) {"last":773.5,...}` 같은 줄이 `assistant` 역할로
   * 들어 있다. 그대로 `contents` 에 넣으면 모델은 **그 숫자를 자기가 방금 받은 데이터로** 읽는다.
   *
   * 실제로 그렇게 됐다:
   * ```
   * 09-23 02:20  [도구 결과] get_candles("QLD") → last 773.5   ← 그날 한 번 잘못 온 값
   * 09-24 05:59  답변: "QLD 현재 773.5, 20일선 766.07 위"       ← 이력에서 그대로 베꼈다
   * 09-30 07:48  답변: "QLD 2,652주 … 현재 773.5"               ← 일주일 뒤에도
   * ```
   * ⚠️ **`get_candles` 자체는 지금 정상이다**(실측 10-01: QQQ 745.4 vs QLD 97.13 — 다르게 나온다).
   *    즉 **일회성 오류 하나가 이력에 박혀 일주일을 거짓말했다.** 도구 결과는 그 턴에만
   *    유효한 **휘발성 데이터**이지 대화가 아니다 — 다음 턴에는 반드시 다시 받아야 한다.
   */
  const turns = (rows || []).filter((h) => (h.role === 'user' || h.role === 'assistant')
    && !String(h.text || '').startsWith(TOOL_RESULT_PREFIX));
  if (!turns.length) return [];
  const out = [turns[turns.length - 1]];
  for (let i = turns.length - 2; i >= 0 && out.length < max; i -= 1) {
    const cur = Date.parse(turns[i].at);
    const next = Date.parse(turns[i + 1].at);
    if (Number.isFinite(cur) && Number.isFinite(next) && next - cur > gapMs) break;
    out.unshift(turns[i]);
  }
  return out;
}

/**
 * 한국어 조사를 떼어 **주제어를 드러낸다**.
 *
 * 🔴 왜 필요한가: 종전 토크나이저는 공백으로만 잘라 `리얼티인컴도` 를 통째로 들고
 *    `includes('리얼티인컴도')` 를 했다 ⇒ 과거에 `리얼티인컴은`·`리얼티인컴` 이 있어도
 *    **한 글자 차이로 전부 못 찾는다.** 정작 주제어가 매칭에서 빠지고, 남은 것은
 *    `매수`·`많이` 같은 **아무 글에나 있는 낱말**뿐이라 그것으로 점수가 매겨졌다.
 * ⚠️ 원형도 함께 남긴다 — 조사가 아니라 **낱말의 일부**일 수 있다(`정보`, `주가`).
 *    둘 다 넣고 매칭은 관대하게, **점수는 아래 IDF 가 엄격하게** 가른다.
 */
const PARTICLES = ['으로서', '으로써', '에서는', '에게서', '이라고', '라고', '으로', '에서', '에게', '까지', '부터', '보다', '처럼', '마다', '조차', '라도', '이나', '든지', '은', '는', '이', '가', '을', '를', '도', '의', '에', '와', '과', '로', '만', '및'];

function tokenize(text) {
  const raw = String(text || '').toLowerCase().split(/[^0-9a-z가-힣]+/).filter((t) => t.length >= 2);
  const out = new Set();
  for (const t of raw) {
    out.add(t);
    if (!/[가-힣]/.test(t)) continue;
    for (const p of PARTICLES) {
      if (t.length - p.length >= 2 && t.endsWith(p)) { out.add(t.slice(0, -p.length)); break; }
    }
  }
  return [...out];
}

/**
 * recall — 과거 대화에서 관련 대목을 찾는다.
 *
 * ⚠️ 임베딩을 쓰지 않는다. **낱말 겹침**으로 고른다 — 이력이 수천 건 규모가 아니고,
 *    임베딩을 넣으면 외부 호출이 하나 더 늘어 실패 지점이 늘어난다.
 *
 * 🔴🔴 **종전 판정은 "흔한 낱말 하나" 를 관련성으로 읽었다** (2026-10-01 실측 재현).
 * ```
 * 질의: "리얼티인컴도 많이 내려간거 같은데 매수 매력 판단해줘"
 * 결과: score=1 아이온큐 답변 ×3  ← 전부 `매수` 또는 `많이` **한 낱말**로 1점
 *       (주제어 `리얼티인컴도` 는 조사 때문에 **아무것도 못 맞혔다**)
 * ```
 * 그 6건이 프롬프트의 `## 과거 대화에서 찾은 것` 으로 들어가 **답을 아이온큐로 끌었다.**
 *
 * ⇒ 네 가지를 함께 고친다. **하나만 고치면 다른 경로로 같은 일이 난다**:
 *   ① **IDF** — 이력 대부분에 나오는 낱말은 정보가 없다(`매수`·`시장`·`판단`). 가중을 깎는다
 *   ② **최소 점수** — 흔한 낱말 하나로는 못 들어온다
 *   ③ **자기 자신 제외** — `recall` **도구** 경로는 이력을 새로 읽어 이번 턴이 들어 있다.
 *      (⚠️ preface 경로는 append **전에** 읽은 `history` 를 쓰므로 해당 없다 — 두 경로가
 *       같은 함수를 **다른 입력**으로 불러 동작이 갈렸다. 한쪽만 보고 단정하면 틀린다)
 *   ④ **도구 결과 줄 제외** — `[도구 결과] get_candles({...})` 는 대화가 아니라 **기계 출력**이다.
 *      숫자·티커가 잔뜩이라 낱말 겹침에서 부당하게 이긴다
 */
/**
 * 🔴 **이력의 이 비율을 넘게 나오는 낱말은 주제어가 아니다.**
 *
 * 처음엔 IDF 점수에 하한(1.5)만 뒀는데 **그걸로는 안 걸러졌다** — 실측에서 `매수` 가
 * 40건 중 8건(20%)에 있어 idf 1.72 로 하한을 넘었고, 아이온큐 답변 4건이 **그 한 낱말로**
 * 그대로 들어왔다. 점수를 올리면 이번엔 **작은 이력에서 아무것도 안 걸린다**(N 에 따라
 * idf 범위가 통째로 움직인다).
 * ⇒ 점수가 아니라 **비율**로 끊는다. "이력 다섯 건 중 하나 꼴로 나오는 낱말" 은
 *   주제가 아니라 **이 사람의 말버릇**이다(매수·시장·판단·종목…).
 * ⚠️ `Math.max(2, …)` — **단 한 건에만 나오는 낱말은 무슨 일이 있어도 살린다.**
 *    이력이 짧을 때 비율만 쓰면 희귀어까지 잘려 recall 이 통째로 죽는다.
 */
const RECALL_MAX_DF_RATIO = Number(process.env.ANALYST_RECALL_MAX_DF_RATIO) || 0.35;
/**
 * 🔴 **0.2 로 잡았다가 0.35 로 넓혔다 — 규칙이 자기 패배적이었다.**
 *    라이브 이력에서 `아이온큐` 의 df 가 **8/39(21%)** 였다. 그런데 그게 흔한 이유가
 *    **바로 이 오염 때문**이다(빗나간 답변이 8일간 이력을 채웠다). 0.2 로 자르면
 *    *"오염된 주제어를 말버릇으로 오인해 영영 못 찾는"* 상태가 된다 — 실측으로
 *    `아이온큐 프리장 상승 이유` 질의가 **0건**을 냈다(판별력 상실).
 * ⇒ 비율은 **진짜 말버릇만** 걷어내는 선으로 넓히고, 정밀도는 아래 희귀어·다중일치
 *   규칙이 진다. ★한 규칙을 조이는 대신 **다른 축으로 가른다.**
/** 낱말 하나만 겹쳤을 때, 이 건수 이하로만 나오는 낱말이어야 "주제가 같다" 고 본다 */
const RECALL_RARE_DF = Number(process.env.ANALYST_RECALL_RARE_DF) || 2;
/** 이 건수 미만이면 "흔한 낱말" 판정 자체를 하지 않는다(표본이 없다) */
const RECALL_MIN_CORPUS = Number(process.env.ANALYST_RECALL_MIN_CORPUS) || 10;

function recall(query, { limit = RECALL_LIMIT, history = null, excludeTurnId = null } = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];

  const rows = (history || readHistory()).filter((r) => {
    if (r.role !== 'user' && r.role !== 'assistant') return false;
    if (excludeTurnId && r.turnId === excludeTurnId) return false;        // ③
    if (String(r.text || '').startsWith(TOOL_RESULT_PREFIX)) return false; // ④
    return true;
  });
  if (!rows.length) return [];

  // ① 문서빈도 — 이력의 몇 %에 나오는 낱말인가. 흔할수록 가중이 0 에 수렴한다.
  const df = new Map();
  const hays = rows.map((r) => String(r.text || '').toLowerCase());
  for (const t of terms) {
    let n = 0;
    for (const hay of hays) if (hay.includes(t)) n += 1;
    df.set(t, n);
  }
  const N = rows.length;
  // ② 말버릇 낱말을 **아예 뺀다**(위 RECALL_MAX_DF_RATIO 주석 참조)
  /**
   * 🔴 **이력이 적으면 "흔하다" 를 판정할 수 없다** (기존 테스트가 잡았다).
   *    N=3 짜리 이력에서 2건에 나오는 낱말은 말버릇이 아니라 **그냥 그 사람의 주제**다.
   *    비율만 쓰면 `삼성전자`(3건 중 2건)가 잘려 정작 관련 대화를 못 찾았다.
   * ⚠️ 절대 건수 하한(3)도 함께 둔다 — 2건은 어떤 코퍼스에서도 말버릇의 증거가 못 된다.
   */
  const dfCap = N >= RECALL_MIN_CORPUS ? Math.max(3, N * RECALL_MAX_DF_RATIO) : Infinity;
  const topical = terms.filter((t) => df.get(t) < dfCap);
  if (!topical.length) return [];   // 주제어가 하나도 없으면 **아무것도 집어오지 않는다**

  const scored = [];
  for (let i = 0; i < rows.length; i += 1) {
    const hay = hays[i];
    let score = 0;
    const hits = [];
    for (const t of topical) {
      if (!hay.includes(t)) continue;
      score += Math.log(N / Math.max(1, df.get(t)));   // 희귀할수록 크게
      hits.push(t);
    }
    /**
     * 🔴 **한 낱말만 겹쳤으면 그 낱말이 희귀할 때만 인정한다.**
     *    비율 상한만으로는 못 막았다 — 실측에서 `매수` 가 33건 중 6건(18%)이라 20% 문턱을
     *    **간신히 통과**했고, 아이온큐 답변 4건이 그 한 낱말로 그대로 들어왔다.
     *    문턱을 더 조이면 이번엔 희귀어까지 잘린다 ⇒ **낱말 수**라는 다른 축을 함께 본다.
     * ★ 두 축이 **서로 다른 실패를 막는다**: 비율은 말버릇을, 개수는 "우연히 한 낱말 겹침" 을.
     *   하나만 두면 다른 쪽으로 샌다.
     */
    const onlyOneCommonHit = hits.length === 1 && df.get(hits[0]) > RECALL_RARE_DF;
    if (score > 0 && !onlyOneCommonHit) {
      const r = rows[i];
      scored.push({ score: Number(score.toFixed(2)), at: r.at, turnId: r.turnId || null, role: r.role, hits, text: String(r.text || '').slice(0, 400) });
    }
  }
  scored.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  return scored.slice(0, limit);
}

// ── 도구 실행 ────────────────────────────────────────────────

/**
 * 도구를 실행한다. 🔴 **실패를 성공으로 만들지 않는다** — `{ok:false, error}` 를 그대로
 * 모델에게 돌려줘서 모델이 "못 받았다" 고 말할 수 있게 한다.
 */
async function runTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'get_portfolio': {
      /**
       * ⚠️ 같은 턴에 프리페이스가 이미 읽어 뒀으면 **그것을 쓴다** (2026-10-01).
       *    몇 초 차이로 두 번 부르면 외부 호출만 두 배이고, 두 값이 미세하게 달라지면
       *    모델이 **같은 턴 안에서 다른 숫자 둘**을 보게 된다(그게 더 나쁘다).
       */
      const p = ctx.account || await tossPortfolio.getHoldings({ fx: ctx.fx || null });
      return {
        summary: p.summary,
        items: (p.items || []).map((h) => ({
          symbol: h.symbol, name: h.name, market: h.market, currency: h.currency,
          // 🔴 정체 필드 (2026-09-22) — 이게 빠져 있어 모델이 RAM 의 레버리지 여부를 지어냈다
          officialName: h.officialName || null, securityType: h.securityType || null,
          leverageFactor: h.leverageFactor ?? null, listDate: h.listDate || null,
          quantity: h.quantity, avgPrice: h.avgPrice, lastPrice: h.lastPrice,
          profitRate: h.profitRate, dailyRate: h.dailyRate,
        })),
        note: '종목의 정체(사업·레버리지)는 officialName/leverageFactor **만** 근거로 말하라. '
          + '티커 글자에서 추측 금지 — 티커가 비슷한 다른 회사와 혼동하지 말 것. '
          + 'leverageFactor≥2 면 일일 리밸런싱 상품이다(횡보 시 가치 감쇠를 전제로 판단).',
      };
    }
    case 'get_candles': {
      const c = await toss.getCandles(String(args.symbol || ''), {
        interval: args.interval === '1m' ? '1m' : '1d',
        count: Math.min(200, Math.max(10, Number(args.count) || 120)),
      });
      const closes = (c.rows || []).map((r) => r.c).filter(Number.isFinite);
      const ma = (n) => (closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null);
      // ⚠️ 봉 200개를 통째로 넘기면 토큰만 태운다 — **계산해서 요약**해 준다
      return {
        bars: closes.length,
        last: closes[closes.length - 1] ?? null,
        ma20: ma(20), ma60: ma(60),
        high: closes.length ? Math.max(...closes) : null,
        low: closes.length ? Math.min(...closes) : null,
        // 🔴 실측: 모델이 이 high/low 를 "52주 고점" 이라 지어 불렀다(상장 3개월 종목에서)
        note: `high/low 는 이 ${closes.length}개 봉 창 안의 값이다 — "52주" 등 더 긴 기간의 이름을 붙이지 말 것.`,
      };
    }
    case 'get_rankings': {
      const r = await toss.getRankings({
        country: String(args.country || 'KR').toUpperCase(),
        type: String(args.type || 'TOP_GAINERS'),
        duration: '1d',
        count: 10,
      });
      return { rows: (r.rows || []).slice(0, 10) };
    }
    case 'get_warnings': {
      const w = await toss.getWarnings(String(args.symbol || ''));
      // 🔴 빈 배열이 **정상**이다(경고 없음). "못 받았다" 와 구분되게 말로 적는다
      return { symbol: args.symbol, warnings: w, note: w.length ? null : '경고 지정 없음' };
    }
    case 'web_search': {
      // 🔴 모델이 준 검색어를 **그대로 쓰지 않는다** — 보유 수량·금액이 섞여 들어올 수 있다.
      //    `buildQuery` 와 같은 원칙: 밖으로 나가는 문자열은 한 곳에서 만든다.
      const safe = sanitizeQuery(String(args.query || ''));
      if (!safe) return { ok: false, error: '검색어가 비어 있거나 전부 걸러졌습니다.' };
      const r = await mcp.searchMarketNews([{ name: safe, symbol: '' }], { maxSubjects: 1 });
      if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
      const hit = r.results[0] || {};
      if (hit.error) return { ok: false, error: hit.error, kind: hit.kind };
      return { query: safe, text: String(hit.text || '').slice(0, 3000) };
    }
    case 'rate_stock': {
      // ⚠️ 한국 종목은 야후 티커가 `.KS` 다 — 6자리 숫자면 붙여 준다(모델이 자주 빠뜨린다)
      const sym = String(args.symbol || '').trim().toUpperCase();
      const ysym = /^\d{6}$/.test(sym) ? `${sym}.KS` : sym;
      const r = await rating.rate(ysym);
      return {
        symbol: r.symbol, name: r.name, type: r.type, total: r.total, opinion: r.opinion,
        confidence: r.confidence, items: r.items,
        strengths: r.strengths, weaknesses: r.weaknesses, oneLiner: r.oneLiner,
        unverified: r.unverified, missingValueMetrics: r.missingValueMetrics,
        stats: r.stats, links: r.links,
        // 🔴 판단이 갈릴 수 있음을 도구 결과에 적어 둔다 — 모델이 혼동하지 않게
        note: '이 점수는 **기업의 질**이다. 지금 사고팔 것인가는 가격·추세와 함께 별도로 판단하라.',
      };
    }
    case 'propose_order': {
      /**
       * 🔴 **계좌로 먼저 막는다** (2026-09-22). 구조 가드가 이 경로를 찾아냈다 —
       *    분석·라우트에는 검증을 붙였는데 **채팅 경로만 빠져 있었다.**
       *    문이 셋인데 둘만 막으면 **안 막는 것**이고, 하필 여기가 사용자가
       *    *"이거 사줘"* 라고 말하면 바로 제안이 만들어지는 자리다.
       * ⚠️ 못 물어봤으면 통과가 아니다 — 모델에게 **왜 막혔는지**를 돌려줘야
       *    "다시 시도" 대신 사용자에게 설명한다.
       */
      const chk = await orderService.checkAccountLimits({
        symbol: args.symbol,
        side: String(args.side || '').toUpperCase(),
        quantity: args.quantity,
        price: args.price,
      });
      if (!chk.ok) {
        return {
          ok: false,
          error: chk.error,
          kind: chk.kind,
          note: chk.kind === 'unknown'
            ? '계좌를 확인하지 못해 제안을 만들지 않았다. **추측해서 다시 시도하지 말고** 사용자에게 알려라.'
            : '계좌 한도를 넘어 제안을 만들지 않았다. 수량을 줄이거나 사용자에게 알려라.',
        };
      }
      // 🔴 계좌 다음은 **사용자 방침** — 둘 다 통과해야 제안이 된다
      const blocked = policyBlock(args, ctx, args.price);
      if (blocked) return blocked;
      // 🔴 빈칸이 있으면 `orderService` 가 거부한다 — 승인 화면이 주문 화면이 되면 안 된다
      const r = orderService.propose(
        {
          symbol: args.symbol,
          side: String(args.side || '').toUpperCase(),
          type: 'LIMIT',
          quantity: args.quantity,
          price: args.price,
          reason: args.reason,
        },
        { source: 'chat' }
      );
      if (!r.ok) return { ok: false, error: r.error, missing: r.missing };
      return {
        ok: true,
        proposalId: r.proposal.id,
        note: '상단 HITL 목록에 등록했습니다. **아직 주문이 아닙니다** — 사람이 승인해야 진행됩니다.',
      };
    }
    case 'propose_conditional_order': {
      /**
       * 🔴 예약도 **계좌로 먼저 막는다** — 즉시 주문과 같은 규율(문이 둘인데 하나만 막으면 안 막는 것).
       *    예산 검사의 가격은 주문가(없으면 감시가) 기준 — 발동 시 그 가격 근처에서 체결된다.
       */
      const chk = await orderService.checkAccountLimits({
        symbol: args.symbol,
        side: String(args.side || '').toUpperCase(),
        quantity: args.quantity,
        price: args.orderPrice ?? args.triggerPrice,
      });
      if (!chk.ok) {
        return {
          ok: false, error: chk.error, kind: chk.kind,
          note: chk.kind === 'unknown'
            ? '계좌를 확인하지 못해 예약 제안을 만들지 않았다. 추측해서 다시 시도하지 말고 사용자에게 알려라.'
            : '계좌 한도를 넘어 예약 제안을 만들지 않았다. 수량을 줄이거나 사용자에게 알려라.',
        };
      }
      // 🔴 조건부도 같은 문이다 — **발동가**로 방침을 판정한다(위 policyBlock 주석 참조)
      const blockedCond = policyBlock(args, ctx, args.orderPrice ?? args.triggerPrice);
      if (blockedCond) return blockedCond;
      const r = orderService.propose(
        {
          symbol: args.symbol,
          side: String(args.side || '').toUpperCase(),
          type: 'LIMIT',
          quantity: args.quantity,
          reason: args.reason,
          conditional: {
            triggerPrice: args.triggerPrice,
            orderPrice: args.orderPrice ?? null,
            orderType: String(args.orderType || 'LIMIT').toUpperCase(),
            expireDate: args.expireDate,
          },
        },
        { source: 'chat' }
      );
      if (!r.ok) return { ok: false, error: r.error, missing: r.missing };
      return {
        ok: true,
        proposalId: r.proposal.id,
        note: '예약 제안을 등록했습니다. **사람이 승인해야 거래소에 예약이 걸립니다** — 승인 후에도 감시가 도달 전엔 체결되지 않습니다.',
      };
    }
    case 'list_conditional_orders': {
      const toss = require('./tossClient');
      const r = await toss.listConditionalOrders({ status: 'OPEN' });
      const rows = (Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : []).slice(0, 20);
      return { count: rows.length, rows, note: rows.length ? null : '등록된 예약 주문이 없습니다.' };
    }
    case 'get_my_orders': {
      const toss = require('./tossClient');
      const r = await toss.listOrders({});
      const rows = (Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : []).slice(0, 20)
        .map((o) => ({ symbol: o.symbol, side: o.side ?? o.orderSide, status: o.status, quantity: o.quantity, price: o.price, filledQuantity: o.filledQuantity ?? o.executedQuantity ?? null, at: o.createdAt ?? o.orderedAt ?? null }));
      return { count: rows.length, rows, note: rows.length ? null : '주문 내역이 없습니다.' };
    }
    case 'get_trades': {
      const toss = require('./tossClient');
      const r = await toss.getTrades(String(args.symbol || ''), { count: 30 });
      const rows = (Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : []).slice(0, 30);
      return {
        symbol: args.symbol, count: rows.length, rows,
        note: '시장 전체의 체결 틱이다(내 계좌 아님). 방향(매수/매도 체결)과 규모로 단기 수급을 읽어라.',
      };
    }
    case 'read_article': {
      // pm2 실측(09-27): 한국 경제지 12도메인 본문 1.7k~12k자 양호 · 실패 3(조선비즈 추출·SBS JS·블룸버그 403)
      const r = await mcp.readArticle(String(args.url || ''));
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, chars: r.chars, text: r.text, note: '본문 전문이다 — 숫자·발언을 직접 인용해 근거로 쓰라.' };
    }
    case 'recall': {
      /**
       * 🔴 **이 경로는 이번 발화를 자기 자신으로 되찾는다.** `chat()` 의 preface 경로는
       *    append 전에 읽은 `history` 를 넘기지만, 도구 경로는 여기서 `readHistory()` 를
       *    **새로** 읽으므로 방금 적힌 이번 턴이 들어 있다 ⇒ 질의와 100% 겹쳐 1위를 먹고
       *    **recall 한 자리를 자기 자신으로 태운다.**
       * ⚠️ 두 경로가 같은 함수를 쓰는데 **입력이 달라 동작이 갈렸다** — 한쪽만 보고
       *    "자기 매칭은 없다" 고 단정할 뻔했다.
       */
      const hits = recall(String(args.query || ''), { excludeTurnId: ctx.turnId || null });
      return { hits, note: hits.length ? null : '관련된 과거 대화를 찾지 못했습니다.' };
    }
    default:
      return { ok: false, error: `알 수 없는 도구: ${name}` };
  }
}

/**
 * 🔴 모델이 만든 검색어에서 **돈·수량으로 보이는 것을 걷어낸다.**
 *
 * 프롬프트로 "넣지 마라" 고 적어 뒀지만 **프롬프트는 가드가 아니다**
 * (오늘 이미 배웠다 — 작은 모델일수록 앞의 지시를 놓친다).
 * ⇒ 밖으로 나가기 직전에 코드가 거른다.
 */
/**
 * 🔴 **모델이 만드는 검색어의 두 가지 고질** (2026-10-01, 이력 전수 실측 8건 중 6건)
 *
 * ```
 * "RAM ETF 반도체 장비 전망 2025"                          ← 연도가 틀렸다(지금은 2026)
 * "반도체 매매 타이밍 HBM DRAM 가격 전망 D램 고정거래가격 2025"  ← 9낱말
 * "2026년 반도체 전망 하반기 HBM D램 \"고정거래가\" 바로"       ← 따옴표 + 무의미 토큰
 * ```
 * ① **연도 토큰** — 우리는 이미 `recency='1d'`(Brave `freshness=pd`)로 기간을 자른다.
 *    거기에 `2025`·`2026` 을 더하면 **기간이 좁아지는 게 아니라 매칭만 좁아진다**(AND 검색).
 *    게다가 실제로 **틀린 연도**가 6건 중 3건이었다 — 모델의 시간 감각은 믿을 수 없다.
 * ② **낱말 과다** — 09-22 사고의 교훈(*"AND 검색이라 낱말이 늘수록 0 에 수렴한다"*)이
 *    브리핑 경로에만 반영됐고 **채팅 경로에는 한 줄도 없었다.**
 *
 * ⇒ ①은 **코드가 지운다**(프롬프트로 타이르지 않는다 — 이 저장소가 이미 실패한 길이다).
 *   ②는 지우면 뜻이 바뀌므로 **경고만** 남긴다 — 사람이 보고 도구 설명을 고칠 수 있게.
 * ⚠️ `2026년` 처럼 **조사·단위가 붙은 것은 건드리지 않는다**(문장의 일부다).
 *    맨 토큰으로 선 네 자리 연도만 지운다.
 */
const YEAR_TOKEN = /(^|\s)(19|20)\d{2}(?=\s|$)/g;
const QUERY_WORD_WARN = Number(process.env.ANALYST_QUERY_WORD_WARN) || 6;

function sanitizeQuery(q) {
  const before = String(q);
  const out = sanitizeQueryInner(before.replace(YEAR_TOKEN, '$1'));
  if (out !== sanitizeQueryInner(before)) {
    logWarn('chat.query_year_stripped', { before: before.slice(0, 120), after: out.slice(0, 120) });
  }
  const words = out.split(/\s+/).filter(Boolean);
  if (words.length > QUERY_WORD_WARN) {
    // 🔴 지우지 않는다 — 어떤 낱말을 버릴지는 코드가 알 수 없다. **보이게만** 한다
    logWarn('chat.query_too_many_words', { words: words.length, limit: QUERY_WORD_WARN, query: out.slice(0, 160) });
  }
  return out;
}

function sanitizeQueryInner(q) {
  return String(q)
    // 통화 기호가 붙은 금액, 3자리 구분 숫자, `12주`·`100株` 같은 수량 표현
    .replace(/[₩$€¥]\s?[\d,.]+/g, ' ')
    .replace(/\b\d{1,3}(,\d{3})+(\.\d+)?\b/g, ' ')
    // ⚠️ `\b` 는 **ASCII 기준**이라 `32주 보유` 의 `주` 뒤에서 경계가 안 잡힌다
    //    (한글도 공백도 비단어라 경계가 없다). 한글 단위는 **뒤에 한글이 안 오는지**로 가른다.
    .replace(/\b\d+\s*(?:주|株)(?![가-힣])/g, ' ')
    .replace(/\b\d+\s*shares?\b/gi, ' ')
    .replace(/\b\d{5,}\b/g, ' ') // 계좌번호·큰 금액
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 200);
}

// ── 스트리밍 대화 ────────────────────────────────────────────

/**
 * 🔴 **답이 "하겠습니다" 로 끝나는 미완인가** — 2026-10-01 E2E 에서 두 번째로 뚫렸다.
 *
 * 실물: `"아직 계좌 전체를 조회 중입니다. 잠시만요. (QLD 정리, RAM 손절, O 매수 — 세 가지를
 * 함께 검토하겠습니다)"` (66자). **도구 결과를 이미 받은 턴**인데 대기 선언으로 끝났다.
 *
 * 종전 패턴 `(하겠습니다|…)\s*\.?\s*$` 은 **닫는 괄호에서 진다** — 끝이 `검토하겠습니다)`
 * 라 안 걸렸다. 09-30 에 *"확인해 보겠"* → *"보겠습니다"* 로 한 번 넓힌 바로 그 자리이고,
 * 같은 가족을 **문장부호 축**에서 또 밟았다.
 * ⇒ 꼬리 문장부호를 허용하고, *"조회 중 / 확인 중 / 잠시만"* 류 **대기 선언**도 본다.
 *
 * ⚠️ 길이 상한(200자)을 **모든 축에 건다.** 긴 답이 본문 중간에 "조회 중" 을 언급하는 것은
 *    미완이 아니다 — 오탐하면 멀쩡한 답을 버리고 다시 쓰게 만든다(비용·지연 두 배).
 */
function isStubAnswer(answer) {
  const t = String(answer || '').trim();
  if (t.length >= 200) return false;
  if (/(하겠습니다|보겠습니다|드리겠습니다)[\s.)\]"'’”」』]*$/.test(t)) return true;
  return /잠시만|조회\s*중|확인\s*중|알아보는 중/.test(t);
}

/**
 * 🔴 **과거 "내 답변" 의 수치를 가린다** (2026-10-01 — E2E 로 두 번 확인한 뒤).
 *
 * 계좌 정본을 매 턴 실어도 모델이 **과거 대화의 가격을 그대로 썼다**(실측: 답변이
 * `$96.54`·`$13.98`·`$54.50` 을 인용 — 실제 현재가는 96.83·14.00·54.49).
 * 같은 턴 안에 올바른 숫자가 **두 번**(계좌 절 + 도구 결과) 있었는데도 그랬다.
 * ⇒ 프롬프트로 한 번 더 타이르는 것은 09-30 에 이미 실패했다. **숫자를 없앤다.**
 *
 * ⚠️ **사용자 발화는 절대 안 건드린다.** 사용자가 *"나 아직 90주 남았어"* 라고 한 것은
 *    **사실의 진술**이고, 가리면 모델이 사용자의 정정을 못 읽는다. 가리는 것은
 *    *"그때 데이터로 내가 한 말"* 뿐이다 — 그건 지금 낡았다.
 * ⚠️ 뜻은 남긴다 — 방향("전량 매도")·논리("레버리지 감쇠")는 그대로이고 **수치만** 간다.
 */
const STALE = '⟨옛값⟩';
function maskStaleNumbers(text) {
  return String(text || '')
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, STALE)          // $96.54
    .replace(/\d[\d,]*(?:\.\d+)?\s*(원|달러)/g, STALE)     // 19,537,164원
    .replace(/\d[\d,]*\s*주(?![가-힣])/g, `${STALE}주`)      // 400주 (주가·주식 은 제외)
    .replace(/[+-]?\d+(?:\.\d+)?\s*%/g, STALE)            // -26.7%
    .replace(/\b\d{1,6}\.\d{1,2}\b/g, STALE);            // 92.38 (맨 소수 = 이 바닥에선 가격)
}

function partsOf(chunk) {
  return chunk?.candidates?.[0]?.content?.parts || [];
}

/**
 * 한 턴을 돌린다. **콜백으로만** 밖에 내보낸다.
 *
 * @param {object} o
 * @param {string} o.message 사용자 발화
 * @param {function} o.emit `(event, data) => void` — SSE 로 그대로 흘린다
 */
async function chat({ message, emit, fx = null, contextNote = '', userInstruction = '' }) {
  if (!isAiConfigured()) throw new Error('AI 가 설정되지 않았습니다.');
  const text = String(message || '').trim();
  if (!text) throw new Error('메시지가 비어 있습니다.');

  const ai = await createGeminiClient();
  const runtime = getEffectiveAiConfig();
  const turnId = crypto.randomUUID();
  const startedAt = Date.now();

  const history = readHistory();
  appendHistory({ at: new Date().toISOString(), turnId, role: 'user', text });

  /**
   * ★ **묻지 않아도 되는 recall 을 미리 한 번** 한다(사용자 요구: "기존 대화 이력 기반 recall").
   *   도구로도 부를 수 있지만, 모델이 부를 생각을 못 하면 맥락이 통째로 빠진다.
   *   ⚠️ 찾은 게 없으면 **아무것도 싣지 않는다**(빈 섹션은 모델을 헷갈리게 한다).
   */
  const recalled = recall(text, { history, excludeTurnId: turnId });
  if (recalled.length) emit('recall', { count: recalled.length, items: recalled.slice(0, 3) });

  /**
   * 🔴 **"최근 8턴" 이 아니라 "지금 이어지고 있는 대화"** (2026-10-01 — 위 SESSION_GAP_MS 참조).
   *    종전 `slice(-8)` 은 개수만 봐서 8일 전 다른 종목 대화를 현재 대화로 실었다.
   */
  const recent = currentSession(history);
  /**
   * ⚠️ **무엇을 실었는지 남긴다** — 답이 빗나갔을 때 *"맥락이 오염됐나"* 를 소급으로
   *    가를 수 있어야 한다. 09-24~10-01 오염은 **로그에 아무 흔적이 없어** 사용자가
   *    말해 줄 때까지 아무도 몰랐다. 본문은 안 싣는다(길이·개인정보).
   */
  const sessionSpanMin = recent.length > 1
    ? Math.round((Date.parse(recent[recent.length - 1].at) - Date.parse(recent[0].at)) / 60_000)
    : 0;
  logInfo('chat.context', {
    turnId,
    historyTurns: history.filter((h) => h.role === 'user' || h.role === 'assistant').length,
    sessionTurns: recent.length,
    sessionSpanMin: Number.isFinite(sessionSpanMin) ? sessionSpanMin : null,
    recalled: recalled.length,
    recallTopScore: recalled[0]?.score ?? null,
  });

  const contents = [];
  for (const h of recent) {
    const isUser = h.role === 'user';
    contents.push({
      role: isUser ? 'user' : 'model',
      // 🔴 **내 과거 답변의 수치만** 가린다 (maskStaleNumbers 주석 참조)
      parts: [{ text: isUser ? String(h.text || '') : maskStaleNumbers(h.text) }],
    });
  }
  /**
   * 🔴 **계좌 정본을 먼저 읽는다** — 판단기가 도구를 고르든 말든 상관없이 (2026-10-01).
   *    같은 턴에 `get_portfolio` 도구가 불려도 **이 스냅샷을 재사용**한다(외부 호출 1회).
   */
  let accountSnap = null;
  let accountErr = null;
  try {
    accountSnap = await tossPortfolio.getHoldings({ fx: fx || null });
  } catch (e) {
    accountErr = e.message || String(e);
    logWarn('chat.account_failed', { turnId, message: accountErr });
  }

  const preface = [accountTruthSection(accountSnap, accountErr)];
  /**
   * 🔴 **보유 방침도 채팅에 싣는다** (2026-10-01). 16:44 에 방침 게이트를 배포했는데
   *    **채팅 경로 배선이 0건**이라, 그 뒤 세 턴이 전부 *"RAM 400주 전량 매도"* 를 권했다.
   *    게이트는 제안 **등록**을 막지만 채팅은 **말로** 권한다 — 모델이 방침을 모르면
   *    사용자는 "분명 보유하라고 정했는데 또 팔라네" 를 본다.
   * ★ 정본은 `config/holding-policy.json` **한 벌**이고 분석 경로와 같은 함수를 쓴다.
   */
  try {
    const policy = require('./analystService').holdingPolicyLines();
    if (policy && policy.length) preface.push(`## 사용자가 정한 보유 방침 (어기지 마라)\n${policy.join('\n')}`);
  } catch (e) {
    logWarn('chat.policy_load_failed', { turnId, message: e.message });
  }
  /**
   * 🔴 **사용자 템플릿을 채팅에도 싣는다** (2026-09-22). 분석 경로에는 있었는데
   *    채팅 경로에는 **빠져 있었다** — 사용자: *"내부의 내가 준 템플릿들을 종합하여서
   *    문의에 대한 탐색 소견 … 이 나와야 하는데"*. 템플릿 없이 답하니 나열이 됐다.
   */
  if (userInstruction) preface.push(`## 사용자 지침 (모든 답에 이 관점을 적용하라)\n${String(userInstruction).slice(0, 2000)}`);
  if (contextNote) preface.push(`## 지금 화면 상태\n${contextNote}`);
  if (recalled.length) {
    preface.push(
      '## 과거 대화에서 찾은 것 (recall)\n' +
        /**
         * 🔴 **여기도 과거 "내 답변" 이 들어온다** — `contents` 만 가리고 이 절을 빠뜨려
         *    가격이 그대로 샜다(배선 테스트가 잡았다). *형제 중 하나만 빠진* 전형이고,
         *    바로 그 패턴을 지적하는 커밋에서 내가 똑같이 저질렀다.
         */
        recalled.map((r) => `- [${r.at}] ${r.role === 'user' ? '사용자' : '나'}: `
          + (r.role === 'user' ? r.text : maskStaleNumbers(r.text))).join('\n')
    );
  }
  contents.push({
    role: 'user',
    parts: [{ text: preface.length ? `${preface.join('\n\n')}\n\n## 질문\n${text}` : text }],
  });

  const config = {
    systemInstruction: SYSTEM_PROMPT,
    /**
     * ⚠️ 출력 캡 (2026-09-23) — 이 스트림은 aiService 를 안 거쳐 자동 유도 캡 밖이었다.
     *    게이트웨이 실측에서 output 18,921~20,634토큰(445~820초, 회차 ₩4) 요청이 잡혔다.
     *    채팅 발화는 3,800자 분할 발송이라 4,096토큰(한글 수천 자)이면 충분하다.
     */
    maxOutputTokens: 4096,
    // ⚠️ 게이트웨이는 이것을 **무시한다**(실측: functionCall 0개). 그래도 남겨 둔다 —
    //    GEMINI_API_KEY 직결이면 네이티브로 동작하고, 위 루프가 둘 다 받는다.
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    /**
     * 🔴 thinking 을 끈다 (2026-09-23 실측: chars **1** — 답이 1자였다). 어제 structured
     *    경로에서 잡은 그 병이 여기 남아 있었다: thinkingConfig 를 안 보내면 모델 기본
     *    (reasoning ON)이고 생각이 maxOutputTokens 4096 을 먹어 **본문이 안 나온다.**
     *    includeThoughts 스트림은 게이트웨이가 지원하지 않으므로 budget 0 고정이 맞다.
     */
    ...(runtime.includeThoughts && runtime.thinkingBudget > 0
      ? { thinkingConfig: { includeThoughts: true, thinkingBudget: runtime.thinkingBudget } }
      : { thinkingConfig: { thinkingBudget: 0 } }),
  };

  let answer = '';
  /** 🔴 **도구 바퀴 수**다(응답 횟수가 아니다). 0 = 도구 없이 바로 답했다 */
  let rounds = 0;
  let toolCalls = 0;
  let decideFailed = null;

  /**
   * 판단기에게 보여 줄 대화 사본 — 도구 결과가 쌓이면 여기에도 붙는다.
   *
   * 🔴 **직전 사용자 발화를 함께 준다** (2026-10-01). 종전엔 현재 발화 **한 줄**만 줬다.
   *    사용자는 종목 이름을 한 번 말하고 그다음부터 생략한다 —
   *    *"매일매일 1주씩 사고 50달러 하방 돌파시 추가로 더 사는건?"* 에 판단기가
   *    **`web_search("TQQQ")`** 를 골랐다(그 대화는 리얼티인컴 얘기였다). 라이브 실측.
   *
   * ⚠️ **사용자 발화만** 넣는다 — 모델의 과거 답변이나 `[도구 결과]` 를 넣으면
   *    판단기가 *"이미 받았다"* 며 도구를 안 부른다. **고치려던 결함을 그대로 다시 만든다.**
   */
  const priorUserTurns = recent
    .filter((h) => h.role === 'user')
    .slice(-2)
    .map((h) => `## 직전 사용자 발화\n${String(h.text || '').slice(0, 200)}`);
  const seen = [...priorUserTurns, `## 사용자 발화\n${text}`];
  /**
   * ⚠️ **같은 호출을 두 번 하지 않는다.** 결과를 이미 줬는데도 판단기가 또 부르는 일이
   *    실측 5회 중 1회 있었다(같은 `get_portfolio`). 프롬프트로 막으려 하지 말고
   *    코드가 막는다 — 외부 API 호출이라 그대로 두면 **돈과 시간이 두 배**다.
   * ★ 인자까지 합쳐 구분한다 — `get_candles` 를 종목 둘에 부르는 것은 **정당하다.**
   */
  const calledKeys = new Set();
  /**
   * 🔴 도구 이름·성패를 이력에 남긴다 (2026-09-22, pm2 발견) — 종전엔 rounds/toolCalls
   *    숫자만 남아, 재기동 뒤에는 "어느 도구가 왜 실패했나" 진단이 **원리상 불가능**했다
   *    (컨테이너 로그가 재기동 2회로 사라져 21:09 턴을 영영 못 갈랐다).
   *    ⚠️ 결과 본문은 안 남긴다 — 크기와 개인 금융정보 때문에 이름·성패·에러 문구까지만.
   */
  const toolLog = [];

  // ── ① 도구 바퀴: **스키마로 강제된 판단기**가 정한다 ─────────
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const decision = await decideTools(seen.join('\n\n'));
    if (decision.error) {
      /**
       * 🔴 판단기가 죽어도 대화는 계속한다. 다만 **조용히** 계속하지 않는다 — 두 곳에 알린다:
       *   ① 사용자에게 `notice`
       *   ② **답하는 모델에게도** — 안 알리면 모델은 도구가 없는 줄 모르고 **지어낸다.**
       *     (피어 실측: 라이브에서 판단 호출이 10회 중 3회 실패했는데, 그때 답이 그냥
       *      서술로 나와서 **사용자는 도구가 안 돌았다는 걸 몰랐다.**)
       */
      decideFailed = decision.error;
      emit('notice', { text: `도구 판단에 실패해 도구 없이 답합니다: ${decision.error}` });
      contents.push({
        role: 'user',
        parts: [{
          text: '[시스템] 도구 호출 판단이 실패해 **이번 답에는 어떤 도구도 실행되지 않았습니다.**'
            + ' 보유·시세·차트·뉴스 데이터가 **없습니다.** 추측해서 채우지 말고,'
            + ' 데이터를 가져오지 못했다고 밝히고 다시 시도해 달라고 하세요.',
        }],
      });
      break;
    }
    if (!decision.tools.length) {
      /**
       * 🔴 **판단기가 정상 작동해도 이번 턴 도구 결과가 0개일 수 있다** (2026-09-30 실측:
       *    "오늘 마이크론 실발 전에 다 털까" 에 판단기가 `{"tools":[]}` 로 답함 — 매도
       *    여부를 물었는데 보유를 확인할 생각을 못 했다). 위 `decideFailed` 분기는 판단기가
       *    **죽었을 때만** 이 경고를 주고, 판단기가 **멀쩡히 돌다가 실수로 빈 배열을 낸
       *    경우**는 아무 신호도 안 갔다 — 모델은 최근 대화(4일 전 다른 종목 답변에 섞인
       *    숫자)를 근거인 것처럼 재사용해 **QLD 를 "2,652주·평균 542·현재 773.5" 로
       *    지어냈다**(실제: 99주·71.78·95.63 — 자릿수부터 다르다).
       * ⇒ toolCalls 가 이번 턴 내내 0 이면(=이번 턴에 [도구 결과]가 하나도 없으면) 같은
       *    안전장치를 건다. 잡담이면 그대로 답하면 되니 대가가 없다.
       */
      if (toolCalls === 0) {
        contents.push({
          role: 'user',
          parts: [{
            text: '[시스템] 이번 턴엔 어떤 도구도 호출되지 않았습니다. 보유·시세·차트·뉴스처럼'
              + ' 실데이터가 필요한 질문이면, 과거 대화에 나온 숫자를 근거로 재사용하지 말고'
              + ' "지금 데이터를 확인하지 못했다"고 밝히세요. 잡담·의견 질문이면 평소대로 답하세요.',
          }],
        });
      }
      break;
    }

    rounds = round;
    contents.push({ role: 'model', parts: [{ text: '(도구 호출)' }] });
    const resultParts = [];
    for (const call of decision.tools.slice(0, MAX_CALLS_PER_ROUND)) {
      const key = `${call.name}(${JSON.stringify(call.args)})`;
      if (calledKeys.has(key)) {
        // 조용히 건너뛰지 않는다 — 판단기가 왜 또 불렀는지 알 수 있어야 한다
        logWarn('chat.duplicate_tool_skipped', { key });
        continue;
      }
      calledKeys.add(key);
      const callId = crypto.randomUUID().slice(0, 8);
      toolCalls += 1;
      emit('tool_call', { id: callId, name: call.name, args: call.args });
      let result;
      try {
        result = await runTool(call.name, call.args, { fx, turnId, account: accountSnap });
        emit('tool_result', { id: callId, name: call.name, ok: true, preview: preview(result) });
        // ⚠️ 도구가 스스로 {ok:false} 를 돌려주는 경우(runTool 안에서 잡은 실패)도 실패로 센다
        toolLog.push({ name: call.name, ok: result?.ok !== false, ...(result?.ok === false ? { error: String(result.error || '').slice(0, 200) } : {}) });
      } catch (e) {
        // 🔴 실패도 모델에게 돌려준다. 삼키면 모델이 "받았다" 고 착각하고 지어낸다
        result = { ok: false, error: e.message, kind: e.kind || 'unknown' };
        logWarn('chat.tool_failed', { name: call.name, kind: e.kind, message: e.message });
        emit('tool_result', { id: callId, name: call.name, ok: false, error: e.message });
        toolLog.push({ name: call.name, ok: false, error: String(e.message || '').slice(0, 200), kind: e.kind || 'unknown' });
      }
      const line = `[도구 결과] ${call.name}(${JSON.stringify(call.args)})\n${JSON.stringify(result).slice(0, 4000)}`;
      resultParts.push({ text: line });
      seen.push(line);
    }
    if (!resultParts.length) {
      // 전부 중복이라 실행할 게 없었다 — 같은 판단이 반복될 뿐이니 여기서 멈춘다
      logWarn('chat.round_all_duplicates', { round });
      /**
       * 🔴 바로 위(918행)에서 이미 `(도구 호출)` model 턴을 넣어 놨는데, 여기서 그냥
       *    break 하면 **응답이 안 붙은 턴**이 대화에 남는다 (2026-09-30 실측: 최종 답변
       *    앞에 "(도구 결과가 들어왔다고 가정하고 답하라는 지시인데, 아직 실제 결과가
       *    없는 상태네요…)" 라는 군더더기가 붙었다 — 실제로는 결과를 이미 갖고 있는데도).
       *    열어 둔 턴을 닫아준다.
       */
      contents.push({
        role: 'user',
        parts: [{ text: '[시스템] 방금 요청한 도구는 이미 이전 라운드에서 불러 결과를 받았습니다. 그 결과로 답하세요.' }],
      });
      break;
    }
    contents.push({ role: 'user', parts: resultParts });

    if (round === MAX_ROUNDS) {
      // ⚠️ 상한에 걸린 것을 **조용히 넘기지 않는다** — 답이 어중간한 이유를 사람이 알아야 한다
      emit('notice', { text: `도구 호출 상한(${MAX_ROUNDS}바퀴)에 걸려 여기서 멈췄습니다.` });
    }
  }

  // ── ② 사람에게 하는 답: **여기만 스트리밍** ──────────────────
  //    🔴 사용자 요구가 이것이다 — 이 구간이 REST 로 바뀌면 요구사항 위반이다
  /**
   * 🔴 "확인하겠습니다" 로 끝나는 턴 게이트 (2026-09-23 실측: 도구 5회 돌고 최종 발화가
   *    44자 의지 표명 한 문장 — 답이 아니다). 최종 발화가 짧고 미완 선언이면 **딱 한 번**
   *    "지금 가진 결과로 완결하라" 를 붙여 다시 쓴다(재도구 없음 — 루프·비용 통제).
   */
  // 🔴 도구 단계 종료 선언 — 이게 없으면 모델이 최종 발화에서도 도구 호출을 "흉내" 낸다(실물 노출 사고)
  /**
   * 🔴 여기 적힌 문장이 **모델이 보는 마지막 지시**라 시스템 프롬프트보다 힘이 세다
   * (2026-09-30) — 위 SYSTEM_PROMPT 를 토스 라이팅 원칙으로 다듬어도, 이 자리가
   * "①②③④" 4단 구조를 강제하고 있으면 매번 그 틀로 되돌아간다. 강제 구조는 빼고
   * 결론부터·짧게만 요구한다 — 길이는 질문 난이도가 정한다.
   */
  contents.push({ role: 'user', parts: [{ text: '[시스템] 도구 단계는 끝났다. 지금부터는 사용자에게 하는 답만 쓴다. 결론부터, 짧게 — 받은 숫자만 근거로 인용한다. 단순한 질문이면 2~5문장으로 끝내라. 판단이 갈릴 만할 때만 리스크·다음 행동을 한두 줄 덧붙인다. 도구 호출 표기·사죄·중간 과정 서술 금지.' }] });
  let retriedFinal = false;
  for (let pass = 1; pass <= 2; pass += 1) {
    const stream = await ai.models.generateContentStream({ model: runtime.model, contents, config });
    for await (const chunk of stream) {
      for (const part of partsOf(chunk)) {
        if (typeof part.text !== 'string' || !part.text) continue;
        if (part.thought) {
          // 사고 과정은 **답과 섞지 않는다** — 화면이 따로 접어 둘 수 있어야 한다
          emit('thinking_delta', { text: part.text });
        } else {
          answer += part.text;
          emit('text_delta', { text: part.text });
        }
      }
    }
    /**
     * 🔴 확장(2026-09-24 실물): 모델이 "[도구 호출] …" 흉내 텍스트·"(도구 호출 —" 메타·
     *    "죄송합니다…실행하겠습니다" 사죄+중간과정을 **답변 본문에** 그대로 썼다 —
     *    사용자: "중간 과정 보여주지 말고 체계화된 브리핑으로". 짧은 미완만이 아니라
     *    이 패턴들도 재작성 대상이다(길어도).
     */
    const fake = /\[도구 호출\]|\(도구 호출|\[도구 결과\]/.test(answer);
    /**
     * 🔴 **"확인해 보겠"만 잡고 "확인해 보겠습니다"는 못 잡았다** (2026-09-30 실측) —
     *    `확인해\s*보겠` 뒤에 `\s*\.?\s*$` 만 허용해서, 실제로 나온 "포트폴리를 확인해
     *    보겠습니다"(끝이 "습니다"로 닫힌 정상 종결어미)는 이 패턴에 안 걸려 17자 스텁이
     *    그대로 최종 답으로 나갔다. `보겠습니다` 로 넓히면 "해보겠습니다"·"확인해
     *    보겠습니다"·"살펴보겠습니다" 를 전부 한 패턴으로 잡는다(부분집합이라 별도
     *    "해보겠습니다" 항목은 뺀다).
     */
    const stub = fake || isStubAnswer(answer);
    if (!stub) break;
    if (pass === 2) {
      /**
       * 🔴 **재시도까지 실패했을 때만 사용자에게 말한다.**
       *    성공한 재시도는 **내부 복구**다(네트워크 재시도와 같다) — 완결된 답 뒤에
       *    *"미완으로 끝나 한 번 더 요청합니다"* 가 붙으면 멀쩡한 답을 의심하게 만든다.
       *    실제로 2026-10-01 에 사용자가 그 줄을 보고 *"뭐야 이게"* 라고 물었다.
       * ⚠️ 그렇다고 조용하지도 않다 — **여전히 미완이면** 그건 사용자가 알아야 한다.
       */
      logWarn('chat.final_stub_after_retry', { turnId, chars: answer.trim().length });
      emit('notice', { text: '답이 두 번 모두 미완으로 끝났습니다 — 다시 물어봐 주세요.' });
      break;
    }
    retriedFinal = true;
    logWarn('chat.final_stub_retry', { turnId, chars: answer.trim().length, preview: answer.trim().slice(0, 160) });
    /**
     * 🔴🔴 **소비자에게 "지금까지 받은 것을 버려라" 고 말한다** (2026-10-01 실사고).
     *
     * 여기서 `answer = ''` 로 비우는 것은 **이 함수의 변수**일 뿐이다. 조각은 이미
     * `emit('text_delta')` 로 **밖에 나간 뒤**이고, 텔레그램 쪽은 자기 누적기에
     * `answer += data.text` 로 쌓기만 한다 ⇒ **pass1 + pass2 가 둘 다 발송된다.**
     *
     * 사용자가 실제로 받은 것(2026-10-01):
     * ```
     * (도구 호출)
     * [도구 결과] get_portfolio({"summary":{"purchase":{...계좌 전체 JSON...}})
     *
     * 내 포트폴리오 — 3종목, 평가손익 +$188       ← pass2 의 정상 답
     * ⚠️ 답이 미완으로 끝나 한 번 더 완결을 요청합니다.
     * ```
     * ⇒ **버리라고 안 하면 재시도가 "두 배로 보여주는" 기능이 된다.** 더 나쁜 것은
     *   pass1 이 하필 **도구 결과 원문**(계좌 잔고·보유 전량)이라는 점이다.
     * ★ 스트리밍은 되돌릴 수 없으니 **되돌리라는 신호**를 보내는 것이 유일한 수단이다.
     */
    emit('answer_restart', { reason: fake ? 'tool_markup' : 'stub', discarded: answer.length });
    contents.push({ role: 'model', parts: [{ text: answer }] });
    contents.push({ role: 'user', parts: [{ text: '[시스템] 방금 답은 미완이거나 도구 호출 흉내·중간과정이 섞였다. 결론부터 시작하는 짧고 완결된 답으로 다시 써라. "[도구 호출]"·"(도구 호출" 표기·사죄·과정 서술 절대 금지.' }] });
    answer = '';
  }

  /**
   * 🔴 **말과 행동이 갈리면 사용자에게 말한다** (2026-10-01 실사고 — 위 PROPOSAL_CLAIMED 참조).
   *    조용히 두면 사용자는 상단 목록에서 승인 버튼을 찾다가 **시스템이 고장 났다고 읽는다.**
   * ⚠️ 답을 고쳐 쓰지는 않는다 — 스트리밍은 되돌릴 수 없고, 판단 자체는 쓸모가 있다.
   *    **없는 것을 있다고 한 사실만** 덧붙인다.
   */
  if (PROPOSAL_CLAIMED.test(answer)
      && !toolLog.some((t) => /^propose/.test(t.name || '') && t.ok !== false)) {
    logWarn('chat.proposal_claim_unbacked', { turnId, tools: toolLog.map((t) => t.name) });
    emit('notice', {
      text: '⚠️ 답에는 제안을 등록했다고 적혀 있지만 **실제로는 등록되지 않았습니다** —'
        + ' 상단 목록에 안 뜹니다. 필요하면 "제안 등록해줘" 라고 다시 말해 주세요.',
    });
  }

  appendHistory({ at: new Date().toISOString(), turnId, role: 'assistant', text: answer, toolCalls, rounds, tools: toolLog });
  logInfo('chat.turn', {
    turnId, rounds, toolCalls, chars: answer.length, recalled: recalled.length,
    toolFailed: toolLog.filter((t) => !t.ok).length,
    retriedFinal,
    // ★ 도구가 **실제로 불렸다는 증거**를 지표에 함께 — 0이면 결과가 스스로 알려준다
    decideFailed: decideFailed || null,
    durationMs: Date.now() - startedAt,
  });
  return { turnId, rounds, toolCalls, chars: answer.length, recalled: recalled.length, decideFailed };
}

/**
 * 모델이 텍스트로 낸 도구 호출을 읽는다.
 *
 * 받아 주는 모양 (모델은 **지시해도 흔든다** — 코드가 흡수한다):
 * ```
 * {"tool":"x","args":{}}            한 건
 * [{"tool":"x"},{"tool":"y"}]       여러 건
 * ```json { ... } ```               코드펜스로 감싼 것
 * ```
 * ⚠️ `name`/`tool`, `args`/`arguments`/`parameters` 를 모두 받는다 —
 *    프롬프트로 한 가지만 쓰게 만드는 것보다 **코드가 흡수하는 쪽**이 싸다
 *    (워크스페이스 규율: *"프롬프트로 못 고치는 것을 프롬프트로 고치려 하지 말 것"*).
 * 🔴 **알 수 없는 도구 이름은 여기서 거르지 않는다** — `runTool` 이 이유를 담아 돌려주고
 *    그게 모델에게 전달돼야 스스로 고친다.
 */
function parseToolCalls(text) {
  let body = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fence) body = fence[1].trim();

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    // 앞뒤에 말이 섞였을 때 **첫 JSON 덩어리**만 떼어 본다
    const m = /[[{][\s\S]*[\]}]/.exec(body);
    if (!m) return [];
    try {
      data = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }

  const list = Array.isArray(data) ? data : [data];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.tool || item.name || '').trim();
    if (!name) continue;
    const args = item.args || item.arguments || item.parameters || {};
    out.push({ name, args: typeof args === 'object' && args ? args : {} });
  }
  return out;
}

/** 도구 결과를 화면에 한 줄로 — 원본을 다 흘리면 채팅창이 잠긴다 */
function preview(result) {
  try {
    const s = JSON.stringify(result);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return '(표시할 수 없음)';
  }
}

module.exports = {
  chat,
  recall,
  runTool,
  sanitizeQuery,
  sanitizeQueryInner,
  readHistory,
  appendHistory,
  clearHistory,
  TOOL_DECLARATIONS,
  SYSTEM_PROMPT,
  parseToolCalls,
  toolCatalog,
  decideTools,
  DECIDE_SCHEMA,
  HISTORY_FILE,
  MAX_ROUNDS,
  // 테스트용 — 맥락 조립의 두 축을 밖에서 직접 잰다(로그를 세려 하면 공허해진다)
  accountTruthSection,
  isStubAnswer,
  maskStaleNumbers,
  PROPOSAL_CLAIMED,
  currentSession,
  tokenize,
  SESSION_GAP_MS,
  RECALL_MAX_DF_RATIO,
  RECALL_RARE_DF,
  RECALL_MIN_CORPUS,
};
