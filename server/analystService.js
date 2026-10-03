const { generateStructuredOutput, getAiSettings } = require('./aiService');
const { getDashboardSettings } = require('./settingsService');
const orderService = require('./orderService');
const toss = require('./tossClient');
const stockIdentity = require('./stockIdentity');
const mcp = require('./mcpClient');
// 🔴 모델이 지어낸 가격을 거르는 검증 단계 (2026-10-02)
const prose = require('./proseNumbers');
const rating = require('./stockRating');
const activity = require('./activityLog');
const telegram = require('./telegramService');
const tossWriting = require('./tossWriting');
const crypto = require('node:crypto');
const { logInfo, logWarn } = require('./logger');

/**
 * 매수·매도 애널리스트 (2026-09-21)
 *
 * 사용자: *"최근 주식시장 상태 보면서 모멘텀 분석한 후에, 주식 매수/매도 분석 관련 HITL 처리 및
 * 매도 수량 / 매수 수량 / 평가금액 같은거만 나오게 해줘."*
 *
 * ## 🔴 가장 중요한 제약 — **없는 데이터로 분석시키지 않는다**
 *
 * 사용자가 준 애널리스트 프롬프트들은 **5년 재무제표 · DCF · F/Z/O/M-score · 옵션 IV ·
 * 기관 수급 · 내부자 거래**를 요구한다. **토스 API 에는 그 데이터가 없다.**
 * 우리가 가진 것은 아래가 전부다:
 * ```
 * 보유(수량·평단·현재가·평가손익·당일손익) · 일봉 200개(OHLCV) · 랭킹 · 투자자별 매매동향
 * 종목 경고 · 상하한가 · 환율 · 장 운영시간
 * ```
 * ⇒ 없는 축을 요구하면 모델은 **지어낸다.** 그래서 프롬프트가
 *   ①가진 데이터만 근거로 쓰게 하고 ②없는 축은 **"데이터 없음"** 이라 말하게 하고
 *   ③**모든 수치에 근거를 달게** 한다. 이건 이 워크스페이스에서 반복해 배운 것이다
 *   — *뭉뚱그린 답은 틀린 답보다 나쁘다*(채워진 척하므로 검증을 건너뛴다).
 *
 * ## 제안은 **완전한 값**이어야 한다
 *
 * 모델이 종목·방향·수량·가격을 **전부** 채워야 제안이 만들어진다. 빈칸이 있으면
 * `orderService` 가 거부한다 — **승인 화면이 주문 화면이 되면 안 된다.**
 * 그리고 실행은 여전히 **사람 승인 + no-op** 이다(샌드박스가 없다).
 */

/**
 * 🔴 **마지막 분석을 파일로 남긴다** (2026-09-21).
 *
 * 화면 진입 자동 실행을 껐다(사용자 지시: *"장마감 + 모멘텀 발생시점에만"*).
 * 저장하지 않으면 사용자는 **사건이 날 때까지 빈 화면**을 본다 —
 * *"안 돌린 것"* 과 *"고장난 것"* 이 화면에서 같아 보이는 건 오늘 내내 본 실패 모드다.
 * ⚠️ 감사 로그와 다르다 — 이건 **'지금 상태'** 라 통째로 덮어쓴다(원자적 쓰기).
 */
const LAST_FILE = process.env.ANALYST_LAST_FILE
  || require('node:path').join(__dirname, '..', 'data', 'analyst-last.json');

/**
 * 🔴 **모델에게 보낸 프롬프트를 남긴다** (2026-10-02 — 판정을 가능하게 하는 전제).
 *
 * 프롬프트는 *"제공된 숫자를 그대로 인용합니다. 근거 없는 수치는 쓰지 않습니다"* 를
 * 요구하는데, **그게 지켜졌는지 확인할 방법이 없었다** — 라이브 회차의 입력이 어디에도
 * 안 남아 있어서, 보고서의 숫자가 **우리가 준 것인지 지어낸 것인지** 영영 가를 수 없었다.
 * ⇒ 입력을 남겨야 감사가 성립한다. *"판정하려면 원자료를 남겨야 한다"*(Probius 09-11:
 *   원자료를 안 남겨 소급 채점이 영영 불가능했던 그 자리).
 *
 * ⚠️ `analyst-last.json` 에 넣지 않는다 — 그 파일은 **화면이 읽는다**(13k자가 매번 오간다).
 * ⚠️ 한 회차분만 덮어쓴다(감사 로그가 아니라 "마지막 입력" 이다).
 * ⚠️ 계좌 수량·금액이 들어 있다 — `data/` 는 이미 보유 스냅샷을 담고 있고 같은 권한이다.
 */
const LAST_PROMPT_FILE = process.env.ANALYST_LAST_PROMPT_FILE
  || require('node:path').join(__dirname, '..', 'data', 'analyst-last-prompt.txt');

function savePrompt(text) {
  try {
    const fs = require('node:fs');
    fs.mkdirSync(require('node:path').dirname(LAST_PROMPT_FILE), { recursive: true });
    const tmp = `${LAST_PROMPT_FILE}.tmp`;
    fs.writeFileSync(tmp, String(text || ''));
    fs.renameSync(tmp, LAST_PROMPT_FILE);
  } catch (e) {
    // ⚠️ 감사 보조물이라 실패해도 브리핑을 막지 않는다 — 다만 조용하지 않다
    logWarn('analyst.save_prompt_failed', { message: e.message });
  }
}
function readLastPrompt() {
  try { return require('node:fs').readFileSync(LAST_PROMPT_FILE, 'utf8'); } catch { return null; }
}

