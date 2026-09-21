const { generateStructuredOutput, getAiSettings } = require('./aiService');
const { getDashboardSettings } = require('./settingsService');
const orderService = require('./orderService');
const toss = require('./tossClient');
const mcp = require('./mcpClient');
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
].join('\n');

function fmt(n, d = 2) {
  return n == null ? '-' : Number(n).toFixed(d);
}

/** 일봉에서 **계산으로 확인 가능한** 것만 뽑는다(모델이 추정하지 않게) */
function summarizeCandles(rows) {
  if (!rows || rows.length < 20) return null;
  const closes = rows.map((r) => r.c).filter(Number.isFinite);
  const last = closes[closes.length - 1];
  const ma = (n) => {
    if (closes.length < n) return null;
    const s = closes.slice(-n).reduce((a, b) => a + b, 0);
    return s / n;
  };
  const hi = Math.max(...closes);
  const lo = Math.min(...closes);
  return {
    last,
    ma20: ma(20),
    ma60: ma(60),
    high: hi,
    low: lo,
    fromHighPct: hi ? ((last - hi) / hi) * 100 : null,
    fromLowPct: lo ? ((last - lo) / lo) * 100 : null,
    bars: closes.length,
  };
}

/**
 * 리포트를 만든다. 실패해도 **부분 결과를 돌려준다**(조각 실패를 전체 실패로 만들지 않는다).
 * @param {object} dash `/api/dashboard` 결과
 */
async function analyze(dash, { userInstruction = '', useWebSearch = true } = {}) {
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
          ? ` · 20일선 ${fmt(t.ma20)} · 60일선 ${fmt(t.ma60)} · ${t.bars}일 고점대비 ${fmt(t.fromHighPct)}% · 저점대비 ${fmt(t.fromLowPct)}%`
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
  const report = await generateStructuredOutput({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: lines.join('\n'),
    schema: REPORT_SCHEMA,
    logLabel: 'trade_analyst',
    fallback: { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] },
  });

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

module.exports = { analyze, summarizeCandles, REPORT_SCHEMA, SYSTEM_PROMPT };
