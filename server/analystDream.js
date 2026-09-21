const fs = require('node:fs');
const path = require('node:path');
const { generateStructuredOutput } = require('./aiService');
const { createLongTermMemory } = require('./memoryService');
const { readHistory } = require('./analystChat');
const { logInfo, logWarn, logError } = require('./logger');

/**
 * dreaming — 유휴 시간에 대화 이력을 되짚는다 (2026-09-21)
 *
 * 사용자 요구: *"기존 대화 이력 기반 recall 구현, **dreaming** 구현 처리 진행해."*
 *
 * ## recall 과 무엇이 다른가
 *
 * `recall` 은 **물어봤을 때** 과거에서 찾아 온다(동기·수동).
 * `dreaming` 은 **아무도 안 물어봤을 때** 이력을 다시 읽고
 * *"그때 못 본 것 · 되풀이되는 패턴 · 확인해야 할 것"* 을 남긴다(비동기·능동).
 * 남긴 것은 장기기억으로 가고, 다음 대화의 `recall` 이 그것을 집어 온다 — **되먹임**이다.
 *
 * ## 🔴 조용히 도는 것이 가장 위험하다
 *
 * 무인 반복 작업에서 이 워크스페이스가 반복해 밟은 것들을 미리 막는다:
 *
 * ```
 * 기본 꺼짐          ANALYST_DREAM_ENABLED 없으면 안 돈다(미설정이 켜짐이 되면 안 된다)
 * 변한 게 없으면 안 돈다  마지막으로 꿈꾼 지점 이후 새 대화가 없으면 **그냥 넘긴다**
 *                    (Probius: 새로 찾을 게 없어도 매 사이클 LLM 을 돌면 비용이 선형 증가)
 * 결과가 0이어도 남긴다  "안 돌았다" 와 "돌았는데 없었다" 를 구분한다
 * 상한               한 번에 최대 3건. 장기기억이 쓰레기로 차면 recall 이 망가진다
 * ```
 *
 * ⚠️ **꿈은 사실이 아니다.** 여기서 나온 것은 *가설*이고, 그렇게 표시해 저장한다.
 *    나중에 recall 이 집어 왔을 때 모델이 이것을 **관측된 사실로 착각하면 안 된다.**
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
// ⚠️ 테스트 병렬 실행에서 파일이 겹치지 않게(위 analystChat 과 같은 이유)
const STATE_FILE = process.env.ANALYST_DREAM_FILE || path.join(DATA_DIR, 'analyst-dream.json');

/** 🔴 기본 꺼짐 */
const ENABLED = String(process.env.ANALYST_DREAM_ENABLED || '').trim().toLowerCase() === 'true';
/** 이만큼 새 대화가 쌓여야 한 번 꾼다 */
const MIN_NEW_TURNS = Math.max(1, Number(process.env.ANALYST_DREAM_MIN_TURNS) || 6);
const MAX_INSIGHTS = 3;

const SCHEMA = {
  type: 'object',
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['pattern', 'gap', 'followup'] },
          evidence: { type: 'string' },
        },
        required: ['text', 'kind', 'evidence'],
      },
    },
  },
  required: ['insights'],
};

const SYSTEM_PROMPT = [
  '당신은 과거 대화를 다시 읽고 **놓친 것**을 찾아내는 역할입니다.',
  '',
  '아래 셋 중 하나에 해당하는 것만 적습니다:',
  '- `pattern` — 사용자가 **되풀이하는** 관심사·습관·걱정',
  '- `gap` — 대화에서 **답하지 못하고 넘어간** 질문이나 확인 안 된 전제',
  '- `followup` — 나중에 **확인해 보기로** 하고 잊힌 것',
  '',
  '## 지킬 것',
  '1. 각 항목에 `evidence` 로 **대화의 실제 문장**을 인용합니다. 인용 못 하면 적지 마세요.',
  '2. 시세 전망·매매 판단은 적지 마세요. 그건 대화에서 할 일입니다.',
  '3. 뻔한 말("주식에 관심이 많다")은 적지 마세요. **다음에 도움이 될 것만.**',
  '4. 없으면 **빈 배열**이 정답입니다. 억지로 채우지 마세요.',
  '5. 한국어로 한 문장씩.',
].join('\n');

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { lastDreamAt: null, lastSeen: 0, runs: 0 };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastDreamAt: null, lastSeen: 0, runs: 0 };
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    logError('dream.state_write_failed', e, {});
  }
}