function saveLast(report) {
  try {
    const fs = require('node:fs');
    fs.mkdirSync(require('node:path').dirname(LAST_FILE), { recursive: true });
    const tmp = `${LAST_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report));
    fs.renameSync(tmp, LAST_FILE);
  } catch (e) {
    logWarn('analyst.save_last_failed', { message: e.message });
  }
}

/** ⚠️ 못 읽어도 **null 을 준다** — 화면이 그걸 "아직 없음" 으로 그린다(에러로 죽지 않는다) */
function readLast() {
  try {
    return JSON.parse(require('node:fs').readFileSync(LAST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 직전에 보낸 분석의 지문 — 같은 **판단**을 두 번 보내지 않는다(서술은 지문에 안 넣는다) */
let lastSentDigest = null;
/**
 * 🔴 **둘째 방어선 — 최근에 보낸 판단으로 *되돌아온* 경우를 묶는다.**
 *
 * 지문(직전 1건)만으로는 부족하다: 모델이 `HOLD → SELL → HOLD` 로 오가면 **매번 새 판단**으로
 * 보여 계속 발송된다. 화면 진입마다 분석이 도는 구조라 그 진동이 그대로 알림이 된다.
 *
 * ⚠️ 그렇다고 **일괄 최소 간격**을 걸면 안 된다 — 사용자 지시가 *"판단하면 **바로** 쏴"* 다.
 *    `HOLD → SELL` 같은 **처음 보는 판단**은 즉시 가야 한다.
 * ⇒ 창(window) 안에서 **이미 보낸 적 있는 판단**만 건너뛴다. 처음 보는 판단은 지연 0.
 */
const sentWindow = new Map(); // digest → 보낸 시각
const SEND_WINDOW_MS = Math.max(0, Number(process.env.ANALYST_SEND_WINDOW_MS ?? 15 * 60_000));

/** ⚠️ 테스트가 상태를 격리할 수 있어야 한다 — 안 그러면 회차 순서에 결과가 묶인다 */
function _resetSendStateForTest() { lastSentDigest = null; sentWindow.clear(); }

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    marketView: { type: 'string' },
    momentumRead: { type: 'string' },
    // 🔴 개수 상한 (2026-09-23) — 출력 길이 = 시간. 상한 없이 6,905~9,762토큰을 써서 캡에 잘렸다
    dataGaps: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    positions: {
      type: 'array',
      // ⚠️ 설명이 없으면 모델이 **어느 배열에 무엇을 넣을지** 모른다(실측: 통째로 비웠다)
      description: '매수 후보(아직 **안 들고 있는** 종목) 판단. 보유는 holdings 에 넣는다. 없으면 빈 배열.',
      /**
       * ⚠️ 이제 **후보 전용 자리**다 — 보유는 `holdings`(아래 `reportSchemaFor`)가 받는다.
       *    종전엔 둘이 여기서 경쟁했고 비중 0.7% 인 O 가 네 회차 연속 밀려났다.
       * ⚠️ 상한은 남긴다 — 출력 길이 = 시간이고, 상한 없이 6,905~9,762토큰을 써서 캡에 잘린 적이 있다.
       */
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          stance: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
          confidence: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
          rationale: { type: 'string', description: '2문장 이내' },
          evidence: { type: 'array', items: { type: 'string' }, maxItems: 2, description: '제공된 숫자 인용, 각 40자 이내' },
          risk: { type: 'string', description: '1문장' },
          // 🔴 **레벨만** 모델이 정한다 — 손익비·수량은 코드가 계산한다(모델은 산수를 틀린다)
          entry: { type: 'number' },
          stop: { type: 'number' },
          target: { type: 'number' },
          scenarioUp: { type: 'string' },
          scenarioDown: { type: 'string' },
        },
        required: ['symbol', 'stance', 'confidence', 'rationale', 'evidence', 'risk'],
      },
    },
    proposals: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          side: { type: 'string', enum: ['BUY', 'SELL'] },
          quantity: { type: 'number' },
          price: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['symbol', 'side', 'quantity', 'price', 'reason'],
      },
    },
  },
  required: ['marketView', 'momentumRead', 'dataGaps', 'positions', 'proposals'],
};

/**
 * 🔴 **보유 종목에 자리를 따로 준다** (2026-10-02 — O 누락 네 회차 연속의 원인).
 *
 * ## 무엇이 일어났나
 * `positions` 는 **보유와 후보가 함께 들어가는 한 배열**이고 `maxItems: 6` 이다.
 * 도구상자가 커지면서 후보가 7~10종이 되자 모델이 **후보 위주로 답하고 보유를 밀어냈다.**
 * 19:27 회차가 정확히 그 모양이다 — 후보 7 + QLD·RAM, 그리고 **O 누락.**
 * O 는 **2주 · $107 · 비중 0.7%** 라 **가장 먼저 버려진다.**
 *
 * ## 🔴 프롬프트로는 네 번 다 실패했다
 * 지시문에 *"보유 종목은 하나도 빠뜨리지 말고 전부 판단하십시오"* 가 **이미 있고**,
 * 재요청 프롬프트에도 종목명을 찍어서 다시 요구한다. **네 회차 모두 안 들었다.**
 * ⇒ 이 워크스페이스의 규율대로 **프롬프트로 못 고치는 것은 구조로 바꾼다.**
 *
 * ## 처방 — 경쟁을 없앤다
 * 보유 전용 배열 `holdings` 를 두고 **`minItems = maxItems = 보유 개수`**,
 * `symbol` 은 **보유 티커 enum**. 자리가 따로 있으면 후보와 경쟁하지 않는다.
 * ⚠️ `shapeReport` 는 **응답의 모든 배열을 훑어** `asPosition` 으로 모으므로
 *    (그래서 `got:9` 같은 수가 나온다) **합치는 코드를 따로 쓸 필요가 없다.**
 * ⚠️ `minItems` 가 모델을 억지로 채우게 해 지어내기를 유발할 수 있다 — 그러나
 *    보유 종목은 **실재하고 시세·평단·이동평균을 전부 줬다.** 지어낼 것이 없고,
 *    최악이라도 `HOLD · LOW` 는 **코드가 대신 채우는 지금보다 낫다.**
 * ⚠️ 보유가 없으면 원래 스키마를 그대로 쓴다 — 빈 enum 은 스키마를 깨뜨린다.
 */
function reportSchemaFor(heldSymbols = []) {
  // ⚠️ trim 을 빠뜨려 ' qld ' 가 그대로 enum 에 들어갔다 — 자가 잡았다(2026-10-02)
  const syms = [...new Set((heldSymbols || []).map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))];
  if (!syms.length) return REPORT_SCHEMA;
  const base = REPORT_SCHEMA.properties.positions.items;
  return {
    ...REPORT_SCHEMA,
    properties: {
      ...REPORT_SCHEMA.properties,
      holdings: {
        type: 'array',
        minItems: syms.length,
        maxItems: syms.length,
        description: `사용자가 **실제로 들고 있는** ${syms.length}개 종목 전부 — ${syms.join(', ')}. 하나도 빠뜨리지 말 것. 비중이 작아도 뺄 수 없다.`,
        items: {
          ...base,
          properties: { ...base.properties, symbol: { type: 'string', enum: syms } },
        },
      },
    },
    required: [...REPORT_SCHEMA.required, 'holdings'],
  };
}

const SYSTEM_PROMPT = [
  '당신은 **퀀트 모멘텀 분석가**입니다. 이야기가 아니라 **가격·추세·상대강도·변동성**으로 판단합니다.',
  '',
  /**
   * 🔴 **공격적 기조 · 퀀트 모멘텀 재구성** (2026-10-02 사용자 지시:
   *    *"지금 퀀트 모먼트 분석가로서 제대로 매도 매수 제안도 안나오고 … 제한 걸지말고
   *    냉철하게 공격적 포트폴리오 관점에서 구성해야해."*)
   * 같은 날 현금 버퍼(15%)와 보유 방침 게이트를 **코드에서 제거**했다 — 프롬프트가
   *    없는 한도를 말하면 모델이 스스로 제안을 깎는다(문서가 코드보다 오래 사는 그 병).
   */
  '## 운용 기조 — 공격적 (2026-10-02 사용자 결정)',
  '- 🔴 현금 버퍼(15%)와 보유 방침 게이트는 **제거됐습니다.** 인위적 한도로 제안을 깎지 마십시오.',
  '- 확신의 근거는 **숫자**입니다 — 추세·상대강도·손익비가 서면 **제안을 내십시오.** 뉴스가 없어도 됩니다.',
  '  "관망" 은 판단이 아니라 판단 회피입니다. 다만 숫자가 안 서면 빈 배열이 정답입니다.',
  '- 공격적이란 위험을 **모르고** 가는 게 아니라 위험을 **정량화하고** 가는 것입니다 —',
  '  그래서 `stop` 이 더 중요해집니다. 손절선 없는 공격은 공격이 아니라 도박입니다.',
  '- 레버리지는 추세가 선 구간에서 허용됩니다. 횡보·고변동 구간에서는 일일 리밸런싱 감쇠가 복리로 깎습니다.',
  '',
  '## 모멘텀 판단의 축 (이 순서로 보십시오)',
  '1. **추세** — 종가 vs 20일선 vs 60일선. 정배열(종가>20>60)·역배열·엇갈림',
  '2. **상대강도** — 같은 기간 지수 대비 초과인가 열위인가. 오르는 것 중에 고르고 내리는 것 중에 피합니다',
  '3. **변동성** — volPct·atrPct. 기대수익이 같으면 변동성이 낮은 쪽이 낫습니다(같은 리스크로 더 담을 수 있습니다)',
  '4. **위치** — 120일 고점 대비 어디인가, 20일 스윙 고저 안 어디인가',
  '5. **국면 정합** — "## 시장 국면" 의 매크로 축(금리·신용·달러·시장폭)과 이 종목이 **같은 방향인가**',
  '',
  '🔴 **종목의 등락을 국면으로 먼저 설명하십시오.** "52주 신저가" 는 증상이지 원인이 아닙니다.',
  '   금리 상승기에 리츠·유틸·고배당이 함께 내리는 것은 **그 종목의 문제가 아닙니다** —',
  '   그걸 "약세라 매도" 로 읽으면 국면이 바뀔 때 **가장 싼 자리에서 팔게 됩니다**(2026-10-02 실사고).',
  '🔴 **사용자가 적립·보유를 정한 종목에 매도 제안을 내려면 근거가 "가격이 내렸다" 보다 강해야 합니다** —',
  '   배당 삭감·신용등급 하락·사업 훼손처럼 **종목 자체의 변화**여야 합니다. 국면 역풍은 그 근거가 아닙니다.',
  '',
  /**
   * 🔴 길이는 **필드별 자수로** 묶는다 (2026-09-23 2차) — "전체 2,000토큰" 총량 지시는
   *    flash 가 무시했다(dryRun: 출력이 정확히 캡 2,592 에 닿아 잘림 3/3). 반면 필드별
   *    자수를 준 market_briefing 은 잘림 0 — **구체적 자수 지시만 먹힌다**는 방증.
   *    자연 출력(6,905~9,762)이 예산(2,592)의 3배라 항목 수가 아니라 길이를 직접 묶어야 한다.
   */
  /**
   * 🔴 국면은 **코드가 판정**해 프롬프트에 싣는다 (2026-09-23, regimeService) —
   *    모델이 스스로 판정하게 하면 회차마다 흔들린다. ⚠️ 두 줄로 유지 — 길이 = 시간.
   */
  '"## 시장 국면" 절의 판정을 그대로 쓰라 — 다시 판정하지 마라.',
  '"## 발동된 매뉴얼" 이 있으면 그 스텝 안에서만 제안하고, 티커는 "## 도구상자" 안에서만 고른다.',
  '',
  '⚠️ 길이 규칙 — 어기면 답이 잘려 **통째로 버려집니다**:',
  '- marketView·momentumRead: 각 2문장 이내',
  '- 종목별 rationale: 2문장 · evidence: **40자 이내 인용** 최대 2개 · risk: 1문장',
  '- scenarioUp/scenarioDown: 각 1문장 · dataGaps: 항목당 15자 이내',
  '- proposals 의 reason: 1문장',
  '',
  '## 반드시 지킬 것',
  '1. **제공된 데이터만 근거로 씁니다.** 재무제표·DCF·PER/PBR·기관 수급·내부자 거래·옵션 IV 는',
  '   이 시스템에 **없습니다**. 그런 근거를 지어내지 마세요.',
  '2. 쓰지 못한 분석 축은 `dataGaps` 에 **솔직히 적습니다**("5년 재무 미제공" 처럼).',
  '3. 모든 판단에 `evidence` 를 답니다 — **제공된 숫자를 그대로 인용**합니다(예: "당일 +4.63%",',
  '   "평단 $71.78 대비 현재 $92.21", "20일선 상회"). 근거 없는 수치는 쓰지 않습니다.',
  '4. **뭉뚱그리지 않습니다.** "관망 필요", "시장 상황에 따라" 같은 말은 답이 아닙니다.',
  '   판단이 안 서면 stance=HOLD 에 confidence=LOW 로 **그렇게 말합니다.**',
  '5. 감정적 표현·과장을 쓰지 않습니다. 한국어로 씁니다.',
  // 🔴 12:15 실검수: 우리 데이터에 없는 "달러인덱스" 가 marketView 에 등장했다(출처 불투명)
  '6. 웹검색에서 온 사실은 **"(검색)"** 을 붙여 구분합니다. 검색 결과에도 없는 지표(달러인덱스 등)는',
  '   언급하지 않습니다 — 어디서도 받지 않은 값은 존재하지 않는 값입니다.',
  '',
  // 🔴 **두 배열의 역할을 말로 갈라 준다** (2026-10-02 실측) — `holdings` 를 신설하자
  //    모델이 `positions` 를 **통째로 비웠다**(3회 연속 후보 0건·제안 0건).
  //    자리를 나눠 주고 **무엇을 넣을지 안 말하면** 한쪽만 채운다.
  '## holdings (보유 종목 판단) — **지금 들고 있는 것**',
  '🔴 **보유 종목은 하나도 빠뜨리지 말고 전부 판단하십시오.**',
  '   빠진 종목은 "판단 보류" 가 아니라 **방치**입니다 — 사용자는 그 종목을 들고 있습니다.',
  '   데이터가 모자라면 stance=HOLD · confidence=LOW 로 **그렇게 적고**, dataGaps 에 무엇이 없는지 쓰십시오.',
  '',
  '## positions (매수 후보 판단) — **아직 안 들고 있는 것**',
  '- 위 「매수 후보 기술 위치」·「도구상자」에서 **지금 살 만한 것**을 골라 같은 형식으로 판단합니다.',
  '- 보유 종목을 여기 넣지 마십시오 — 그건 `holdings` 자리입니다.',
  '- 살 만한 것이 없으면 **빈 배열**이 정답입니다. 억지로 채우지 마십시오.',
  '',
  '## proposals (매매 제안)',
  '- 추세·상대강도·손익비가 서면 **냅니다.** 숫자가 안 서면 빈 배열이 정답입니다.',
  '  ⚠️ 한도 때문에 못 낸다고 적지 마십시오 — 현금 버퍼 규칙은 제거됐습니다(2026-10-02).',
  '- symbol·side·quantity·price 를 **전부 숫자로** 채웁니다. 하나라도 비면 그 제안은 버려집니다.',
  '- quantity 는 **보유 수량과 현금 여력을 넘지 않게** 합니다. 매도는 보유 수량 이내입니다.',
  '- price 는 지정가입니다. 🔴 **현재가 ±2.5% 안**이어야 합니다(코드가 거부합니다 — 09-23 실물:',
  '  당일 고가 옆 지정가 3건이 전부 10분 TTL 안에 체결 불가였다). 그 밖의 가격을 원하면 제안 대신',
  '  **조건주문**을 서술하세요(사람이 예약으로 겁니다).',
  '- 🔴 이 제안은 **사람이 승인해야만** 실행됩니다. 당신은 실행하지 않습니다.',
  '',
  '## 손익비 · 손절 · 시나리오 (2026-09-21 추가)',
  '각 종목 판단에 아래를 **숫자로** 답하세요. 없는 데이터를 지어내지 말고, 제공된',
  '현재가·20/60일선·최근 20일 스윙 고저·일간 변동성(volPct)·하루 폭(atrPct) 안에서 정하세요.',
  '- `entry`  지금 들어간다면(또는 이미 보유면 현재가 기준) 기준이 되는 가격',
  '- `stop`   🔴 **여기가 깨지면 판단이 틀린 것**이라는 가격. 스윙 저점·이동평균처럼',
  '           **차트에 근거가 있는 자리**로 잡으세요. "10% 아래" 같은 임의값은 쓰지 마세요.',
  '- `target` 도달하면 판단이 맞은 것이라는 가격(스윙 고점·전고점 등)',
  '- `scenarioUp` / `scenarioDown` 각각 **한 문장** — 그 방향이 될 때 먼저 보이는 신호',
  '⚠️ **손익비와 수량은 계산하지 마세요.** 시스템이 계산합니다 — 당신은 레벨만 정합니다.',
  '⚠️ 매도 판단이면 `stop` 은 현재가 **위**입니다(반등하면 판단이 틀린 것).',
  // 🔴 2026-10-02: 아래 두 줄이 없어서 QLD 목표 97 < 현재가 97.6 (이미 달성된 목표)이 나왔다.
  //    ⚠️ 프롬프트는 **보조**다 — 코드(`computeTrade`)가 현재가와 대조해 실제로 잡는다.
  '🔴 `target` 은 **현재가를 넘어선 자리**여야 합니다 — 매수면 현재가 **위**, 매도면 **아래**.',
  '   현재가 이미 지난 목표는 "지금 청산하라" 와 같은 말이라 제안으로서 의미가 없습니다.',
  '🔴 `entry` 가 현재가와 다르면 **왜 그 가격인지** `rationale` 에 한 마디 적으세요',
  '   (예: "20일선 92.7 까지 눌리면" / "저항 29.6 을 넘으면"). 안 적으면 사용자는',
  '   그 숫자가 추격매수인지 지정가 대기인지 알 수 없습니다.',
  '🔴 값을 정할 수 없으면 그 칸을 **비우십시오 — `0` 을 쓰지 마세요.** `0` 은',
  '   "가격이 0원" 이라는 뜻이고, 화면에 `진입 0.00` 으로 떠서 사용자를 혼란스럽게 합니다.',
].join('\n');

/**
 * 🔴 **모델이 스키마를 무시하고 모양을 바꾼다 — 세 번째 층이다** (2026-09-21 실측).
 *
 * 라이브에서 받은 것:
 * ```
 * {"dataGaps":[…], "stance":"HOLD", "stanceConfidence":…}     ← **평평하다**
 * ```
 * `marketView`·`positions`·`proposals` 가 통째로 없고 종목 판단이 **최상위**에 올라왔다.
 * 그 결과 화면·텔레그램·타임라인이 전부 **"(시황 요약 없음)"** 이 됐다 —
 * 모델은 답했는데 **내 파서가 버린 것**이다. 도구 판단기에서 겪은 그 비대칭이 여기서 재발했다.
 *
 * ⇒ 도구 때와 같은 처방: **키가 아니라 모양으로 읽는다.**
 *   · 종목 판단 = `stance` 값이 BUY/SELL/HOLD 인 객체 (배열이든 최상위든)
 *   · 제안     = side + quantity + price 가 **다 있는** 객체
 *   · 시황     = 알려진 이름 → 없으면 **가장 긴 산문 문자열**
 * ⚠️ 제안은 **네 칸이 다 있을 때만** 줍는다 — 반쪽을 주우면 `orderService` 가 거부하고
 *    사용자는 "왜 제안이 사라졌지" 를 겪는다.
 */
const STANCES = new Set(['BUY', 'SELL', 'HOLD']);

/**
 * 매수 여력을 재는 통화 — `tossPortfolio` 가 현금을 **이 둘만** 받아 온다
 * (`cash = { krw, usd, failed }`). 새 통화가 생기면 **거기와 여기를 같이** 고쳐야 한다.
 */
const CAPACITY_CURRENCIES = ['USD', 'KRW'];

function pickString(obj, names) {
  for (const n of names) {
    const v = obj?.[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 값들 중 **가장 긴 산문** — 이름을 모를 때의 마지막 수단 */
function longestProse(obj, exclude = new Set()) {
  let best = '';
  for (const [k, v] of Object.entries(obj || {})) {
    if (exclude.has(k)) continue;
    if (typeof v === 'string' && v.trim().length > best.length && v.trim().length > 20) best = v.trim();
  }
  return best;
}

function asPosition(o) {
  if (!o || typeof o !== 'object') return null;
  /**
   * ⚠️ **주문을 판단으로 오인하면 안 된다.** `{side:'SELL', quantity, price}` 는 `side` 값이
   *    STANCES 에 걸려 판단으로 읽혔다(자체 점검에서 잡았다). 수량·가격이 있으면 **제안**이다.
   */
  const looksLikeOrder = ['quantity', 'qty', 'shares'].some((k) => Number(o[k]) > 0)
    && ['price', 'limitPrice'].some((k) => Number(o[k]) > 0);
  if (looksLikeOrder) return null;
  let stance = null;
  let symbol = null;
  for (const v of Object.values(o)) {
    if (typeof v !== 'string') continue;
    const up = v.trim().toUpperCase();
    if (!stance && STANCES.has(up)) stance = up;
  }
  symbol = pickString(o, ['symbol', 'ticker', 'code', 'stock']);
  /**
   * 🔴 **버려지는 경로는 조용하면 안 된다** (2026-09-29, pm2 지적).
   *
   * 종전에는 `if (!stance) return null` 로 **말없이** 버렸다. 그래서 09-28 12:17 의
   * `positions 0` 을 두고 **하루를 추론에 썼다** — `positions_short got:0` 은 *실패했다*는
   * 것만 알려주고 **모델이 실제로 뭐라 답했는지**는 안 알려줬다. 원문이 있었으면 한 줄로 끝났다.
   *
   * ⚠️ **종목처럼 생긴 것만** 짖는다(`symbol` 이 있는데 stance 를 못 읽은 경우). `asPosition`
   *    은 브리핑 파싱 중 온갖 객체에 불리므로, 조건을 안 좁히면 warn 이 소음이 되어
   *    **읽히지 않는 로그**가 된다(그건 침묵과 같다).
   * ★ 관대한 파서로 흡수하지 않는 이유: **흡수하면 계약 위반이 관측 불가가 된다.**
   *   정본은 스키마 enum 하나이고, 이탈은 조용히 통과시키는 대신 **보이게** 만든다.
   */
  if (!stance) {
    /**
     * ⚠️ **`symbol` 만으로 좁히면 절반이 안 보인다** (pm2 지적) — 종목명이 아예 안 온 이탈이
     *    `got:0` 의 그럴듯한 모양 중 하나인데, 그게 통째로 침묵하면 이 warn 의 목적이 반만 선다.
     *    ⇒ **stance 자리에 뭔가 오긴 했는데 enum 밖인 경우**도 짖는다(그게 곧 계약 위반이다).
     *    여전히 아무 관련 키도 없는 객체는 조용하다 — 그건 이탈이 아니라 **그냥 다른 객체**다.
     */
    const rawStance = ['stance', 'rating', 'judgment', 'action', '판단'].find((k) => typeof o[k] === 'string');
    if (symbol || rawStance) {
      logWarn('analyst.stance_unrecognized', {
        symbol: symbol || null,
        rawStanceKey: rawStance || null,
        received: JSON.stringify(o).slice(0, 240),
        expected: [...STANCES].join('|'),
      });
    }
    return null;
  }
  const num = (names) => {
    for (const n of names) { const v = Number(o?.[n]); if (Number.isFinite(v) && v > 0) return v; }
    return null;
  };
  return {
    symbol: symbol || '(종목 미상)',
    stance,
    entry: num(['entry', 'entryPrice', 'basePrice']),
    stop: num(['stop', 'stopLoss', 'stopPrice']),
    target: num(['target', 'targetPrice', 'takeProfit']),
    scenarioUp: pickString(o, ['scenarioUp', 'upside', 'bullCase']),
    scenarioDown: pickString(o, ['scenarioDown', 'downside', 'bearCase']),
    confidence: (pickString(o, ['confidence', 'stanceConfidence', 'conviction']) || 'LOW').toUpperCase(),
    rationale: pickString(o, ['rationale', 'reason', 'why', 'comment']) || longestProse(o, new Set(['symbol'])),
    evidence: Array.isArray(o.evidence) ? o.evidence : [],
    risk: pickString(o, ['risk', 'downside']) || '',
  };
}

/**
 * 주문을 만들려 한 **흔적**으로 쓰는 키들 — 값이 아니라 **키의 존재**만 본다
 * (`quantity: 0` 처럼 **틀린 값**이야말로 우리가 보고 싶은 반쪽 제안이다).
 */
const PROPOSAL_NUM_KEYS = ['quantity', 'qty', 'shares', 'amount', 'price', 'limitPrice', 'targetPrice'];

function asProposal(o) {
  if (!o || typeof o !== 'object') return null;
  const side = (pickString(o, ['side', 'action', 'direction']) || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return null;
  const num = (names) => {
    for (const n of names) {
      const v = Number(o?.[n]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  };
  const quantity = num(['quantity', 'qty', 'shares', 'amount']);
  const price = num(['price', 'limitPrice', 'targetPrice']);
  // 🔴 네 칸이 다 있어야 제안이다 — 반쪽은 버린다(거부될 것을 만들지 않는다)
  const symbol = pickString(o, ['symbol', 'ticker', 'code']);
  if (!symbol || !quantity || !price) {
    /**
     * 🔴 **버려지는 경로는 조용하면 안 된다** (2026-10-01) — `asPosition` 의
     *    `stance_unrecognized`(:263)와 **같은 가족**인데 이쪽만 빠져 있었다.
     *
     * 종전에는 말없이 `null` 을 돌려줬다. 그래서 `proposed:0` 을 볼 때
     * **"모델이 제안을 안 냈다" 와 "반쪽 제안을 냈는데 우리가 버렸다" 가 원리상 구분되지
     * 않았다** — 몇 건이 증발했는지 셀 방법이 아예 없었다.
     *
     * ⚠️ **제안처럼 생긴 것만** 짖는다. 이 함수는 파싱 중 **온갖 객체**에 불리고(모든
     *    배열의 모든 원소), `side` 자리에는 `BUY|SELL` 이 **판단**으로도 들어온다
     *    (`STANCES` 에 BUY·SELL 이 있다 — `{symbol, action:'BUY', confidence, rationale}`
     *    같은 보유 판단이 여기까지 온다). 그걸 전부 짖으면 warn 이 소음이 되고,
     *    **읽히지 않는 로그는 침묵과 같다.**
     *    ⇒ 기준 = **수량·가격 칸을 하나라도 들고 왔는가**(= 주문을 만들려 한 흔적).
     *       하나도 없으면 이탈이 아니라 **그냥 다른 객체**다.
     */
    const missing = [];
    if (!symbol) missing.push('symbol');
    if (!quantity) missing.push('quantity>0');
    if (!price) missing.push('price>0');
    const triedOrderFields = PROPOSAL_NUM_KEYS.some((k) => Object.prototype.hasOwnProperty.call(o, k));
    if (triedOrderFields) {
      logWarn('analyst.proposal_incomplete', {
        symbol: symbol || null,
        side,
        missing,
        received: JSON.stringify(o).slice(0, 240),
      });
    }
    return null;
  }
  return { symbol, side, quantity, price, reason: pickString(o, ['reason', 'rationale', 'why']) };
}

/**
 * 같은 종목이 서로 다른(또는 같은) 판단으로 두 번 나오는 것을 막는다.
 *
 * 🔴 2026-09-27 실측(pm1, 라이브 dryRun) — `positions` 에 QLD·RAM 이 각각 HOLD 와
 *    SELL 로 **동시에** 나왔다(보유2+후보2=4건이 정상인데 6건). 그날 웹검색이 막혀
 *    있어 모델이 후보 절까지 끌어다 같은 종목을 두 번 판단한 것으로 보인다. 이 배열은
 *    폰 브리핑·화면에 그대로 나가 사용자가 "팔라는 건가 들라는 건가" 를 모르게 된다.
 *
 * ⚠️ **먼저 나온 것을 남긴다** — 모델이 보유를 먼저 판단하는 순서를 존중한다.
 * 🔴 **모순이면 지우지 않고 흔적을 남긴다** — stance 가 다른 중복은 그 자체가 정보다.
 *    조용히 지우면 사용자는 흔들린 판단을 확신으로 읽는다. 남긴 쪽의 confidence 를
 *    LOW 로 낮추고 rationale 앞에 경고를 붙인다. 같은 stance 의 완전 중복은 confidence 를
 *    건드리지 않는다 — 모순이 아니기 때문이다.
 */
function dedupePositions(positions) {
  const kept = [];
  const indexBySymbol = new Map();
  for (const p of positions) {
    if (!indexBySymbol.has(p.symbol)) {
      indexBySymbol.set(p.symbol, kept.length);
      kept.push({ ...p });
      continue;
    }
    const idx = indexBySymbol.get(p.symbol);
    const original = kept[idx];
    logWarn('analyst.duplicate_stance', { symbol: p.symbol, kept: original.stance, dropped: p.stance });
    if (p.stance !== original.stance && !original._conflicted) {
      kept[idx] = {
        ...original,
        confidence: 'LOW',
        rationale: `⚠️ 모델이 이 종목에 상반된 판단을 함께 냈다(다른 하나: ${p.stance}). 확신도를 낮춤. ${original.rationale || ''}`.trim(),
        _conflicted: true,
      };
    }
  }
  // 내부 판정용 플래그(_conflicted)는 반환 모양에 새지 않는다
  return kept.map(({ _conflicted, ...rest }) => rest);
}

/**
 * `proposals` 의 **완전 동일 중복**(같은 symbol+side)만 거른다.
 * 같은 종목의 BUY/SELL 동시 제안은 `inverseGate` 등 다른 게이트가 이미 잡으므로
 * 여기서는 건드리지 않는다 — 이건 그 앞의 순수 중복 제거다.
 */
function dedupeProposals(proposals) {
  const seen = new Set();
  const kept = [];
  for (const p of proposals) {
    const key = `${p.symbol}:${p.side}`;
    if (seen.has(key)) {
      logWarn('analyst.duplicate_proposal', { symbol: p.symbol, side: p.side });
      continue;
    }
    seen.add(key);
    kept.push(p);
  }
  return kept;
}

/** 어떤 모양으로 오든 리포트로 만든다 */
function shapeReport(out) {
  const o = out && typeof out === 'object' ? out : {};
  /**
   * 🔴 **`holdings` 를 먼저 읽는다 — 순서가 판정을 바꾸기 때문이다** (2026-10-03 실측).
   *
   * `holdings`(보유 전용)를 신설한 뒤 `analyst.duplicate_stance` 가 **회차당 3~4건**
   * 뜨기 시작했다. 모델이 **같은 종목을 두 배열에 모두** 넣기 때문이다.
   * 대부분은 같은 판단이라 무해한데, 05:04 회차에서 **`RAM kept=HOLD dropped=SELL`** —
   * 두 배열에 **다른 판단**을 써서 `dedupePositions` 가 확신도를 `LOW` 로 낮췄다.
   *
   * ⚠️ 그런데 **어느 쪽이 남는지가 `Object.values` 의 키 순서에 달려 있었다.**
   *    JSON 키 순서는 **모델이 정한다** — 즉 *"보유 판단이 남을지 후보 판단이 남을지"* 가
   *    **매 회차 운에 맡겨져 있었다.**
   * ⇒ `holdings` 를 **명시적으로 먼저** 넣는다. 보유 판단이 기준이고 후보는 보조다.
   * ⚠️ 중복 경고는 **그대로 둔다** — 모델이 두 곳에 다르게 쓰는 것 자체가 관측돼야 한다.
   */
  const named = Array.isArray(o.holdings) ? [o.holdings] : [];
  const rest = Object.entries(o)
    .filter(([k, v]) => k !== 'holdings' && Array.isArray(v))
    .map(([, v]) => v);
  const arrays = [...named, ...rest];

  const positions = [];
  for (const arr of arrays) for (const it of arr) { const p = asPosition(it); if (p) positions.push(p); }
  // ⚠️ **평평하게** 온 경우 — 최상위 객체 자체가 한 건의 판단이다(실측된 모양)
  if (!positions.length) { const p = asPosition(o); if (p) positions.push(p); }

  const proposals = [];
  for (const arr of arrays) for (const it of arr) { const q = asProposal(it); if (q) proposals.push(q); }

  const gaps = arrays.find((a) => a.length && a.every((x) => typeof x === 'string')) || [];

  // ⚠️ `conclusion`·`결론` 은 라이브에서 **실제로 온** 키다(2026-09-21 pm2 실측) — 빠뜨리면 시황이 빈다
  const view = pickString(o, ['marketView', 'market_view', 'marketSummary', 'summary', 'overview', 'view', 'conclusion', '결론', '판단', '종합의견'])
    || longestProse(o, new Set(['momentumRead', 'momentum']));
  const mom = pickString(o, ['momentumRead', 'momentum_read', 'momentum', 'momentumSummary']);

  const dedupedPositions = dedupePositions(positions);
  const dedupedProposals = dedupeProposals(proposals);

  return {
    marketView: view,
    momentumRead: mom,
    dataGaps: gaps.slice(0, 12),
    positions: dedupedPositions,
    proposals: dedupedProposals,
    // 🔴 아무것도 못 읽었으면 **그 사실을 남긴다** — 조용히 빈 리포트를 내지 않는다
    _unreadable: !view && !dedupedPositions.length && !gaps.length ? JSON.stringify(o).slice(0, 300) : null,
  };
}

function fmt(n, d = 2) {
  return n == null ? '-' : Number(n).toFixed(d);
}

/**
 * 일봉에서 **계산으로 확인 가능한** 것만 뽑는다(모델이 추정하지 않게).
 *
 * 🔴 2026-09-21 추가: **변동성과 스윙 레벨**. 손절 위치를 "감" 으로 잡지 않으려면
 *    그 종목이 하루에 얼마나 움직이는지가 있어야 한다.
 *    · `volPct`  일간 수익률 표준편차(%) — 평소 흔들림
 *    · `atrPct`  (고가-저가)/종가 평균(%) — 하루 폭
 *    · `swingLow/High` 최근 20일 최저/최고 — 손절·목표의 **자연스러운 자리**
 * ⚠️ 표본이 적으면 변동성이 **거짓말한다** ⇒ 20개 미만이면 null 로 둔다(0 이 아니다).
 */
function summarizeCandles(rows) {
  if (!rows || rows.length < 20) return null;
  const closes = rows.map((r) => r.c).filter(Number.isFinite);
  if (closes.length < 20) return null;
  const last = closes[closes.length - 1];
  const ma = (n) => {
    if (closes.length < n) return null;
    return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
  };
  const hi = Math.max(...closes);
  const lo = Math.min(...closes);

  // 일간 수익률 표준편차
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const volPct = rets.length >= 19 ? Math.sqrt(variance) * 100 : null;

  // 하루 폭(ATR 대용) — 고·저가가 있는 봉만 쓴다
  const ranges = rows
    .filter((r) => Number.isFinite(r.h) && Number.isFinite(r.l) && Number.isFinite(r.c) && r.c > 0)
    .slice(-20)
    .map((r) => ((r.h - r.l) / r.c) * 100);
  const atrPct = ranges.length >= 10 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null;

  const win = closes.slice(-20);
  return {
    last,
    ma20: ma(20),
    ma60: ma(60),
    high: hi,
    low: lo,
    fromHighPct: hi ? ((last - hi) / hi) * 100 : null,
    fromLowPct: lo ? ((last - lo) / lo) * 100 : null,
    volPct,
    atrPct,
    swingLow: Math.min(...win),
    swingHigh: Math.max(...win),
    bars: closes.length,
  };
}

/**
 * 🔴 **산수는 코드가 한다.** 모델은 *어디가 손절이고 어디가 목표인가* 를 판단하고,
 *    손익비·수량은 **여기서** 계산한다 — 모델에게 곱셈·나눗셈을 시키면 틀린다
 *    (오늘 내내 본 "그럴듯한 숫자" 의 가장 흔한 출처다).
 *
 * 손익비(R/R) = (목표 − 진입) / (진입 − 손절)   ※ 매도는 부호를 뒤집는다
 * 수량        = floor(위험예산 / 주당 위험액)
 *   · 위험예산 = 계좌 평가액 × `riskPerTradePct`  ← **사용자가 정한다**(내가 정하지 않는다)
 *
 * ⚠️ 손절이 진입과 **같거나 반대편**이면 계산 불가다 — 0 으로 두지 않고 `null` 과 이유를 남긴다.
 */
/**
 * @param {number} [costRate] 편도 수수료율(예: 0.001 = 0.1%). 주면 **비용 반영 손익비**를 함께 낸다.
 *
 * 🔴 종전 R/R 은 **수수료를 무시**했다. 왕복 0.2% 는 작은 폭 거래에서 손익비를 눈에 띄게 깎는다.
 * ⚠️ **세금·제비용은 여전히 빠져 있다** — 토스 `/commissions` 가 `commissionRate` 하나만 주고
 *    매수/매도 구분도 없다. 그래서 이름을 `rrAfterFee`(수수료 반영)로 두고
 *    *"실제 비용"* 이라고 부르지 않는다. **모르는 것을 아는 척하지 않는다.**
 */
/**
 * 🔴 **현재가와의 관계를 안 보면 모순이 통과한다** (2026-10-02 사용자 지적).
 *
 * 화면 실측:
 * ```
 * QLD  진입 92.53 · 손절 89.50 · 목표 97.00   ← 현재가 97.6
 * UUP  진입 29.59 · 손절 28.20 · 목표 31.50   ← 현재가 28.44
 * ```
 * 종전 검증은 **방향**(`stop < entry < target`)만 봤고 둘 다 **통과**한다.
 * 그런데 **QLD 목표 97 은 현재가 97.6 보다 낮다** — 사자마자 달성된 목표다. 말이 안 된다.
 * UUP 는 진입이 현재가보다 **4% 높은데**(추격매수) 화면에 그 사실이 안 적힌다.
 *
 * ⇒ `last`(현재가)를 받아 **① 목표가 이미 달성됐는지 ② 진입이 현재가에서 얼마나 먼지**를
 *   함께 낸다. ⚠️ **값을 지우지 않는다** — 모델이 쓴 숫자는 남기고 **사실을 덧붙인다**
 *   (사용자가 보고 판단해야 한다). 다만 **손익비(rr)는 null 로** 만든다 —
 *   달성된 목표로 계산한 rr 은 **거짓 확신**이다.
 * ⚠️ `last` 를 못 구하면 **검사하지 않는다**(통과가 아니라 미검사) — `levelNote` 가 안 붙는다.
 */
/**
 * 진입가가 현재가에서 이만큼 벗어나면 **가격대 자체를 의심한다**(2026-10-02).
 * ⚠️ 넉넉히 잡는다 — 정당한 레벨을 죽이는 쪽이 더 해롭다(관측 오류는 +104% 로 한참 밖).
 */
const ENTRY_GAP_MAX_PCT = Number(process.env.ANALYST_ENTRY_GAP_MAX_PCT) || 50;

function computeTrade({ side, entry, stop, target, riskBudget, costRate, last }) {
  const e = Number(entry);
  const s2 = Number(stop);
  const t = Number(target);
  if (!Number.isFinite(e) || e <= 0) return { error: '진입가 없음' };
  if (!Number.isFinite(s2) || s2 <= 0) return { error: '손절가 없음' };

  const isBuy = String(side).toUpperCase() !== 'SELL';
  const perShareRisk = isBuy ? e - s2 : s2 - e;
  if (!(perShareRisk > 0)) {
    // 🔴 매수인데 손절이 진입 위에 있으면 **방향이 뒤집힌 것**이다. 조용히 넘기면 수량이 음수가 된다
    return { error: `손절 위치가 방향과 맞지 않습니다(${isBuy ? '매수' : '매도'}인데 손절 ${s2} / 진입 ${e})` };
  }

  const out = { perShareRisk: round2(perShareRisk), riskPct: round2((perShareRisk / e) * 100) };
  /**
   * 🔴 현재가 대비 **진입 괴리** — 화면이 이걸 안 보여줘서 사용자가 *"29? 28?"* 를 물었다.
   *    `+4%` 면 추격매수, `-5%` 면 지정가 대기다. 숫자만 보면 구분이 안 된다.
   */
  const px = Number(last);
  const hasPx = Number.isFinite(px) && px > 0;
  if (hasPx) {
    out.entryGapPct = round2(((e - px) / px) * 100);
    /**
     * 🔴 **괴리가 크면 그건 "먼 가격" 이 아니라 그 종목 가격이 아니다** (2026-10-02 실측).
     *
     * 22:07 회차: `RAM entry=29.59 stop=28.20 target=31.50` — **RAM 현재가는 14.50** 이다.
     * 진입이 **실제가의 2배**(+104%)인데 방향 검사(`stop<entry<target`)는 통과하고
     * **손익비 1.37 까지 계산돼** 화면에 떴다. 사용자: *"진입 29? 손절 28? 뭔 말도 안 되는 수치"*
     *
     * 왜 29.59 가 나왔나: 프롬프트가 *"스윙 고저를 근거로"* 라 했고, RAM 의 71일 고점이
     * 약 28.7 이다 — 모델이 **고점을 진입으로** 썼다. 근거는 있지만 **현재가에서 2배 위**를
     * 진입으로 삼는 것은 제안이 아니다.
     *
     * ⚠️ 상한은 **50%** 로 넉넉히 둔다 — 급등락 종목에서 정당한 ±30% 레벨을 죽이면
     *    가드가 제품을 해친다. 관측된 오류는 **+104%** 로 한참 밖이다.
     * ⚠️ 값은 **지우지 않는다**. `rr` 만 null 로 하고 사실을 적는다 — 판단은 사람이 한다.
     */
    const gap = Math.abs(out.entryGapPct);
    if (gap > ENTRY_GAP_MAX_PCT) {
      out.levelNote = `진입 ${round2(e)} 가 현재가 ${round2(px)} 에서 ${out.entryGapPct > 0 ? '+' : ''}${out.entryGapPct}% 떨어져 있습니다 — 이 종목의 가격대가 맞는지 확인이 필요합니다`;
      out.entryFar = true;
    }
  }

  if (Number.isFinite(t) && t > 0) {
    const reward = isBuy ? t - e : e - t;
    out.rr = reward > 0 ? round2(reward / perShareRisk) : null;
    if (out.rr === null) out.rrNote = '목표가가 진입 대비 이익 방향이 아닙니다';
    /**
     * 🔴 **이미 달성된 목표**는 손익비를 계산할 자격이 없다.
     *    매수인데 목표 ≤ 현재가(또는 매도인데 목표 ≥ 현재가)면, 그 목표는
     *    *"지금 당장 청산하라"* 와 같은 말이다 — 제안으로서 의미가 없다.
     */
    if (hasPx) {
      const reached = isBuy ? t <= px : t >= px;
      if (reached) {
        out.rr = null;
        out.levelNote = `목표 ${round2(t)} 가 현재가 ${round2(px)} 기준 이미 달성된 수준입니다`;
      }
    }
    /**
     * 🔴 **수수료를 반영한 손익비** — 종전 R/R 은 비용을 무시했다.
     *    왕복 0.2% 는 폭이 좁은 거래에서 손익비를 눈에 띄게 깎는다.
     * ⚠️ 이름이 `rrAfterFee` 인 이유: **세금·제비용은 여전히 빠져 있다**
     *    (토스가 `commissionRate` 하나만 주고 매수/매도 구분도 없다).
     *    *"실제 비용 반영"* 이라고 부르면 모르는 것을 아는 척하는 것이다.
     */
    const cr = Number(costRate);
    if (Number.isFinite(cr) && cr > 0 && out.rr !== null) {
      const roundTrip = (e + t) * cr;          // 진입·청산 양쪽 수수료
      const netReward = reward - roundTrip;
      const netRisk = perShareRisk + (e + s2) * cr;
      out.rrAfterFee = netReward > 0 ? round2(netReward / netRisk) : null;
      out.costRate = cr;
      if (out.rrAfterFee === null) out.rrAfterFeeNote = '수수료를 빼면 이익이 남지 않습니다';
    }
  }
  if (Number.isFinite(riskBudget) && riskBudget > 0) {
    out.riskBudget = Math.round(riskBudget);
    out.sizedQuantity = Math.floor(riskBudget / perShareRisk);
    if (out.sizedQuantity < 1) out.sizeNote = '위험예산이 1주 위험액보다 작습니다';
  }
  /**
   * 🔴 **가격대가 의심스러우면 손익비를 보여주지 않는다** — 틀린 진입으로 계산한 rr 은
   *    "1.37" 이라는 **그럴듯한 숫자**가 되어 사용자를 설득한다. 그게 제일 위험하다.
   */
  if (out.entryFar) { out.rr = null; out.rrAfterFee = null; }

  return out;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * 리포트를 만든다. 실패해도 **부분 결과를 돌려준다**(조각 실패를 전체 실패로 만들지 않는다).
 * @param {object} dash `/api/dashboard` 결과
 */
/**
 * 🔴 **"매수 제안 0건" 의 이유를 사실로 만든다** (2026-10-01)
 *
 * 실측 상태: 가용 현금 **USD 3.76 · KRW 0**(총 평가액 15,674 USD). 현금 버퍼 15% 는
 * 2,351 USD 라 `orderService` 의 `cash-floor` 게이트는 **도달조차 불가능한 사문**이었다 —
 * 신규 매수가 **물리적으로 불가능**한 상태인데 프롬프트도, 폰 브리핑도, 로그도 그 사실을
 * **한 번도 말하지 않았다.** 사용자는 `proposed:0` 만 보고 "제안이 없다" 로 읽는다.
 * ⇒ 침묵이 **"정상"과 "고장"을 똑같이 보이게** 만드는 그 자리다.
 *
 * ⚠️ **가격을 몰라도 판정되는 축이 먼저다.** 버퍼를 빼고 남는 금액이 0 이하면 *어떤 종목이든,
 *    아무리 싸도* 1주를 못 산다 — 후보 목록도 시세도 필요 없다. 가격 비교(`below-min-price`)는
 *    그 다음이고, 참조가는 **이미 들고 있는 종목의 현재가**를 쓴다(새 의존성을 만들지 않는다).
 * ⚠️ **못 읽은 것과 0 은 다르다.** `cash[cur]` 이 없으면 `unknown` 이고, 그 통화가 하나라도
 *    있으면 전체를 `blocked` 로 **단정하지 않는다** — "살 수 없다" 는 전부 읽고서만 하는 말이다.
 * ⚠️ 버퍼 비율은 게이트를 실제로 거는 `orderService.CASH_FLOOR_PCT` 를 **그대로 읽는다**(복제 금지).
 *
 * @param {{cash?:{krw?:object,usd?:object,failed?:string[]}}|null} summary `dash.portfolio.summary`
 * @param {Array<{currency?:string, marketValue?:number, lastPrice?:number}>} items 보유 종목
 */
function assessBuyingCapacity(summary, items = []) {
  const floorPct = Number(orderService.CASH_FLOOR_PCT) || 0;
  const list = Array.isArray(items) ? items : [];
  const cash = summary?.cash || null;
  const byCurrency = {};
  for (const cur of CAPACITY_CURRENCIES) {
    const slot = cash ? cash[cur.toLowerCase()] : null;
    const amount = Number(slot?.amount);
    if (!slot || !Number.isFinite(amount)) {
      byCurrency[cur] = { state: 'unknown', cash: null, floor: null, available: null, minPrice: null };
      continue;
    }
    const sameCur = list.filter((it) => String(it?.currency || '').toUpperCase() === cur);
    // 🔴 `orderService` 와 **같은 식**이다(평가액 = 현금 + 그 통화 보유 평가금액)
    const holdingsVal = sameCur.reduce((s, it) => s + (Number(it?.marketValue) || 0), 0);
    const floor = (amount + holdingsVal) * (floorPct / 100);
    const available = amount - floor;
    const prices = sameCur.map((it) => Number(it?.lastPrice)).filter((v) => Number.isFinite(v) && v > 0);
    // ⚠️ 보유가 없는 통화는 참조가가 **없다** — 그러면 가격 축으로는 판정하지 않는다
    const minPrice = prices.length ? Math.min(...prices) : null;
    let state = 'ok';
    if (!(available > 0)) state = 'floor-exhausted';
    else if (minPrice != null && available < minPrice) state = 'below-min-price';
    byCurrency[cur] = { state, cash: amount, floor, available, minPrice };
  }
  const states = CAPACITY_CURRENCIES.map((c) => byCurrency[c].state);
  const state = states.includes('ok') ? 'ok'
    : states.includes('unknown') ? 'unknown'
      : 'blocked';
  return { state, byCurrency, floorPct };
}

/**
 * 감시 종목 보고 문턱·표시 개수.
 *
 * ⚠️ `analystTrigger` 의 `MIN_MOVE_PCT`(1.5)와 **값은 같지만 같은 상수가 아니다** — 저쪽은
 *    *"LLM 을 깨울 만한가"*(z≥2 AND |등락|≥1.5)이고 이쪽은 *"브리핑에 한 줄 적을 만한가"* 다.
 *    질문이 다르니 **따로 조절되어야** 한다(트리거를 둔감하게 바꿔도 보고는 그대로여야 한다).
 *    ★ 그래서 복제가 아니다 — 복제였다면 상수를 공개해 한 벌로 묶는 것이 맞다.
 */
const WATCH_REPORT_MIN_PCT = Math.max(0, Number(process.env.ANALYST_WATCH_REPORT_MIN_PCT ?? 1.5));
const WATCH_REPORT_TOP_N = Math.max(1, Number(process.env.ANALYST_WATCH_REPORT_TOP_N ?? 8));

const WATCH_ROLE_LABEL = { reentry: '되살후보', targeted: '목표지정', watch: '감시', held: '보유' };

/**
 * 🔴 **감시 종목 41개를 지켜보면서 판단에는 0개가 들어가고 있었다** (2026-10-01)
 *
 * `alertService.collectMomentumRows()` 가 5분마다 유니버스 **전체**의 등락·분포를 계산하는데,
 * 그 rows 는 `trigger.decide()` 에만 쓰이고 **프롬프트로는 안 갔다.** 정기 회차의 `reasons` 에는
 * 스케줄 사유 하나뿐이라 `## 되살/신규 진입 후보` 절(`kind==='momentum'` 만 읽는다)은 **항상 비었다.**
 * ⇒ 모델이 보는 종목 = 보유 2 + 후보 2 = **4개**. 실측 당일 |3%| 이상이 6종이었는데 **한 줄도** 안 실렸다.
 * 이 저장소가 반복해 밟은 ***"수집해 놓고 안 쓰는"*** 자리다.
 *
 * ⚠️ **절을 통째로 빼지 않는다.** 움직임이 없으면 *"특이 움직임 없음"* 이라고 **쓴다** —
 *    *"조용했다"* 와 *"안 봤다"* 가 같아 보이면 안 된다(이 저장소가 제일 비싸게 배운 것).
 *    그래서 rows 를 **못 받은 경우**는 조용한 경우와 **다른 문장**을 낸다.
 * ⚠️ **추가 조회 0건** — 캔들·평가를 붙이면 회차당 수십 번의 외부 호출이 된다. 이미 받은 값만 쓴다.
 * ⚠️ 보유 종목은 **뺀다** — `## 보유 종목` 절이 같은 등락을 더 자세히 싣는다(중복은 예산 낭비다).
 *
 * @param {Array|null|undefined} rows `collectMomentumRows()` 의 결과. **없는 것과 빈 것은 다르다.**
 * @param {{heldSet?:Set<string>, nameOf?:(s:string)=>string|null, zOf?:(row:object)=>number|null}} opts
 */
function watchMovesSection(rows, { heldSet = new Set(), nameOf = () => null, zOf = () => null } = {}) {
  const HEAD = '## 감시 종목 오늘의 움직임 (보유 밖 · **보고 대상**)';
  const RULE = [
    '🔴 **이 종목들은 제안 대상이 아니다.** 매수 제안의 티커는 위 "## 도구상자" 안에서만 고른다(기존 규칙 그대로).',
    '   이 절의 쓰임은 **"오늘 무슨 일이 있었나"** 를 `marketView`·`momentumRead` 에 반영하는 것이다.',
    '   ⚠️ 여기 티커로 매매를 제안하면 계좌·게이트 검증에서 **전부 거부**된다 — 지금보다 나빠진다.',
  ];
  if (!Array.isArray(rows)) {
    /**
     * 🔴 **"안 봤다" 를 "조용했다" 로 보이게 하지 않는다.** 분석이 트리거 밖(수동·크론)에서
     *    돌면 rows 가 없다 — 그때 절을 빼면 모델도 사람도 *"감시 종목이 잠잠했다"* 로 읽는다.
     */
    return [HEAD, '⚠️ 이번 회차는 감시 종목 움직임을 **받지 못했습니다**(트리거 밖 실행).',
      '   이 침묵은 *"조용했다"* 가 아니라 ***"안 봤다"*** 입니다 — 감시 종목에 대해 아무 말도 하지 마세요.'].join('\n');
  }
  const pool = rows.filter((r) => r && r.symbol && !heldSet.has(String(r.symbol).toUpperCase()));
  const movers = pool
    .filter((r) => Math.abs(Number(r.dailyChangePct)) >= WATCH_REPORT_MIN_PCT)
    .sort((a, b) => Math.abs(Number(b.dailyChangePct)) - Math.abs(Number(a.dailyChangePct)));
  if (!movers.length) {
    return [HEAD, `오늘 특이 움직임 없음 — 감시 ${pool.length}종 전부 |${WATCH_REPORT_MIN_PCT}%| 미만입니다(조회는 **했습니다**).`].join('\n');
  }
  const shown = movers.slice(0, WATCH_REPORT_TOP_N);
  const out = [HEAD];
  for (const r of shown) {
    const pct = Number(r.dailyChangePct);
    const z = zOf(r);
    const name = nameOf(r.symbol);
    out.push(`- ${r.symbol}${name ? `(${name})` : ''} ${pct > 0 ? '+' : ''}${pct}%`
      // ⚠️ z 는 **못 구할 수 있다**(표본 10일 미만·σ=0). 그때 0 으로 적으면 "평범하다" 는 거짓 판정이 된다
      + ` · ${Number.isFinite(z) ? `${z.toFixed(1)}σ` : 'σ 판정불가'}`
      + ` · ${WATCH_ROLE_LABEL[r.role] || r.role || '-'}`);
  }
  // 🔴 **조용히 자르지 않는다** — 자른 사실 자체를 적는다(안 적으면 8종이 전부인 줄 안다)
  out.push(`(감시 ${pool.length}종 중 |${WATCH_REPORT_MIN_PCT}%| 이상 ${movers.length}종`
    + `${movers.length > shown.length ? ` — 변동 큰 ${shown.length}종만 표시, 나머지 ${movers.length - shown.length}종 생략` : ''})`);
  out.push(...RULE);
  return out.join('\n');
}

/**
 * 통화별 매수 여력을 **구간 이름**으로 — 로그에 금액 대신 들어가는 값.
 * ⚠️ 판정을 다시 하지 않고 `assessBuyingCapacity` 의 state 를 **옮기기만** 한다.
 *    여기서 다시 계산하면 로그와 브리핑이 어긋날 수 있다(판정은 한 곳이어야 한다).
 */
function capacityBand(d) {
  switch (d?.state) {
    case 'floor-exhausted': return 'none';
    case 'below-min-price': return 'under_one_share';
    case 'ok': return 'ok';
    default: return 'unknown';
  }
}

/** 사람이 읽는 한 줄 — **숫자를 적는다**("부족하다" 만으로는 소급 확인이 안 된다) */
function capacityDetail(byCurrency) {
  return CAPACITY_CURRENCIES.map((cur) => {
    const d = byCurrency?.[cur];
    if (!d || d.state === 'unknown') return `${cur} 확인 못 함`;
    const dp = cur === 'KRW' ? 0 : 2;
    const avail = Math.max(0, d.available).toFixed(dp);
    return `${cur} 매수가능 ${avail}(현금 ${d.cash.toFixed(dp)} − 버퍼 ${Math.max(0, d.floor).toFixed(dp)})`;
  }).join(' · ');
}

/**
 * 🔴 **제안 0건의 이유를 한 줄로** — 이 한 줄이 이 변경의 핵심이다.
 *    지금까지는 침묵이라 사용자가 "정상(살 게 없었다)" 과 "고장(살 수가 없다)" 을 구분할 수 없었다.
 * ⚠️ 매수 여력 판정은 **매수에만** 걸린다 — 현금이 0 이어도 **매도 제안은 가능하다**.
 *    그래서 문구를 "제안 불가" 가 아니라 "**신규 매수** 불가" 로 적는다.
 */
function describeNoProposal(reason, capacity, { proposed = 0, rejected = [] } = {}) {
  const detail = capacityDetail(capacity?.byCurrency);
  switch (reason) {
    case 'no_buying_capacity':
      return `현금 부족 — 버퍼(평가액의 ${capacity.floorPct}%)를 빼면 신규 매수에 쓸 돈이 남지 않습니다`
        + ` (${detail}). 가장 싼 보유 종목 1주도 살 수 없는 상태입니다.`;
    case 'cash_unknown':
      return `현금을 확인하지 못했습니다 (${detail}) — 매수 수량의 근거가 없어 제안을 만들 수 없습니다.`;
    case 'all_rejected': {
      const why = [...new Set(rejected.map((r) => r?.error).filter(Boolean))].slice(0, 3);
      return `모델이 ${proposed}건을 냈지만 **전부 거부**됐습니다${why.length ? ` — ${why.join(' / ')}` : ''}`;
    }
    case 'model_proposed_none':
    default:
      return `현금 여력은 있으나 (${detail}) 모델이 제안을 내지 않았습니다 — 판단이 "지금은 아니다" 였습니다.`;
  }
}

/**
 * @param {object} opts
 * @param {boolean} [opts.dryRun] 🔴 **부작용 없이** 분석만 한다 — 텔레그램 발송도, 제안 생성도 안 한다.
 *   pm2: *"검증이 곧 발송이다. 칠 때마다 사용자가 알림을 받는다."* 맞는 지적이고,
 *   **검증할 수 없는 경로는 결국 검증 안 된 채로 배포된다.**
 *   ⚠️ `lastSentDigest` 도 **건드리지 않는다** — 점검이 다음 진짜 발송을 삼키면 안 된다.
 */
/**
 * 🔴 **현재 비중을 계산해서 준다** (2026-10-02 사용자 지적:
 *    *"각 시황 판정에 따른 포트폴리오 리밸런싱, 강화가 처리되고 있는지?"*)
 *
 * 답은 **아니오**였다. 국면마다 `modelPortfolio`(기준 배분)를 프롬프트에 **문자열로**
 * 싣고 있었지만, **현재 비중을 계산하는 코드가 0줄**이었다 — 모델에게
 * *"공격 축 40~60%"* 라고 말하면서 **지금이 몇 %인지는 안 알려줬다.**
 * 괴리를 모르면 리밸런싱 제안은 원리상 나올 수 없다. "나침반이지 울타리가 아니다" 라고
 * 적어 뒀지만 **나침반 노릇도 못 하고 있었다.**
 *
 * ⚠️ 현금을 분모에 넣는다 — 주식만으로 비중을 내면 현금 100% 일 때 비중이 정의되지 않고,
 *    "현금 비중" 이라는 축 자체가 사라진다.
 * ⚠️ 카테고리 매핑은 **카탈로그 한 벌**에서 온다(두 벌이면 갈라진다).
 */
function portfolioWeights(items = [], summary = null, catalog = null) {
  const symCat = new Map();
  for (const [key, c] of Object.entries(catalog?.categories || {})) {
    for (const e of c.etfs || []) if (!symCat.has(e.symbol)) symCat.set(e.symbol, key);
  }
  const rows = (items || []).map((h) => ({
    symbol: String(h.symbol || '').toUpperCase(),
    value: Number(h.marketValue) || (Number(h.quantity) * Number(h.lastPrice)) || 0,
    category: symCat.get(String(h.symbol || '').toUpperCase()) || null,
    leverage: Number(h.leverageFactor) || 1,
  })).filter((r) => r.value > 0);

  const cashUsd = Number(summary?.cash?.usd?.amount) || 0;
  const fx = Number(summary?.fx?.rate) || 0;
  const cashKrwRaw = Number(summary?.cash?.krw?.amount) || 0;
  // ⚠️ 통화가 섞이면 비중이 거짓말한다 — 환율이 없으면 원화 현금을 **빼지 않고 모른다고 적는다**
  const cashUsdEq = cashUsd + (fx > 0 ? cashKrwRaw / fx : 0);
  const stock = rows.reduce((a, r) => a + r.value, 0);
  const total = stock + cashUsdEq;
  if (!(total > 0)) return null;

  const pct = (v) => Math.round((v / total) * 1000) / 10;
  const byCategory = new Map();
  for (const r of rows) {
    const k = r.category || '미분류';
    byCategory.set(k, (byCategory.get(k) || 0) + r.value);
  }
  const levValue = rows.filter((r) => r.leverage > 1).reduce((a, r) => a + r.value, 0);
  return {
    total,
    cashPct: pct(cashUsdEq),
    krwCashUnconverted: fx > 0 ? 0 : cashKrwRaw,
    leveragePct: pct(levValue),
    holdings: rows.map((r) => ({ symbol: r.symbol, pct: pct(r.value), category: r.category, leverage: r.leverage }))
      .sort((a, b) => b.pct - a.pct),
    categories: [...byCategory.entries()].map(([k, v]) => ({ key: k, pct: pct(v) })).sort((a, b) => b.pct - a.pct),
  };
}

async function analyze(dash, { userInstruction = '', useWebSearch = true, fx = null, dryRun = false, trigger = null } = {}) {
  const items = dash?.portfolio?.items || [];
  const summary = dash?.portfolio?.summary || null;

  /**
   * 웹 검색(my-computer MCP). 🔴 **검색어에 수량·금액을 싣지 않는다** — 종목명·티커만 넘긴다.
   * ⚠️ 실패해도 리포트는 난다. 검색은 곁가지이지 본체가 아니다.
   */
  /**
   * 🔴 **브리핑 대상 시장을 웹 검색보다 **먼저** 구한다** (2026-09-22).
   *    사용자 지시: *"국장도 국장 관련 종합적인 웹 검색 및 종목 없으면 전반적인 시황 브리핑"*.
   *    보유가 없는 시장은 종목 질의가 **하나도 안 만들어져** 검색이 통째로 비어 있었다.
   */
  /**
   * 🔴 **`preopen` 이 빠져 있었다** (2026-09-28 실사고 — 프리장·장중 브리핑 2회 연속
   *    "대상 시장: … 판단하라" 지시가 통째로 안 실렸다). 회차 종류 열거가 `BRIEF_JOB`·
   *    `SCHEDULED`·여기 셋으로 흩어져 있고 이 자리만 갱신을 놓쳤다. ⇒ `tests/analystBriefKinds.test.js`
   *    가 세 열거를 소스에서 직접 대조해 어긋나면 빨간불을 낸다(손으로 맞추는 한 또 어긋난다).
   */
  const BRIEF_KINDS = new Set(['preopen', 'open', 'mid', 'close']);
  const MARKET_NAME = { kr: '한국 증시(코스피·코스닥)', us: '미국 증시(S&P500·나스닥)' };
  const briefMarkets = [...new Set((trigger?.reasons || [])
    .filter((r) => BRIEF_KINDS.has(r?.kind) && MARKET_NAME[r?.key])
    .map((r) => r.key))];
  /** 그 시장에 보유·감시 종목이 하나도 없으면 **시장 자체**를 검색 주제로 넣는다 */
  /**
   * 🔴 시장 주제 표식은 **전용 필드(isMarket)** 다 (2026-09-24 인수 검증에서 발견) —
   *    종전엔 `market` 필드로 갈랐는데 **보유 items 에도 market('US'/'KR')이 있어서**
   *    09-22 부터 모든 종목 질의가 "QLD 증시 마감 시황" 꼴 시장 질의로 나가고 있었다.
   *    (officialName 우선도 그래서 한 번도 안 탔다 — 분기가 먼저 걸렸다.)
   */
  const marketSubjects = briefMarkets
    .filter((m) => !items.some((i) => (m === 'kr') === (String(i.market).toUpperCase() === 'KR')))
    .map((m) => ({ symbol: m.toUpperCase(), name: MARKET_NAME[m], isMarket: true }));

  let web = null;
  if (useWebSearch) {
    // ⚠️ **일부러 통째로 넘긴다.** 걸러서 넘기면 가드가 호출부에 있는 셈이고,
    //    다음 사람이 이 줄을 고치는 순간 조용히 뚫린다. `buildQuery` 가 두 칸만 읽는다.
    // ⚠️ 시장 주제를 **앞에** 둔다 — `maxSubjects` 로 잘릴 때 종목보다 시황이 먼저 살아남게
    web = await mcp.searchMarketNews([...marketSubjects, ...items]);
    /**
     * ⚠️ **`null` 도 받는다** (2026-10-02). 종전엔 `web.ok` 라 검색 모듈이 null 을 내면
     *    **브리핑이 통째로 죽는다.** 검색은 곁가지인데 본체를 끌고 내려가면 안 된다.
     */
    if (!web?.ok) logWarn('analyst.web_unavailable', { kind: web?.kind || 'null', error: web?.error || '검색 결과 객체가 없다' });
  }

  /**
   * 🔴 **종목 평가를 도구처럼 내부 호출한다** (2026-09-21 사용자 지시).
   *    *"해당 대상을 도구처럼 호출해서 내부 호출 평가 해서 상세하게 점수 계층화 처리 후
   *      판정이 가능하도록 구성. **모든건 매수/매도가 최종 목표**임."*
   *
   * ⇒ 각 보유 종목을 10항목 100점으로 평가하고, 그 **점수·투자의견을 매매 판단의 입력**으로 준다.
   * ⚠️ 평가는 LLM 을 한 번씩 더 쓴다 — **보유 종목만**, 그리고 **실패해도 리포트는 난다.**
   * ⚠️ 한국 종목은 야후 티커가 `005930.KS` 다. 토스 코드 그대로 넣으면 404 다.
   */
  const ratings = {};
  for (const it of items.slice(0, 6)) {
    const ysym = it.market === 'KR' && /^\d{6}$/.test(it.symbol) ? `${it.symbol}.KS` : it.symbol;
    try {
      // ⚠️ 리포트는 **점수만** 필요하다. 서술 보충은 종목당 35초라 자동 분석을 못 쓰게 만든다
      //    (pm2 실측: 2종목이면 +84초). 서술은 사용자가 상세를 펼칠 때 `/api/rate` 가 받아온다.
      ratings[it.symbol] = await rating.rate(ysym, { withProse: false });
    } catch (e) {
      // 조용히 넘기지 않는다 — 평가 없이 판단했다는 사실이 리포트에 남아야 한다
      logWarn('analyst.rating_failed', { symbol: it.symbol, ysym, kind: e.kind, message: e.message });
      ratings[it.symbol] = { error: e.message, kind: e.kind || 'unknown' };
    }
  }

  /**
   * 🔴 **수집해 놓고 안 쓰던 둘을 배선한다** (2026-09-22 — 사용자 *"데이터 좀 개선해봐"*).
   *
   * ⚠️ **처음에 "만들어 놓고 한 번도 안 불렀다" 고 적었는데 틀렸다**(pm2 가 로그로 반박했고 맞았다).
   *    `getWarnings` 는 **alertService·dashboardService·analystChat 세 곳에서 불린다.**
   *    나는 `analystService.js` **한 파일만 grep 하고** 저장소 전체로 결론을 냈다 — *본 범위를 전체로 착각*.
   * ⇒ 정확한 사실: 경고는 **알림·화면·채팅에는 닿고 있었지만, 매수·매도 판단을 내리는
   *    이 리포트 경로에는 한 번도 안 들어왔다.** 그래서 점수는 높은데 정리매매인 종목을
   *    **거를 방법이 없었다.** 구멍은 실재했고 **내가 범위를 과장한 것**이다.
   * `getShortSelling` 은 호출부가 **정말로 0개**였다(전수 확인).
   *
   * ★ `warnings` 는 **안전 축**이다 — 정리매매·거래정지·단기과열·투자경고·VI.
   *   이걸 안 보면 **정리매매 종목을 사라고 할 수 있다.** 점수가 높아도 사면 안 되는 종목이 있다.
   * ⚠️ `short-selling` 은 **KR 전용**(명세). US 에 부르면 낭비다.
   * ⚠️ 한 종목이 실패해도 나머지는 간다 — 그리고 **실패를 조용히 넘기지 않는다**(gaps 에 남는다).
   */
  /**
   * 🔴 **국장 시황은 "누가 샀나" 가 있어야 쓸 수 있다** (2026-09-22).
   *    지수 등락률만 주면 모델은 *"코스피가 올랐습니다"* 밖에 못 쓴다 —
   *    그건 사용자가 이미 아는 것이고, **브리핑이 아니라 중계**다.
   * ⚠️ 국장 브리핑일 때만 부른다(한도 그룹 `MARKET_INDICATOR`, 종목 조회와 다른 통).
   */
  const indexFlow = {};
  const indexTech = {};
  /**
   * 지수 **현재가** (2026-09-23, 명세 배선 마감) — 캔들의 last 는 마지막 봉이라
   * 장중에는 뒤처진다. 현재가·등락은 이 API 가 실시간으로 준다(200개 1콜).
   * ⚠️ 심볼 카탈로그에 있는 것만 — 없는 심볼은 실측으로 확인해 목록을 좁힌다.
   */
  const indexNow = {};
  {
    /**
     * ⚠️ **KR 지수만** — US 는 카탈로그에 없다(2026-09-23 실측: SPX·NDX·DJI·IXIC·GSPC·
     *    NASDAQ·SP500·DOW 전부 400. KOSPI·KOSDAQ 만 200). US 지수 위치는 QLD 캔들이 대신한다.
     */
    const want = briefMarkets.includes('kr') ? ['KOSPI', 'KOSDAQ'] : [];
    if (want.length) {
      try {
        for (const r of await toss.getIndexPrices(want)) {
          if (r?.symbol) indexNow[r.symbol] = r;
        }
      } catch (e) {
        logWarn('analyst.index_prices_failed', { kind: e.kind, message: e.message });
      }
    }
  }
  if (briefMarkets.includes('kr')) {
    for (const idx of ['KOSPI', 'KOSDAQ']) {
      try {
        const rows = await toss.getIndexInvestorTrading(idx, { interval: '1d', count: 3 });
        if (rows.length) indexFlow[idx] = rows;
      } catch (e) {
        logWarn('analyst.index_flow_failed', { index: idx, kind: e.kind, message: e.message });
      }
      /**
       * 🔴 **지수 캔들** (2026-09-22 — 명세에 있는데 안 쓰던 것 정비).
       *    수급(누가 샀나)만 있고 **추세(어디에 서 있나)** 가 없으면 시황이 반쪽이다.
       *    보유 종목에 쓰는 `summarizeCandles`(20·60일선 등)를 지수에 그대로 재사용한다 —
       *    자를 새로 만들지 않는다(같은 판정 함수를 쓴다).
       */
      try {
        const c = await toss.getIndexCandles(idx, { interval: '1d', count: 120 });
        const t = summarizeCandles(c.rows || []);
        if (t) indexTech[idx] = t;
      } catch (e) {
        logWarn('analyst.index_candles_failed', { index: idx, kind: e.kind, message: e.message });
      }
    }
  }

  const warnings = {};
  const supply = {};
  for (const it of items.slice(0, 6)) {
    const isKr = String(it.market).toUpperCase() === 'KR';
    try {
      const w = await toss.getWarnings(it.symbol);
      const list = Array.isArray(w) ? w : (w?.warnings || w?.records || []);
      if (list.length) warnings[it.symbol] = list;
    } catch (e) {
      logWarn('analyst.warnings_failed', { symbol: it.symbol, kind: e.kind, message: e.message });
      warnings[it.symbol] = { error: e.message };
    }
    if (!isKr) continue; // 아래 넷은 전부 **국내 전용**이다(명세)
    /**
     * 🔴 KR 수급 4종 세트 (2026-09-22 확장 — 신용·프로그램·대차가 명세에 있는데 안 쓰고 있었다).
     *    공매도만으로는 반쪽이다: 공매도(하방 베팅) ↔ 대차잔고(그 탄약) ↔ 신용융자(레버리지 매수)
     *    ↔ 프로그램(기관 바스켓). 넷이 함께 있어야 "누가 어느 방향으로 기울었나" 가 읽힌다.
     * ⚠️ 한 축이 실패해도 나머지는 싣는다 · 전부 STOCK_TRADING_TREND 그룹(실측 10/s — 여유 있다).
     */
    const kr = { short: null, credit: null, program: null, lending: null };
    const pulls = [
      ['short', () => toss.getShortSelling(it.symbol)],
      ['credit', () => toss.getCreditTrades(it.symbol, { count: 3 })],
      ['program', () => toss.getProgramTrades(it.symbol, { count: 3 })],
      ['lending', () => toss.getSecuritiesLending(it.symbol, { count: 3 })],
    ];
    for (const [key, fn] of pulls) {
      try {
        const rows = await fn();
        if (rows.length) kr[key] = rows.slice(0, 5);
      } catch (e) {
        logWarn('analyst.kr_supply_failed', { symbol: it.symbol, axis: key, kind: e.kind, message: e.message });
      }
    }
    if (kr.short || kr.credit || kr.program || kr.lending) supply[it.symbol] = kr;
  }

  /**
   * 🔴 **호가(최우선 매수/매도)** (2026-09-22 — `getOrderbook` 이 만들어져 있었는데 소비 0).
   *    지정가 제안의 근거가 **어제 종가·지표**뿐이면 모델이 스프레드 밖 가격을 부른다.
   *    최우선 호가를 주면 "지금 시장이 서 있는 자리" 를 알고 값을 정한다.
   * ⚠️ 장이 닫혀 있으면 비어 있을 수 있다 — 그때는 싣지 않는다(빈 호가를 0 으로 읽게 하지 않는다).
   */
  const books = {};
  for (const it of items.slice(0, 6)) {
    try {
      const ob = await toss.getOrderbook(it.symbol);
      const bestAsk = ob.asks?.[0]; const bestBid = ob.bids?.[0];
      if (bestAsk?.price || bestBid?.price) books[it.symbol] = { ask: bestAsk || null, bid: bestBid || null, at: ob.at };
    } catch (e) {
      logWarn('analyst.orderbook_failed', { symbol: it.symbol, kind: e.kind, message: e.message });
    }
  }

  // 보유 종목의 일봉을 모은다 — **계산으로 확인되는 값만** 프롬프트에 싣는다
  const tech = {};
  for (const it of items.slice(0, 8)) {
    try {
      const c = await toss.getCandles(it.symbol, { interval: '1d', count: 120 });
      const s = summarizeCandles(c.rows);
      if (s) tech[it.symbol] = s;
    } catch (e) {
      logWarn('analyst.candles_failed', { symbol: it.symbol, kind: e?.kind, message: e?.message });
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  /**
   * 🔴 **매수 여력을 프롬프트보다 먼저 판정한다** (2026-10-01) — 아래 `## 계좌` 절과
   *    브리핑 본문·`analyst.no_proposal_reason` 로그가 **같은 한 판정**을 쓴다.
   *    세 곳에서 각자 계산하면 하나가 어긋난 채 "채워진 척" 한다.
   */
  const capacity = assessBuyingCapacity(summary, items);

  const lines = [];
  lines.push('## 계좌');
  if (summary) {
    lines.push(
      /**
       * 🔴 **두 수익률이 다르면 둘 다 보여준다** (2026-10-01).
       *    증권사가 준 `profitRate` 가 자기 금액과 일관되게 어긋난다(실측 약 8%p, 오늘은
       *    **부호까지** 반대: 금액 +$220 인데 rate −8.7%). 의미를 모르니 덮어쓰지 않고
       *    **금액에서 유도한 값**을 함께 준다 — 안 주면 모델이 **스스로 다시 계산**하고
       *    (10-01 에 실제로 그랬다) 사용자는 화면과 답이 다른 것을 보게 된다.
       * ⚠️ 어느 쪽이 "맞다" 고 단정하지 않는다 — **다르다는 사실**을 모델에게 넘긴다.
       */
      summary.profitRateDerived != null && summary.profitRate != null
        && Math.abs(summary.profitRateDerived - summary.profitRate) > 0.5
        ? `평가 ${fmt(summary.value?.krw, 0)}원(환산) · 당일 ${fmt(summary.dailyRate)}%`
          + `\n⚠️ 평가손익률이 두 값으로 온다 — 증권사 보고 ${fmt(summary.profitRate)}% ·`
          + ` **보유 금액에서 계산하면 ${fmt(summary.profitRateDerived)}%**`
          + `(평가 ${fmt(summary.value?.usd)} − 매입 ${fmt(summary.purchase?.usd)}).`
          + ' 금액과 일관된 쪽은 계산값이다 — 그쪽을 쓰고, 다르다는 사실도 한 번 짚어라.'
        : `평가 ${fmt(summary.value?.krw, 0)}원(환산) · 평가손익률 ${fmt(summary.profitRate)}% · 당일 ${fmt(summary.dailyRate)}%`
    );
    /**
     * 🔴 **현금을 준다** (2026-09-22). 종전엔 프롬프트가 *"현금 여력을 넘지 않게"* 라고
     *    지시하면서 **현금 데이터를 안 줬다** — 지킬 수 없는 규칙을 요구한 것이다.
     * ⚠️ 못 받은 통화는 **"확인 못 함"** 이라고 쓴다. 빈칸으로 두면 모델이 0 으로 읽는다.
     */
    const c = summary.cash;
    if (c) {
      const part = (cur, v) => (v ? `${cur} ${v.raw}` : `${cur} 확인 못 함`);
      lines.push(`현금(매수 가능): ${part('원화', c.krw)} · ${part('달러', c.usd)}`);
      /**
       * 🔴 **종전 판정이 실제 상태를 못 잡았다** (2026-10-01). 조건이 `krw<=0 && usd<=0`
       *    이라, 실측 **USD 3.76**(> 0)에서 **한 번도 안 걸렸다** — 3.76 달러로는 아무것도
       *    못 사는데 프롬프트는 "현금 있음" 으로 보였다. ⇒ 판정을 **버퍼 차감 후 잔액**으로
       *    옮긴다(`assessBuyingCapacity`). 0 과의 비교가 아니라 **살 수 있는가**가 질문이다.
       *
       * ⚠️ **지시가 아니라 사실을 준다.** "사지 마라" 는 판단을 왜곡하지만 "살 수 없다" 는
       *    제약이다. 제약을 알아야 모델이 남은 선택지(매도·보유)에 집중한다 —
       *    사실을 숨기고 금지만 걸면 모델은 왜 금지인지 모른 채 서술을 지어낸다.
       */
      if (capacity.state === 'blocked') {
        lines.push(
          `🔴 **지금 신규 매수는 불가능합니다(사실).** 현금 버퍼(평가액의 ${capacity.floorPct}%)를 빼면`
          + ` 매수에 쓸 수 있는 돈이 남지 않습니다 — ${capacityDetail(capacity.byCurrency)}.`,
          '   가장 싼 보유 종목 1주조차 체결될 수 없습니다. 이것은 금지 지시가 아니라 **계좌의 상태**입니다.',
          '   ⇒ **매도·보유 판단에 집중**하세요. 매수 아이디어는 수량·가격 제안 대신 "현금이 생기면" 조건으로 적으세요.',
        );
      } else if (c.failed?.length) {
        lines.push(`⚠️ ${c.failed.join('·')} 현금을 못 받았습니다 — **매수 수량의 근거가 없으니 제안하지 마세요.**`);
      }
    } else {
      lines.push('⚠️ 현금 정보를 받지 못했습니다 — **매수 제안을 내지 마세요**(수량 근거가 없습니다).');
    }
  } else {
    lines.push('보유 정보를 받지 못했습니다.');
  }

  /**
   * 🔴 종목 정체를 먼저 깐다 (2026-09-22) — 이름이 "RAM" 뿐이면 모델이 레버리지 여부를
   *    회차마다 지어낸다(17시 "2배 리밸런싱" ↔ 21시 "일반 종목" — 정반대). 판단의 전제다.
   */
  const identity = stockIdentity.sectionFromItems(items);
  if (identity) lines.push('', identity);

  /**
   * ⚠️ **사용자 보유 방침 절은 제거됐다** (2026-10-02 사용자 지시: *"holding-policy 이거 없애.
   *    제한 걸지말고 냉철하게 공격적 포트폴리오 관점에서 구성해야해."*).
   *    종전에는 `config/holding-policy.json` 이 프롬프트 문구와 코드 게이트를 함께 먹였다.
   * 🔴 **되돌린 이유를 적어 둔다** — 안 적으면 다음 세션이 *"방침 게이트를 넣으면 되겠네"*
   *    를 또 한다. 그 장치는 10-01 에 만들어 10-02 에 사용자가 뺐다. 판단은 사람이 한다.
   */
  /**
   * 🔴 **사용자가 채팅에서 한 말을 브리핑이 읽는다** (2026-10-02 사용자 지적:
   *    *"텔래그램 얘기하면 브리핑 애널리스트가 그걸 듣고 … 처리하는지?"*)
   *
   * 답은 **아니오**였다 — 브리핑(`analystService`)과 채팅(`analystChat`)은 **완전히 분리**돼
   * 있었고, 브리핑이 채팅 이력을 읽는 코드가 **0줄**이었다. 그래서 사용자가 17:30 에
   * *"나 리얼티인컴도 이제 1주씩 살건데"* 라고 말했는데, 01:47·05:03 브리핑이 그걸 모른 채
   * **O 매도 제안을 두 번** 냈다(둘 다 거절). 두 에이전트가 같은 계좌를 보면서 **서로
   * 다른 전제**로 움직인 것이다.
   *
   * ⚠️ **사용자 발화만** 싣는다 — 모델의 과거 답변은 그 시점 데이터라 낡았고(10-02 에
   *    이미 겪었다), `[도구 결과]` 는 휘발성이다. 사용자가 **자기 입으로 한 말**만이
   *    시간이 지나도 유효한 의사다.
   * ⚠️ 창을 둔다 — 두 달 전 "사겠다" 를 오늘의 방침으로 읽으면 안 된다.
   */
  try {
    const chat = require('./analystChat');
    const windowMs = Math.max(0, Number(process.env.ANALYST_USER_VOICE_DAYS || 7)) * 24 * 3600_000;
    const cutoff = Date.now() - windowMs;
    const said = (chat.readHistory({ limit: 200 }) || [])
      .filter((h) => h.role === 'user' && Date.parse(h.at) >= cutoff)
      .slice(-10)
      .map((h) => `- [${String(h.at).slice(5, 16).replace('T', ' ')}] ${String(h.text || '').slice(0, 200)}`);
    if (said.length) {
      lines.push('', '## 사용자가 최근에 직접 한 말 (의사·방침 — 판단보다 우선한다)');
      lines.push(...said);
      lines.push('🔴 여기에 **적립·보유 의사**가 있으면 그 종목의 매도 제안은 근거가 "가격이 내렸다"'
        + ' 보다 강해야 한다(배당 삭감·신용등급 하락·사업 훼손 같은 **종목 자체의 변화**).');
      lines.push('🔴 여기서 사용자가 **방향을 바꿨으면**(예: "레버리지는 이제 안 하는 게 맞겠다")'
        + ' 그 뒤의 판단은 바뀐 방향을 따른다.');
    }
  } catch (e) {
    // ⚠️ 채팅 이력을 못 읽어도 브리핑은 돈다 — 다만 조용하지 않다
    logWarn('analyst.user_voice_unavailable', { message: e.message });
  }

  /**
   * 🔴 **현재 비중 vs 국면 기준선** — 괴리를 모르면 리밸런싱은 원리상 불가능하다.
   */
  /**
   * 🔴 **한 번만 계산해 함수 전체에서 쓴다** (2026-10-02). 처음엔 이 블록 안에서만 만들었는데,
   *    뒤에 오는 국면 블록이 그 값을 **못 봤다**(블록 스코프 + 순서 역전) — 레버리지 괴리
   *    계산이 `active is not defined` 로 **조용히 실패**하고 있었다. 테스트가 잡았다.
   */
  const weights = portfolioWeights(items, summary, require('./regimeService').readCatalog());
  {
    const w = weights;
    if (w) {
      lines.push('', '## 현재 비중 (현금 포함 · 코드 계산 — 이 숫자를 그대로 써라)');
      lines.push(`- 종목: ${w.holdings.map((h) => `${h.symbol} ${h.pct}%${h.leverage > 1 ? `(${h.leverage}배)` : ''}`).join(' · ')}`);
      lines.push(`- 카테고리: ${w.categories.map((c) => `${c.key} ${c.pct}%`).join(' · ')}`);
      lines.push(`- 현금 ${w.cashPct}% · 레버리지 합계 ${w.leveragePct}%`);
      if (w.krwCashUnconverted > 0) lines.push(`  ⚠️ 환율을 못 읽어 원화 현금 ${w.krwCashUnconverted} 은 분모에서 빠졌다 — 현금 비중은 실제보다 낮다`);
      lines.push('🔴 위 "## 발동된 매뉴얼" 의 **기준 배분과 이 숫자의 차이**가 리밸런싱 제안의 근거다.');
      lines.push('   기준선에서 크게 벗어난 축을 먼저 줄이고/늘려라. ⚠️ 기준선은 울타리가 아니라 나침반이다 —');
      lines.push('   추세·상대강도가 더 강하게 말하면 그쪽을 따르되, **왜 기준선을 벗어나는지 rationale 에 적어라.**');
    }
  }

  lines.push('', '## 보유 종목');
  for (const h of items) {
    const t = tech[h.symbol];
    lines.push(
      `- ${h.name}(${h.symbol}/${h.market}) 수량 ${h.quantity} · 평단 ${fmt(h.avgPrice)} · 현재 ${fmt(h.lastPrice)} ` +
        `· 평가손익 ${fmt(h.profitRate)}% · 당일 ${fmt(h.dailyRate)}%` +
        (t
          ? ` · 20일선 ${fmt(t.ma20)} · 60일선 ${fmt(t.ma60)}`
            + ` · ${t.bars}일 고점대비 ${fmt(t.fromHighPct)}% · 저점대비 ${fmt(t.fromLowPct)}%`
            + ` · 최근20일 스윙 ${fmt(t.swingLow)}~${fmt(t.swingHigh)}`
            + (t.volPct != null ? ` · 일간변동성 ${fmt(t.volPct)}%` : '')
            + (t.atrPct != null ? ` · 하루폭 ${fmt(t.atrPct)}%` : '')
          : ' · (일봉 없음)')
    );
  }

  /**
   * 🔴 **종목별 "쓸 수 있는 가격대" 를 못박는다** (2026-10-03 실측으로 추가).
   *
   * 밤새 4회차 **전부**에서 모델이 RAM(현재가 14.3)의 레벨을 **80~95 달러**로 썼다:
   * `"82달러까지 상승"` · `"95.76 이상 종가 시"` · `"90 하회 시"`.
   * 프롬프트를 뒤져 보니 그 숫자들이 **다른 종목 줄에 있었다** —
   * `QLD 20일선 92.75 · 60일선 90.15` · `XLP 80.53/82.62/84.37` · `SHY 81.045`.
   * ⇒ 모델이 **종목별로 숫자를 묶어 읽지 못하고** 이웃 줄의 값을 가져온다.
   * ★ 어제 *"QLD 시나리오가 SOXX 를 말한다"*(주제 이탈)와 같은 가족인데, 이번엔
   *   **종목명 없이 숫자만** 건너와서 `findSubjectDrift` 가 못 잡았다.
   *
   * ⚠️ 범위를 **좁게** 주면 정당한 돌파 목표를 죽인다(05:04 의 `16.00` 은 스윙 고점
   *    15.35 위지만 맞는 값이다). ⇒ 코드 가드와 **같은 기준**(`ENTRY_GAP_MAX_PCT`)을 쓴다.
   *    **프롬프트와 코드가 한 상수를 보므로 갈라질 수 없다.**
   */
  {
    const band = [];
    for (const h of items) {
      const t = tech[h.symbol];
      const px = Number(t?.last) || Number(h.lastPrice);
      if (!(px > 0)) continue;
      const lo = round2(px * (1 - ENTRY_GAP_MAX_PCT / 100));
      const hi = round2(px * (1 + ENTRY_GAP_MAX_PCT / 100));
      band.push(`- **${h.symbol}** : ${lo} ~ ${hi} (현재 ${round2(px)})`);
    }
    if (band.length) {
      lines.push('', `## 🔴 종목별 가격대 — 이 밖의 숫자는 **그 종목 가격이 아니다**`);
      lines.push(...band);
      lines.push(
        `각 종목의 \`entry\`·\`stop\`·\`target\` 과 시나리오 문장의 가격은 **그 종목 줄의 범위 안**이어야 합니다.`,
        '⚠️ 위·아래 다른 종목 줄의 숫자를 가져오지 마십시오 — 실제로 그런 일이 반복됐습니다.',
      );
    }
  }


  /**
   * 🔴 평가 결과를 **판단의 입력**으로 싣는다. 점수가 매매 결론으로 이어져야 한다 —
   *    사용자: *"모든건 매수/매도가 최종 목표임."*
   */
  const rated = Object.entries(ratings).filter(([, r]) => r && !r.error && r.total != null);
  if (rated.length) {
    lines.push('', '## 종목 계층 평가 (10항목 100점 · Yahoo Statistics 기준)');
    for (const [sym, r] of rated) {
      lines.push(
        `- ${r.name}(${sym}) — **${r.total}/100 · ${r.opinion}** · 유형 ${r.type} · 확신도 ${r.confidence}`
        + `\n    항목: ${r.items.map((x) => `${x.name} ${x.score}`).join(' / ')}`
        + (r.weaknesses ? `\n    약점: ${String(r.weaknesses).slice(0, 200)}` : '')
        + (r.unverified?.length ? `\n    확인 못 함: ${r.unverified.slice(0, 3).join(' · ')}` : '')
      );
    }
    lines.push(
      '',
      '🔴 위 **투자의견은 기업의 질**에 대한 것이고, 당신이 낼 것은 **지금 사고팔 것인가**다.',
      '둘이 갈릴 수 있다 — 좋은 회사인데 지금 비쌀 수 있고, 약한 회사인데 단기 반등 구간일 수 있다.',
      '**어긋나면 왜 어긋나는지 한 문장으로 밝히세요.**',
    );
  }
  /**
   * 🔴 **펀드 평가도 반드시 싣는다** — 총점이 없다고 빼면 "수집해 놓고 안 쓰는" 여덟 번째다.
   *
   * ETF 는 기업 채점을 하지 않으므로 `total` 이 `null` 인데, 위 필터가 `total != null` 이라
   * **조용히 빠졌다.** 사용자 보유 2종이 **둘 다 ETF** 라 그러면 판단 근거가 통째로 사라진다.
   * ⚠️ 레버리지·일일 리밸런싱은 매매 판단에 **직접적**이다(횡보장 가치 감쇠) — 맨 앞에 둔다.
   */
  const funds = Object.entries(ratings).filter(([, r]) => r && !r.error && r.isFund);
  if (funds.length) {
    lines.push('', '## 보유 ETF·펀드 (기업 채점 대상 아님 — 점수 없음)');
    for (const [sym, r] of funds) {
      // 🔴 평가가 잘려 r 이 비면 이 줄이 아니라 **분석 전체가 죽는다**(09-23 dryRun 실증: holdIt TypeError)
      if (!r || r.error) { lines.push(`- ${sym} — 평가를 받지 못했습니다(잘림/실패). 이 종목 평가는 근거로 쓰지 마세요.`); continue; }
      lines.push(
        `- ${r.name}(${sym}) — ${r.typeWhy}`
        + (r.holdIt ? ` · 보유 적합성 **${r.holdIt}**${r.holdWhy ? ` (${String(r.holdWhy).slice(0, 120)})` : ''}` : '')
        + (r.description ? `\n    추종: ${String(r.description).slice(0, 160)}` : '')
        + (r.weaknesses ? `\n    약점: ${String(r.weaknesses).slice(0, 160)}` : '')
        + (r.notes?.length ? `\n    ${r.notes.join('\n    ')}` : '')
      );
    }
    lines.push(
      '',
      '🔴 레버리지·일일 리밸런싱 상품은 **방향이 맞아도 횡보하면 깎입니다.**',
      '보유 기간과 손절선을 그 전제로 잡으세요. 기업 점수와 같은 잣대로 비교하지 마세요.',
    );
  }

  const failedRatings = Object.entries(ratings).filter(([, r]) => r?.error);
  if (failedRatings.length) {
    lines.push('', `⚠️ 평가하지 못한 종목: ${failedRatings.map(([s2]) => s2).join(', ')} — 질 평가 없이 판단해야 합니다.`);
  }

  /**
   * ⚠️ **위치가 중요하다** — 이 절은 `lines` 가 만들어진 **뒤에** 와야 한다.
   *    처음에 시세 조회 근처(위쪽)에 뒀다가 `Cannot access 'lines' before initialization` 로
   *    터졌다. 🔴 하필 **사용자가 요청한 되살 경로에서만** 터지는 자리였다 —
   *    보유 종목만 있는 회차에서는 이 블록을 건너뛰어 **조용히 통과**했다.
   *    자를 먼저 쓴 덕에 배포 전에 잡혔다.
   */
  /**
   * 🔴 **판 종목의 되살 자리도 본다** (2026-09-21 사용자 지적)
   *
   * *"매도한다고 판정한 경우 다음날이나 다음 매수 시점의 부분매수 진입 시점 같은 게
   * 애매할 거 같은데, **보유종목만 판정해버리면**."* — 맞다. 팔면 포트폴리오에서 사라지고
   * 그 순간 판단 대상에서도 빠져 **되살 자리를 영영 못 본다.**
   *
   * ⇒ 트리거가 `role:'reentry'`(최근까지 들고 있던 것) 또는 `'targeted'`(목표·손절 지정)로
   *    깨운 종목은 **다른 질문**으로 다룬다: *들고 있을 것인가* 가 아니라 **지금 되살 자리인가**.
   * ⚠️ 보유가 아니므로 **수량·평단이 없다** — 분할 매수 레벨을 물어야지 손익을 물으면 안 된다.
   */
  /**
   * 🔴 **브리핑 종류를 모델에게 말해 준다** (2026-09-22 — 정기 브리핑 6회 체계).
   *
   * 안 말해 주면 개장·장중·마감이 **전부 같은 글**이 된다. 사용자가 하루 6번 받는데
   * 내용이 구분되지 않으면 **셋째부터 안 읽는다**(그러면 진짜 소식도 같이 묻힌다).
   * ⚠️ 같은 데이터로 **다른 질문**에 답하게 하는 것이지, 데이터를 바꾸는 게 아니다.
   */
  const BRIEF_JOB = {
    preopen: '**프리장 개장 브리핑**이다. 밤사이 미국장 결과와 오늘 국내장 계획을 정리하라. '
      + '정규장 시작 전이라 **지금은 체결이 안 되는 시간대**임을 전제로, 개장 직후 대응안을 제시하라.',
    open: '**개장 브리핑**이다. 직전 세션(밤사이 해외장 포함)에서 넘어온 흐름과 **시가 갭**을 먼저 짚고, '
      + '오늘 이 종목들에서 **무엇을 지켜볼 것인지**를 말하라. 지금 당장의 매매보다 **관전 포인트**가 중심이다.',
    /**
     * 🔴 **stance 예시를 한국어로 주지 않는다** (2026-09-29, prompt-audit F1).
     *    종전 문구는 `같으면 "유지" 라고 분명히 말하라` 였다 — 프롬프트가 주는 **유일한 stance
     *    예시가 enum 밖 한국어**였고, 모델이 그대로 따르면 `STANCES`(:212)에 걸려 `asPosition`
     *    이 그 항목을 **통째로 버린다**(= positions 0). 정본은 스키마 enum 하나다.
     *    ⚠️ 이것이 09-28 12:17 `positions 0` 의 원인이라는 **단정은 하지 않았다** —
     *      09-29 08:04 `positions_short` 는 `"유지"` 가 없는 preopen 회차에서 났다.
     *      최초 0건은 다른 경로로도 난다. 여기서 고친 것은 **계약 불일치 하나**다.
     * ⚠️ "새 얘기를 만들지 마라" 는 **서술에만** 걸어야 한다 — 범위를 안 적으면
     *    구조화 필드(positions)까지 비우는 쪽으로 읽힌다(F2).
     */
    mid: '**장중 브리핑**이다. 개장 이후 흐름이 **개장 때 본 그림과 같은지 달라졌는지**를 먼저 말하라. '
      + '달라졌으면 무엇이 바뀌었는지 짚고, 그대로면 그대로라고 분명히 말하라(그 종목 stance 는 HOLD). '
      + '**바뀐 게 없으면 서술을 억지로 늘리지 마라** — 단 이것은 marketView·momentumRead 에만 해당하고, '
      + '`positions` 는 변화가 없어도 **보유 종목마다 항상 채운다**(변화 없음도 판단이다).',
    close: '**마감 브리핑**이다. 오늘 결과를 정리하고, **다음 세션까지 무엇을 들고 갈지**를 말하라. '
      + '장이 닫혀 있으므로 **지금 당장 집행할 수 없다** — 다음 개장에 볼 것으로 적어라.',
  };
  const briefKinds = [...new Set((trigger?.reasons || []).filter((r) => BRIEF_JOB[r.kind]).map((r) => r.kind))];
  if (briefKinds.length) {
    lines.push('', '## 이번 브리핑의 성격');
    for (const k of briefKinds) lines.push(`- ${BRIEF_JOB[k]}`);
    /**
     * 🔴 **어느 시장의 브리핑인지 말해 준다** — 안 말하면 국장 마감 브리핑에
     *    미국 보유 종목 얘기만 적힌다(그 시장에 보유가 없으니 할 말이 그것뿐이다).
     * ⚠️ 보유가 없는 시장이면 **종목 판단이 아니라 시황**을 요구한다. 사용자 지시가 그렇다.
     */
    for (const m of briefMarkets) {
      const has = items.some((i) => (m === 'kr') === (String(i.market).toUpperCase() === 'KR'));
      lines.push(has
        ? `- 대상 시장: **${MARKET_NAME[m]}** — 이 시장의 보유 종목을 중심으로 판단하라.`
        : `- 대상 시장: **${MARKET_NAME[m]}** — 이 시장에는 **보유·감시 종목이 없다.** `
          + '종목 판단 대신 **지수·업종·수급·주요 이슈 중심의 전반적 시황**을 쓰고, '
          + '보유 종목(다른 시장)에 미칠 영향이 있으면 그것만 연결하라. '
          + '**없는 종목을 지어내지 마라.**');
    }
    // ⚠️ 종류가 둘 이상이면(이월로 겹친 경우) 둘 다 적는다 — 하나로 뭉뚱그리면 하나가 조용히 사라진다
  }

  /**
   * 🔴 **유의사항은 점수보다 먼저 온다** — 100점짜리라도 정리매매면 사면 안 된다.
   *    그래서 프롬프트에서도 **위쪽**에 놓고, 모델에게 *"매수 제안을 내지 마라"* 를 명시한다.
   */
  /**
   * 🔴 시장 국면 + 발동 매뉴얼 + 도구상자 (2026-09-23 사용자 지시) — **코드 판정**을 싣는다.
   *    VIX 사용자 규칙(20/25/30/35)·급락·추세가 전부 regimeService 한 곳에서 판정되고
   *    (같은 입력 = 같은 판정), playbook.json 의 발동 절과 etf-catalog 의 관련 카테고리만
   *    함께 실린다. 모델은 판정하지 않는다 — 그 안에서 서술·선정만 한다.
   */
  try {
    const regime = require('./regimeService');
    const { state, scenarios } = await regime.refresh();
    /**
     * 🔴 **내 비중도 국면 판정에 넣는다** (2026-10-02). `refresh()` 는 **시장만** 본다 —
     *    그래서 레버리지 합계 **90.7%** 같은 상태가 어떤 매뉴얼도 못 건드렸다.
     *    비중을 실어 다시 매칭하면 `leverage_concentration`·`cash_drag` 가 발동한다.
     * ⚠️ 비중을 못 읽으면 **원래 결과를 그대로 쓴다**(포트폴리오 매뉴얼은 안 뜬다).
     *    모름을 "맞다" 로 읽지 않는 규율은 여기도 같다.
     */
    let active = scenarios;
    if (weights) {
      try {
        active = regime.matchScenarios({ ...state, portfolio: weights }, regime.readPlaybook());
      } catch (e) { logWarn('analyst.portfolio_regime_failed', { message: e.message }); }
    }
    const sec = regime.promptSection(state, active);
    if (sec) lines.push('', sec);
    /**
     * 🔴 **괴리를 코드가 빼서 준다** (2026-10-02 09:04 라이브 실측).
     *    레버리지 **90.7%** 인데 발동 매뉴얼은 *"레버리지 0~10%"* 를 말했고, 괴리가 80%p 인데
     *    **제안이 0건**(`model_proposed_none`)이었다 — 현재 비중과 기준 배분을 **따로** 주고
     *    뺄셈을 모델에게 맡긴 탓이다.
     * ⚠️ 파싱되는 것만 한다 — 못 읽으면 **아무 말도 안 한다**(지어내지 않는다).
     * ⚠️ 기준이 여럿이면 **가장 엄한 것**을 쓴다(위험을 줄이는 쪽이 이긴다는 우선순위와 같은 방향).
     */
    if (weights) {
      const targets = [];
      for (const sc of active || []) {
        for (const [k, v] of Object.entries(sc.modelPortfolio || {})) {
          if (k === '_설명' || !/레버리지/.test(k)) continue;
          const nums = String(v).match(/\d+(?:\.\d+)?/g);
          if (nums && nums.length) targets.push({ scenario: sc.name, max: Math.max(...nums.map(Number)) });
        }
      }
      if (targets.length) {
        const tight = targets.reduce((x, y) => (y.max < x.max ? y : x));
        const over = Math.round((weights.leveragePct - tight.max) * 10) / 10;
        if (over > 0) {
          lines.push('', `🔴 **레버리지 괴리: 현재 ${weights.leveragePct}% vs 기준 ${tight.max}% — ${over}%p 초과**`
            + ` (${tight.scenario}). 기준선까지 줄이려면 약 ${Math.round((over / 100) * weights.total)} 어치 축소가 필요하다.`);
          lines.push('   ⚠️ 한 번에 다 팔라는 뜻이 아니다 — **분할 축소 제안**을 내고, 추세가 강하면 속도를 늦춰라.'
            + ' 다만 **아무것도 제안하지 않는 것은 답이 아니다.**');
        }
      }
    }
    // 🔴 매수 후보 실데이터 — 이름만 주면 모델이 정직하게 침묵한다(시뮬 E: 현금 있어도 제안 0)
    const cand = await regime.candidateSection(active, {
      heldSymbols: items.map((i) => i.symbol),
      summarize: summarizeCandles,
      getCandles: (sym, o) => toss.getCandles(sym, o),
    });
    if (cand) lines.push('', cand);
  } catch (e) {
    logWarn('analyst.regime_failed', { message: e.message });
    lines.push('', '## 시장 국면: 판정 실패 — 국면 기반 판단은 하지 마라(추측 금지).');
  }

  const nowKeys = Object.keys(indexNow);
  if (nowKeys.length) {
    lines.push('', '## 지수 현재가 (실시간)');
    for (const k of nowKeys) {
      const r = indexNow[k];
      // ⚠️ 실측 필드는 lastPrice(문자열) 다 — price/changePct 는 안 온다(추측 키 금지 규율)
      lines.push(`- ${k}: ${r.lastPrice ?? '-'}`);
    }
  }

  const techKeys = Object.keys(indexTech);
  if (techKeys.length) {
    lines.push('', '## 국내 지수 기술적 위치');
    for (const idx of techKeys) {
      const t = indexTech[idx];
      // ⚠️ 키는 summarizeCandles 의 실제 반환(last·ma20·ma60·high·low)이다 —
      //    high20 으로 추측해 썼다가 소스 대조에서 잡았다(오늘 수급 필드명과 같은 병)
      lines.push(`- ${idx}: 종가 ${t.last} · 20일선 ${t.ma20 ?? '-'} · 60일선 ${t.ma60 ?? '-'} · 고점 ${t.high ?? '-'} (대비 ${t.fromHighPct != null ? t.fromHighPct.toFixed(1) + '%' : '-'}) · 저점 ${t.low ?? '-'}`);
    }
    lines.push('⚠️ 지수의 자리다 — 수급(아래)과 붙여서 "어디서 누가" 를 설명하라.');
  }

  const flowKeys = Object.keys(indexFlow);
  if (flowKeys.length) {
    lines.push('', '## 국내 지수 투자자별 매매대금 (최근 3일)');
    for (const idx of flowKeys) {
      for (const r of indexFlow[idx]) {
        const net = (who) => {
          const b = Number(r?.[`${who}BuyAmount`] ?? r?.[who]?.buyAmount);
          const sl = Number(r?.[`${who}SellAmount`] ?? r?.[who]?.sellAmount);
          if (!Number.isFinite(b) || !Number.isFinite(sl)) return null;
          return Math.round((b - sl) / 1e8); // 억원
        };
        /**
         * 🔴 **필드명을 추측해서 3분의 2가 조용히 사라졌다** (2026-09-22 첫 실증에서 발견).
         *    명세의 실제 키는 `foreigner`·`institution` 인데 나는 `foreign`·`institutional` 로 짐작했다.
         *    `individual` 만 우연히 맞아 **개인만 프롬프트에 실렸고**, 모델이 그걸 정확히 짚었다 —
         *    gap 에 *"코스피·코스닥 **개인만 제공**"* 이라고 적었다. **모델의 불평이 자였다.**
         *    ⚠️ null 을 거르는 방어(`filter(Boolean)`)가 오히려 증상을 숨겼다 — 죽지 않으니 아무도 모른다.
         */
        // `otherCorporation`(기타법인)도 싣는다 — pm2 실응답 확인(2026-09-22). 국내 수급에서
        // 무시 못 할 주체이고, 파싱 구조가 같아 비용이 없다.
        /**
         * 🔴 방향 낱말까지 코드가 붙인다 (2026-09-23) — 부호(+/-)만 실었더니 12:15 브리핑이
         *    개인 순매도를 "개인의 순매수" 로 서술했다(본문 검수에서 발견). 기호 해석을
         *    모델에 남기면 방향이 뒤집힌다 — 산수도 방향도 코드가 말한다.
         */
        const parts = [['개인', 'individual'], ['외국인', 'foreigner'], ['기관', 'institution'], ['기타법인', 'otherCorporation']]
          .map(([ko, k]) => { const n = net(k); return n == null ? null : `${ko} ${n >= 0 ? '순매수' : '순매도'} ${n > 0 ? '+' : ''}${n}억`; })
          .filter(Boolean);
        if (parts.length) lines.push(`- ${idx} ${String(r?.date || r?.baseDate || '').slice(5)}: ${parts.join(' · ')}`);
      }
    }
    lines.push('⚠️ **순매수(매수−매도) 금액**이다. 지수 등락과 **누가 샀는지**를 붙여서 설명하라 — '
      + '등락률만 되풀이하면 브리핑이 아니라 중계다.');
  }

  const warnSyms = Object.keys(warnings).filter((k) => Array.isArray(warnings[k]) && warnings[k].length);
  if (warnSyms.length) {
    lines.push('', '## ⚠️ 매수 유의사항 (점수보다 우선한다)');
    for (const sym of warnSyms) {
      const kinds = warnings[sym].map((w) => w?.type || w?.code || w?.name || JSON.stringify(w)).slice(0, 5);
      lines.push(`- **${sym}**: ${kinds.join(' · ')}`);
    }
    lines.push('🔴 위 종목은 **정리매매·거래정지·투자경고·과열** 등에 걸려 있다. '
      + '점수가 높아도 **매수 제안을 내지 마라.** 보유 중이면 위험을 분명히 적어라.');
  }

  const supplySyms = Object.keys(supply);
  if (supplySyms.length) {
    lines.push('', '## 국내 수급 4축 (최근 3~5일 · 최신순)');
    const d5 = (r) => String(r?.date || r?.baseDate || '').slice(5);
    for (const sym of supplySyms) {
      const k = supply[sym];
      const parts = [];
      if (k.short) {
        parts.push(`공매도비중 ${k.short.map((r) => {
          const ratio = r?.shortSellingVolumeRatio ?? r?.volumeRatio ?? r?.ratio;
          return `${d5(r)} ${ratio != null ? `${ratio}%` : '-'}`;
        }).join('·')}`);
      }
      if (k.lending) {
        parts.push(`대차잔고 ${k.lending.map((r) => `${d5(r)} ${r?.balanceQuantity ?? '-'}주`).join('·')}`);
      }
      if (k.credit) {
        parts.push(`신용융자잔고 ${k.credit.map((r) => `${d5(r)} ${r?.marginLoan?.balanceQuantity ?? r?.marginLoan?.balance ?? '-'}`).join('·')}`);
      }
      if (k.program) {
        parts.push(`프로그램 ${k.program.map((r) => {
          const b = Number(r?.arbitrage?.buyVolume ?? 0) + Number(r?.nonArbitrage?.buyVolume ?? 0);
          const sl = Number(r?.arbitrage?.sellVolume ?? 0) + Number(r?.nonArbitrage?.sellVolume ?? 0);
          return `${d5(r)} 순${b - sl >= 0 ? '+' : ''}${(b - sl).toLocaleString('ko-KR')}주`;
        }).join('·')}`);
      }
      lines.push(`- **${sym}**: ${parts.join(' | ')}`);
    }
    lines.push('⚠️ 읽는 법: 공매도·대차잔고 상승 = 하방 압력 축적 · 신용융자 상승 = 개인 레버리지 매수(과열 신호일 수 있음) · '
      + '프로그램 순매수 = 기관 바스켓 방향. **절대량이 아니라 추세와 조합**으로 읽어라.');
  }

  const bookSyms = Object.keys(books);
  if (bookSyms.length) {
    lines.push('', '## 현재 호가 (최우선)');
    for (const sym of bookSyms) {
      const b = books[sym];
      lines.push(`- ${sym}: 매도호가 ${b.ask ? `${b.ask.price} (${b.ask.volume}주)` : '-'} · 매수호가 ${b.bid ? `${b.bid.price} (${b.bid.volume}주)` : '-'}`);
    }
    lines.push('⚠️ 지정가를 낼 때 **이 호가를 기준**으로 하라 — 스프레드 밖 가격은 체결되지 않거나 불리하게 체결된다.');
  }

  const heldSet = new Set(items.map((i) => String(i.symbol).toUpperCase()));

  /**
   * 🔴 **감시 종목의 오늘 움직임** (2026-10-01) — `alertService` 가 이미 계산해 넘겨 준 rows 를
   *    그대로 쓴다(**새 호출 0건**). 상세·배경은 `watchMovesSection` 주석에.
   * ⚠️ 종목명은 **로컬 관심종목 상태**에서만 가져온다(파일 읽기 · 네트워크 없음). 실패하면
   *    이름 없이 티커만 적는다 — 이름 하나 때문에 절 전체를 잃지 않는다.
   *    ⚠️ 이 경로는 `watchlistService` 의 `isSelfDeclaredStale` 시세 필터와 **무관**하다:
   *       등락률은 `toss.getPrices`/`getCandles` 에서 오고 여기서는 **이름만** 읽는다.
   */
  {
    let nameOf = () => null;
    try {
      const wl = require('./watchlistService').getWatchlistState();
      const bySym = new Map();
      for (const g of wl?.groups || []) {
        for (const t of g?.tickers || []) {
          const s = String(t?.symbol || '').toUpperCase();
          if (s && t?.name && t.name !== t.symbol && !bySym.has(s)) bySym.set(s, String(t.name));
        }
      }
      nameOf = (s) => bySym.get(String(s).toUpperCase()) || null;
    } catch (e) {
      // 조용히 넘기지 않는다 — 이름이 통째로 빠지면 KR 6자리 코드가 모델에게 무의미해진다
      logWarn('analyst.watch_names_failed', { message: e.message });
    }
    lines.push('', watchMovesSection(trigger?.momentumRows, {
      heldSet,
      nameOf,
      // ⚠️ z 는 **트리거가 쓰는 그 함수**로 센다 — 공식을 복제하면 두 숫자가 조용히 갈린다
      zOf: (r) => require('./analystTrigger').zScore(r.dailyChangePct, r.history),
    }));
  }

  const reentry = [...new Map(
    (trigger?.reasons || [])
      .filter((r) => r.kind === 'momentum' && r.symbol && !heldSet.has(String(r.symbol).toUpperCase()))
      .map((r) => [String(r.symbol).toUpperCase(), r])
  ).values()].slice(0, 3);

  if (reentry.length) {
    lines.push('', '## 되살/신규 진입 후보 (보유 아님 — 다른 질문이다)');
    const ROLE_LABEL = { reentry: '최근까지 보유했다 매도', targeted: '목표·손절 지정', watch: '감시 표시(미보유)' };
    for (const r of reentry) {
      let tech = null;
      try {
        const c = await toss.getCandles(r.symbol, { interval: '1d', count: 120 });
        tech = summarizeCandles(c.rows || []);
      } catch (e) {
        logWarn('analyst.reentry_candles_failed', { symbol: r.symbol, message: e?.message });
      }
      /**
       * 🔴 **후보도 기업 평가를 받는다** (2026-09-22 사용자 지시)
       *
       * *"감시중이라고 무조건 분석하지말고 **회사 재무/회계/성장성/모멘텀/증시상황 전반적 분석 후에**
       * 매수 및 매도 처리가 되도록 해."*
       *
       * 종전엔 보유 종목만 10항목 평가를 받았다 ⇒ 미보유 후보는 **모멘텀과 차트만** 보고
       * 매수 제안이 나갈 수 있었다. 그건 사용자가 금지한 바로 그 모양이다.
       * ⚠️ 서술은 안 받는다(`withProse:false`) — 종목당 35초라 후보까지 붙이면 분석이 못 쓰게 느려진다.
       */
      try {
        const ysym = /^\d{6}$/.test(r.symbol) ? `${r.symbol}.KS` : r.symbol;
        ratings[r.symbol] = await rating.rate(ysym, { withProse: false });
      } catch (e) {
        ratings[r.symbol] = { error: e.message, kind: e.kind || 'unknown' };
        logWarn('analyst.reentry_rating_failed', { symbol: r.symbol, message: e?.message });
      }
      const rr = ratings[r.symbol];
      lines.push(
        `- **${r.symbol}** (${ROLE_LABEL[r.role] || r.role})`
        + ` · 오늘 ${r.changePct > 0 ? '+' : ''}${r.changePct}% (이 종목 기준 ${r.z}σ)`
        + (tech ? `\n    현재가 ${fmt(tech.last)} · 20일선 ${fmt(tech.ma20)} · 60일선 ${fmt(tech.ma60)}`
          + ` · 20일 스윙 ${fmt(tech.swingLow)}~${fmt(tech.swingHigh)} · 일변동성 ${fmt(tech.volPct)}%` : '')
        + (rr && !rr.error && rr.total != null
          ? `\n    기업 평가 **${rr.total}/100 · ${rr.opinion}** (확신도 ${rr.confidence})`
            + `\n    항목: ${rr.items.map((x) => `${x.name} ${x.score}`).join(' / ')}`
          : '')
        + (rr?.isFund ? `\n    ${rr.typeWhy} — 기업 채점 대상 아님${rr.holdIt ? ` · 보유 적합성 ${rr.holdIt}` : ''}` : '')
        + (rr?.error ? `\n    ⚠️ 기업 평가 실패: ${rr.error} — **질 평가 없이 판단해야 한다**` : '')
      );
    }
    lines.push(
      '',
      '🔴 이 종목들은 **보유가 아니다.** 수량·평단·평가손익이 없으니 그걸 근거로 쓰지 마세요.',
      '물을 것은 **"지금 되살(신규) 진입 자리인가"** 이고, 답은 `positions` 에 담되',
      '`stance` 는 `BUY`(지금 산다) 또는 `HOLD`(아직 아니다) 만 씁니다 — **`SELL` 은 쓸 수 없습니다**(없는 걸 팔 수 없다).',
      '⚠️ **한 번에 다 사는 것을 전제하지 마세요.** 분할이면 `entry` 에 **1차 진입가**를 쓰고',
      '   `rationale` 에 나머지 회차 조건을 한 문장으로 적으세요(예: "1차 92, 89 이탈 없이 반등 확인 후 2차").',
      '⚠️ 되살 이유가 **"전에 들고 있었으니까" 가 되면 안 됩니다** — 판 이유가 해소됐는지로 판단하세요.',
      '',
      '## 🔴 모멘텀만으로 사지 마세요 (사용자 지시)',
      '이 종목들이 여기 올라온 이유는 **"오늘 평소보다 크게 움직였다"** 뿐입니다.',
      '그건 **깨우는 신호**이지 매수 근거가 아닙니다. `BUY` 를 내려면 아래를 **함께** 보고',
      '`rationale` 에 **각각을 한 문장씩** 적으세요:',
      '1. **재무·회계** — 위 기업 평가 점수와 항목(없으면 "확인 못 함" 이라고 쓰세요)',
      '2. **성장성** — 매출·이익이 실제로 늘고 있는가(주어진 숫자로만)',
      '3. **모멘텀** — 오늘 움직임이 추세의 시작인지 과열인지',
      '4. **증시 상황** — 위 지수·환율 구간에서 이 종목을 살 때인가',
      '🔴 넷 중 하나라도 **근거를 못 대면 `HOLD`** 로 두세요. "일단 조금 사본다" 는 답이 아닙니다.',
      '⚠️ 기업 평가가 **실패했거나 ETF 라 점수가 없으면** 그 사실을 `rationale` 에 적고',
      '   확신도를 낮추세요 — 모르는 것을 모른다고 적는 것이 지어내는 것보다 낫습니다.',
    );
  }

  const mom = dash?.momentum || [];
  lines.push('', `## 오늘 모멘텀 (|${dash?.momentumPct ?? 3}%| 이상)`);
  lines.push(mom.length ? mom.map((m) => `- ${m.name} ${fmt(m.dailyRate)}%`).join('\n') : '- 해당 없음');

  const warn = dash?.warnings || {};
  lines.push('', '## 종목 경고');
  lines.push(Object.keys(warn).length ? Object.entries(warn).map(([k, v]) => `- ${k}: ${v.length}건`).join('\n') : '- 없음');

  lines.push('', '## 시장 랭킹(참고)');
  for (const [key, r] of Object.entries(dash?.rankings || {})) {
    if (r.error) {
      lines.push(`- ${key}: (받지 못함)`);
      continue;
    }
    const top = (r.rows || []).slice(0, 5).map((x) => `${x.name || x.symbol} ${fmt(x.changePct)}%`).join(', ');
    lines.push(`- ${key}: ${top}`);
  }

  // 웹 검색 결과 — **성공한 것만** 근거로 싣고, 못 받은 것은 아래 "없는 데이터" 에 남긴다
  const webHits = (web?.results || []).filter((r) => r.text);
  if (webHits.length) {
    lines.push('', '## 웹 검색 (my-computer 경유 · 최신 시장 정보)');
    /**
     * 🔴 **품질 저하는 실패가 아니다** (2026-09-27, pm2 실측) — Brave 월 쿼터가 마르거나
     *    장애가 나면 searxng 등 대체 소스로 넘어간다. 검색 자체는 됐으니 `dataGaps`(실패 축)엔
     *    안 넣는다 — 대신 **이 절 머리**에서 모델에게 알려 인용 전에 스스로 걸러 읽게 한다.
     */
    if (web?.degraded) {
      lines.push('⚠️ 뉴스가 대체 검색 소스(품질 낮음)에서 왔다 — 출처·날짜를 특히 확인하라');
    }
    lines.push('⚠️ 아래는 외부 검색 결과입니다. **날짜와 출처를 확인하고** 인용하세요.');
    for (const r of webHits) {
      lines.push('', `### ${r.name || r.symbol}`, r.text.slice(0, 2500));
    }
    /**
     * 🔴 **헤드라인만 보던 것을 본문까지 읽는다** (2026-10-01 — simpleStock ↔ my-computer 연계).
     *
     * 종전 브리핑은 검색 **목록**(제목·날짜·URL·220자 요약)만 받았다. 그래서 *"왜 움직였나"*
     * 를 물으면 제목을 바꿔 말하는 수준이었다. 본문을 읽는 `readArticle` 은 **이미
     * 구현돼 있고 실측까지 돼 있었는데**(한국 경제지 12도메인 1.7k~12k자) **채팅 전용**
     * 이라 브리핑 경로에 배선이 0 이었다 — 이 저장소가 반복해 밟은 *"만들어 놓고 안 쓴"* 자리.
     *
     * ⚠️ **전부 읽으면 안 된다** — 회차당 URL 이 8~15개다. 실측 비용으로 재니
     *    본문 8건이면 프롬프트가 **3~4배**(+16k~24k 토큰)가 되고 최악 +120초다.
     *    출력 길이가 곧 시간인 이 저장소에서 그건 브리핑을 죽인다(09-23 전례).
     * ⇒ **주제당 1건 · 전체 최대 3건 · 본문 1,500자 · 전체 시간 예산 20초**로 묶는다.
     *    예산을 넘으면 **거기서 멈추고 몇 건을 못 읽었는지 적는다**(조용히 줄이지 않는다).
     * ⚠️ 실패는 `dataGaps` 가 아니라 이 절에 **그 종목 자리에** 적는다 — "본문을 못 읽었다"
     *    는 그 종목에 대한 사실이지 시스템 전체의 결손이 아니다.
     */
    /**
     * ⚠️ `Number(x) || 기본값` 을 쓰면 **0 을 끌 수 없다** — `0 || 3` 은 3 이다.
     *    처음에 그렇게 썼고 "끄면 안 부른다" 테스트가 바로 잡았다(내 자가 내 코드를 잡은 자리).
     *    이 저장소에서 `|| 기본값` 관용구는 **0 이 의미 있는 값일 때만** 함정이 된다.
     */
    const envNum = (k, dflt) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : dflt; };
    const ARTICLE_MAX = Math.max(0, envNum('ANALYST_ARTICLE_MAX', 3));
    const ARTICLE_CHARS = Math.max(500, envNum('ANALYST_ARTICLE_CHARS', 1500));
    const ARTICLE_BUDGET_MS = Math.max(5000, envNum('ANALYST_ARTICLE_BUDGET_MS', 20_000));
    if (ARTICLE_MAX > 0) {
      const deadline = Date.now() + ARTICLE_BUDGET_MS;
      const bodies = [];
      let readAttempts = 0;
      let skippedForBudget = 0;
      for (const r of webHits) {
        if (bodies.length >= ARTICLE_MAX) { skippedForBudget += 1; continue; }
        if (Date.now() >= deadline) { skippedForBudget += 1; continue; }
        const url = (/https?:\/\/\S+/.exec(String(r.text || '')) || [null])[0];
        if (!url) continue;
        readAttempts += 1;
        try {
          const art = await mcp.readArticle(url);
          if (art.ok && art.text) {
            bodies.push({ name: r.name || r.symbol, url, text: String(art.text).slice(0, ARTICLE_CHARS) });
          } else {
            bodies.push({ name: r.name || r.symbol, url, error: art.error || '본문 확보 실패' });
          }
        } catch (e) {
          // 🔴 본문 읽기 실패가 브리핑을 멈추면 안 된다 — 헤드라인만으로도 회차는 성립한다
          logWarn('analyst.article_read_failed', { symbol: r.symbol, message: e?.message });
          bodies.push({ name: r.name || r.symbol, url, error: e?.message || '예외' });
        }
      }
      if (bodies.length) {
        lines.push('', '## 기사 본문 (위 목록 중 상위 기사 — 숫자·발언을 직접 인용하라)');
        for (const b of bodies) {
          lines.push('', `### ${b.name} — ${b.url}`);
          lines.push(b.error ? `(본문을 못 읽었다: ${b.error} — 제목·요약만으로 판단하라)` : b.text);
        }
        if (skippedForBudget) {
          lines.push('', `⚠️ 나머지 ${skippedForBudget}건은 시간·개수 예산으로 **본문을 안 읽었다** — 그 종목은 제목 수준의 근거만 있다.`);
        }
      }
      logInfo('analyst.articles_read', {
        attempted: readAttempts,
        ok: bodies.filter((b) => !b.error).length,
        failed: bodies.filter((b) => b.error).length,
        skipped: skippedForBudget,
        budgetMs: ARTICLE_BUDGET_MS,
      });
    }
  }

  /**
   * 🔴 **수급** — `getInvestorTrading` 은 **구현·라우트까지 있는데** 프롬프트는
   *    *"기관/외국인 수급 상세는 이 시스템에 없다"* 고 적고 있었다(세 군데).
   *    모델에게 **없다고 말하고 쓸 수 있는 데이터를 안 준** 것이다.
   * ⚠️ 보유 종목만 본다(최대 4) — 감시 11종까지 돌면 `STOCK_TRADING_TREND` 그룹을 태운다.
   * ⚠️ 미국 종목은 빈 배열이 올 수 있다 — **"없다" 와 "못 받았다" 를 구분해 적는다.**
   */
  const flows = [];
  for (const it of items.slice(0, 4)) {
    /**
     * 🔴 **투자자별 매매동향은 국내(KR) 전용이다**(명세 명시). 2026-09-22 라이브 로그에서 확인:
     *    `analyst.flows_failed QLD/RAM 토스 API 오류 (400)` 이 **분석마다** 났다.
     *    ⇒ 쓸 수 없는 호출을 매번 하면서 **한도를 깎고**, 그 실패가 리포트에
     *      *"수급 조회 실패"* 라는 gap 으로 남아 **"데이터가 없다" 로 읽혔다.**
     *      실제로는 없는 게 아니라 **애초에 물어볼 수 없는 곳에 물은 것**이다.
     * ⚠️ 같은 가족을 오늘 `short-selling` 에서 이미 막았다 — 그때 이 자리를 안 훑었다.
     */
    if (String(it.market).toUpperCase() !== 'KR') continue;
    try {
      const rows = await toss.getInvestorTrading(it.symbol);
      if (Array.isArray(rows) && rows.length) flows.push({ symbol: it.symbol, rows: rows.slice(0, 3) });
      else flows.push({ symbol: it.symbol, empty: true });
    } catch (e) {
      flows.push({ symbol: it.symbol, error: e.message });
      logWarn('analyst.flows_failed', { symbol: it.symbol, kind: e.kind, message: e.message });
    }
  }
  const withFlows = flows.filter((f) => f.rows);
  if (withFlows.length) {
    lines.push('', '## 투자자별 매매동향 (최근)');
    for (const f of withFlows) {
      lines.push(`- ${f.symbol}: ${f.rows.map((r) => {
        const net = (k) => {
          const b = Number(r?.[k]?.buyAmount ?? r?.[k]?.buyVolume ?? 0);
          const sl = Number(r?.[k]?.sellAmount ?? r?.[k]?.sellVolume ?? 0);
          if (!Number.isFinite(b) || !Number.isFinite(sl)) return null;
          return b - sl;
        };
        const parts = [['개인', net('individual')], ['외국인', net('foreigner')], ['기관', net('institution')]]
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${(v / 1e8).toFixed(1)}억`);
        return `${r.date || ''} ${parts.join('/')}`;
      }).join(' · ')}`);
    }
    // 🔴 순매수 필드가 없어 **우리가 뺀 값**이라는 것을 밝힌다
    lines.push('⚠️ 순매수는 매수−매도로 **우리가 계산**한 값이다(API 가 순매수를 주지 않는다).');
  }
  const flowGaps = flows.filter((f) => f.empty || f.error);
  if (flowGaps.length) {
    lines.push(`⚠️ 수급 없음/실패: ${flowGaps.map((f) => `${f.symbol}(${f.error ? '조회 실패' : '데이터 없음'})`).join(' · ')}`);
  }

  /**
   * 🔴 **증시 상황** — 어제 "재무·성장성·모멘텀·**증시상황**" 네 축을 요구해 놓고
   *    **지수를 하나도 안 줬다.** 그런데 테이프가 28종(나스닥·S&P·VIX·미국채30년·환율)을
   *    이미 받고 있었다 — *"수집해 놓고 안 쓰는"* 것이 또 하나 있었다.
   * ⚠️ 새 API 가 아니라 **이미 있는 것을 연결**한 것이다(비용 0).
   * ⚠️ 토스 `market-indicators` 는 **국내 8종(KOSPI·KOSDAQ·국채)뿐**이라 쓰지 않았다 —
   *    사용자는 국내 주식을 하지 않고, 나스닥·S&P 는 애초에 그 API 에 없다.
   */
  try {
    /**
     * ⚠️ `getTape()` 는 **async** 다 — 동기로 부르면 Promise 가 와서 `.items` 가 `undefined`,
     *    그러면 이 절이 **조용히 통째로 빠진다**(오류도 안 난다). 처음에 그렇게 쓸 뻔했다.
     */
    const tape = await require('./tickerTapeService').getTape();
    const tapeRows = [...(tape?.items || []), ...(tape?.fixed || [])];
    const pick = tapeRows.filter((r) => r && r.changePct != null).slice(0, 14);
    if (pick.length) {
      lines.push('', '## 증시 상황 (지수·환율·변동성)');
      lines.push(pick.map((r) => `${r.label} ${r.prefix || ''}${r.price ?? '-'}${r.suffix || ''} ${r.changePct > 0 ? '+' : ''}${Number(r.changePct).toFixed(2)}%`).join(' · '));
      lines.push('⚠️ 이 값들은 **시장 전체**다. 종목 판단의 배경이지 그 자체가 매매 근거는 아니다.');
    }
  } catch (e) {
    logWarn('analyst.tape_failed', { message: e.message });
  }

  // 🔴 "없는 데이터" 는 **실제로 못 받은 것만** 적는다.
  //    검색이 붙었는데도 "뉴스 없음" 이라 적으면 모델이 있는 근거를 안 쓴다.
  const missingAxes = [
    '재무제표·매출/이익',
    'PER/PBR/EV·DCF',
    '애널리스트 목표가',
    // 🔴 '기관/외국인 수급 상세' 를 뺐다 — **토스가 준다**(`/stocks/{s}/investor-trading`).
    //    구현·라우트까지 있는데 프롬프트는 *"없다"* 고 적고 있었다. 모델에게 없다고 말하고
    //    쓸 수 있는 데이터를 안 준 셈이다(아래 '수급' 절에서 실제로 싣는다).
    '내부자 거래',
    '옵션 IV',
  ];
  if (!webHits.length) missingAxes.push('뉴스·최신 시장 정보');
  lines.push('', '## 이 시스템에 **없는** 데이터 (근거로 쓰지 마세요)', missingAxes.join('·'));
  if (userInstruction) lines.push('', `## 사용자 추가 지시`, userInstruction);

  const started = Date.now();
  /**
   * 🔴 **보낸 입력을 남긴다** — 이게 있어야 *"보고서의 숫자가 우리가 준 것인가"* 를
   *    사후에 판정할 수 있다(위 savePrompt 주석 참조). dryRun 도 남긴다 — 검증 회차도
   *    같은 자로 재야 한다.
   */
  const userPrompt = lines.join('\n');
  savePrompt(userPrompt);
  const raw = await generateStructuredOutput(
    {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      // 🔴 **보유 전용 자리**를 가진 스키마 — 후보와 경쟁시키지 않는다(위 reportSchemaFor 참조)
      schema: reportSchemaFor(items.map((h) => h.symbol)),
      logLabel: 'trade_analyst',
    },
    { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] }
  );

  // 🔴 키가 아니라 **모양**으로 읽는다(위 shapeReport 주석 참조)
  let report = shapeReport(raw);
  if (report._unreadable) {
    logWarn('analyst.unreadable_shape', { raw: report._unreadable });
  }

  /**
   * 🔴 **종목 판단이 비면 한 번 되돌려 묻는다** (2026-09-21 — pm2 라이브 실측)
   *
   * 보유가 2종목인데 3회 중 **0·1·0 건**만 나왔다. 모델은 답하고 있었다 —
   * `{"conclusion": "QLD는 보유 유지, RAM은 …"}` 처럼 **서술형 한 덩어리**로 줬을 뿐이다.
   * 같은 지문에서 0 과 1 이 갈리므로 **확률적**이고, 모양 흡수만으로는 못 메운다
   * (문장에서 BUY/SELL 을 긁는 건 **지어내기**다 — 그건 하지 않는다).
   *
   * ★ 처방은 이 워크스페이스가 이미 검증한 것이다: **프롬프트로 못 고치는 것을 프롬프트로 고치지 말고,
   *   코드가 거부하고 이유를 다음 프롬프트에 돌려준다.** 규칙을 한 줄 더 얹는 쪽은 실패한 전례가 있다.
   *
   * ⚠️ **한 번만** 다시 묻는다 — 무한히 되물으면 분석 한 번이 예산을 다 태운다.
   * ⚠️ 재요청이 더 나쁘게 나올 수도 있으므로 **판단이 더 많이 잡힌 쪽을** 쓴다(회귀 방지).
   */
  /** stance 는 BUY/SELL 인데 제안이 없는 종목 — 폰 본문에 사실대로 적는다 */
  let stanceGap = [];
  const heldSymbols = items.map((h) => String(h.symbol).toUpperCase());
  /**
   * 🔴 **개수로 판정하면 종목이 통째로 바뀌어도 통과한다** (2026-10-02 라이브 dryRun).
   *
   * 종전 조건은 `report.positions.length < heldSymbols.length` 였다. 그런데 실제로
   * **보유 3종(O·QLD·RAM)인데 모델이 후보 3종(SOXX·VONG·XLV)을 내면 `3 < 3` 이 거짓**이라
   * 이 가드가 **발동조차 안 한다.** 그 회차의 최종 보고서에는 **보유 종목이 0개**였다 —
   * 사용자가 보는 화면에 자기 보유 판단이 통째로 없는 상태다.
   *
   * ⇒ **집합 차이로 판정한다.** `missing` 은 어차피 아래에서 계산하고 있었다 —
   *    *"수집해 놓고 안 쓰는"* 의 판정판이다(값은 있는데 조건이 그걸 안 봤다).
   */
  const missing = heldSymbols.filter(
    (s) => !report.positions.some((p) => String(p.symbol).toUpperCase() === s)
  );
  if (missing.length) {
    logWarn('analyst.positions_short', { got: report.positions.length, need: heldSymbols.length, missing });
    const retryRaw = await generateStructuredOutput(
      {
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: [
          lines.join('\n'),
          '',
          '## 🔴 직전 답변이 규격에 안 맞았습니다 — 다시 답하세요',
          `보유 종목 **${heldSymbols.length}개 전부**에 대해 판단이 필요한데 ${missing.join(', ')} 이(가) 빠졌습니다.`,
          '줄글 하나로 묶지 말고, **종목마다 한 건씩** 아래 항목을 채운 객체를 `positions` 배열에 넣으세요.',
          '`symbol`(티커) · `stance`(BUY|SELL|HOLD) · `confidence`(HIGH|MEDIUM|LOW) · `rationale` · `risk`',
          '판단이 "그대로 보유" 여도 `stance: "HOLD"` 로 **명시**하세요. 빠뜨리지 마세요.',
        ].join('\n'),
        // 🔴 **보유 전용 자리**를 가진 스키마 — 후보와 경쟁시키지 않는다(위 reportSchemaFor 참조)
        schema: reportSchemaFor(items.map((h) => h.symbol)),
        logLabel: 'trade_analyst_retry',
      },
      { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] }
    );
    const retried = shapeReport(retryRaw);
    logInfo('analyst.retry_done', { before: report.positions.length, after: retried.positions.length });
    /**
     * 🔴 **재시도까지 실패하면 코드가 자리를 채운다** (2026-10-02 라이브 실측).
     *
     * 09:04 KRX 개장 회차: 프롬프트에 *"하나도 빠뜨리지 말라"* 를 넣고 재시도까지 돌렸는데
     * **두 번 다 O(리얼티 인컴)를 뺐다**(`positions_short missing:["O"]` → `before:2 after:2`).
     * ⇒ *"프롬프트로 못 고치는 것을 프롬프트로 고치려 하지 말 것"* — 두 번 확인됐다.
     *
     * ⚠️ **판단을 지어내지 않는다.** 채우는 것은 **"판단을 못 받았다" 는 사실**이다.
     *    stance=HOLD(행동 없음) · confidence=LOW · rationale 에 그대로 적는다.
     *    사용자는 적어도 **그 종목이 방치되지 않았다**는 것을 보게 된다.
     * ⚠️ 이 자리는 `proposals` 를 만들지 않는다 — 판단이 없는데 주문을 낼 수는 없다.
     */
    {
      const got = new Set((retried.positions.length > report.positions.length ? retried : report)
        .positions.map((p) => String(p.symbol || '').toUpperCase()));
      const stillMissing = heldSymbols.filter((sym) => !got.has(sym));
      if (stillMissing.length) {
        logWarn('analyst.positions_filled_by_code', { symbols: stillMissing, after: 'retry' });
        const filler = stillMissing.map((sym) => ({
          symbol: sym, stance: 'HOLD', confidence: 'LOW',
          // 🔴 **코드가 채운 자리**라는 표식 — 아래 누락 경고가 이걸 보고 **여전히 짖는다**.
          //    채웠다고 경고까지 사라지면 "판단을 받았다" 와 "자리만 채웠다" 가 같아진다.
          _codeFilled: true,
          rationale: '🔴 모델이 두 번(본 요청·재요청) 모두 이 종목 판단을 내지 않았습니다 — '
            + '판단이 "보유 유지" 라서가 아니라 **판단 자체가 없습니다.** 직접 확인이 필요합니다.',
          risk: '판단을 받지 못해 리스크를 평가하지 못했습니다.',
          evidence: [], entry: null, stop: null, target: null,
          scenarioUp: '', scenarioDown: '',
        }));
        if (retried.positions.length > report.positions.length) retried.positions.push(...filler);
        else report = { ...report, positions: [...report.positions, ...filler] };
      }
    }
    // 되물어서 더 잡혔을 때만 바꾼다. 시황은 **있는 쪽을** 남긴다(재요청이 시황을 비우기도 한다)
    if (retried.positions.length > report.positions.length) {
      report = {
        ...retried,
        marketView: retried.marketView || report.marketView,
        momentumRead: retried.momentumRead || report.momentumRead,
        dataGaps: retried.dataGaps.length ? retried.dataGaps : report.dataGaps,
        proposals: retried.proposals.length ? retried.proposals : report.proposals,
      };
    }
  }

  /**
   * 🔴 **모델이 지어낸 가격을 통과시키지 않는다** (2026-10-02 라이브 실사고 → 사용자 지시
   *    *"지어내면 안되지. 내부 검증 단계를 거쳐."*).
   *
   * 15:30 KRX 마감 회차에서 프롬프트는 `QLD 현재 96.84 · 20일선 92.69` 를 **줬는데**
   * 모델이 `"20일선(약 806)"` 이라고 썼다(실제가의 **8배**). RAM 은 13.67 → 46.10.
   * 텔레그램 요약엔 안 갔지만 **화면 시나리오 줄에 그대로 떴다** — 사용자가
   * *"806까지 회복하면"* 으로 읽으면 완전히 틀린 판단을 한다.
   *
   * ★ 프롬프트에는 *"근거 없는 수치는 쓰지 않습니다"* 가 **이미 있었고 안 지켜졌다.**
   *   ⇒ 이 워크스페이스의 규율대로 **코드가 거부하고 이유를 다음 프롬프트에 돌려준다.**
   *
   * 3단: ①검출 → ②맞는 값을 들고 **한 번** 재요청 → ③그래도 틀리면 **코드가 사실로 교체**.
   * ⚠️ 재요청은 한 번뿐이다 — 무한히 되물으면 분석 한 번이 예산을 다 태운다.
   * ⚠️ 교체본은 **우리가 모델에게 준 값**으로만 쓴다(코드도 지어내지 않는다).
   */
  {
    const refBySymbol = {};
    for (const [sym, t] of Object.entries(tech || {})) {
      if (t && Number(t.last) > 0) refBySymbol[String(sym).toUpperCase()] = t;
    }
    /**
     * 🔴 **주제가 바뀌는 축을 함께 본다** (2026-10-02 dryRun 실측).
     *    `QLD` 의 시나리오가 `SOXX` 를 말했는데 **가격 자는 `outliers: 0`** 이었다 —
     *    산문에 **숫자가 0개**라 볼 것이 없었기 때문이다.
     *    ★ 같은 회차에서 한 자는 통과하고 다른 축이 통째로 틀렸다 ⇒ **자를 하나만 두면
     *      모델이 그 자가 안 보는 쪽으로 빠진다.**
     * ⚠️ 아는 종목 목록은 **보유 + 후보 + 보고서에 등장한 심볼** 의 합집합이다 —
     *    좁게 잡으면 "다른 종목" 을 인식 못 해 조용히 통과한다.
     */
    const knownSyms = [...new Set([
      ...items.map((h) => String(h.symbol || '').toUpperCase()),
      ...report.positions.map((p) => String(p.symbol || '').toUpperCase()),
      ...(report.proposals || []).map((p) => String(p.symbol || '').toUpperCase()),
    ])].filter(Boolean);
    const nameBySym = {};
    for (const h of items) nameBySym[String(h.symbol || '').toUpperCase()] = h.name || '';
    const drift = prose.findSubjectDrift(report.positions, knownSyms, nameBySym);
    /**
     * 🔴 **가격 자리의 0** — `priceNumbers` 가 `<1` 을 거르므로 **원리상 안 걸리던 축**.
     *    사용자: *"o 는 진입 0.00, 손절 0.00, 목표 0.00 이거 대체 뭐하는 짓이야"*
     *    ⇒ 가격 이탈·주제 이탈과 **같은 단계**에서 함께 본다(자를 하나씩 더 붙여 온 이유다).
     */
    const zeros = prose.findZeroLevels(report.positions);
    if (zeros.length) {
      logWarn('analyst.prose_zero_level', {
        hits: zeros.map((z) => ({ symbol: z.symbol, field: z.field, raw: z.raw, context: z.context })),
      });
    }
    if (drift.length) {
      logWarn('analyst.prose_subject_drift', {
        hits: drift.map((d) => ({ symbol: d.symbol, others: d.others })),
      });
    }

    const outliers = prose.findPriceOutliers(report.positions, refBySymbol);
    const notChecked = prose.unverifiable(report.positions, refBySymbol);
    // ⚠️ **검사 못 한 것을 통과로 보여주지 않는다** — 0건이 "다 맞았다" 가 아닐 수 있다
    logInfo('analyst.prose_price_check', {
      checked: report.positions.filter((p) => !p._codeFilled).length - notChecked.length,
      outliers: outliers.length, unverifiable: notChecked,
    });
    if (outliers.length || drift.length || zeros.length) {
      if (outliers.length) logWarn('analyst.prose_price_outlier', {
        // ⚠️ `context` 를 함께 — 없으면 **교체된 뒤 오탐인지 가릴 수 없다**(실제로 겪었다)
        hits: outliers.map((h) => ({ symbol: h.symbol, field: h.field, raw: h.raw, current: h.current, ratio: h.ratio, context: h.context })),
      });
      const fixRaw = await generateStructuredOutput(
        {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: [
            lines.join('\n'), '',
            // ⚠️ 두 가지가 동시에 틀릴 수 있다 — **둘 다** 돌려준다(하나만 주면 다른 쪽이 또 틀린다)
            ...(outliers.length ? [prose.retryNote(outliers, refBySymbol)] : []),
            ...(drift.length ? [prose.driftNote(drift)] : []),
            ...(zeros.length ? [['## 🔴 가격 자리에 0 을 쓴 종목이 있습니다 — 다시 답하세요',
              ...zeros.map((z) => `- **${z.symbol}** ${z.field}: "${z.context}"`),
              '값을 정할 수 없으면 **그 칸을 비우십시오**(0 이 아니라 생략). 0 은 "가격이 0" 이라는 뜻이라 사용자에게 의미가 없습니다.',
            ].join('\n')] : []),
          ].join('\n'),
          // 🔴 **보유 전용 자리**를 가진 스키마 — 후보와 경쟁시키지 않는다(위 reportSchemaFor 참조)
          schema: reportSchemaFor(items.map((h) => h.symbol)),
          logLabel: 'trade_analyst_price_fix',
        },
        { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] }
      );
      const fixed = shapeReport(fixRaw);
      const stillBad = prose.findPriceOutliers(fixed.positions, refBySymbol);
      const stillDrift = prose.findSubjectDrift(fixed.positions, knownSyms, nameBySym);
      const stillZero = prose.findZeroLevels(fixed.positions);
      /**
       * 🔴 **`after: 0` 이 "고쳐졌다" 로 읽히면 안 된다** (2026-10-02 라이브에서 드러났다).
       *    재요청이 어긋남을 0으로 만들어도 **종목 수가 줄면 채택하지 않는다**(회귀 방지).
       *    실제로 `after:0` 인데 `got:2 < positions:4` 라 버렸고, 로그만 보면
       *    **고쳐진 것처럼 보였다.** ⇒ **채택 여부와 그 이유를 같은 줄에 적는다.**
       *    ★ 09-28 *"플래그가 거짓말했다"* 와 같은 가족 — **조용한 것보다 나쁜 것은
       *      틀린 확신을 주는 것이다.**
       */
      const improved = (stillBad.length + stillDrift.length + stillZero.length) < (outliers.length + drift.length + zeros.length);
      /**
       * 🔴 **개수만 보면 종목이 갈려도 받는다** (같은 회차에서 실제로 일어났다).
       *    `got:4 had:3` 이라 채택했는데 그 4개가 **전부 후보**였고 보유는 0개였다.
       *    ⇒ **원본에 있던 심볼이 하나라도 빠지면 거부**한다. 개수는 그다음이다.
       */
      const hadSyms = new Set(report.positions.map((p) => String(p.symbol || '').toUpperCase()));
      const fixedSyms = new Set(fixed.positions.map((p) => String(p.symbol || '').toUpperCase()));
      const lostSyms = [...hadSyms].filter((x) => !fixedSyms.has(x));
      const keptCount = fixed.positions.length >= report.positions.length && lostSyms.length === 0;
      logInfo('analyst.prose_price_retry', {
        before: outliers.length, after: stillBad.length,
        driftBefore: drift.length, driftAfter: stillDrift.length,
        zeroBefore: zeros.length, zeroAfter: stillZero.length,
        got: fixed.positions.length, had: report.positions.length,
        adopted: improved && keptCount,
        // ⚠️ 거부 이유를 **갈라서** 적는다 — "개수가 줄었다" 와 "종목이 바뀌었다" 는 다른 사고다
        why: improved && keptCount ? 'ok'
          : lostSyms.length ? 'lost_symbols'
            : fixed.positions.length < report.positions.length ? 'fewer_positions' : 'not_improved',
        lost: lostSyms,
      });
      /**
       * ⚠️ **재요청이 더 나쁠 수도 있다** — 판단 수가 줄지 않았고 어긋남이 줄었을 때만 채택한다.
       *    (`positions_short` 재시도가 이미 같은 규율을 쓴다 — 회귀 방지)
       */
      // ⚠️ **둘을 합쳐서** 나아졌는지 본다 — 한쪽만 보면 다른 쪽 회귀를 채택한다
      if (keptCount && improved) {
        report = {
          ...report,
          positions: fixed.positions,
          marketView: fixed.marketView || report.marketView,
          momentumRead: fixed.momentumRead || report.momentumRead,
        };
      }
      // ③ 그래도 남은 것은 코드가 사실로 교체한다 — 조용히 지우지 않고 표식을 남긴다
      /**
       * 🔴 주제 이탈은 **코드가 대신 써 줄 수 없다** — 가격처럼 "우리가 준 값" 이 없다.
       *    ⇒ 조용히 두지 않고 **그 문장을 비우고 무슨 일이 있었는지 적는다.**
       *       틀린 종목 이야기를 그대로 두면 사용자가 그걸 그 종목 근거로 읽는다.
       */
      const remainDrift = prose.findSubjectDrift(report.positions, knownSyms, nameBySym);
      if (remainDrift.length) {
        const bad = new Set(remainDrift.map((d) => d.symbol));
        logWarn('analyst.prose_subject_drift_unfixed', {
          symbols: [...bad], action: 'cleared_with_notice',
          hits: remainDrift.map((d) => ({ symbol: d.symbol, others: d.others })),
        });
        report = {
          ...report,
          positions: report.positions.map((p) => (bad.has(String(p.symbol || '').toUpperCase())
            ? {
              ...p,
              scenarioUp: '', scenarioDown: '',
              rationale: `🔴 모델이 두 번 모두 **다른 종목(${remainDrift.find((d) => d.symbol === String(p.symbol).toUpperCase())?.others.join(', ')}) 이야기**를 했습니다 — `
                + '이 종목에 대한 판단이 아닙니다. 직접 확인이 필요합니다.',
              _subjectDrift: true,
            }
            : p)),
        };
      }

      const remain = prose.findPriceOutliers(report.positions, refBySymbol);
      if (remain.length) {
        const badSyms = new Set(remain.map((h) => h.symbol));
        logWarn('analyst.prose_price_fabricated', {
          symbols: [...badSyms],
          action: 'replaced_with_facts',
          hits: remain.map((h) => ({ symbol: h.symbol, field: h.field, raw: h.raw, current: h.current })),
        });
        report = {
          ...report,
          positions: report.positions.map((p) =>
            badSyms.has(String(p.symbol || '').toUpperCase())
              ? prose.replaceWithFacts(p, refBySymbol[String(p.symbol).toUpperCase()])
              : p),
        };
      }
    }
  }

  /**
   * 🔭 **의사결정 파이프라인 요약** (2026-10-03 — 자율 트레이딩 대시보드).
   *
   * 사용자 최종 목표가 자율 트레이딩이다. 자율을 믿으려면 **이번 회차에 무엇을 보고
   * 무엇을 걸렀고 왜 그 결론인지**가 화면에 보여야 한다 — 로그는 운영자용이지
   * 사용자용이 아니다. 각 단계의 수치를 보고서에 싣는다(값이 아니라 **집계**만 —
   * 프롬프트 원문은 안 싣는다).
   */
  const pipeline = {
    collected: {
      holdings: items.length,
      candidates: require('./regimeService').readLastGate()?.measured ?? null,
      webSearch: web?.ok ? (web.results || []).filter((r) => !r.skipped && !r.error).length : 0,
    },
    gate: require('./regimeService').readLastGate(),
    judged: {
      positions: report.positions.length,
      codeFilled: report.positions.filter((p) => p._codeFilled).length,
    },
    guards: {
      priceOutliers: (report.positions || []).filter((p) => p._priceFabricated).length,
      subjectDrift: (report.positions || []).filter((p) => p._subjectDrift).length,
      entryFilled: (report.positions || []).filter((p) => p._entryFromPrice).length,
    },
  };
  report.pipeline = pipeline;

  // 제안을 orderService 로 넘긴다 — **빈칸이 있으면 거기서 거부된다**
  const created = [];
  const rejected = [];
  for (const p of dryRun ? [] : (report.proposals || [])) {
    /**
     * 🔴 **계좌로 먼저 막는다** — 모델이 낼 수 없는 제안을 폰으로 보내면
     *    사용자가 승인을 누르고 나서야 실패를 안다. 그건 HITL 이 아니라 헛수고다.
     * ⚠️ 못 물어봤으면(`unknown`) **통과가 아니다** — 막고 이유를 화면에 적는다.
     */
    /**
     * 🔴 인버스 게이트 — 사용자 규칙(09-24)을 **코드로** 강제한다. 스펙트럼 시뮬 실증:
     *    횡보 케이스에서 모델이 "추세 붕괴 확인되어 소액 헤지" 라며 PSQ 매수를 냈다 —
     *    규칙(확정 하락추세에서만·1배만)이 프롬프트에 있는데도 어겼다. 프롬프트로 못
     *    지키는 규칙은 코드가 정본이다(뭉뚱그림 걸러내기와 같은 가족).
     * ⚠️ 분석(analyst) 제안만 막는다 — 채팅의 사용자 명시 요청은 사람 의사라 통과.
     */
    {
      const gate = inverseGate(p, require('./regimeService').getState());
      if (!gate.ok) {
        rejected.push({ symbol: p.symbol, side: p.side, error: gate.why });
        logWarn('analyst.inverse_blocked', { symbol: p.symbol, why: gate.why });
        continue;
      }
    }
    /**
     * 🔴 **사용자가 "보유 유지" 를 정한 종목의 매도를 코드가 막는다** (2026-10-01).
     *    프롬프트에 적어 뒀는데도 12:19 에 `RAM SELL @14.1` 이 나갔고 사용자가 거절했다.
     *    ⚠️ 막는 쪽이 **방침과 같은 설정**을 읽으므로 둘이 갈라질 수 없다.
     */
    /** 깎인 값이 있으면 여기 담긴다 — `p` 는 상수라 덮어쓰지 않는다 */
    let clamped = null;
    const chk = await orderService.checkAccountLimits({
      symbol: p.symbol, side: p.side, quantity: p.quantity, price: p.price,
    });
    /**
     * 🔴 **현금을 넘으면 거부하지 말고 깎는다** (2026-10-02 실사고).
     *    08:00 회차에서 `SHY BUY · 필요 1,622 USD > 가능 1,375` 가 **통째로 거부**됐다.
     *    모델 판단(단기국채로 피난)은 **맞았는데** 수량 하나 때문에 제안이 0건이 됐고,
     *    사용자 화면에는 *"매매 제안 0건"* 만 남았다.
     * ★ `checkAccountLimits` 는 **가능 수량(maxQuantity)을 이미 계산해서 돌려주고 있었다** —
     *   그걸 읽는 코드가 0곳이었다. *"수집해 놓고 안 쓰는"* 의 또 하나.
     * ⚠️ 깎는 것은 **수량 부족(insufficient)** 일 때만이다 — 다른 거부(종목 제한·가격 밴드)는
     *    판단 자체가 틀린 것이라 깎아서 통과시키면 안 된다.
     * ⚠️ 깎았다는 사실을 **제안 사유에 적는다** — 사용자가 승인 화면에서 원래 의도를 알아야 한다.
     */
    if (!chk.ok) {
      const canClamp = chk.kind === 'insufficient' && Number(chk.maxQuantity) >= 1
        && Number(chk.maxQuantity) < Number(p.quantity);
      if (!canClamp) {
        rejected.push({ symbol: p.symbol, side: p.side, error: chk.error, kind: chk.kind });
        logWarn('analyst.proposal_blocked', { symbol: p.symbol, side: p.side, kind: chk.kind, error: chk.error });
        continue;
      }
      logInfo('analyst.proposal_clamped', {
        symbol: p.symbol, side: p.side, asked: p.quantity, to: chk.maxQuantity, why: chk.kind,
      });
      clamped = { quantity: Number(chk.maxQuantity),
        reason: `${p.reason || ''} (현금 한도로 ${p.quantity}→${chk.maxQuantity}주 축소)`.trim() };
    }
    const r = orderService.propose(
      {
        symbol: p.symbol, side: p.side, type: 'LIMIT', price: p.price,
        quantity: clamped ? clamped.quantity : p.quantity,
        reason: clamped ? clamped.reason : p.reason,
      },
      { source: 'analyst' }
    );
    if (r.ok) created.push(r.proposal);
    // 🔴 버려진 제안을 조용히 넘기지 않는다 — 왜 안 만들어졌는지 화면이 알아야 한다
    else rejected.push({ symbol: p.symbol, side: p.side, error: r.error, missing: r.missing });
  }

  /**
   * 🔴 **산수는 코드가 한다.** 모델이 준 레벨로 손익비·수량을 여기서 계산해 붙인다.
   *    ⚠️ 위험예산은 **사용자가 정한 비율**에서 나온다 — 내가 임의로 정하지 않는다.
   *       설정이 없으면 계산을 **안 한다**(0 으로 두면 "위험 없음" 처럼 보인다).
   */
  /**
   * 수수료율 — **한 번만** 받아 모든 종목이 나눠 쓴다.
   * ⚠️ 실패하면 `null` 이고, 그러면 손익비에 **비용을 안 넣는다**(0 으로 치지 않는다).
   * 🔴 유효기간을 적용한다 — 라이브에서 미국 요율 `endDate` 가 **오늘**이었다(프로모션 종료).
   */
  let fees = null;
  try {
    const rows = await toss.getCommissions();
    fees = {};
    for (const r of rows) if (r.rate?.num != null) fees[r.market] = r.rate.num;
    const soon = rows.filter((r) => r.endsSoon);
    if (soon.length) {
      lines.push('', `⚠️ **곧 바뀌는 수수료율**: ${soon.map((r) => `${r.market} ${(r.rate.num * 100).toFixed(3)}% (~${r.endDate})`).join(' · ')}`);
    }
    if (Object.keys(fees).length) {
      lines.push('', `## 수수료율 (편도)\n${Object.entries(fees).map(([k, v]) => `${k} ${(v * 100).toFixed(3)}%`).join(' · ')}`);
      lines.push('⚠️ **세금·제비용은 빠져 있다** — 손익비의 `rrAfterFee` 는 *수수료만* 반영한 값이다.');
    }
  } catch (e) {
    logWarn('analyst.commissions_failed', { kind: e.kind, message: e.message });
  }

  const riskPct = Number(getDashboardSettings().riskPerTradePct);
  const accountKrw = Number(summary?.value?.krw) || 0;
  for (const ps of report.positions) {
    /**
     * 🔴 **진입만 비어 오는 반쪽을 메운다** (2026-10-02 라이브 실측).
     *
     * `QLD entry=null stop=92.70 target=103.72` — 손절·목표는 있는데 **진입이 없다.**
     * 그러면 `computeTrade` 가 `진입가 없음` 으로 끝나 **손익비·수량이 통째로 안 나오고**,
     * 화면엔 `손절 92.7 · 목표 103.72` 만 떠서 **무엇 대비 손절인지 알 수 없다.**
     *
     * ⚠️ 내가 프롬프트에 *"값을 못 정하면 비우십시오"* 를 넣은 **직후** 나왔다 —
     *    모델이 그 지시를 **진입에도** 적용했다. ★**지시를 하나 넣으면 그게 어디까지
     *    적용될지 본다** — 의도한 칸(0 대신 비우기)을 넘어 번졌다.
     *
     * ⇒ 진입이 비고 손절·목표 중 하나라도 있으면 **현재가를 진입으로** 쓴다.
     *   지어내는 것이 아니다 — 프롬프트가 이미 *"이미 보유면 **현재가 기준**"* 이라 정의했고,
     *   현재가는 **우리가 받은 사실**이다. 다만 **그렇게 했다는 표시를 남긴다.**
     */
    if (!ps.entry && (ps.stop || ps.target)) {
      const held0 = items.find((h) => String(h.symbol).toUpperCase() === String(ps.symbol).toUpperCase());
      const px0 = Number(held0?.lastPrice)
        || Number(tech?.[String(ps.symbol).toUpperCase()]?.last) || Number(tech?.[ps.symbol]?.last);
      if (px0 > 0) {
        ps.entry = px0;
        ps._entryFromPrice = true;
        logWarn('analyst.entry_filled_from_price', { symbol: ps.symbol, price: px0 });
      }
    }
    if (!ps.entry || !ps.stop) continue;
    // ⚠️ 계좌는 원화, 종목은 달러일 수 있다 — 통화가 섞이면 수량이 엉뚱해진다.
    //    보유 종목의 통화를 찾아 **같은 통화로** 예산을 환산한다.
    const held = items.find((h) => String(h.symbol).toUpperCase() === String(ps.symbol).toUpperCase());
    const fxRate = Number(fx?.rate) || 0;
    let budget = null;
    if (Number.isFinite(riskPct) && riskPct > 0 && accountKrw > 0) {
      const krwBudget = accountKrw * (riskPct / 100);
      budget = held?.currency === 'USD' ? (fxRate > 0 ? krwBudget / fxRate : null) : krwBudget;
    }
    /**
     * ⚠️ **평단을 진입으로 쓰는 것** (2026-10-03 관측, 3회 중 1회).
     *    `QLD entry=71.78` 은 **평단**이다(현재 98.13 · gap -27%). 이미 보유 중인데
     *    *"평단에 다시 산다"* 는 제안이 아니고, 차트 근거도 없다 — 모델이 **익숙한 숫자**를
     *    집은 것으로 보인다. ±50% 안이라 `entryFar` 에는 안 걸린다.
     * 🔴 **로그만 남기고 rr 은 건드리지 않는다** — 평단 근처가 **정당한 지지선**일 수도
     *    있어서 판정하면 오탐이 난다. 이 가드의 다른 처방들과 달리 **파괴적이지 않은 쪽**
     *    (관측)으로만 둔다. 관측이 쌓이면 그때 판정을 붙인다.
     * ⚠️ 평단과 현재가가 **가까우면 구분이 안 된다**(O: 평단 54.03 vs 현재 54.13) ⇒
     *    둘이 10% 넘게 떨어져 있을 때만 본다.
     */
    if (held && Number(held.avgPrice) > 0 && Number(ps.entry) > 0) {
      const avg = Number(held.avgPrice);
      const px = Number(held.lastPrice);
      const nearAvg = Math.abs(ps.entry - avg) / avg <= 0.01;
      const farFromPx = px > 0 && Math.abs(avg - px) / px > 0.10;
      if (nearAvg && farFromPx) {
        logWarn('analyst.entry_equals_avg', {
          symbol: ps.symbol, entry: ps.entry, avgPrice: avg, lastPrice: px,
          note: '평단을 진입가로 썼다 — 차트 근거가 아닐 수 있다',
        });
      }
    }
    const calc = computeTrade({
      side: ps.stance, entry: ps.entry, stop: ps.stop, target: ps.target, riskBudget: budget,
      /**
       * ⚠️ 현재가는 **보유면 lastPrice, 후보면 tech.last** 다. 한쪽만 보면
       *    후보 종목이 통째로 미검사가 된다(UUP 가 정확히 그 경우였다).
       */
      last: Number(held?.lastPrice) || Number(tech?.[String(ps.symbol).toUpperCase()]?.last)
        || Number(tech?.[ps.symbol]?.last) || null,
      // ⚠️ 통화가 아니라 **시장**으로 고른다(US/KR 요율이 다르다). 못 받았으면 안 넘긴다 — 0 으로 치지 않는다
      costRate: fees?.[held?.currency === 'USD' ? 'US' : 'KR'] ?? undefined,
    });
    ps.trade = { ...calc, currency: held?.currency || null };
  }

  // 🔴 웹검색 실패를 **코드가** dataGaps 에 적는다 — 모델에게 맡기면 빠뜨린다.
  //    "검사하지 않은 것" 이 "통과한 것" 으로 보이면 안 되는 그 규칙의 이 프로젝트 판본이다.
  /**
   * 🔴 **"못 구한 것" 과 "해당 없음" 을 가른다** (2026-09-22).
   *
   * 종전에는 한 바구니였다. 그래서 09-22 05시 마감 분석의 `gaps:7` 중 **2건이
   * *"QLD·RAM 은 ETF 라 기업 100점 채점 대상이 아닙니다"*** 였다 —
   * **우리가 일부러 만든 분리(기업↔ETF)가 결함처럼 계수된 것**이다.
   * 숫자만 보면 *"근거가 7개나 부족하다"* 로 읽혀 `proposed:0` 의 해석을 흐린다.
   *
   * ⇒ `missing`(못 구했다 = 진짜 결손) 과 `notApplicable`(해당 없다 = 정상) 로 가른다.
   * ⚠️ **합친 `dataGaps` 는 그대로 둔다** — 화면·프롬프트가 이미 쓰고 있고, 사람에게는
   *    *"못 본 것"* 으로 한 줄에 보이는 편이 낫다. **가르는 것은 세는 자리**다.
   */
  const gaps = [...(report.dataGaps || [])];
  const notApplicable = [];
  /**
   * 🔴 구조적 부재는 결손이 아니다 (2026-09-25 — 실측: 매 회차 gapsMissing 5~8 이
   *    전부 "5년 재무·PER/PBR·기관 수급·내부자·옵션 IV·목표주가 미제공" 고정 문구였다.
   *    SYSTEM_PROMPT 가 "이 시스템에 없다" 고 명시한 축을 모델이 성실히 받아 적은 것 —
   *    설계이지 결손이 아니다. missing 에 섞이면 **진짜 결손(뉴스 실패·캔들 실패)이 묻힌다.**
   * ⚠️ 목표주가는 pm2 소스 판정 후 채울 수도 있다 — 그때 이 목록에서 뺀다.
   */
  // 목표주가는 09-27 부터 제공(yahooStats financialData) — 구조적 부재 목록에서 뺐다(기업 종목의 진짜 실패가 숨지 않게)
