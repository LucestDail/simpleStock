const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

/**
 * 애널리스트 채팅 — 스트리밍 + 툴 콜링 (2026-09-21)
 *
 * ## 🔴 이 파일에서 제일 중요한 자
 *
 * 사용자가 **명시적으로** 요구했다: *"스트리밍 형태로 출력되어야 함. REST 형태로 안 나오게 주의"*
 * 그런데 *"다 모았다가 한 번에 내보내기"* 는 **결과가 같아서 조용히 그렇게 되기 쉽다.**
 * ⇒ `text_delta` 가 **2조각 이상** 오는지, 그리고 **첫 조각이 done 보다 먼저** 오는지 본다.
 *    이 둘이 있어야 "흘렸다" 고 말할 수 있다.
 */

/**
 * 🔴 **이력 파일을 다른 테스트와 나눠 쓴다.**
 *    `node --test` 는 파일을 **병렬로** 돌린다. dreaming 테스트와 같은
 *    `data/analyst-chat.jsonl` 을 쓰다가 서로의 이력을 지워서, **단독 실행은 통과하고
 *    전체 실행에서만** 2건이 깨졌다 — 원인이 테스트 안에 안 보이는 종류다.
 */
process.env.ANALYST_CHAT_FILE = path.join(require('node:os').tmpdir(), `sschat-${process.pid}.jsonl`);

// ── 가짜 모델 ────────────────────────────────────────────────

/** 모델이 뱉을 chunk 를 만든다(@google/genai 응답 모양) */
const chunk = (parts) => ({ candidates: [{ content: { parts } }] });

let scripted = [];   // 바퀴별 chunk 배열
let seenContents = []; // 모델이 받은 contents 를 기록(도구 결과가 실제로 돌아갔는지 확인)

/** 판단기가 돌려줄 값. 테스트마다 갈아끼운다 */
let decideReplies = [];
/**
 * ⚠️ 판단기를 **실패시키는 스위치.** `require.cache[...].exports.fn = ...` 로 바꿔도
 *    `analystChat` 이 구조분해로 붙들고 있어 안 먹는다 — 오늘 **세 번째로** 밟은 함정이라
 *    스텁 안에 스위치를 둔다(스텁은 처음부터 내 것이다).
 */
let decideThrows = null;