function status() {
  const st = readState();
  const turns = readHistory({ limit: 2000 }).filter((h) => h.role === 'user' || h.role === 'assistant').length;
  return {
    enabled: ENABLED,
    // 🔴 어느 쪽이 막고 있는지 화면·로그가 알 수 있어야 한다
    reason: ENABLED ? null : 'disabled',
    lastDreamAt: st.lastDreamAt,
    runs: st.runs || 0,
    turnsTotal: turns,
    turnsSinceLastDream: Math.max(0, turns - (st.lastSeen || 0)),
    minNewTurns: MIN_NEW_TURNS,
  };
}

/**
 * 한 번 꾼다.
 *
 * @returns {Promise<{ran:boolean, why?:string, saw?:number, insights?:number}>}
 *   🔴 `ran:false` 와 `insights:0` 을 **반드시 구분**해 돌려준다 —
 *      "안 돌았다" 가 "돌았는데 없었다" 로 보이면 안 된다(이 워크스페이스의 단골 실패 모드).
 */
async function dream({ force = false } = {}) {
  if (!ENABLED && !force) {
    logInfo('dream.skipped', { why: 'disabled' });
    return { ran: false, why: 'disabled' };
  }

  const st = readState();
  const rows = readHistory({ limit: 2000 }).filter((h) => h.role === 'user' || h.role === 'assistant');
  const fresh = rows.length - (st.lastSeen || 0);

  // ⚠️ **순서가 중요하다.** 이력이 아예 없는 것과 "새 대화가 모자란 것" 은 다른 상황인데,
  //    턴 수 검사를 먼저 하면 빈 이력도 `no_new_turns` 로 보고돼 **원인을 가린다**
  //    (테스트를 쓰다 걸렸다 — 둘 다 ran:false 라 겉으로는 똑같아 보인다).
  if (!rows.length) {
    logInfo('dream.skipped', { why: 'empty_history' });
    return { ran: false, why: 'empty_history', saw: 0 };
  }
  if (!force && fresh < MIN_NEW_TURNS) {
    // 변한 게 없으면 **돌지 않는다.** 매번 돌면 같은 이력으로 같은 결론을 내며 토큰만 태운다
    logInfo('dream.skipped', { why: 'no_new_turns', fresh, need: MIN_NEW_TURNS });
    return { ran: false, why: 'no_new_turns', saw: fresh };
  }

  // 최근 것 위주로 — 전부 넣으면 토큰도 크고 옛날 얘기가 결론을 흐린다
  const window = rows.slice(-60);
  const transcript = window
    .map((r) => `[${r.at}] ${r.role === 'user' ? '사용자' : '애널리스트'}: ${String(r.text || '').slice(0, 400)}`)
    .join('\n');

  let out;
  try {
    out = await generateStructuredOutput({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `## 대화 기록 (${window.length}턴)\n${transcript}`,
      schema: SCHEMA,
      logLabel: 'analyst_dream',
      fallback: { insights: [] },
    });
  } catch (e) {
    // 실패를 "꿈이 없었다" 로 만들지 않는다
    logWarn('dream.failed', { message: e.message });
    return { ran: false, why: 'llm_failed', saw: window.length, error: e.message };
  }

  const picked = (out.insights || []).slice(0, MAX_INSIGHTS);
  let saved = 0;
  for (const it of picked) {
    const text = String(it.text || '').trim();
    if (!text) continue;
    try {
      // ⚠️ **가설이라고 적어서** 저장한다 — recall 이 집어 왔을 때 사실로 읽히면 안 된다
      await createLongTermMemory({
        text: `[꿈·${it.kind}] ${text}\n근거: ${String(it.evidence || '').slice(0, 200)}`,
        kind: 'dream',
      });
      saved += 1;
    } catch (e) {
      logWarn('dream.save_failed', { message: e.message });
    }
  }

  writeState({
    lastDreamAt: new Date().toISOString(),
    lastSeen: rows.length,
    runs: (st.runs || 0) + 1,
  });

  // ★ 돌았다는 사실과 **몇 개를 봤는지**를 함께 남긴다 — 0이면 결과가 스스로 알려준다
  logInfo('dream.done', { saw: window.length, proposed: (out.insights || []).length, saved });
  return { ran: true, saw: window.length, insights: saved };
}

module.exports = { dream, status, SCHEMA, SYSTEM_PROMPT, STATE_FILE, MIN_NEW_TURNS, ENABLED };
