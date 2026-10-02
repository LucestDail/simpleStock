/**
 * 보유 종목에 **자리를 따로 준다** (2026-10-02 — O 누락 네 회차 연속의 원인)
 *
 * ## 원인
 * `positions` 는 **보유와 후보가 함께** 들어가는 한 배열(`maxItems: 6`)이었다.
 * 도구상자가 커져 후보가 7~10종이 되자 모델이 후보 위주로 답하고 보유를 밀어냈다.
 * O 는 **2주 · $107 · 비중 0.7%** 라 **가장 먼저 버려진다.**
 *
 * ## 🔴 프롬프트로는 네 번 다 실패했다
 * 지시문에 *"보유 종목은 하나도 빠뜨리지 말고 전부 판단하십시오"* 가 **이미 있고**
 * 재요청에도 종목명을 찍어 다시 요구한다. 네 회차 모두 안 들었다.
 * ⇒ **프롬프트로 못 고치는 것은 구조로 바꾼다.**
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../server/analystService');
const SRC = () => fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

test('🔴 보유 심볼이 **enum 으로** 들어가고 개수가 고정된다', () => {
  const sc = svc._reportSchemaFor(['O', 'QLD', 'RAM']);
  const h = sc.properties.holdings;
  assert.ok(h, 'holdings 자리가 없다 — 보유가 후보와 또 경쟁한다');
  assert.strictEqual(h.minItems, 3);
  assert.strictEqual(h.maxItems, 3, '개수가 고정이 아니면 또 밀려난다');
  assert.deepStrictEqual(h.items.properties.symbol.enum, ['O', 'QLD', 'RAM']);
  assert.ok(sc.required.includes('holdings'), 'required 가 아니면 비어 와도 통과한다');
  // ⚠️ 한 글자 티커가 **그대로** 살아야 한다 — O 가 이 사고의 주인공이다
  assert.ok(h.items.properties.symbol.enum.includes('O'));
});

test('⚠️ 보유가 없으면 원래 스키마 — 빈 enum 은 스키마를 깨뜨린다', () => {
  assert.strictEqual(svc._reportSchemaFor([]), svc._REPORT_SCHEMA);
  assert.strictEqual(svc._reportSchemaFor(undefined), svc._REPORT_SCHEMA);
});

test('⚠️ 중복·공백·소문자를 정규화한다', () => {
  const sc = svc._reportSchemaFor(['o', 'O', ' qld ', '', null]);
  assert.deepStrictEqual(sc.properties.holdings.items.properties.symbol.enum, ['O', 'QLD']);
});

test('⚠️ 원본 스키마를 **변형하지 않는다** — 다음 호출이 오염된다', () => {
  svc._reportSchemaFor(['O']);
  assert.ok(!svc._REPORT_SCHEMA.properties.holdings, '원본에 holdings 가 새어 들어갔다');
  assert.ok(!svc._REPORT_SCHEMA.required.includes('holdings'));
});

test('🔴 배선 — 분석 3경로가 전부 동적 스키마를 쓴다', () => {
  const s = SRC();
  const dyn = (s.match(/schema: reportSchemaFor\(items\.map\(/g) || []).length;
  assert.strictEqual(dyn, 3, `본요청·재시도·가격수정 3곳이어야 한다 (지금 ${dyn})`);
  // 🔴 한 곳이라도 옛 상수로 남으면 **그 경로에서만** 보유가 또 밀린다
  const inAnalyze = s.slice(s.indexOf('async function analyze('));
  assert.ok(!/schema: REPORT_SCHEMA,/.test(inAnalyze.slice(0, inAnalyze.indexOf('\nasync function ') + 1 || undefined)),
    'analyze() 안에 옛 상수 스키마가 남아 있다');
});

test('⚠️ shapeReport 가 holdings 배열도 모은다 (합치는 코드를 따로 안 쓴 전제)', () => {
  const r = svc._shapeReport({
    marketView: 'x', momentumRead: 'y', dataGaps: [],
    holdings: [{ symbol: 'O', stance: 'HOLD', confidence: 'LOW', rationale: 'r', evidence: [], risk: 'k' }],
    positions: [{ symbol: 'SOXX', stance: 'HOLD', confidence: 'LOW', rationale: 'r', evidence: [], risk: 'k' }],
    proposals: [],
  });
  const syms = r.positions.map((p) => p.symbol).sort();
  assert.deepStrictEqual(syms, ['O', 'SOXX'], '두 배열이 합쳐지지 않으면 보유가 화면에서 사라진다');
});
