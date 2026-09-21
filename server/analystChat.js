const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGeminiClient, isAiConfigured } = require('./geminiClient');
const { getEffectiveAiConfig } = require('./settingsService');
const { logInfo, logWarn, logError } = require('./logger');
const toss = require('./tossClient');
const tossPortfolio = require('./tossPortfolio');
const mcp = require('./mcpClient');

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
    description: '최신 뉴스·시장 정보를 웹에서 찾는다. 종목명이나 주제어를 넣는다.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '검색어. 보유 수량·금액은 절대 넣지 않는다.' } },
      required: ['query'],
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

const SYSTEM_PROMPT = [
  '당신은 사용자의 주식 포트폴리오를 함께 보는 매수·매도 애널리스트입니다.',
  '',
  '## 도구를 씁니다',
  '- 추측하지 말고 **도구로 확인**합니다. 보유를 물으면 get_portfolio, 추세는 get_candles,',
  '  최신 소식은 web_search, 예전에 한 얘기는 recall 을 씁니다.',
  '- 도구가 실패하면 **실패했다고 말합니다.** 값을 지어내지 않습니다.',
  '',
  '## 답하는 방식',
  '- **제공된 숫자를 인용**합니다. 근거 없는 수치는 쓰지 않습니다.',
  '- 재무제표·DCF·PER/PBR·기관 수급·내부자 거래·옵션 IV 는 이 시스템에 **없습니다**.',
  '  필요하면 "그 데이터는 없다" 고 말합니다.',
  '- 뭉뚱그리지 않습니다. 판단이 안 서면 "판단 못 하겠다" 고 그렇게 말합니다.',
  '- 한국어로, 과장 없이 씁니다.',
  '',
  '## 🔴 주문은 내지 않습니다',
  '매수/매도는 **제안까지만** 합니다. 실행은 사람이 승인합니다. 당신은 주문을 넣을 수 없습니다.',
].join('\n');

// ── 이력 (append-only) ───────────────────────────────────────

/**
 * 🔴 **덮어쓰지 않고 이어붙인다.** 대화는 '현재 상태' 가 아니라 **'일어난 일의 목록'** 이다
 *    (Probius `AuditStore` 와 같은 이유). 통째로 다시 쓰면 동시 쓰기에 한쪽이 사라진다.
 */
function appendHistory(entry) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
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
 * recall — 과거 대화에서 관련 대목을 찾는다.
 *
 * ⚠️ 임베딩을 쓰지 않는다. **낱말 겹침**으로 고른다 — 이력이 수천 건 규모가 아니고,
 *    임베딩을 넣으면 외부 호출이 하나 더 늘어 실패 지점이 늘어난다.
 *    ★ 나중에 이력이 커지면 그때 바꾼다. **지금 확인할 수 있는 것**을 만든다.
 */