const STRUCTURAL = /5년 재무|PER\/?PBR|기관 수급|내부자 거래|옵션 IV/;
  for (const g of report.dataGaps || []) {
    if (STRUCTURAL.test(String(g))) notApplicable.push(g);
  }
  for (const [sym, r] of Object.entries(ratings)) {
    if (r?.error) gaps.push(`${sym} 기업 평가 실패 — ${r.error}`);
    else if (r?.isFund) {
      // 🔴 "안 잰 것" 과 "재서 나쁜 것" 을 화면이 구분해야 한다 — ETF 는 점수가 **없다**.
      //    다만 이건 **결손이 아니라 설계**다 ⇒ 세는 바구니를 따로 쓴다
      const line = `${sym} 은 ETF·펀드 — 기업 100점 채점 대상이 아닙니다`;
      gaps.push(line);
      notApplicable.push(line);
    } else if (r && r.total == null) gaps.push(`${sym} 기업 평가 미완 — 항목이 다 안 채워졌습니다`);
  }
  if (useWebSearch) {
    if (!web?.ok) gaps.push(`웹 검색 사용 불가 — ${web?.error || '알 수 없음'}`);
    else if (web.failedCount) gaps.push(`웹 검색 일부 실패 (${web.failedCount}/${web.results.length}종목)`);
    /**
     * 🔴 **건너뛴 검색을 조용히 넘기지 않는다** (2026-10-01) — 정식 종목명을 못 구해
     *    맨 티커 질의를 포기한 경우다(`mcp.bare_ticker_skipped`). 안 적으면 모델도
     *    사용자도 **"그 종목 뉴스는 원래 없었다"** 로 읽는다. 실패는 아니지만 **결손이다.**
     */
    if (web.skippedCount) {
      gaps.push(`정식 종목명을 못 구해 뉴스 검색을 건너뛴 종목 ${web.skippedCount}건 (맨 티커 검색은 엉뚱한 결과를 준다)`);
    }
  } else {
    gaps.push('웹 검색을 끄고 분석했습니다.');
  }

  /**
   * 🔴 **`proposed:0` 만으로는 "살 게 없었다" 와 "판단을 못 했다" 가 구분되지 않는다** (2026-09-22).
   *
   * 실거래 첫날 05시 마감 분석이 `positions:2 proposed:0 gaps:7` 로 끝났는데,
   * 이 줄만 보면 **제안이 없는 이유를 알 수 없다** — 모델이 HOLD 라고 판단한 것인지,
   * 데이터가 모자라 판단 자체를 못 한 것인지. 답은 `analyst-last.json` 안에 있었지만
   * **요약 줄에는 개수만 실려** 운영 쪽에서 볼 수 없었다.
   *
   * ⚠️ 판정 장치 없이 사건(첫 자동 제안)을 기다릴 수는 없다 — **무엇을 기다리는지 모르게 된다.**
   *    ⇒ 판단 분포와 저확신 건수를 함께 낸다. `{HOLD:2}` 면 "살 게 없었다" 가 **줄에서 바로 읽힌다.**
   */
  const stances = {};
  let lowConfidence = 0;
  for (const pos of report.positions || []) {
    const k = String(pos?.stance || 'UNKNOWN').toUpperCase();
    stances[k] = (stances[k] || 0) + 1;
    if (String(pos?.confidence || '').toUpperCase() === 'LOW') lowConfidence += 1;
  }

  /**
   * 🔴 **0건이 왜 0건인지 소급으로 셀 수 있어야 한다** (2026-10-01)
   *
   * 41.6시간 4회차 중 3회차가 `proposed:0`(전부 HOLD)이었는데, 그게 *"살 게 없었다"* 인지
   * *"살 돈이 없었다"* 인지 **로그만으로는 영원히 알 수 없었다.** 그러면 "제안이 안 나온다" 는
   * 사용자 체감에 대해 아무도 답을 못 한다.
   *
   * ⚠️ **매 회차 정확히 한 줄**을 낸다(제안이 나온 회차도 `has_proposals` 로). 0건일 때만
   *    찍으면 *"줄이 없다"* 가 **"이유가 없다"와 "분석 자체가 안 돌았다"** 둘 다로 읽혀,
   *    이 저장소가 반복해 밟은 **「0 읽기」** 가족에 그대로 들어간다.
   * ⚠️ 현금은 **못 읽었으면 `null`**(= 모른다)이다 — 0 으로 적으면 "돈이 없다" 와
   *    "조회가 실패했다" 가 같은 숫자가 된다.
   * ⚠️ 매수 여력은 **매수에만** 걸린다 — 현금 0 이어도 SELL 제안은 나올 수 있으므로
   *    제안이 실재하면 그쪽이 이유다(여력 판정으로 덮지 않는다).
   */
  const proposedCount = report.proposals?.length || 0;
  const noProposalReason = dryRun && proposedCount ? 'dry_run_proposals'
    : created.length ? 'has_proposals'
      : proposedCount ? 'all_rejected'
        : capacity.state === 'unknown' ? 'cash_unknown'
          : capacity.state === 'blocked' ? 'no_buying_capacity'
            : 'model_proposed_none';

  /**
   * 🔴 **판단과 제안이 끊겼다** (2026-10-02 실측).
   *
   * 같은 계좌·같은 국면에서 3회 돌리니 한 회차가 `stances ["SELL","SELL","SELL"]` 인데
   * **`proposals` 는 0건**이었다. 모델이 *"팔아야 한다"* 고 결론 내리고도 수량·가격을
   * 못 정해 배열을 비워 둔 것이다. 사용자 화면에는 **"매매 제안 0건"** 만 남고,
   * *"모델이 지금은 아니라고 했다"* 와 **구분이 안 된다** — 침묵이 두 상태를 같게 만드는
   * 그 자리다(이 저장소가 09-28 하루 전체를 쓴 축).
   *
   * ⚠️ **코드가 제안을 지어내지 않는다.** 수량·가격은 주문의 핵심이고, 모델이 못 정한 것을
   *    코드가 채우면 그건 판단이 아니라 날조다. 대신 **사실을 말한다.**
   */
  {
    const acted = new Set((report.proposals || []).map((p) => String(p.symbol || '').toUpperCase()));
    const gap = (report.positions || [])
      .filter((p) => !p._codeFilled && /^(BUY|SELL)$/.test(String(p.stance || '').toUpperCase()))
      .map((p) => ({ symbol: String(p.symbol || '').toUpperCase(), stance: String(p.stance).toUpperCase() }))
      .filter((p) => !acted.has(p.symbol));
    if (gap.length) {
      logWarn('analyst.stance_without_proposal', { items: gap, proposals: (report.proposals || []).length });
      stanceGap = gap;
    }
  }

  logInfo('analyst.no_proposal_reason', {
    reason: noProposalReason,
    dryRun,
    capacity: capacity.state,
    floorPct: capacity.floorPct,
    /**
     * 🔴 **금액은 로그에 남기지 않는다 — 구간만 남긴다** (2026-10-01 판정).
     *
     * 첫 판은 `cashUsd`·`availableUsd` 같은 **실금액**을 실었다. `tossPortfolio.js:167`
     * 의 *"금액·수량은 로그에 남기지 않는다. 건수와 성패만."* 과 정면으로 어긋난다 —
     * 로그는 **디스크(journald)에 남고** 백업·오프사이트까지 따라간다.
     *
     * ⚠️ 그러면서 **목적은 잃지 않는다.** 이 줄의 목적은 *"왜 0건인가"* 를 소급으로 가르는
     *    것이고, 그 질문에는 **구간이면 충분하다**(아래 세 값이 서로 다른 처방을 가리킨다):
     *      `none`             버퍼를 빼면 남는 돈이 0 이하 — 가격과 무관하게 불가
     *      `under_one_share`  남긴 하는데 가장 싼 보유 종목 1주 값에 못 미침
     *      `ok`               살 수 있다 ⇒ 0건의 원인은 현금이 아니다
     *      `unknown`          못 읽었다 — 0 이 아니다
     * ★ 금액이 답하던 질문 중 **"언제쯤 가능해지나"** 만 못 답하는데, 그건 이 줄이 맡은
     *   질문이 아니다. 필요해지면 금액이 아니라 **무차원 비율 구간**(available÷1주값)을
     *   더하면 된다 — 금액을 되살릴 이유는 없다.
     * ⚠️ 사용자 **브리핑 본문에는 금액을 그대로 둔다** — 본인 폰이고, 이미 평단·수량이
     *    가는 자리다. 가리는 기준은 "민감하냐" 가 아니라 **"디스크에 남느냐"** 다.
     */
    cashBandUsd: capacityBand(capacity.byCurrency.USD),
    cashBandKrw: capacityBand(capacity.byCurrency.KRW),
    positions: report.positions?.length || 0,
    stances,
    proposed: proposedCount,
    created: created.length,
    rejected: rejected.length,
  });

  logInfo('analyst.report', {
    /**
     * 🔴 **dryRun 을 로그에 밝힌다** (2026-09-22). 점검 실행의 `stances:{SELL:1}` 을
     *    워치독이 실전으로 읽어 **사용자 폰에 "자동 제안이 나왔습니다" 를 두 번** 보냈다
     *    (17:23·17:28 — pm2 배포 검증이었다). 로그에 dryRun 표시가 없으면
     *    감시하는 쪽은 **원리상 구분할 수 없다.**
     */
    dryRun,
    positions: report.positions?.length || 0,
    proposed: report.proposals?.length || 0,
    created: created.length,
    rejected: rejected.length,
    // ★ 제안이 0 인 **이유**가 여기서 갈린다(판단했는데 HOLD / 판단 자체가 없음)
    stances,
    lowConfidence,
    // 🔴 `gaps` 는 **합계**다. 그중 "해당 없음"(설계대로 동작한 것)을 빼야 진짜 결손이 보인다
    gaps: gaps.length,
    gapsMissing: gaps.length - notApplicable.length,
    gapsNotApplicable: notApplicable.length,
    // ★ 새 기능이 **실제로 돌았다는 증거**를 지표에 함께 넣는다 — 0 이면 결과가 스스로 알려준다
    webTool: web?.tool || null,
    webHits: (web?.results || []).filter((r) => r.text).length,
    durationMs: Date.now() - started,
  });

  /**
   * 🔴 사용자: *"텔레그램 발송을 별도로 버튼으로 하지말고 … 애널리스트가 판단하면 바로 쏴."*
   *
   * ⚠️ 그런데 **화면에 들어올 때마다 분석이 자동으로 돈다**(사용자 요청). 그대로 쏘면
   *    새로고침 세 번에 **같은 글이 세 번** 간다 — 그건 사용자가 원한 "바로" 가 아니다.
   * ⇒ **내용이 같으면 안 보낸다.** 판단이 바뀌면 그때 바로 나간다.
   *    ★ "보내지 않는다" 가 아니라 "같은 말을 두 번 하지 않는다" 이다.
   * ⚠️ 발송 실패가 분석을 망치지 않는다 — 곁가지다.
   */
  /**
   * 🔴 **지문에 자유 서술을 넣으면 안 된다** (2026-09-21 — 내가 사용자 폰에 6건을 보냈다)
   *
   * 종전 지문은 `marketView`·`momentumRead` 를 포함했는데, 그건 **모델이 매번 다르게 쓰는 문장**이다.
   * ⇒ 판단이 똑같아도 지문이 달라져 **화면을 열 때마다 발송**됐다. 화면 진입 시 자동 분석이 도니
   *    사용자가 **새로고침만 해도** 알림이 온다. 중복 방지가 **자기 입력에 무력화**된 것이다.
   *
   * ★ 오늘 세 번째로 밟은 *"대리 지표를 불변식으로 착각"* 이다 — 내가 지키려던 불변식은
   *   *"**판단**이 바뀌었는가"* 인데 잰 것은 *"리포트 **글자**가 바뀌었는가"* 였다.
   *
   * ⇒ **결정만** 넣는다: 종목·방향·확신도 + 실제로 만들어진 주문.
   * ⚠️ 서술은 일부러 뺀다 — 같은 판단을 다르게 설명한 것은 **새 소식이 아니다.**
   */
  /**
   * 🔴 **정기 브리핑은 지문에서 빠져나가야 한다** (2026-09-22, pm2 지적).
   *
   * 지문을 *"결정만"* 으로 좁힌 건 옳았지만, 그 때문에 **브리핑이 삼켜진다**:
   * 개장·장중·마감에 전부 `HOLD` 면 결정이 같아 **둘째·셋째가 안 나간다.**
   * 사용자는 *"개장 브리핑이 안 왔네"* 로 보고, **조용히 사라져 아무도 모른다**
   * (*"점검이 다음 진짜 발송을 삼킨다"* 와 같은 가족).
   *
   * ⇒ **예정된 브리핑이면** 종류·시장·날짜를 지문에 넣어 **매 회차가 서로 다른 사건**이 되게 한다.
   * ⚠️ **모멘텀은 넣지 않는다** — 같은 판단으로 두 번 튀는 건 여전히 새 소식이 아니다.
   * ⚠️ 날짜를 넣는 이유: 안 넣으면 **어제 개장과 오늘 개장이 같은 지문**이라 이튿날이 막힌다.
   */
  const SCHEDULED = new Set(['preopen', 'open', 'mid', 'close']);
  // ⚠️ `trigger` 는 이 함수의 **구조분해 인자**다. 처음에 `opts?.trigger` 라 썼는데
  //    `opts` 는 선언된 적이 없어 **ReferenceError** 다 — 옵셔널 체이닝은 미선언 변수를 못 막는다.
  const brief = (trigger?.reasons || [])
    .filter((r) => SCHEDULED.has(r?.kind))
    .map((r) => `${r.key || ''}:${r.kind}`)
    .sort();
  const briefKey = brief.length
    ? `${brief.join(',')}@${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })}`
    : '';

  const digest = crypto
    .createHash('sha1')
    .update(JSON.stringify({
      p: (report.positions || []).map((x) => `${x.symbol}:${x.stance}:${x.confidence}`).sort(),
      c: created.map((x) => `${x.symbol}:${x.side}:${x.quantity}`).sort(),
      b: briefKey,
    }))
    .digest('hex');

  if (dryRun) {
    // 🔴 점검이면 **아무것도 안 보내고 digest 도 안 남긴다** — 다음 진짜 발송을 삼키지 않게
    logInfo('analyst.telegram_skipped', { why: 'dry_run' });
  } else if (digest === lastSentDigest) {
    // 🔴 안 보낸 이유를 남긴다 — "왜 안 오지" 를 겪지 않게
    logInfo('analyst.telegram_skipped', { why: 'same_decision' });
  } else if (Date.now() - (sentWindow.get(digest) || 0) < SEND_WINDOW_MS) {
    // ⚠️ 창 안에서 **이미 보낸 판단으로 되돌아왔다**(HOLD→SELL→HOLD) — 새 소식이 아니다
    logInfo('analyst.telegram_skipped', {
      why: 'recently_sent',
      agoSec: Math.round((Date.now() - sentWindow.get(digest)) / 1000),
    });
    lastSentDigest = digest;
  } else {
    const now = Date.now();
    lastSentDigest = digest;
    sentWindow.set(digest, now);
    // 창을 벗어난 것은 버린다 — 안 그러면 무한히 자란다
    for (const [k, t] of sentWindow) if (now - t > SEND_WINDOW_MS) sentWindow.delete(k);
    /**
     * 🔴 **사용자 발화 직전 토스 라이팅 정제** (2026-09-30 사용자 지시) — "모든 내부 분석
     *    시스템이 최종적으로 답변 나가기 전에 토스라이팅으로 정제되어 나갈 수 있게".
     *    ⚠️ **LLM 이 쓴 서술(marketView·momentumRead·종목별 rationale)만** 정제한다 —
     *    아래 이어지는 안내 문구(보유 판단 누락·제안 건수·검색 저하·못 본 것)는 **코드가
     *    보장하는 사실**이라 정제 대상에 안 넣는다. 통째로 넣으면 스타일 다듬는 모델이
     *    "잡초"로 보고 쳐낼 위험이 있고, 그건 이 저장소가 09-28 에 이미 겪은
     *    "코드가 보장한 사실을 프롬프트 단계에서 잃는다" 사고와 같은 자리다.
     */
    const proseLines = ['🧭 매매 분석'];
    if (report.marketView) proseLines.push('', report.marketView);
    if (report.momentumRead) proseLines.push('', `[모멘텀] ${report.momentumRead}`);
    for (const ps of report.positions || []) {
      proseLines.push('', `· ${ps.symbol} ${ps.stance}/${ps.confidence} — ${ps.rationale}`);
    }
    const lines = [];
    /**
     * 🔴 **종목별 근거 보고서를 폰으로 보낸다** (2026-10-02 사용자 지시:
     *    *"매도 매수 제안 근거 보고서도 없고 뭐하는거야? 토큰비용이 너무 아까운데?"*).
     *
     * 모델은 종목마다 `entry/stop/target/evidence/risk/scenarioUp/scenarioDown` 을 **이미
     * 만들고 있었다.** 시스템은 거기에 `trade`(R:R·수수료 반영·리스크 비중)까지 계산해
     * 붙였다. 그런데 폰으로 가는 건 `marketView`+`momentumRead` **두 문장뿐**이었고
     * 나머지는 전부 버려졌다 — *"수집해 놓고 안 쓰는"* 의 가장 비싼 형태다.
     * (실측 2026-10-02 05:48 회차: O 한 종목에만 진입 54.3·손절 52.5·목표 57.52·R:R 1.79·
     *  근거 2건·리스크·양방향 시나리오가 생성됐고 **단 한 줄도 전달되지 않았다.**)
     *
     * ⚠️ `lines` 에 넣는다 — 토스 라이팅 정제 대상이 아니다. 정제 모델이 숫자를 "잡초" 로
     *    쳐내면 **근거가 사라진 근거 보고서**가 된다(09-28 에 겪은 그 자리).
     * ⚠️ 길어지면 `telegramService` 가 4096자 경계에서 나눠 보낸다(10-02 추가).
     */
    if ((report.positions || []).length) {
      lines.push('', '━━━ 종목별 근거 ━━━');
      for (const ps of report.positions) {
        const t = ps.trade || {};
        const n = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : null);
        lines.push('', `▸ ${ps.symbol} — ${ps.stance}/${ps.confidence}`);
        const lv = [
          n(ps.entry) && `진입 ${n(ps.entry)}`,
          n(ps.stop) && `손절 ${n(ps.stop)}`,
          n(ps.target) && `목표 ${n(ps.target)}`,
          n(t.rr) && `R:R ${n(t.rr)}${n(t.rrAfterFee) ? `(수수료후 ${n(t.rrAfterFee)})` : ''}`,
          n(t.riskPct) && `리스크 ${n(t.riskPct, 1)}%`,
        ].filter(Boolean);
        if (lv.length) lines.push(`  ${lv.join(' · ')}`);
        const ev = (ps.evidence || []).filter(Boolean);
        if (ev.length) lines.push(`  근거: ${ev.join(' · ')}`);
        if (ps.risk) lines.push(`  리스크: ${ps.risk}`);
        if (ps.scenarioUp) lines.push(`  ↑ ${ps.scenarioUp}`);
        if (ps.scenarioDown) lines.push(`  ↓ ${ps.scenarioDown}`);
      }
    }
    /**
     * 🔴 **보유가 있는데 재시도(위 1262~1295행) 후에도 판단이 통째로 비면 조용히 넘어가지
     *    않는다** (2026-09-28 실사고 — 08:47·12:17 두 회차가 시황만 오고 종목 판단이
     *    아예 없이 "정상 발송" 됐다). 사용자는 이걸 "브리핑이 왔다" 로 받아서 실패로 안
     *    보였다. ⇒ 폰으로 가는 이 본문에 직접 적는다.
     * ⚠️ **보유가 0 이면 아무 말도 안 한다** — 그건 정상이다(보유가 없으면 판단도 없다).
     *    오탐하면 매 회차 울린다.
     */
    /**
     * 🔴 **부분 누락을 잡는다** (2026-10-02 실사고). 종전 가드는 `!report.positions.length`
     *    — **통째로 비었을 때만** 봤다. 08:00 회차는 보유 3종 중 **2종만** 판단했고
     *    리얼티 인컴(O)이 조용히 빠졌는데 **아무 경고도 안 났다.**
     *    사용자: *"브리핑 내용도 지금 전혀 내 자산 현황을 고려하지 않는데?"*
     * ★ 0건은 잡으면서 부분 누락은 못 잡는 모양 — 이 저장소가 반복해 밟은 자리다.
     *    **집합의 차**로 본다(건수 비교가 아니라).
     */
    /**
     * ⚠️ **코드가 채운 자리는 "판단 받음" 이 아니다** (2026-10-02). 재시도까지 실패하면
     *    코드가 `_codeFilled` 항목을 넣어 **종목이 화면에서 사라지지 않게** 한다 —
     *    그런데 그걸 판단으로 세면 경고가 꺼지고, *"판단을 받았다"* 와 *"자리만 채웠다"* 가
     *    같아진다. 이 저장소가 반복해 밟은 *"검사 안 한 것을 통과로 보여주지 않는다"* 다.
     */
    const judged = new Set((report.positions || [])
      .filter((p) => !p._codeFilled)
      .map((p) => String(p.symbol || '').toUpperCase()));
    const missed = heldSymbols.filter((sym) => !judged.has(String(sym).toUpperCase()));
    if (missed.length) {
      lines.push('', `⚠️ 보유 ${missed.length}종(${missed.join('·')}) 판단이 빠졌습니다`
        + `${judged.size ? ` — 나머지 ${judged.size}종만 판단했습니다` : ''}`);
      // ⚠️ `symbols` 는 **기존 계약**이다(빠진 종목) — 이름을 바꾸면 소비자가 조용히 깨진다
      logWarn('analyst.positions_missing_in_brief', {
        symbols: missed, judged: [...judged], held: heldSymbols, partial: judged.size > 0,
      });
    }
    // 제안은 `orderService` 가 **승인 버튼과 함께** 따로 쏘므로 여기서는 건수만 적는다
    if (created.length) lines.push('', `🟡 매매 제안 ${created.length}건 — 승인 버튼이 곧 옵니다`);
    /**
     * 🔴 **0건으로 끝난 회차는 "왜 0건인지" 를 사용자에게 말한다** (2026-10-01).
     *
     * 지금까지 이 자리는 **침묵**이었다. 그래서 사용자 화면에서
     *   · 현금이 없어 **구조적으로 제안이 불가능한 상태**(실측: USD 3.76 · 버퍼 2,351)와
     *   · 모델이 보고 판단해서 **"지금은 아니다" 라고 한 정상 회차**가
     * **똑같이 보였다.** 침묵이 정상과 고장을 같은 모양으로 만드는 그 자리다.
     *
     * ⚠️ 코드가 보장하는 사실이므로 `proseLines`(LLM 서술·토스라이팅 정제 대상)가 아니라
     *    **여기(`lines`)** 에 넣는다 — 정제 모델이 "잡초" 로 쳐내면 안 되는 문장이다.
     */
    else lines.push('', `💤 매매 제안 0건 — ${describeNoProposal(noProposalReason, capacity, { proposed: proposedCount, rejected })}`);
    /**
     * 🔴 **"팔라고 해놓고 제안이 없다" 를 사용자에게 말한다** — 안 적으면 "제안 0건" 이
     *    *"모델이 지금은 아니라고 했다"* 로 읽힌다. 그건 사실이 아니다.
     */
    if (stanceGap.length) {
      lines.push('', `🔴 판단은 났는데 제안이 없습니다 — ${stanceGap.map((x) => `${x.symbol} ${x.stance}`).join(' · ')}`
        + ' (모델이 수량·가격을 정하지 못했습니다. 직접 정하시거나 다시 분석을 돌려 주세요.)');
    }
    /**
     * 🔴 **검색 품질 저하를 사용자가 보는 곳에도 코드로 적는다** (2026-09-28, pm1 지시).
     *    `web.degraded` 는 지금까지 **LLM 프롬프트에만**(1137행) 실렸다 — 모델이 그 귀띔을
     *    자기 문장에 반영하지 않으면 사용자는 저품질 출처였다는 걸 영영 모른다. "프롬프트는
     *    지시일 뿐이고 보장은 코드가 한다" 는 이 저장소 규율 그대로, **프롬프트 귀띔은
     *    그대로 두고** 여기서 독립적으로 보장한다.
     * ⚠️ `web` 이 `null`(검색 자체를 안 함)이거나 `degraded` 가 없으면(undefined) 한 글자도
     *    안 낸다 — 평상시 본문을 더럽히면 사람이 안 읽는다.
     * ⚠️ 어느 소스였는지는 **실제로 있으면만** 적는다(`mcpClient.js` 가 이미 결과별
     *    `source` 를 담아 준다 — 지어내지 않는다).
     */
    if (web?.degraded) {
      const altSources = [...new Set((web.results || []).map((r) => r.source).filter((s) => s && !/^brave/i.test(s)))];
      lines.push('', `⚠️ 뉴스가 대체 검색 소스에서 왔습니다(품질 낮음${altSources.length ? ` — ${altSources.join('·')}` : ''})`);
    }
    if (gaps.length) lines.push('', `못 본 것: ${gaps.join(' · ')}`);
    // 정제는 서술 부분에만, 코드가 보장하는 안내 문구(lines)는 그대로 뒤에 붙인다.
    // analyze() 자체를 안 막는다 — 종전처럼 fire-and-forget 사슬에 한 단계만 끼운다.
    tossWriting
      .refine(proseLines.join('\n'), { logLabel: 'toss_writing_brief' })
      .then((refinedProse) => telegram.send([refinedProse, ...lines].join('\n'), { reason: 'analysis' }))
      .then((r) => logInfo('analyst.telegram', { sent: Boolean(r.sent), why: r.why || null }))
      .catch((e) => logWarn('analyst.telegram_failed', { message: e.message }));
  }

  // 🔴 분석 기록을 **시간축에 남긴다**(사용자: "모든 분석 기록들이 시간순으로")
  /**
   * ⚠️ 타임라인 제목이 **"(시황 요약 없음)"** 이면 사용자는 *"분석이 안 됐다"* 로 읽는다.
   *    시황 문장이 없어도 **종목 판단은 있을 수 있다** — 그걸 제목으로 쓴다.
   */
  const title = report.marketView
    || (report.positions.length
      ? report.positions.map((p) => `${p.symbol} ${p.stance}`).join(' · ')
      : report._unreadable ? '⚠️ 모델 응답을 읽지 못했습니다' : '(판단 없음)');

  activity.record('analysis', title, {
    positions: report.positions?.length || 0,
    proposals: created.length,
    rejected: rejected.length,
    stances,
    lowConfidence,
    gaps: gaps.length,
    gapsMissing: gaps.length - notApplicable.length,
    webHits: (web?.results || []).filter((r) => r.text).length,
  });

  return {
    at: new Date().toISOString(),
    marketView: report.marketView || '',
    momentumRead: report.momentumRead || '',
    dataGaps: gaps,
    // ⚠️ 합친 목록은 그대로 두고 **분류만 함께** 낸다(화면·프롬프트가 `dataGaps` 를 쓴다)
    dataGapsNotApplicable: notApplicable,
    positions: report.positions || [],
    created,
    rejected,
    tech,
    ratings,
    web: web
      ? { ok: web.ok, tool: web.tool, hits: (web.results || []).filter((r) => r.text).length, error: web.error || null }
      : { ok: false, tool: null, hits: 0, error: '웹 검색을 끄고 실행했습니다.' },
  };
}

