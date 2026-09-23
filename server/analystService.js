const { generateStructuredOutput, getAiSettings } = require('./aiService');
const { getDashboardSettings } = require('./settingsService');
const orderService = require('./orderService');
const toss = require('./tossClient');
const stockIdentity = require('./stockIdentity');
const mcp = require('./mcpClient');
const rating = require('./stockRating');
const activity = require('./activityLog');
const telegram = require('./telegramService');
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
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          stance: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
          confidence: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
          rationale: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string' },
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

const SYSTEM_PROMPT = [
  '당신은 매수·매도 판단을 내리는 선임 주식 애널리스트입니다.',
  '',
  // 🔴 출력 길이 = 시간(초당 ~24토큰 고정). 이 지시 없이 6,905~9,762토큰을 써서 120초×3 타임아웃
  '⚠️ 시간 예산이 120초뿐입니다. **전체 출력 2,000토큰 이내** — rationale·evidence·risk 는 각 1~2문장,',
  'marketView·momentumRead 는 각 3문장 이내. 길게 쓰면 답이 통째로 버려집니다.',
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
  '',
  '## proposals (매매 제안)',
  '- **확신이 있을 때만** 냅니다. 없으면 빈 배열이 정답입니다.',
  '- symbol·side·quantity·price 를 **전부 숫자로** 채웁니다. 하나라도 비면 그 제안은 버려집니다.',
  '- quantity 는 **보유 수량과 현금 여력을 넘지 않게** 합니다. 매도는 보유 수량 이내입니다.',
  '- price 는 지정가입니다. 현재가에서 **터무니없이 먼 값을 쓰지 않습니다**.',
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
  if (!stance) return null;
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
  if (!symbol || !quantity || !price) return null;
  return { symbol, side, quantity, price, reason: pickString(o, ['reason', 'rationale', 'why']) };
}