function recall(query, { limit = RECALL_LIMIT, history = null } = {}) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/)
    .filter((t) => t.length >= 2);
  if (!terms.length) return [];

  const rows = history || readHistory();
  const scored = [];
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const text = String(r.text || '');
    const hay = text.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    if (score) scored.push({ score, at: r.at, role: r.role, text: text.slice(0, 400) });
  }
  // 점수 높은 것 우선, 같으면 최근 것 우선
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
      const p = await tossPortfolio.getHoldings({ fx: ctx.fx || null });
      return {
        summary: p.summary,
        items: (p.items || []).map((h) => ({
          symbol: h.symbol, name: h.name, market: h.market, currency: h.currency,
          quantity: h.quantity, avgPrice: h.avgPrice, lastPrice: h.lastPrice,
          profitRate: h.profitRate, dailyRate: h.dailyRate,
        })),
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
    case 'recall': {
      const hits = recall(String(args.query || ''));
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
function sanitizeQuery(q) {
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
async function chat({ message, emit, fx = null, contextNote = '' }) {
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
  const recalled = recall(text, { history });
  if (recalled.length) emit('recall', { count: recalled.length, items: recalled.slice(0, 3) });

  // 최근 대화 몇 턴을 맥락으로(전부 싣지 않는다 — 토큰과 혼선)
  const recent = history.filter((h) => h.role === 'user' || h.role === 'assistant').slice(-8);

  const contents = [];
  for (const h of recent) {
    contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.text || '') }] });
  }
  const preface = [];
  if (contextNote) preface.push(`## 지금 화면 상태\n${contextNote}`);
  if (recalled.length) {
    preface.push(
      '## 과거 대화에서 찾은 것 (recall)\n' +
        recalled.map((r) => `- [${r.at}] ${r.role === 'user' ? '사용자' : '나'}: ${r.text}`).join('\n')
    );
  }
  contents.push({
    role: 'user',
    parts: [{ text: preface.length ? `${preface.join('\n\n')}\n\n## 질문\n${text}` : text }],
  });

  const config = {
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    ...(runtime.includeThoughts && runtime.thinkingBudget > 0
      ? { thinkingConfig: { includeThoughts: true, thinkingBudget: runtime.thinkingBudget } }
      : {}),
  };

  let answer = '';
  let rounds = 0;
  let toolCalls = 0;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    rounds = round;
    const calls = [];
    const modelParts = [];

    const stream = await ai.models.generateContentStream({ model: runtime.model, contents, config });
    for await (const chunk of stream) {
      for (const part of partsOf(chunk)) {
        if (part.functionCall) {
          calls.push(part.functionCall);
          modelParts.push({ functionCall: part.functionCall });
          continue;
        }
        if (typeof part.text !== 'string' || !part.text) continue;
        if (part.thought) {
          // 🔴 사고 과정은 **답과 섞지 않는다** — 화면이 따로 접어 둘 수 있어야 한다
          emit('thinking_delta', { text: part.text });
        } else {
          answer += part.text;
          modelParts.push({ text: part.text });
          emit('text_delta', { text: part.text });
        }
      }
    }

    if (!calls.length) break;

    // 모델이 도구를 불렀다 — 실행하고 결과를 붙여 **다시** 물어본다
    contents.push({ role: 'model', parts: modelParts });
    const responseParts = [];
    for (const call of calls.slice(0, MAX_CALLS_PER_ROUND)) {
      const callId = crypto.randomUUID().slice(0, 8);
      toolCalls += 1;
      emit('tool_call', { id: callId, name: call.name, args: call.args || {} });
      let result;
      try {
        result = await runTool(call.name, call.args || {}, { fx });
        emit('tool_result', { id: callId, name: call.name, ok: true, preview: preview(result) });
      } catch (e) {
        // 🔴 실패도 모델에게 돌려준다. 삼키면 모델이 "받았다" 고 착각하고 지어낸다
        result = { ok: false, error: e.message, kind: e.kind || 'unknown' };
        logWarn('chat.tool_failed', { name: call.name, kind: e.kind, message: e.message });
        emit('tool_result', { id: callId, name: call.name, ok: false, error: e.message });
      }
      responseParts.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });

    if (round === MAX_ROUNDS) {
      // ⚠️ 상한에 걸린 것을 **조용히 넘기지 않는다** — 답이 어중간한 이유를 사람이 알아야 한다
      emit('notice', { text: `도구 호출 상한(${MAX_ROUNDS}바퀴)에 걸려 여기서 멈췄습니다.` });
    }
  }

  appendHistory({ at: new Date().toISOString(), turnId, role: 'assistant', text: answer, toolCalls, rounds });
  logInfo('chat.turn', { turnId, rounds, toolCalls, chars: answer.length, recalled: recalled.length, durationMs: Date.now() - startedAt });
  return { turnId, rounds, toolCalls, chars: answer.length, recalled: recalled.length };
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
  readHistory,
  appendHistory,
  TOOL_DECLARATIONS,
  SYSTEM_PROMPT,
  HISTORY_FILE,
  MAX_ROUNDS,
};