/**
 * 🔴 인버스 게이트 — 사용자 규칙(09-24)을 코드로 강제한다. 스펙트럼 시뮬 실증:
 *    프롬프트에 규칙이 있는데도 모델이 횡보에서 PSQ 매수를 냈다.
 *    실전(analyze)과 백테스트(decideOnContext)가 **같은 함수**를 태운다 — 게이트가 두 벌이면 갈라진다.
 */



function inverseGate(p, regimeState) {
  const inv = require('./regimeService').readCatalog().categories?.inverse_hedge?.etfs || [];
  const hit = inv.find((e) => e.symbol === String(p.symbol).toUpperCase());
  if (!hit || String(p.side).toUpperCase() !== 'BUY') return { ok: true };
  const mkt = hit.market === 'KR' ? 'kr' : 'us';
  const trend = regimeState?.[mkt]?.trend ?? null;
  if (Math.abs(hit.leverage) !== 1) return { ok: false, why: `${hit.leverage}x 인버스는 명시 요청으로만 (사용자 규칙)` };
  if (trend !== 'down') return { ok: false, why: `${mkt.toUpperCase()} 가 확정 하락추세가 아니다(현재 ${trend ?? '판정불가'}) — 인버스는 확정 하락에서만 (사용자 규칙)` };
  return { ok: true };
}

