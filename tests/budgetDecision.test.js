/**
 * 📒 **AI 예산 판단에 자리를 준다** (2026-10-06)
 *
 * ## 무엇이 일어났나
 * 자율 1단 + AI 전용 예산 $500 이 가동 중인데 **AI 매매가 0건**이었다.
 * `ledgerSection` 은 *"진입하지 않으면 왜 안 하는지 반드시 적어라"* 를 요구하는데
 * **`REPORT_SCHEMA` 에 그걸 담을 자리가 없었다** — 실측(10-06 11:0x): 보고서를 전부 walk 해도
 * "예산/진입하지" 문자열 **0건**. 모델이 적어도 `shapeReport` 가 **새 객체를 재조립**하며 버린다.
 *
 * ## 처방 — 프롬프트로 못 고치는 것은 스키마/구조로
 * `holdings` 신설(10-02)과 **같은 수**다. 프롬프트 4회 실패를 스키마가 1회에 끝냈다.
 * ⇒ *"안 산 날도 왜 안 샀는지가 매 회차 남는다"* 를 **구조**로 만든다.
 *
 * ## 이 자가 잠그는 것
 * ① 조건부 스키마(예산 없으면 **없다** — 없는 예산에 판단을 요구하면 모델이 지어낸다)
 * ② `holdings` 와의 합성 — 보유·예산 **넷 조합 전부**
 * ③ 수치가 **인자에서 유도**된다(하드코딩이면 예산을 바꾼 날 프롬프트가 거짓말한다)
 * ④ `shapeReport` 보존 + 깨진 모양 방어(*"파싱 성공이 안전을 뜻하지 않는다"* 가족)
 * ⑤ **배선** — 호출부 전부가 `budget` 을 넘긴다("형제 중 하나만 빠짐" 이 이 저장소의 전형)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../server/analystService');

const SRC = () => fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8')
  // ⚠️ 주석을 지우고 본다 — 설명문의 `reportSchemaFor(` 를 호출로 세면 자가 거짓말한다
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

const LEDGER = (over = {}) => ({
  budgetUsd: 500, effectiveBudgetUsd: 500, availableUsd: 500, openCostUsd: 0,
  realizedUsd: 0, positions: {}, ...over,
});

const POS = { symbol: 'O', stance: 'HOLD', confidence: 'LOW', rationale: 'r', evidence: [], risk: 'k' };
const BASE_OUT = (over = {}) => ({
  marketView: 'v', momentumRead: 'm', dataGaps: [], positions: [POS], proposals: [], ...over,
});

/**
 * 그 회차에 실제로 찍힌 warn 을 모은다.
 * ⚠️ `analystService` 는 `const { logWarn } = require('./logger')` 로 **구조분해**해 두므로
 *    logger 모듈 객체를 갈아끼워도 안 먹는다(10-01 에 같은 함정으로 로그 테스트가
 *    변이에도 통과했다) ⇒ `logger` 가 최종적으로 쓰는 **`console.warn` 을** 가로챈다.
 */
function captureWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try { return { value: fn(), out: lines.join('\n') }; } finally { console.warn = orig; }
}

// ────────────────────────────── ① 조건부 스키마

test('🔴 예산이 있으면 budgetDecision 이 properties·required 에 들어간다', () => {
  const sc = svc._reportSchemaFor([], { budget: LEDGER() });
  const b = sc.properties.budgetDecision;
  assert.ok(b, 'budgetDecision 자리가 없다 — 모델이 적어도 버려진다');
  assert.strictEqual(b.type, 'object');
  assert.deepStrictEqual(b.properties.action.enum, ['ENTER', 'HOLD', 'EXIT', 'WAIT']);
  assert.ok(b.properties.reason, 'reason 이 없으면 "왜 안 샀나" 를 못 받는다');
  assert.ok(b.properties.symbol, 'ENTER·EXIT 대상 종목 자리');
  assert.deepStrictEqual(b.required, ['action', 'reason']);
  assert.ok(sc.required.includes('budgetDecision'), 'required 가 아니면 비어 와도 통과한다');
});

