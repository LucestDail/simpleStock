const { logInfo, logWarn, logError } = require('./logger');

/**
 * my-computer MCP 클라이언트 (2026-09-21)
 *
 * 사용자: *"my-computer 쪽이랑 연계해서 a2a / mcp 연계를 통해 시장 웹 검색 기능을 연계해"*
 *
 * ## 🔴 "없다" 가 아니라 "그 경로로 안 돈다" 였다
 *
 * 피어가 소스를 열어 확인해 준 것 — `WebSearchTool.java`·`WebPageTool.java` 는 **있는데**
 * 내부 에이전트에만 등록돼 있고 MCP 에는 `computer*` 14개만 올라가 있었다.
 * ⇒ 검색 API 를 새로 붙일 뻔한 것을 **소스 확인 한 번이 막았다.**
 *
 * ## 이름을 박지 않고 `tools/list` 로 찾는다
 *
 * 환경변수에 도구 이름을 박으면 **"내가 아는 이름" 과 "실제 있는 이름" 이 갈릴 때 조용히 실패**한다.
 * 목록을 읽어서 고르면, 없을 때 `dataGaps` 에 *"웹검색 도구 미노출"* 로 **화면에 뜬다.**
 * 오늘 랭킹 종류를 추측해 400 을 맞은 것과 같은 실수를 안 하려는 것이다
 * (그때 원인은 **내 스펙 덤프가 긴 enum 을 잘라서** — 문서를 봤는데도 틀렸다).
 *
 * ## ⚠️ 응답이 SSE 로 온다
 *
 * streamable-http 는 같은 엔드포인트가 JSON 도 SSE 도 돌려준다. SSE 프레임은
 * `data:` 뒤 **공백이 있을 수도 없을 수도** 있고(피어가 오늘 여기 걸렸다), 한 줄이 아닐 수도 있다.
 * ⇒ `data:` 접두사만 떼고 **여러 줄을 이어 붙인 뒤** 파싱한다.
 *
 * ## 지키는 선 (사용자 자산이 밖으로 나가지 않게)
 *
 * 🔴 **검색어에 보유 수량·평가금액·계좌를 싣지 않는다.** 종목명·티커까지만.
 *    외부 검색 엔진에 흘러가는 것은 되돌릴 수 없다.
 * 🔴 **읽기 전용 도구만 부른다.** 이름이 `computer*` 인 것은 목록에 있어도 고르지 않는다.
 * ⚠️ 실패해도 리포트는 난다 — 검색은 **곁가지**이지 본체가 아니다.
 */

const URL_RAW = String(process.env.MYCOMPUTER_MCP_URL || '').trim();
const TOKEN = String(process.env.MYCOMPUTER_MCP_TOKEN || '').trim();
const TIMEOUT_MS = Math.max(3000, Number(process.env.MYCOMPUTER_MCP_TIMEOUT_MS) || 20000);
/** 🔴 기본 꺼짐. 미설정이 켜짐이 되면 안 된다 */
const ENABLED = String(process.env.MYCOMPUTER_MCP_ENABLED || '').trim().toLowerCase() === 'true';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'simpleStock', version: '3.0.0' };

/**
 * 고를 도구를 **이름이 아니라 쓸모**로 찾는다.
 * `tools/list` 가 준 이름·설명에서 검색/페이지읽기에 해당하는 것을 고른다.
 */
const SEARCH_HINTS = ['web_search', 'websearch', 'search_web'];
const FETCH_HINTS = ['web_page', 'webpage', 'fetch_page', 'read_page', 'web_fetch'];
/** 🔴 읽기 전용이 아닌 것은 목록에 있어도 안 부른다 */
const NEVER = ['computer', 'shell', 'exec', 'file', 'write', 'delete', 'workflow'];

let sessionId = null;
let nextId = 1;
/** `tools/list` 결과 캐시. 재기동·재연결하면 다시 읽는다 */
let toolsCache = null;

