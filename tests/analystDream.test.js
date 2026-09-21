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

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/analystDream|analystChat|aiService|memoryService/.test(k)) delete require.cache[k];
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