test('⚠️ 예산 미설정이면 budgetDecision 이 **없다** — 없는 예산에 판단을 요구하면 지어낸다', () => {
  assert.strictEqual(svc._reportSchemaFor([], { budget: null }), svc._REPORT_SCHEMA);
  assert.strictEqual(svc._reportSchemaFor([]), svc._REPORT_SCHEMA);
  // budgetUsd 가 null 인 원장(예산을 지운 상태)도 마찬가지다
  assert.strictEqual(svc._reportSchemaFor([], { budget: LEDGER({ budgetUsd: null }) }), svc._REPORT_SCHEMA);
  const sc = svc._reportSchemaFor(['O'], { budget: LEDGER({ budgetUsd: null }) });
  assert.ok(!sc.properties.budgetDecision, '예산이 없는데 자리가 생겼다');
  assert.ok(!sc.required.includes('budgetDecision'));
});

// ────────────────────────────── ② holdings 와의 합성 (넷 조합)

test('🔴 보유·예산 **넷 조합 전부** 성립한다', () => {
  const none = svc._reportSchemaFor([], { budget: null });
  assert.ok(!none.properties.holdings && !none.properties.budgetDecision);
  assert.strictEqual(none, svc._REPORT_SCHEMA, '둘 다 없으면 원본 그대로여야 한다');

  const onlyHold = svc._reportSchemaFor(['O', 'QLD'], { budget: null });
  assert.ok(onlyHold.properties.holdings && !onlyHold.properties.budgetDecision);
  assert.ok(onlyHold.required.includes('holdings') && !onlyHold.required.includes('budgetDecision'));

  const onlyBudget = svc._reportSchemaFor([], { budget: LEDGER() });
  assert.ok(!onlyBudget.properties.holdings && onlyBudget.properties.budgetDecision);
  assert.ok(!onlyBudget.required.includes('holdings') && onlyBudget.required.includes('budgetDecision'));

  const both = svc._reportSchemaFor(['O', 'QLD'], { budget: LEDGER() });
  assert.ok(both.properties.holdings && both.properties.budgetDecision, '합성이 안 된다');
  assert.ok(both.required.includes('holdings') && both.required.includes('budgetDecision'));
  // ⚠️ 기존 holdings 계약이 합성 때문에 깨지지 않았는지
  assert.strictEqual(both.properties.holdings.minItems, 2);
  assert.deepStrictEqual(both.properties.holdings.items.properties.symbol.enum, ['O', 'QLD']);
  // ⚠️ 원본 스키마 오염 금지 — 다음 호출이 오염된다
  assert.ok(!svc._REPORT_SCHEMA.properties.budgetDecision, '원본에 budgetDecision 이 새어 들어갔다');
  assert.ok(!svc._REPORT_SCHEMA.required.includes('budgetDecision'));
});

// ────────────────────────────── ③ 수치는 인자에서 유도

test('🔴 description 의 수치가 **인자에서** 나온다 — 하드코딩이면 예산을 바꾼 날 거짓말한다', () => {
  const a = svc._reportSchemaFor([], { budget: LEDGER() }).properties.budgetDecision.description;
  assert.match(a, /\$500/);
  assert.match(a, /가용 \$500/);
  assert.match(a, /AI 보유 없음/);
  assert.match(a, /WAIT/, '미진입 시 무엇을 적어야 하는지가 빠지면 빈칸으로 온다');

  // 🔴 다른 수치를 주면 **그 수치가** 나와야 한다(= 하드코딩이 아니라는 증명)
  const b = svc._reportSchemaFor([], {
    budget: LEDGER({ budgetUsd: 1200, availableUsd: 250, positions: { SOXX: { qty: 2, avgUsd: 60, costUsd: 120 } } }),
  }).properties.budgetDecision.description;
  assert.match(b, /\$1200/);
  assert.match(b, /가용 \$250/);
  assert.match(b, /AI 보유 SOXX/, 'AI 보유를 안 알려주면 HOLD·EXIT 판단을 할 수 없다');
  assert.doesNotMatch(b, /\$500/, '앞 호출의 수치가 남아 있다 — 하드코딩이거나 캐시 오염');
});

// ────────────────────────────── ④ shapeReport 보존·방어

test('🔴 정상 객체가 라운드트립한다 — 이게 없으면 모델이 적어도 버려진다', () => {
  const r = svc._shapeReport(BASE_OUT({
    budgetDecision: { action: 'ENTER', reason: '정배열 + 가용 $500', symbol: 'qqq' },
  }));
  assert.deepStrictEqual(r.budgetDecision, { action: 'ENTER', reason: '정배열 + 가용 $500', symbol: 'QQQ' });
});

test('⚠️ WAIT 가 symbol 없이 와도 살아남는다 — 미진입 회차가 우리가 보고 싶은 그것이다', () => {
  const r = svc._shapeReport(BASE_OUT({ budgetDecision: { action: 'wait', reason: '추세 미형성' } }));
  assert.deepStrictEqual(r.budgetDecision, { action: 'WAIT', reason: '추세 미형성', symbol: null });
});