class McpError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'McpError';
    this.kind = kind; // unconfigured|disabled|auth|timeout|transport|protocol|no-tool|tool-error
  }
}

function isConfigured() {
  return Boolean(URL_RAW && TOKEN);
}

function status() {
  return {
    configured: isConfigured(),
    enabled: ENABLED,
    // 둘 다여야 실제로 부른다. 화면이 **어느 쪽이 막고 있는지** 알 수 있어야 한다
    effective: isConfigured() && ENABLED ? 'live' : 'off',
    reason: !isConfigured() ? 'url_or_token_missing' : ENABLED ? null : 'disabled',
    url: URL_RAW ? URL_RAW.replace(/\/\/[^@]*@/, '//***@') : null,
    session: sessionId ? 'established' : 'none',
    toolsKnown: toolsCache ? toolsCache.length : null,
  };
}

/**
 * SSE 프레임 또는 그냥 JSON 을 파싱한다.
 * ⚠️ `data:` 뒤 공백은 **있을 수도 없을 수도** 있다. 여러 `data:` 줄은 이어 붙인다.
 */
function parseBody(text, contentType) {
  const body = String(text || '');
  if (!/text\/event-stream/i.test(contentType || '') && !/^\s*(event|data|id|retry)\s*:/m.test(body)) {
    return JSON.parse(body);
  }
  const chunks = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (m) chunks.push(m[1]);
  }
  if (!chunks.length) throw new McpError('SSE 응답에 data 프레임이 없습니다.', 'protocol');
  return JSON.parse(chunks.join('\n'));
}