/**
 * 🔴 제품 판단 진입점 (2026-09-24, 사용자 지시 — 백테스트가 "simpleStock 의 판단" 을 그대로 쓰게).
 *
 * analyze() 는 실데이터 수집·제안 등록·발송이 결합돼 있어 가상 세계를 태울 수 없다.
 * 이 함수는 **판단만** 한다: 같은 SYSTEM_PROMPT · 같은 REPORT_SCHEMA · 같은 shapeReport ·
 * 같은 인버스 게이트. 컨텍스트(국면·후보·보유·현금)는 호출자가 준다 — 실전은 실데이터,
 * 백테스트는 합성 세계. **판단 코드가 한 벌**이라 백테스트 결과가 실전을 대표한다.
 * ⚠️ 부작용 0: 제안을 등록하지 않는다(orderService 를 안 부른다) — 반환만.
 */
/**
  * ⚠️ `holdings` 는 **선택**이다 — 안 주면 보유 방침을 **판정하지 않고 그 사실을 로그로 남긴다**
  *    (모르면 막지 않는다. 다만 조용히 통과시키지도 않는다).
  */
async function decideOnContext({ contextText, regimeState = null, holdings = [] }) {
  const raw = await generateStructuredOutput({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: String(contextText || ''),
    schema: REPORT_SCHEMA,
    logLabel: 'trade_analyst_ctx',
  }, { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] });
  const report = shapeReport(raw);
  const accepted = [];
  const rejected = [];
  for (const p of report.proposals || []) {
    const gate = inverseGate(p, regimeState);
    if (gate.ok) accepted.push(p);
    else rejected.push({ ...p, error: gate.why });
  }
  return { report, proposals: accepted, rejected };
}

module.exports = {
  // ⚠️ 테스트가 **구조 불변식**을 잴 수 있게 내보낸다 — 숨겨 두면 둘이 갈라져도 모른다
  _reportSchemaFor: reportSchemaFor, _REPORT_SCHEMA: REPORT_SCHEMA, _shapeReport: shapeReport,
  savePrompt, readLastPrompt, LAST_PROMPT_FILE, portfolioWeights,
  analyze, saveLast, readLast, _resetSendStateForTest, summarizeCandles, shapeReport,
  computeTrade, decideOnContext, inverseGate, REPORT_SCHEMA, SYSTEM_PROMPT,
  // ⚠️ 검증용 노출 — 매수 여력 판정은 **네트워크·LLM 없이** 재야 한다(순수 함수로 유지한 이유)
  assessBuyingCapacity, capacityDetail, capacityBand, describeNoProposal, watchMovesSection,
};