test('⚠️ 필드가 아예 없으면 null (예산 미설정 회차)', () => {
  assert.strictEqual(svc._shapeReport(BASE_OUT()).budgetDecision, null);
});

test('🔴 원시값·배열은 버리고, **문자열이면 짖는다**(모델이 산문으로 답한 것)', () => {
  for (const v of [123, true, null, [{ action: 'ENTER' }]]) {
    assert.strictEqual(svc._shapeReport(BASE_OUT({ budgetDecision: v })).budgetDecision, null, `${JSON.stringify(v)} 가 통과했다`);
  }
  const cap = captureWarn(() => svc._shapeReport(BASE_OUT({
    budgetDecision: '가용 예산이 있지만 추세가 안 서서 이번 회차는 진입하지 않습니다',
  })));
  assert.strictEqual(cap.value.budgetDecision, null);
  assert.match(cap.out, /budget_decision_prose/, '산문 응답을 조용히 버렸다 — 관측돼야 한다');
  assert.match(cap.out, /진입하지 않습니다|진입하지/, 'warn 에 실제 값이 없으면 무엇이 왔는지 모른다');
});

test('🔴 enum 밖 action 은 **WAIT 로 보정해 살리고** 짖는다 — 버리면 "왜 안 샀나" 를 영영 못 본다', () => {
  const cap = captureWarn(() => svc._shapeReport(BASE_OUT({
    budgetDecision: { action: '관망', reason: '가용 $500 이지만 20일선 아래' },
  })));
  assert.deepStrictEqual(cap.value.budgetDecision, { action: 'WAIT', reason: '가용 $500 이지만 20일선 아래', symbol: null });
  assert.match(cap.out, /budget_decision_action_unrecognized/);
  assert.match(cap.out, /관망/, '실제 받은 값이 warn 에 없으면 프롬프트를 고칠 근거가 없다');
});

test('⚠️ reason 이 없으면 null — 내용 없는 껍데기는 싣지 않는다(다만 짖는다)', () => {
  const cap = captureWarn(() => svc._shapeReport(BASE_OUT({ budgetDecision: { action: 'WAIT' } })));
  assert.strictEqual(cap.value.budgetDecision, null);
  assert.match(cap.out, /budget_decision_empty/);
  assert.strictEqual(svc._shapeReport(BASE_OUT({ budgetDecision: { action: 'WAIT', reason: '   ' } })).budgetDecision, null);
});

test('🔴 budgetDecision 이 기존 shapeReport 판정을 **오염시키지 않는다**', () => {
  // ⚠️ `longestProse` 가 marketView 가 빈 회차에 reason 을 시황으로 집어가면 안 된다
  const long = '가용 예산 $500 이 있지만 추세가 서지 않아 이번 회차에는 진입하지 않는다는 판단입니다';
  const r = svc._shapeReport({
    momentumRead: 'm', dataGaps: [], positions: [POS], proposals: [],
    budgetDecision: { action: 'WAIT', reason: long },
  });
  assert.strictEqual(r.marketView, '', 'reason 이 marketView 로 샜다 — 시황을 지어낸 것으로 보인다');
  // 판단·제안 개수가 budgetDecision 때문에 늘지 않는다(배열 훑기·평평한 객체 폴백에 안 걸린다)
  assert.strictEqual(r.positions.length, 1);
  assert.strictEqual(r.proposals.length, 0);
  // HOLD 는 stance enum 과 **글자가 같다** — 판단으로 오인되면 유령 종목이 생긴다
  const h = svc._shapeReport(BASE_OUT({ budgetDecision: { action: 'HOLD', reason: 'AI 보유 유지', symbol: 'SOXX' } }));
  assert.deepStrictEqual(h.positions.map((p) => p.symbol), ['O'], 'budgetDecision 이 판단 배열로 새어 들어갔다');
});

// ────────────────────────────── ⑤ 배선 가드

