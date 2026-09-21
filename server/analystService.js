const { generateStructuredOutput, getAiSettings } = require('./aiService');
const { getDashboardSettings } = require('./settingsService');
const orderService = require('./orderService');
const toss = require('./tossClient');
const mcp = require('./mcpClient');
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

/** 직전에 보낸 분석의 지문 — 같은 내용을 두 번 보내지 않는다 */
let lastSentDigest = null;

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    marketView: { type: 'string' },
    momentumRead: { type: 'string' },
    dataGaps: { type: 'array', items: { type: 'string' } },
    positions: {
      type: 'array',
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

  const view = pickString(o, ['marketView', 'market_view', 'marketSummary', 'summary', 'overview', 'view'])
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
function computeTrade({ side, entry, stop, target, riskBudget }) {
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
async function analyze(dash, { userInstruction = '', useWebSearch = true, fx = null } = {}) {
  const items = dash?.portfolio?.items || [];
  const summary = dash?.portfolio?.summary || null;

  /**
   * 웹 검색(my-computer MCP). 🔴 **검색어에 수량·금액을 싣지 않는다** — 종목명·티커만 넘긴다.
   * ⚠️ 실패해도 리포트는 난다. 검색은 곁가지이지 본체가 아니다.
   */
  let web = null;
  if (useWebSearch) {
    // ⚠️ **일부러 통째로 넘긴다.** 걸러서 넘기면 가드가 호출부에 있는 셈이고,
    //    다음 사람이 이 줄을 고치는 순간 조용히 뚫린다. `buildQuery` 가 두 칸만 읽는다.
    web = await mcp.searchMarketNews(items);
    if (!web.ok) logWarn('analyst.web_unavailable', { kind: web.kind, error: web.error });
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
  } else {
    lines.push('보유 정보를 받지 못했습니다.');
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

  // 🔴 "없는 데이터" 는 **실제로 못 받은 것만** 적는다.
  //    검색이 붙었는데도 "뉴스 없음" 이라 적으면 모델이 있는 근거를 안 쓴다.
  const missingAxes = [
    '재무제표·매출/이익',
    'PER/PBR/EV·DCF',
    '애널리스트 목표가',
    '기관/외국인 수급 상세',
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
  const report = shapeReport(raw);
  if (report._unreadable) {
    logWarn('analyst.unreadable_shape', { raw: report._unreadable });
  }

  // 제안을 orderService 로 넘긴다 — **빈칸이 있으면 거기서 거부된다**
  const created = [];
  const rejected = [];
  for (const p of report.proposals || []) {
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
    const calc = computeTrade({ side: ps.stance, entry: ps.entry, stop: ps.stop, target: ps.target, riskBudget: budget });
    ps.trade = { ...calc, currency: held?.currency || null };
  }

  // 🔴 웹검색 실패를 **코드가** dataGaps 에 적는다 — 모델에게 맡기면 빠뜨린다.
  //    "검사하지 않은 것" 이 "통과한 것" 으로 보이면 안 되는 그 규칙의 이 프로젝트 판본이다.
  const gaps = [...(report.dataGaps || [])];
  if (useWebSearch) {
    if (!web?.ok) gaps.push(`웹 검색 사용 불가 — ${web?.error || '알 수 없음'}`);
    else if (web.failedCount) gaps.push(`웹 검색 일부 실패 (${web.failedCount}/${web.results.length}종목)`);
  } else {
    gaps.push('웹 검색을 끄고 분석했습니다.');
  }

  logInfo('analyst.report', {
    positions: report.positions?.length || 0,
    proposed: report.proposals?.length || 0,
    created: created.length,
    rejected: rejected.length,
    gaps: gaps.length,
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
  const digest = crypto
    .createHash('sha1')
    .update(JSON.stringify({
      v: report.marketView,
      m: report.momentumRead,
      p: (report.positions || []).map((x) => `${x.symbol}:${x.stance}`),
      c: created.map((x) => `${x.symbol}:${x.side}:${x.quantity}`),
    }))
    .digest('hex');

  if (digest !== lastSentDigest) {
    lastSentDigest = digest;
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
  } else {
    // 🔴 안 보낸 이유를 남긴다 — "왜 안 오지" 를 겪지 않게
    logInfo('analyst.telegram_skipped', { why: 'same_as_last' });
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
    gaps: gaps.length,
    webHits: (web?.results || []).filter((r) => r.text).length,
  });

  return {
    at: new Date().toISOString(),
    marketView: report.marketView || '',
    momentumRead: report.momentumRead || '',
    dataGaps: gaps,
    positions: report.positions || [],
    created,
    rejected,
    tech,
    web: web
      ? { ok: web.ok, tool: web.tool, hits: (web.results || []).filter((r) => r.text).length, error: web.error || null }
      : { ok: false, tool: null, hits: 0, error: '웹 검색을 끄고 실행했습니다.' },
  };
}

module.exports = { analyze, summarizeCandles, shapeReport, computeTrade, REPORT_SCHEMA, SYSTEM_PROMPT };