/** 어떤 모양으로 오든 리포트로 만든다 */
function shapeReport(out) {
  const o = out && typeof out === 'object' ? out : {};
  const arrays = Object.values(o).filter(Array.isArray);

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

  return {
    marketView: view,
    momentumRead: mom,
    dataGaps: gaps.slice(0, 12),
    positions,
    proposals,
    // 🔴 아무것도 못 읽었으면 **그 사실을 남긴다** — 조용히 빈 리포트를 내지 않는다
    _unreadable: !view && !positions.length && !gaps.length ? JSON.stringify(o).slice(0, 300) : null,
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
function computeTrade({ side, entry, stop, target, riskBudget, costRate }) {
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
  if (Number.isFinite(t) && t > 0) {
    const reward = isBuy ? t - e : e - t;
    out.rr = reward > 0 ? round2(reward / perShareRisk) : null;
    if (out.rr === null) out.rrNote = '목표가가 진입 대비 이익 방향이 아닙니다';
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
  return out;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * 리포트를 만든다. 실패해도 **부분 결과를 돌려준다**(조각 실패를 전체 실패로 만들지 않는다).
 * @param {object} dash `/api/dashboard` 결과
 */
/**
 * @param {object} opts
 * @param {boolean} [opts.dryRun] 🔴 **부작용 없이** 분석만 한다 — 텔레그램 발송도, 제안 생성도 안 한다.
 *   pm2: *"검증이 곧 발송이다. 칠 때마다 사용자가 알림을 받는다."* 맞는 지적이고,
 *   **검증할 수 없는 경로는 결국 검증 안 된 채로 배포된다.**
 *   ⚠️ `lastSentDigest` 도 **건드리지 않는다** — 점검이 다음 진짜 발송을 삼키면 안 된다.
 */
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
  const BRIEF_KINDS = new Set(['open', 'mid', 'close']);
  const MARKET_NAME = { kr: '한국 증시(코스피·코스닥)', us: '미국 증시(S&P500·나스닥)' };
  const briefMarkets = [...new Set((trigger?.reasons || [])
    .filter((r) => BRIEF_KINDS.has(r?.kind) && MARKET_NAME[r?.key])
    .map((r) => r.key))];
  /** 그 시장에 보유·감시 종목이 하나도 없으면 **시장 자체**를 검색 주제로 넣는다 */
  const marketSubjects = briefMarkets
    .filter((m) => !items.some((i) => (m === 'kr') === (String(i.market).toUpperCase() === 'KR')))
    .map((m) => ({ symbol: m.toUpperCase(), name: MARKET_NAME[m], market: m }));

  let web = null;
  if (useWebSearch) {
    // ⚠️ **일부러 통째로 넘긴다.** 걸러서 넘기면 가드가 호출부에 있는 셈이고,
    //    다음 사람이 이 줄을 고치는 순간 조용히 뚫린다. `buildQuery` 가 두 칸만 읽는다.
    // ⚠️ 시장 주제를 **앞에** 둔다 — `maxSubjects` 로 잘릴 때 종목보다 시황이 먼저 살아남게
    web = await mcp.searchMarketNews([...marketSubjects, ...items]);
    if (!web.ok) logWarn('analyst.web_unavailable', { kind: web.kind, error: web.error });
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

  const lines = [];
  lines.push('## 계좌');
  if (summary) {
    lines.push(
      `평가 ${fmt(summary.value?.krw, 0)}원(환산) · 평가손익률 ${fmt(summary.profitRate)}% · 당일 ${fmt(summary.dailyRate)}%`
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
      const krw = Number(c.krw?.amount || 0);
      const usd = Number(c.usd?.amount || 0);
      if (c.krw && c.usd && krw <= 0 && usd <= 0) {
        // 🔴 살 돈이 없으면 **매수 제안 자체가 불가능**하다. 모델이 그걸 알아야 한다
        lines.push('🔴 **현금이 사실상 0 입니다 — 신규 매수 제안을 내지 마세요.** 매도·보유 판단만 하세요.');
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
    open: '**개장 브리핑**이다. 직전 세션(밤사이 해외장 포함)에서 넘어온 흐름과 **시가 갭**을 먼저 짚고, '
      + '오늘 이 종목들에서 **무엇을 지켜볼 것인지**를 말하라. 지금 당장의 매매보다 **관전 포인트**가 중심이다.',
    mid: '**장중 브리핑**이다. 개장 이후 흐름이 **개장 때 본 그림과 같은지 달라졌는지**를 먼저 말하라. '
      + '달라졌으면 무엇이 바뀌었는지 짚고, 같으면 "유지" 라고 분명히 말하라. **바뀐 게 없으면 없다고 하라** — 억지로 새 얘기를 만들지 마라.',
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
        const parts = [['개인', 'individual'], ['외국인', 'foreigner'], ['기관', 'institution'], ['기타법인', 'otherCorporation']]
          .map(([ko, k]) => { const n = net(k); return n == null ? null : `${ko} ${n > 0 ? '+' : ''}${n}억`; })
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
    lines.push('⚠️ 아래는 외부 검색 결과입니다. **날짜와 출처를 확인하고** 인용하세요.');
    for (const r of webHits) {
      lines.push('', `### ${r.name || r.symbol}`, r.text.slice(0, 2500));
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
  const raw = await generateStructuredOutput({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: lines.join('\n'),
    schema: REPORT_SCHEMA,
    logLabel: 'trade_analyst',
    fallback: { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] },
  });

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
  const heldSymbols = items.map((h) => String(h.symbol).toUpperCase());
  if (heldSymbols.length && report.positions.length < heldSymbols.length) {
    const missing = heldSymbols.filter(
      (s) => !report.positions.some((p) => String(p.symbol).toUpperCase() === s)
    );
    logWarn('analyst.positions_short', { got: report.positions.length, need: heldSymbols.length, missing });
    const retryRaw = await generateStructuredOutput({
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
      schema: REPORT_SCHEMA,
      logLabel: 'trade_analyst_retry',
      fallback: { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] },
    });
    const retried = shapeReport(retryRaw);
    logInfo('analyst.retry_done', { before: report.positions.length, after: retried.positions.length });
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

  // 제안을 orderService 로 넘긴다 — **빈칸이 있으면 거기서 거부된다**
  const created = [];
  const rejected = [];
  for (const p of dryRun ? [] : (report.proposals || [])) {
    /**
     * 🔴 **계좌로 먼저 막는다** — 모델이 낼 수 없는 제안을 폰으로 보내면
     *    사용자가 승인을 누르고 나서야 실패를 안다. 그건 HITL 이 아니라 헛수고다.
     * ⚠️ 못 물어봤으면(`unknown`) **통과가 아니다** — 막고 이유를 화면에 적는다.
     */
    const chk = await orderService.checkAccountLimits({
      symbol: p.symbol, side: p.side, quantity: p.quantity, price: p.price,
    });
    if (!chk.ok) {
      rejected.push({ symbol: p.symbol, side: p.side, error: chk.error, kind: chk.kind });
      logWarn('analyst.proposal_blocked', { symbol: p.symbol, side: p.side, kind: chk.kind, error: chk.error });
      continue;
    }
    const r = orderService.propose(
      { symbol: p.symbol, side: p.side, type: 'LIMIT', quantity: p.quantity, price: p.price, reason: p.reason },
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
    const calc = computeTrade({
      side: ps.stance, entry: ps.entry, stop: ps.stop, target: ps.target, riskBudget: budget,
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
  const SCHEDULED = new Set(['open', 'mid', 'close']);
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
    const lines = ['🧭 매매 분석'];
    if (report.marketView) lines.push('', report.marketView);
    if (report.momentumRead) lines.push('', `[모멘텀] ${report.momentumRead}`);
    for (const ps of report.positions || []) {
      lines.push('', `· ${ps.symbol} ${ps.stance}/${ps.confidence} — ${ps.rationale}`);
    }
    // 제안은 `orderService` 가 **승인 버튼과 함께** 따로 쏘므로 여기서는 건수만 적는다
    if (created.length) lines.push('', `🟡 매매 제안 ${created.length}건 — 승인 버튼이 곧 옵니다`);
    if (gaps.length) lines.push('', `못 본 것: ${gaps.join(' · ')}`);
    telegram
      .send(lines.join('\n'), { reason: 'analysis' })
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

module.exports = { analyze, saveLast, readLast, _resetSendStateForTest, summarizeCandles, shapeReport, computeTrade, REPORT_SCHEMA, SYSTEM_PROMPT };