async function rpc(method, params, { notify = false } = {}) {
  if (!isConfigured()) throw new McpError('MCP 주소·토큰이 설정되지 않았습니다.', 'unconfigured');

  const payload = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };

  const headers = {
    'Content-Type': 'application/json',
    // streamable-http 는 둘 다 받을 수 있다고 알려야 한다
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
    'X-My-Computer-Auth': TOKEN,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  let res;
  try {
    res = await fetch(URL_RAW, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || /abort/i.test(e?.message || '');
    // ⚠️ 타임아웃과 연결 실패를 **구분**한다 — 처방이 다르다
    throw new McpError(
      timedOut ? `MCP 응답이 ${TIMEOUT_MS}ms 안에 오지 않았습니다.` : `MCP 연결 실패: ${e.message}`,
      timedOut ? 'timeout' : 'transport'
    );
  }

  // 서버가 세션을 새로 주면 받아 둔다(초기화 응답에 온다)
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (res.status === 401 || res.status === 403) {
    sessionId = null;
    throw new McpError(`MCP 인증 거부 (${res.status}). X-My-Computer-Auth 토큰을 확인하세요.`, 'auth');
  }
  if (res.status === 404 && sessionId) {
    // 세션이 만료됐다 — 다음 호출에서 다시 초기화하게 비운다
    sessionId = null;
    throw new McpError('MCP 세션이 만료되었습니다. 다시 시도하세요.', 'protocol');
  }

  if (notify) return null;

  const text = await res.text();
  if (!res.ok) {
    throw new McpError(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`, 'transport');
  }

  let json;
  try {
    json = parseBody(text, res.headers.get('content-type'));
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError(`MCP 응답을 해석하지 못했습니다: ${text.slice(0, 200)}`, 'protocol');
  }

  if (json.error) {
    throw new McpError(`MCP 오류 ${json.error.code}: ${json.error.message}`, 'protocol');
  }
  return json.result;
}

/** initialize → notifications/initialized. 이미 세션이 있으면 건너뛴다 */
async function connect() {
  if (sessionId) return;
  const result = await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  // ⚠️ 이 알림을 빠뜨리면 서버가 도구 호출을 거부한다(핸드셰이크 미완)
  await rpc('notifications/initialized', {}, { notify: true });
  logInfo('mcp.connected', {
    server: result?.serverInfo?.name || null,
    version: result?.serverInfo?.version || null,
    protocol: result?.protocolVersion || null,
    session: Boolean(sessionId),
  });
}

async function listTools({ refresh = false } = {}) {
  if (toolsCache && !refresh) return toolsCache;
  await connect();
  const result = await rpc('tools/list', {});
  toolsCache = (result?.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    schema: t.inputSchema || null,
  }));
  logInfo('mcp.tools_listed', { count: toolsCache.length, names: toolsCache.map((t) => t.name) });
  return toolsCache;
}

/**
 * 이름 힌트로 도구를 고른다. 🔴 `NEVER` 에 걸리면 무조건 제외.
 *
 * ⚠️ **네임스페이스 접두사는 동작이 아니다.** `mycomputer.web_search` 는 서버 이름이
 *    앞에 붙은 것일 뿐인데, 이름 전체에서 `computer` 를 찾으면 **정당한 검색 도구가 막힌다**
 *    (테스트를 쓰다 걸렸다 — 실제로 붙을 법한 이름이라 그대로 뒀으면 기능이 조용히 안 돌았다).
 *    ⇒ 금지 판정은 **마지막 구획**(`.`/`:`/`/` 뒤)에만 적용한다. `mycomputer.computerShell`
 *      은 마지막 구획이 `computerShell` 이므로 여전히 막힌다.
 */
function action(name) {
  const parts = String(name).split(/[./:]/);
  return parts[parts.length - 1] || String(name);
}

function pick(tools, hints) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const normHints = hints.map(norm);
  return (
    tools.find((t) => {
      if (NEVER.some((bad) => norm(action(t.name)).includes(bad))) return false;
      return normHints.some((h) => norm(t.name).includes(h));
    }) || null
  );
}

/**
 * 🔴 **라이브에서만 보인 것** — `webSearch` 의 `content[0].text` 가 **JSON 인코딩된 문자열**로 온다.
 *    따옴표로 감싸여 있고 줄바꿈이 `\n` **문자 두 개**다(컨테이너 안에서 실제로 태워 보고 알았다.
 *    스텁 테스트는 평문을 돌려주니 **영원히 안 보인다**).
 *    그대로 모델에 먹이면 리터럴 `\n` 이 잔뜩 섞인 글을 근거로 쓰게 된다.
 * ⚠️ 양끝이 따옴표일 때만, 파싱에 성공할 때만 푼다 — 실패하면 **원문을 그대로** 둔다.
 */
function unwrapJsonString(text) {
  const s = String(text);
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === 'string' ? parsed : s;
  } catch {
    return s;
  }
}

/**
 * 도구를 부른다. 결과의 `content` 에서 텍스트만 뽑는다.
 * @returns {string}
 */
async function callTool(name, args) {
  await connect();
  const result = await rpc('tools/call', { name, arguments: args });
  // 🔴 MCP 는 도구 실패를 **200 + isError** 로 준다 — HTTP 만 보면 성공으로 읽는다
  if (result?.isError) {
    const msg = (result.content || []).map((c) => c.text || '').join(' ').slice(0, 300);
    throw new McpError(`도구 ${name} 실패: ${msg || '(내용 없음)'}`, 'tool-error');
  }
  const parts = (result?.content || [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => unwrapJsonString(c.text));
  return parts.join('\n\n');
}

/**
 * 검색어를 만든다. 🔴 **여기가 자산이 밖으로 나가는 유일한 문이다.**
 *
 * ⚠️ 호출자가 무엇을 넘기든 **이름·티커 두 칸만 읽는다**(허용목록). 첫 판에서는 호출부에서
 *    미리 걸러 넘겼는데, 그러면 **가드가 호출자에게 있는 셈**이라 다음 사람이 보유 객체를
 *    통째로 넘기는 순간 뚫린다. 실제로 내 변이 테스트가 그래서 **안 잡혔다** —
 *    테스트가 이미 걸러진 객체를 넘기고 있어서 검사할 것이 없었던 것이다.
 *    ★ *"재려던 그것이 대상에 들었나"* 를 안 물으면 자가 공허하게 통과한다.
 * @param {{symbol?:string, name?:string}} subject 보유 객체를 통째로 넘겨도 안전하다
 */
function buildQuery(subject) {
  const name = String(subject?.name || '').trim();
  const symbol = String(subject?.symbol || '').trim();
  // 🔴 수량·평단·평가금액·계좌번호는 **이 함수가 읽지 않는다**
  /**
   * 🔴 **시장 단위 주제** (2026-09-22 사용자 지시 — *"종목 없으면 전반적인 시황 브리핑"*).
   *    보유가 없는 시장은 종목 질의가 하나도 안 만들어져 **웹 검색이 통째로 비어** 있었다.
   * ⚠️ 여기도 **`name`·`market` 두 칸만** 읽는다 — 자유 문자열 질의를 받게 열어 두면
   *    수량·금액을 안 싣는다는 보장이 **호출부로 새어 나간다**.
   */
  /**
   * 🔴 "주가 뉴스 전망" 은 SEO 자석이다 (2026-09-24 실측) — 그 질의로 온 5건이 전부
   *    점술 사이트·종목토론방 댓글·광고·포털 링크였다(실증 0). 짧은 질의가 뉴스 소스에서
   *    더 잘 든다(어제 실측: 단독 en 질의 100건 vs "전망" 포함 0건과 같은 계열).
   */
  if (subject?.market) return `${name || symbol} 증시 마감 시황`;
  /**
   * 🔴 맨 티커는 뉴스 인덱스에서 **다른 뜻이 이긴다** (2026-09-24 pm2 실측):
   *    'QLD' → 퀸즐랜드 럭비·경찰 / 'RAM stock' → PC 램 품귀. US ETF 는 name 이 곧
   *    티커라 이 구멍에 빠진다. 정식명은 4/4 금융('ProShares Ultra QQQ'·'Roundhill DRAM').
   *    ⇒ **officialName(종목 정체, 어제 신설) 우선** — 보유 items 에는 이미 붙어 있다.
   *    ⚠️ 여기도 정해진 칸만 읽는다(officialName·name·symbol) — 자유 질의 금지 불변.
   */
  const official = String(subject?.officialName || '').trim();
  return official || name || symbol;
}

/**
 * 종목 시장 뉴스를 찾는다.
 *
 * 🔴 **검색어에 보유 수량·금액이 절대 들어가지 않는다** — `buildQuery` 가 두 칸만 읽는다.
 * @param {Array<{symbol:string,name:string}>} subjects
 * @returns {Promise<{ok:boolean, tool:string|null, results:Array, error?:string, kind?:string}>}
 */
async function searchMarketNews(subjects, { maxSubjects = 5 } = {}) {
  if (!ENABLED) {
    return { ok: false, tool: null, results: [], error: 'MCP 연계가 꺼져 있습니다.', kind: 'disabled' };
  }
  try {
    const tools = await listTools();
    const tool = pick(tools, SEARCH_HINTS);
    if (!tool) {
      // ⚠️ "도구가 없다" 를 조용히 빈 결과로 만들지 않는다 — 화면이 알아야 한다
      return {
        ok: false,
        tool: null,
        results: [],
        error: `웹검색 도구가 MCP 에 노출되어 있지 않습니다. 사용 가능: ${tools.map((t) => t.name).join(', ') || '(없음)'}`,
        kind: 'no-tool',
      };
    }

    const results = [];
    for (const s of (subjects || []).slice(0, maxSubjects)) {
      const query = buildQuery(s);
      try {
        const text = await callTool(tool.name, buildArgs(tool, query));
        results.push({ symbol: s.symbol, name: s.name, query, text: String(text).slice(0, 4000) });
      } catch (e) {
        // 한 종목이 실패해도 나머지는 간다 — 조각 실패를 전체 실패로 만들지 않는다
        logWarn('mcp.search_failed', { symbol: s.symbol, kind: e?.kind, message: e?.message });
        results.push({ symbol: s.symbol, name: s.name, query, error: e.message, kind: e.kind });
      }
    }
    const failed = results.filter((r) => r.error).length;
    logInfo('mcp.search_done', { tool: tool.name, asked: results.length, failed });
    return { ok: true, tool: tool.name, results, failedCount: failed };
  } catch (e) {
    logError('mcp.search_error', e, {});
    return { ok: false, tool: null, results: [], error: e.message, kind: e.kind || 'transport' };
  }
}

/**
 * 도구 스키마를 보고 인자를 만든다.
 *
 * ⚠️ 필드명을 추측해 박지 않는다 — **스키마가 말하는 이름**을 쓴다.
 *
 * 🔴 **검색어 칸만 채우면 안 된다.** 피어가 준 실물 스키마에서
 *    `webSearch` 의 필수 필드가 **`query` 와 `limit` 둘**이었다. `limit` 을 빼면 호출이 실패하는데,
 *    첫 판의 내 코드는 `query` 만 채우고 끝냈다 — **실물을 안 봤으면 그대로 400 을 맞았을 것이다.**
 *    (오늘 랭킹 종류를 추측해 맞은 400 과 같은 자리다. 이번엔 실물을 받고 고쳤다.)
 *    ⇒ 필수 필드를 **전수로 훑어** 빠짐없이 채운다.
 */
const MAX_RESULTS = 5;

function fillRequired(props, required, filled) {
  const args = { ...filled };
  for (const key of required) {
    if (key in args) continue;
    const spec = props[key] || {};
    // 타입이 말하는 대로 채운다. 모르는 타입은 **건드리지 않는다**(틀린 값보다 없는 값이 낫다)
    if (spec.type === 'integer' || spec.type === 'number') args[key] = MAX_RESULTS;
    else if (spec.type === 'boolean') args[key] = false;
    else if (spec.type === 'array') args[key] = [];
    else if (spec.type === 'string' && Array.isArray(spec.enum) && spec.enum.length) args[key] = spec.enum[0];
  }
  return args;
}

function buildArgs(tool, query) {
  const props = tool.schema?.properties;
  if (!props) return { query };
  const required = tool.schema?.required || [];

  let queryKey = null;
  for (const key of ['query', 'q', 'search', 'keyword', 'text', 'input']) {
    if (props[key]) {
      queryKey = key;
      break;
    }
  }
  if (!queryKey) {
    // 문자열 필수 필드가 딱 하나면 그것이 검색어다
    const strings = required.filter((k) => props[k]?.type === 'string');
    if (strings.length === 1) queryKey = strings[0];
  }
  const filled = { [queryKey || 'query']: query };
  /**
   * 🔴 recency 를 스키마가 받으면 채운다 (2026-09-24) — 시장 뉴스는 신선도가 곧 실증성이다.
   *    안 채우면 my-computer 가 일반 웹 검색으로 가서 SEO 상위(점술·포털)가 이긴다(실측 5/5).
   *    ⚠️ 필수만 채우는 fillRequired 와 별개 — 이건 **옵션이라도 아는 필드는 값으로** 의사표시.
   */
  if (props.recency?.type === 'string') {
    filled.recency = Array.isArray(props.recency.enum) && props.recency.enum.length
      ? (props.recency.enum.includes('1d') ? '1d' : props.recency.enum[0])
      : '1d';
  }
  return fillRequired(props, required, filled);
}

function _resetForTest() {
  sessionId = null;
  toolsCache = null;
  nextId = 1;
}

module.exports = {
  isConfigured,
  status,
  listTools,
  callTool,
  searchMarketNews,
  parseBody,
  pick,
  buildArgs,
  McpError,
  action,
  buildQuery,
  unwrapJsonString,
  SEARCH_HINTS,
  FETCH_HINTS,
  NEVER,
  _resetForTest,
};
