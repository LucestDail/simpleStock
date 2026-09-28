const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * dreaming (2026-09-21)
 *
 * ## 🔴 자의 초점
 *
 * 무인 반복 작업에서 이 워크스페이스가 되풀이해 밟은 것 둘을 잠근다:
 * 1. **"안 돌았다" 가 "돌았는데 없었다" 로 보이는 것** — 둘을 반드시 구분해 돌려준다
 * 2. **변한 게 없는데 매번 도는 것** — Probius 가 새로 찾을 게 없어도 매 사이클 LLM 을
 *    한 바퀴 돌아 비용이 선형으로 늘었다
 */

// 🔴 병렬 실행에서 채팅 테스트와 **같은 파일을 놓고 경합**했다(단독은 통과, 전체에서만 깨짐)
const DATA = require('node:os').tmpdir();
const HIST = path.join(DATA, `ssdream-chat-${process.pid}.jsonl`);
const STATE = path.join(DATA, `ssdream-state-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = HIST;
process.env.ANALYST_DREAM_FILE = STATE;

let backupHist = null;
let backupState = null;
let llmCalls = 0;
let llmReply = { insights: [] };
let llmThrows = null;
let saved = [];
let warnCalls = [];
let infoCalls = [];

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/analystDream|analystChat|aiService|memoryService|logger/.test(k)) delete require.cache[k];
  }
  // aiService 는 무겁다 — 스텁으로 갈아끼운다(대상은 dreaming 의 흐름이지 LLM 이 아니다)
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true, exports: {
      generateStructuredOutput: async () => {
        llmCalls += 1;
        if (llmThrows) throw new Error(llmThrows);
        return llmReply;
      },
    },
  };
  const memPath = require.resolve('../server/memoryService');
  require.cache[memPath] = {
    id: memPath, filename: memPath, loaded: true, exports: {
      createLongTermMemory: async ({ text, kind }) => { saved.push({ text, kind }); return { id: 'x' }; },
    },
  };
  // 🔴 dream.bad_shape 가 실제로 나가는지(그리고 정상일 때 0건인지) 재려면 logger 를 가로채야 한다 —
  //    analystDream.js 가 `const { logWarn } = require('./logger')` 로 **구조분해**해서 값을 이미
  //    붙들기 때문에, require 되기 전에 캐시를 갈아끼워야 한다(analystChat.test.js 의 같은 함정 메모 참조).
  const loggerPath = require.resolve('../server/logger');
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true, exports: {
      logInfo: (event, context = {}) => { infoCalls.push({ event, context }); },
      logWarn: (event, context = {}) => { warnCalls.push({ event, context }); },
      logError: () => {},
    },
  };
  return require('../server/analystDream');
}

function seedTurns(n) {
  fs.mkdirSync(DATA, { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({ at: `2026-09-0${(i % 9) + 1}T00:00:00Z`, role: i % 2 ? 'assistant' : 'user', text: `대화 ${i}` }));
  }
  fs.writeFileSync(HIST, `${lines.join('\n')}\n`);
}

beforeEach(() => {
  llmCalls = 0; saved = []; llmReply = { insights: [] }; llmThrows = null;
  warnCalls = []; infoCalls = [];
  backupHist = fs.existsSync(HIST) ? fs.readFileSync(HIST) : null;
  backupState = fs.existsSync(STATE) ? fs.readFileSync(STATE) : null;
  for (const f of [HIST, STATE]) if (fs.existsSync(f)) fs.rmSync(f);
});

afterEach(() => {
  // 🔴 실제 데이터를 테스트가 지우고 끝내지 않는다
  if (backupHist) fs.writeFileSync(HIST, backupHist); else if (fs.existsSync(HIST)) fs.rmSync(HIST);
  if (backupState) fs.writeFileSync(STATE, backupState); else if (fs.existsSync(STATE)) fs.rmSync(STATE);
});

// ── 기본 꺼짐 ────────────────────────────────────────────────

test('설정이 없으면 돌지 않는다 (미설정이 켜짐이 되지 않는다)', async () => {
  delete process.env.ANALYST_DREAM_ENABLED;
  const d = fresh();
  seedTurns(50);
  const r = await d.dream();
  assert.equal(r.ran, false);
  assert.equal(r.why, 'disabled');
  assert.equal(llmCalls, 0, '꺼져 있는데 LLM 을 불렀다');
  assert.equal(d.status().reason, 'disabled');
});

// ── 🔴 "안 돌았다" 와 "돌았는데 없었다" ──────────────────────

test('결과 0건과 미실행을 구분해 돌려준다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);

  llmReply = { insights: [] };
  const ran = await d.dream();
  // 돌았는데 없었던 것 — ran:true, insights:0
  assert.equal(ran.ran, true);
  assert.equal(ran.insights, 0);
  assert.ok(ran.saw > 0, '무엇을 봤는지 세어서 돌려줘야 한다');
  assert.equal(llmCalls, 1);

  // 같은 이력으로 또 부르면 **안 돈다** — ran:false 이고 이유가 붙는다
  const again = await d.dream();
  assert.equal(again.ran, false);
  assert.equal(again.why, 'no_new_turns');
  assert.equal(llmCalls, 1, '변한 게 없는데 LLM 을 또 불렀다 — 비용이 선형으로 는다');

  delete process.env.ANALYST_DREAM_ENABLED;
});

test('새 대화가 쌓이면 다시 돈다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);
  await d.dream();
  assert.equal(llmCalls, 1);

  seedTurns(50 + d.MIN_NEW_TURNS); // 충분히 새 대화가 쌓였다
  const r = await d.dream();
  assert.equal(r.ran, true);
  assert.equal(llmCalls, 2);
  delete process.env.ANALYST_DREAM_ENABLED;
});

test('이력이 비어 있으면 LLM 을 부르지 않는다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  const r = await d.dream();
  assert.equal(r.ran, false);
  assert.equal(r.why, 'empty_history');
  assert.equal(llmCalls, 0);
  delete process.env.ANALYST_DREAM_ENABLED;
});

// ── 저장 ─────────────────────────────────────────────────────

test('가설을 **꿈이라고 표시해서** 저장하고 개수를 제한한다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);
  llmReply = {
    insights: [
      { text: 'QLD 비중을 자주 걱정한다', kind: 'pattern', evidence: '사용자: QLD 더 사도 될까' },
      { text: '환율 영향을 확인 안 했다', kind: 'gap', evidence: '사용자: 환율은?' },
      { text: '금현물 비중 재검토 약속', kind: 'followup', evidence: '나중에 보자' },
      { text: '넘치는 네 번째', kind: 'pattern', evidence: 'x' },
      { text: '넘치는 다섯 번째', kind: 'gap', evidence: 'y' },
    ],
  };
  const r = await d.dream();

  assert.equal(r.insights, 3, '상한을 넘겨 저장하면 장기기억이 쓰레기로 찬다');
  assert.equal(saved.length, 3);
  for (const s of saved) {
    // 🔴 recall 이 집어 왔을 때 **사실로 읽히면 안 된다**
    assert.match(s.text, /^\[꿈·(pattern|gap|followup)\]/, `가설 표시가 없다: ${s.text}`);
    assert.match(s.text, /근거:/, '근거를 함께 저장해야 나중에 검증할 수 있다');
    assert.equal(s.kind, 'dream');
  }
  delete process.env.ANALYST_DREAM_ENABLED;
});

test('LLM 이 실패하면 "꿈이 없었다" 로 만들지 않는다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);
  /**
   * ⚠️ `require.cache[...].exports.fn = ...` 로 바꿔도 **안 먹는다** —
   *    `analystDream` 이 `const { generateStructuredOutput } = require(...)` 로
   *    **구조분해해서 값을 이미 붙들고** 있기 때문이다. 오늘 두 번째로 밟은 함정이라
   *    스텁 안에 스위치를 두는 쪽으로 바꿨다(스텁은 처음부터 내 것이다).
   */
  llmThrows = '게이트웨이 429';

  const r = await d.dream();
  assert.equal(r.ran, false, '실패를 ran:true/insights:0 으로 만들면 "꿈이 없었다" 로 보인다');
  assert.equal(r.why, 'llm_failed');
  assert.match(r.error, /429/);
  delete process.env.ANALYST_DREAM_ENABLED;
});

test('force 는 꺼져 있어도 한 번 돌린다(점검용)', async () => {
  delete process.env.ANALYST_DREAM_ENABLED;
  const d = fresh();
  seedTurns(50);
  const r = await d.dream({ force: true });
  assert.equal(r.ran, true);
  assert.equal(llmCalls, 1);
});

// ── 🔴 2026-09-28 pm1 위임 — "파싱은 됐는데 모양이 아닌 것" ──────────────────
//
// 폴백(같은 날 위치인자 수정)은 **파싱 실패**만 막는다. JSON.parse 가 성공하되
// null·배열·문자열·숫자처럼 **모양이 아닌 값**을 그대로 뱉으면 `out.insights`(167행)가
// out===null/undefined 일 때 크래시하고, 그 밖의 모양이면 "정상인데 0건" 과 구분 안 되게
// 조용히 사라진다. 여기서는 크래시 안 함 + 정확히 1건의 `dream.bad_shape` 경고를 잰다.
// ⚠️ 오탐 축(정상 모양엔 경고가 늘면 안 된다)이 크래시 축보다 더 중요하다 — pm1 의 명시적 지시.

test('🔴 모델이 JSON null 을 그대로 뱉으면 크래시하지 않고 dream.bad_shape 경고를 남긴다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);
  llmReply = null;

  const r = await d.dream(); // 던지면 이 await 에서 테스트가 그대로 실패한다
  assert.equal(r.ran, true, '크래시 대신 정상 반환이어야 한다');
  assert.equal(r.insights, 0);
  const badShape = warnCalls.filter((w) => w.event === 'dream.bad_shape');
  assert.equal(badShape.length, 1, `bad_shape 경고가 정확히 1건이어야 하는데: ${JSON.stringify(warnCalls)}`);
  assert.equal(badShape[0].context.type, 'null');
  delete process.env.ANALYST_DREAM_ENABLED;
});

test('🔴 모델이 배열을 그대로 뱉어도 크래시하지 않고 dream.bad_shape 경고를 남긴다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);
  llmReply = [{ text: '엉뚱한 모양으로 온 인사이트' }]; // 래핑 객체 없이 배열 자체

  const r = await d.dream();
  assert.equal(r.ran, true, '크래시 대신 정상 반환이어야 한다');
  assert.equal(r.insights, 0);
  const badShape = warnCalls.filter((w) => w.event === 'dream.bad_shape');
  assert.equal(badShape.length, 1, `bad_shape 경고가 정확히 1건이어야 하는데: ${JSON.stringify(warnCalls)}`);
  assert.equal(badShape[0].context.type, 'array');
  delete process.env.ANALYST_DREAM_ENABLED;
});

test('🔴 모델이 문자열/숫자를 뱉어도 크래시하지 않고 dream.bad_shape 경고를 남긴다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);
  llmReply = 'hello';
  const r1 = await d.dream();
  assert.equal(r1.ran, true);
  assert.equal(warnCalls.filter((w) => w.event === 'dream.bad_shape').length, 1);

  seedTurns(50 + d.MIN_NEW_TURNS); // 새 대화를 쌓아야 다시 돈다(변한 게 없으면 스킵)
  warnCalls = [];
  llmReply = 42;
  const r2 = await d.dream();
  assert.equal(r2.ran, true);
  const badShape = warnCalls.filter((w) => w.event === 'dream.bad_shape');
  assert.equal(badShape.length, 1, `bad_shape 경고가 정확히 1건이어야 하는데: ${JSON.stringify(warnCalls)}`);
  assert.equal(badShape[0].context.type, 'number');
  delete process.env.ANALYST_DREAM_ENABLED;
});

test('⚠️ 오탐 없음(중요): 정상 {insights:[]} 는 여전히 dream.bad_shape 0건이다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);
  llmReply = { insights: [] };

  const r = await d.dream();
  assert.equal(r.ran, true);
  assert.equal(r.insights, 0);
  assert.equal(warnCalls.filter((w) => w.event === 'dream.bad_shape').length, 0, '정상 모양인데 오탐이 났다');
  delete process.env.ANALYST_DREAM_ENABLED;
});

test('⚠️ 오탐 없음: 정상 모양에 실제 insight 가 있어도 dream.bad_shape 0건이다', async () => {
  process.env.ANALYST_DREAM_ENABLED = 'true';
  const d = fresh();
  seedTurns(50);
  llmReply = { insights: [{ text: '패턴 발견', kind: 'pattern', evidence: '근거' }] };

  const r = await d.dream();
  assert.equal(r.ran, true);
  assert.equal(r.insights, 1);
  assert.equal(saved.length, 1);
  assert.equal(warnCalls.filter((w) => w.event === 'dream.bad_shape').length, 0, '정상 모양인데 오탐이 났다');
  delete process.env.ANALYST_DREAM_ENABLED;
});