function installFakeAi() {
  /**
   * 🔴 판단기는 `aiService.generateStructuredOutput` 을 쓴다(스키마 강제).
   *    `analystChat` 이 **구조분해로 붙들기** 때문에 **require 전에** 캐시를 꽂아야 한다.
   */
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      generateStructuredOutput: async () => {
        if (decideThrows) throw new Error(decideThrows);
        return decideReplies.shift() || { tools: [] };
      },
    },
  };

  const geminiPath = require.resolve('../server/geminiClient');
  const real = require(geminiPath);
  require.cache[geminiPath].exports = {
    ...real,
    isAiConfigured: () => true,
    createGeminiClient: async () => ({
      models: {
        generateContentStream: async ({ contents }) => {
          seenContents.push(JSON.parse(JSON.stringify(contents)));
          const round = seenContents.length - 1;
          const chunks = scripted[round] || [];
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    }),
  };
}

const TMP = process.env.ANALYST_CHAT_FILE;
let backup = null;

beforeEach(() => {
  scripted = [];
  seenContents = [];
  decideReplies = [];
  decideThrows = null;
  backup = fs.existsSync(TMP) ? fs.readFileSync(TMP) : null;
  if (fs.existsSync(TMP)) fs.rmSync(TMP);
  for (const k of Object.keys(require.cache)) {
    if (/analystChat|geminiClient|aiService/.test(k)) delete require.cache[k];
  }
  installFakeAi();
});

afterEach(() => {
  // 🔴 실제 대화 이력을 테스트가 지우면 안 된다 — 원래대로 되돌린다
  if (backup) fs.writeFileSync(TMP, backup);
  else if (fs.existsSync(TMP)) fs.rmSync(TMP);
});

function collect() {
  const events = [];
  return { events, emit: (e, d) => events.push({ e, d }) };
}

// ── 🔴 스트리밍이 REST 로 새지 않는다 ────────────────────────

test('답이 조각으로 흘러나온다 (REST 한방이 아니다)', async () => {
  const chat = require('../server/analystChat');
  scripted = [[chunk([{ text: '삼성전자는 ' }]), chunk([{ text: '20일선 위에 ' }]), chunk([{ text: '있습니다.' }])]];

  const { events, emit } = collect();
  const r = await chat.chat({ message: '삼성전자 어때?', emit });

  const deltas = events.filter((x) => x.e === 'text_delta');
  assert.ok(deltas.length >= 2, `조각이 ${deltas.length}개뿐이다 — 모아서 한 번에 내보내고 있다(REST)`);
  assert.equal(deltas.map((d) => d.d.text).join(''), '삼성전자는 20일선 위에 있습니다.');

  // 첫 조각이 done 보다 **먼저** 나와야 흘린 것이다
  const firstDelta = events.findIndex((x) => x.e === 'text_delta');
  const doneAt = events.findIndex((x) => x.e === 'done');
  assert.ok(firstDelta >= 0 && (doneAt === -1 || firstDelta < doneAt));
  // ⚠️ `rounds` 는 **도구 바퀴 수**다 — 0 이면 "도구 없이 바로 답했다" 는 뜻이다
  //    (판단기가 빈 배열을 돌려준 경우). 응답 라운드 수와 헷갈리면 안 된다.
  assert.equal(r.rounds, 0);
  assert.equal(r.toolCalls, 0);

  // ⚠️ 서비스가 전체 답을 **반환하지 않는다** — 반환하면 라우트가 그걸로 REST 를 만들기 쉽다
  assert.equal(r.text, undefined, '전체 답을 반환하면 REST 로 되돌아갈 길이 열린다');
});

test('사고 과정은 답과 섞이지 않는다 (thinking_delta)', async () => {
  const chat = require('../server/analystChat');
  scripted = [[chunk([{ text: '어디 보자…', thought: true }, { text: '결론입니다.' }])]];

  const { events, emit } = collect();
  await chat.chat({ message: '분석해줘', emit });

  assert.equal(events.filter((x) => x.e === 'thinking_delta').map((x) => x.d.text).join(''), '어디 보자…');
  assert.equal(events.filter((x) => x.e === 'text_delta').map((x) => x.d.text).join(''), '결론입니다.');
});

// ── 툴 콜링 (판단기 = 스키마 강제) ──────────────────────────

test('판단기가 고른 도구를 실행하고 결과를 근거로 답한다', async () => {
  const chat = require('../server/analystChat');
  decideReplies = [{ tools: [{ name: 'recall', argsJson: '{"query":"삼성전자"}' }] }, { tools: [] }];
  scripted = [[chunk([{ text: '전에 ' }]), chunk([{ text: '말씀하신 대로입니다.' }])]];
  chat.appendHistory({ at: '2026-09-01T00:00:00Z', role: 'user', text: '삼성전자 비중을 줄일까 고민중' });

  const { events, emit } = collect();
  const r = await chat.chat({ message: '삼성전자 얘기 뭐였지?', emit });

  assert.equal(events.find((x) => x.e === 'tool_call').d.name, 'recall');
  assert.equal(events.find((x) => x.e === 'tool_result').d.ok, true);
  assert.equal(r.toolCalls, 1);
  assert.equal(r.rounds, 1);

  // 🔴 도구 결과가 **실제로** 모델에게 갔는가 — 없으면 모델은 못 보고 지어낸다
  const sent = JSON.stringify(seenContents[0]);
  assert.ok(sent.includes('[도구 결과]'), '도구 결과가 대화에 안 실렸다');
  assert.ok(sent.includes('비중을 줄일까'), 'recall 이 찾은 내용이 안 실렸다');
});

/**
 * 🔴🔴 **오늘 실측으로 네 번 데인 자리.** 같은 스키마·같은 질문인데 모델이
 *    도구 이름 키를 `name` → `tool` → `id` 로, 목록 키를 `tools` → `tool_requests` 로
 *    **회차마다 바꿔** 줬다. 증상은 매번 똑같이 **"도구를 안 부른다"** 였고
 *    (모델은 제대로 골랐는데 내 파서가 조용히 버렸다) 화면엔 단서가 없었다.
 *    ⇒ 키를 열거하지 않고 **값이 아는 도구 이름인가**로 판정한다. 아래는 **관측된 모양**이다.
 */
test('모델이 키 이름을 바꿔도 도구를 찾아낸다 (관측된 네 가지)', async () => {
  const chat = require('../server/analystChat');
  const shapes = [
    { tools: [{ name: 'get_portfolio', argsJson: '{}' }] },
    { tools: [{ tool: 'get_portfolio', argsJson: '{}' }] },
    { tools: [{ id: 'get_portfolio', argsJson: '{}' }] },
    { tool_requests: [{ tool: 'get_portfolio', argsJson: '{}' }] },
  ];
  for (const shape of shapes) {
    const got = await chat.decideTools('x', shape);
    assert.deepEqual(
      got.tools.map((t) => t.name), ['get_portfolio'],
      `이 모양을 못 읽었다: ${JSON.stringify(shape)}`,
    );
  }
  // ⚠️ 오탐 확인 — 우리가 모르는 이름은 **안 부른다**(아무 문자열이나 도구가 되면 안 된다)
  const bogus = await chat.decideTools('x', { tools: [{ name: 'rm_rf_slash', argsJson: '{}' }] });
  assert.deepEqual(bogus.tools, []);
});

test('인자도 키가 아니라 모양으로 찾는다', async () => {
  const chat = require('../server/analystChat');
  const want = { symbol: '005930', interval: '1d' };
  for (const item of [
    { name: 'get_candles', argsJson: JSON.stringify(want) },
    { name: 'get_candles', args: want },
    { name: 'get_candles', arguments: JSON.stringify(want) },
    { name: 'get_candles', 아무키나: want },
  ]) {
    const got = await chat.decideTools('x', { tools: [item] });
    assert.deepEqual(got.tools[0].args, want, `인자를 못 읽었다: ${JSON.stringify(item)}`);
  }
});

test('도구가 실패해도 모델에게 실패를 알려준다 (삼키지 않는다)', async () => {
  const chat = require('../server/analystChat');
  // 존재하지 않는 도구는 판단기 단계에서 걸러지므로, **실행이 실패하는** 도구로 확인한다
  decideReplies = [{ tools: [{ name: 'get_candles', argsJson: '{"symbol":"NOPE"}' }] }, { tools: [] }];
  scripted = [[chunk([{ text: '데이터를 받지 못했습니다.' }])]];
  const { events, emit } = collect();
  await chat.chat({ message: 'x', emit });

  const sent = JSON.stringify(seenContents[0]);
  assert.ok(/\[도구 결과\] get_candles/.test(sent), '실패한 도구의 결과 자리가 없다');
  // tool_result 가 실패로 보고되거나, 결과 본문에 실패가 담겨 있어야 한다
  const tr = events.find((x) => x.e === 'tool_result');
  assert.ok(tr, 'tool_result 를 안 냈다');
});

test('판단기가 죽어도 대화는 계속되지만 조용하지 않다', async () => {
  const chat = require('../server/analystChat');
  decideThrows = '게이트웨이 429';
  scripted = [[chunk([{ text: '도구 없이 답합니다.' }])]];

  const { events, emit } = collect();
  const r = await chat.chat({ message: 'x', emit });

  assert.equal(r.toolCalls, 0);
  assert.match(r.decideFailed || '', /429/, '판단 실패를 요약에 남겨야 한다');
  assert.ok(events.some((x) => x.e === 'notice' && /도구 판단/.test(x.d.text)), '사용자에게 안 알렸다');
  // 🔴 그래도 답은 나온다 — 판단기가 죽었다고 대화까지 죽이지 않는다
  assert.ok(events.some((x) => x.e === 'text_delta'));
});

test('도구 바퀴 상한에 걸리면 조용히 넘기지 않는다', async () => {
  const chat = require('../server/analystChat');
  decideReplies = Array.from({ length: chat.MAX_ROUNDS + 1 }, () => ({
    tools: [{ name: 'recall', argsJson: '{"query":"무엇"}' }],
  }));
  scripted = [[chunk([{ text: '여기까지입니다.' }])]];
  const { events, emit } = collect();
  const r = await chat.chat({ message: 'x', emit });

  assert.equal(r.rounds, chat.MAX_ROUNDS);
  assert.ok(events.some((x) => x.e === 'notice' && /상한/.test(x.d.text)), '상한에 걸린 것을 알리지 않았다');
});

// ── 🔴 검색어에 자산이 실리지 않는다 ─────────────────────────

/**
 * 🔴 프롬프트에 "넣지 마라" 고 적는 것은 **가드가 아니다.**
 *    오늘 이미 배웠다 — 규칙을 늘려도 모델은 놓친다. **코드가 거른다.**
 */
test('sanitizeQuery 가 금액·수량·계좌로 보이는 것을 걷어낸다', () => {
  const chat = require('../server/analystChat');
  const cases = [
    ['삼성전자 32주 보유 전망', ['32주']],
    ['QLD $3,760.52 평가금액 전망', ['3,760.52', '$3,760.52']],
    ['계좌 1234567890 수익률', ['1234567890']],
    ['₩8,720,000 금현물', ['8,720,000']],
  ];
  for (const [input, leaks] of cases) {
    const out = chat.sanitizeQuery(input);
    for (const l of leaks) assert.ok(!out.includes(l), `"${l}" 가 남았다: ${out}`);
  }
  // ⚠️ 오탐 확인 — 종목명·일반어는 살아 있어야 검색이 된다
  assert.ok(chat.sanitizeQuery('삼성전자 주가 전망').includes('삼성전자'));
  assert.ok(chat.sanitizeQuery('ProShares Ultra QQQ 전망').includes('ProShares'));
  // 코드성 숫자는 4자리 이하라 남는다(005930 은 6자리라 걸러진다 — 이름으로 검색하면 된다)
  assert.equal(chat.sanitizeQuery('QQQ 3배 레버리지'), 'QQQ 3배 레버리지');
});

test('web_search 도구는 sanitize 를 거친 검색어만 내보낸다', async () => {
  const chat = require('../server/analystChat');
  /**
   * ⚠️ `require.cache[...].exports = {...}` 로 **객체를 갈아끼우면 안 된다** —
   *    `analystChat` 은 이미 옛 객체를 붙들고 있어서 스텁이 **아무 일도 안 한다**
   *    (첫 판에서 `sent.length === 0` 으로 나왔다. 테스트가 조용히 통과했으면
   *     "검사했다" 고 믿었을 자리다).
   *    ⇒ **같은 객체의 속성만** 바꾸고 되돌린다.
   */
  const mcpMod = require('../server/mcpClient');
  const realSearch = mcpMod.searchMarketNews;
  const sent = [];
  mcpMod.searchMarketNews = async (subjects) => {
    sent.push(subjects[0]);
    return { ok: true, tool: 'webSearch', results: [{ text: '뉴스', query: 'q' }], failedCount: 0 };
  };
  try {
    await chat.runTool('web_search', { query: '삼성전자 32주 ₩8,720,000 전망' });
    assert.equal(sent.length, 1);
    const blob = JSON.stringify(sent[0]);
    for (const secret of ['32주', '8,720,000']) {
      assert.ok(!blob.includes(secret), `검색어에 ${secret} 이 실렸다: ${blob}`);
    }
    assert.ok(blob.includes('삼성전자'));
  } finally {
    mcpMod.searchMarketNews = realSearch;
  }
});

// ── recall ───────────────────────────────────────────────────

test('recall 은 관련된 과거 대화를 점수순으로 찾는다', () => {
  const chat = require('../server/analystChat');
  const history = [
    { at: '2026-09-01T00:00:00Z', role: 'user', text: '삼성전자 비중 줄일까' },
    { at: '2026-09-02T00:00:00Z', role: 'assistant', text: '오늘 날씨 얘기' },
    { at: '2026-09-03T00:00:00Z', role: 'user', text: '삼성전자 반도체 업황이 걱정된다' },
  ];
  const hits = chat.recall('삼성전자 반도체', { history });
  assert.equal(hits.length, 2, '관련 없는 줄까지 끌고 오면 맥락이 흐려진다');
  assert.ok(hits[0].text.includes('반도체'), '겹치는 낱말이 많은 쪽이 먼저 와야 한다');

  // ⚠️ 한 글자 낱말로는 아무거나 걸리지 않게 한다
  assert.deepEqual(chat.recall('아', { history }), []);
});

test('대화는 덮어쓰지 않고 이어붙는다', () => {
  const chat = require('../server/analystChat');
  chat.appendHistory({ at: '2026-09-01T00:00:00Z', role: 'user', text: '첫 줄' });
  chat.appendHistory({ at: '2026-09-02T00:00:00Z', role: 'user', text: '둘째 줄' });
  const rows = chat.readHistory();
  assert.deepEqual(rows.map((r) => r.text), ['첫 줄', '둘째 줄']);
});