test('🔴 배선 — `reportSchemaFor` 호출부 **전부**가 budget 을 넘긴다', () => {
  const s = SRC();
  const hits = [...s.matchAll(/reportSchemaFor\(/g)];
  const calls = hits.filter((m) => !/function\s+$/.test(s.slice(Math.max(0, m.index - 12), m.index)));
  // ⚠️ "대상이 조용히 줄어드는 것" 을 막는다 — 본요청·재시도·가격수정 3곳
  assert.ok(calls.length >= 3, `호출부가 ${calls.length}곳뿐이다 — 검사 대상이 사라졌다`);
  for (const m of calls) {
    const snippet = s.slice(m.index, m.index + 180);
    assert.match(snippet, /budget\s*:/, `budget 을 안 넘기는 호출부가 있다 — 그 회차만 조용히 자리가 없다:\n${snippet.slice(0, 120)}`);
  }
});

test('🔴 배선 — analyze() 의 return 이 budgetDecision 을 실제로 싣는다', () => {
  const s = SRC();
  // ⚠️ 이 return 은 report 를 통째로 넘기지 않고 **명시 필드만 재조립**한다(파일 주석의 경고).
  //    shapeReport 가 보존해도 여기 없으면 **응답에서 조용히 빠진다.**
  assert.match(s, /budgetDecision:\s*report\.budgetDecision/, 'analyze() 응답에 budgetDecision 이 없다 — 화면이 영영 못 본다');
  assert.match(s, /budgetDecision:\s*asBudgetDecision\(/, 'shapeReport 가 budgetDecision 을 버린다');
});

test('🔴 프롬프트가 **필드 이름을 가리킨다** — "적어라" 만으로는 자리를 모른다', () => {
  const sec = svc.ledgerSection(LEDGER(), 1).join('\n');
  assert.match(sec, /budgetDecision/, '어디에 적는지가 없으면 모델이 산문으로 답하고 버려진다');
  assert.match(sec, /WAIT/, '미진입 회차의 action 을 안 알려주면 빈칸으로 온다');
  assert.match(sec, /reason/);
  // ⚠️ 예산 미설정이면 절 자체가 없으므로 이 안내도 나가지 않는다(스키마와 짝이 맞는다)
  assert.strictEqual(svc.ledgerSection({ budgetUsd: null }), null);
});

test('⚠️ 스키마 enum 과 보정 검사가 **같은 한 벌**을 본다 — 두 벌이면 갈라진다', () => {
  const enumVals = svc._reportSchemaFor([], { budget: LEDGER() }).properties.budgetDecision.properties.action.enum;
  for (const a of enumVals) {
    const r = svc._shapeReport(BASE_OUT({ budgetDecision: { action: a, reason: 'r' } }));
    assert.strictEqual(r.budgetDecision.action, a, `스키마는 ${a} 를 허용하는데 shapeReport 가 보정해 버렸다`);
  }
});

/**
 * 🔴 목록 projection 까지 **도달**하는가 (2026-10-06 — 서브에이전트가 내 지시서의 구멍을 찾았다).
 * 화면은 `h.budgetDecision` 을 이미 읽고 있었는데 `analystHistory.list()` 가 메타를 재조립하며
 * 그 필드를 빠뜨려, **코드는 다 있는데 칩만 영영 안 뜨는** 상태였다("등록됐다 ≠ 도달한다").
 * ⇒ 저장→목록 왕복으로 잠근다. 상세(get)는 행 통째라 같은 왕복으로 함께 본다.
 */
test('이력 왕복 — 저장한 budgetDecision 이 목록·상세 둘 다에 도달한다', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  for (const k of Object.keys(require.cache)) if (/analystHistory/.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bdh-'));
  const hist = require('../server/analystHistory');
  const decision = { action: 'WAIT', reason: '가용 $500 이지만 정배열 후보가 없다', symbol: null };
  hist.record({
    at: new Date().toISOString(),
    report: { marketView: 'v', momentumRead: 'm', positions: [], proposals: [], budgetDecision: decision },
    created: [],
  });
  const rows = hist.list({ limit: 5 }).filter((r) => r.kind === 'full');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].budgetDecision, decision, '목록 projection 이 budgetDecision 을 버렸다 — 화면 칩이 안 뜬다');
  assert.deepEqual(hist.get(rows[0].id).report.budgetDecision, decision, '상세가 budgetDecision 을 잃었다');
});

test('이력 왕복 — 판단 없는 회차는 null (빈 껍데기 금지)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  for (const k of Object.keys(require.cache)) if (/analystHistory/.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bdh2-'));
  const hist = require('../server/analystHistory');
  hist.record({ at: new Date().toISOString(), report: { marketView: 'v', positions: [], proposals: [] }, created: [] });
  const row = hist.list({ limit: 5 }).find((r) => r.kind === 'full');
  assert.equal(row.budgetDecision, null);
});
