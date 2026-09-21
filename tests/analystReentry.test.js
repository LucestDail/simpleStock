const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 매도 뒤 **되살 자리** · 마지막 분석 보존 · 화면 자동 실행 제거 (2026-09-21)
 *
 * 사용자: *"매도한다고 판정한 경우 다음날이나 다음 매수 시점의 부분매수 진입 시점 같은 게
 * 애매할 거 같은데, **보유종목만 판정해버리면**."*
 */

process.env.ANALYST_LAST_FILE = path.join(os.tmpdir(), `ss-last-${process.pid}.json`);
process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ss-re-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ss-re-act-${process.pid}.jsonl`);
process.env.SETTINGS_FILE = path.join(os.tmpdir(), `ss-re-set-${process.pid}.json`);

/** LLM 에 실제로 넘어간 프롬프트를 붙잡는다 — **무엇을 물었는가**가 이 테스트의 대상이다 */
function freshWithCapture(candles = null) {
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService|stockRating/.test(k)) {
      delete require.cache[k];
    }
  }
  const seen = [];
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      generateStructuredOutput: async (o) => {
        seen.push(o.userPrompt + '\n' + o.systemPrompt);
        return { marketView: 'v', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
      },
      getAiSettings: () => ({}),
    },
  };
  const mcpPath = require.resolve('../server/mcpClient');
  const realMcp = require(mcpPath);
  require.cache[mcpPath] = {
    id: mcpPath, filename: mcpPath, loaded: true,
    exports: { ...realMcp, searchMarketNews: async () => ({ ok: false, error: '꺼짐', kind: 'disabled', results: [] }) },
  };
  const tossPath = require.resolve('../server/tossClient');
  const realToss = require(tossPath);
  require.cache[tossPath] = {
    id: tossPath, filename: tossPath, loaded: true,
    exports: { ...realToss, getCandles: async () => (candles ?? { rows: [] }) },
  };
  return { analyst: require('../server/analystService'), seen };
}

const DASH = { portfolio: { items: [], summary: null }, momentum: [], warnings: {}, rankings: {} };
const HELD = {
  portfolio: { items: [{ symbol: 'QLD', name: 'QLD', quantity: 99, currency: 'USD' }], summary: null },
  momentum: [], warnings: {}, rankings: {},
};
const TRIG = (symbol, role) => ({ reasons: [{ kind: 'momentum', symbol, role, z: 2.4, changePct: 6.1 }], why: 'x' });

test('🔴 판 종목이 모멘텀으로 깨우면 **되살 자리**를 묻는다', async () => {
  const { analyst, seen } = freshWithCapture();
  await analyst.analyze(HELD, { dryRun: true, useWebSearch: false, trigger: TRIG('RAM', 'reentry') });
  const p = seen.join('\n');
  assert.match(p, /되살\/신규 진입 후보/, '🔴 판 종목이 프롬프트에 안 실린다 — 되살 자리를 못 본다');
  assert.match(p, /RAM/);
  assert.match(p, /최근까지 보유했다 매도/);
});

test('🔴 보유가 아니므로 **수량·평단을 근거로 쓰지 말라**고 명시한다', async () => {
  const { analyst, seen } = freshWithCapture();
  await analyst.analyze(HELD, { dryRun: true, useWebSearch: false, trigger: TRIG('RAM', 'reentry') });
  const p = seen.join('\n');
  assert.match(p, /수량·평단·평가손익이 없으니/, '🔴 없는 값을 근거로 쓰라고 두면 지어낸다');
  assert.match(p, /`SELL` 은 쓸 수 없습니다/, '🔴 없는 걸 팔라고 할 수 있다');
});

test('🔴 **분할 매수**를 물어본다 (사용자가 지적한 그 지점)', async () => {
  const { analyst, seen } = freshWithCapture();
  await analyst.analyze(HELD, { dryRun: true, useWebSearch: false, trigger: TRIG('RAM', 'reentry') });
  const p = seen.join('\n');
  assert.match(p, /한 번에 다 사는 것을 전제하지 마세요/);
  assert.match(p, /1차 진입가/);
});

test('⚠️ 되살 이유가 "전에 들고 있었으니까" 가 되지 않게 못박는다', async () => {
  const { analyst, seen } = freshWithCapture();
  await analyst.analyze(HELD, { dryRun: true, useWebSearch: false, trigger: TRIG('RAM', 'reentry') });
  assert.match(seen.join('\n'), /판 이유가 해소됐는지로 판단/);
});

/** 🔴 판별력 — **보유 중인 종목**은 되살 후보로 들어가면 안 된다(질문이 뒤바뀐다) */
test('🔴 보유 중인 종목은 되살 후보에 넣지 않는다', async () => {
  const { analyst, seen } = freshWithCapture();
  await analyst.analyze(HELD, { dryRun: true, useWebSearch: false, trigger: TRIG('QLD', 'held') });
  assert.ok(!/되살\/신규 진입 후보/.test(seen.join('\n')), '🔴 보유 종목에게 "되살 자리인가" 를 물었다');
});

test('트리거가 없으면 되살 절도 없다 (수동 실행은 그대로)', async () => {
  const { analyst, seen } = freshWithCapture();
  await analyst.analyze(HELD, { dryRun: true, useWebSearch: false });
  assert.ok(!/되살\/신규 진입 후보/.test(seen.join('\n')));
});

/** ⚠️ 후보가 많아도 상한이 있다 — 분석 1회가 예산을 다 태우면 안 된다 */
test('⚠️ 되살 후보는 최대 3종목', async () => {
  const { analyst, seen } = freshWithCapture();
  const reasons = ['A', 'B', 'C', 'D', 'E'].map((sym) => ({ kind: 'momentum', symbol: sym, role: 'reentry', z: 2.1, changePct: 5 }));
  await analyst.analyze(DASH, { dryRun: true, useWebSearch: false, trigger: { reasons, why: 'x' } });
  const p = seen.join('\n');
  const hits = ['A', 'B', 'C', 'D', 'E'].filter((x) => new RegExp(`\\*\\*${x}\\*\\*`).test(p));
  assert.equal(hits.length, 3, `되살 후보가 ${hits.length}종목 실렸다`);
});

// ── 마지막 분석 보존 ─────────────────────────────────────────

/**
 * 🔴 화면 진입 자동 실행을 껐으므로 **마지막 분석을 저장해야 한다.**
 * 저장하지 않으면 사건이 날 때까지 빈 화면이고, 그러면 사용자는
 * *"안 돌린 것"* 과 *"고장난 것"* 을 구분할 수 없다.
 */
test('🔴 마지막 분석을 저장하고 다시 읽는다', () => {
  const { analyst } = freshWithCapture();
  assert.equal(analyst.readLast(), null, '처음엔 없어야 한다');
  analyst.saveLast({ marketView: '저장된 시황', at: '2026-09-21T14:00:00Z', trigger: { why: '미국장 마감' } });
  const r = analyst.readLast();
  assert.equal(r.marketView, '저장된 시황');
  assert.equal(r.trigger.why, '미국장 마감', '🔴 왜 돌았는지가 사라졌다 — 화면이 "언제 것" 인지 못 보여준다');
});

test('⚠️ 파일이 깨져도 null 을 준다 (화면이 죽지 않는다)', () => {
  fs.writeFileSync(process.env.ANALYST_LAST_FILE, '{깨진 JSON');
  const { analyst } = freshWithCapture();
  assert.equal(analyst.readLast(), null);
});

// ── 화면이 진입 시 분석을 돌리지 않는다 ────────────────────────

/**
 * 🔴 **비용 절감의 핵심이 이 한 줄**이다 — 실측 24회/2시간40분이 대부분 여기서 나왔다.
 * 누가 되살려 놓으면 비용이 조용히 원복되므로 자로 잠근다.
 */
test('🔴 화면 진입이 분석을 실행하지 않는다 (마지막 것을 불러올 뿐)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'WorkspaceView.vue'), 'utf8');
  const mount = /onMounted\(([\s\S]*?)\n\}\);/.exec(src)?.[1] || src;
  assert.ok(/loadLastReport\(\)/.test(src), '🔴 마지막 분석을 안 불러온다 — 빈 화면이 된다');
  assert.ok(!/setTimeout\([^)]*runAnalyst\(\)/.test(src), '🔴 진입 자동 실행이 되살아났다 — 비용이 원복된다');
  // 판별력: 수동 버튼은 **남아 있어야** 한다
  assert.ok(/@click="runAnalyst"/.test(src), '🔴 수동 실행 버튼까지 사라졌다');
});
