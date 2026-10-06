/**
 * 💸 **수수료 게이트 + 요율 배선** — 2026-10-06
 *
 * 사용자: *"너 매수/매도할때 수수료 계산 안하고 있어?"* → *"너 자꾸 왜 나 손해보게 팔려고 해
 * 수수료 계산하면 1달러 손해인데 너 미쳤어?"*
 *
 * ## 세 구멍이 있었다 (전부 "계산해 놓고 안 쓰는" 가족)
 *  ① 수수료율 절이 **프롬프트가 굳은 뒤** push 돼 어떤 LLM 호출에도 안 들어갔다
 *     ⇒ 모델이 왕복 수수료가 차익을 먹는 **1주 주문**을 제약 없이 냈다(QQQ = 팔면 −$1.18)
 *  ② `costRate` 를 `held?.currency` 로 골라 **미보유 후보가 전부 KR 요율**(0.015%)로 떨어졌다
 *     — 실제 US 는 0.1% 로 **6.7배**. 미국 후보 손익비가 실제보다 좋게 나왔다
 *  ③ `rrAfterFee`(수수료 반영 손익비)를 계산만 하고 **소비하는 코드가 0곳**이었다
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const a = require('../server/analystService');

// ── ② 시장 판정 (후보가 KR 로 떨어지던 자리) ──
test('시장 판정 — 보유 통화 우선, 없으면 심볼 모양(KR=6자리)', () => {
  assert.equal(a.marketOfSymbol('QQQM'), 'US', '미보유 미국 후보가 KR 로 떨어진다 — 요율이 6.7배 어긋난다');
  assert.equal(a.marketOfSymbol('005930'), 'KR');
  assert.equal(a.marketOfSymbol('QQQ', 'USD'), 'US');
  assert.equal(a.marketOfSymbol('005930', 'KRW'), 'KR');
  assert.equal(a.marketOfSymbol('  000660  '), 'KR', '공백이 섞이면 판정이 뒤집힌다');
  // 보유 통화가 심볼보다 정본 — 둘이 어긋나면 통화를 따른다
  assert.equal(a.marketOfSymbol('QQQ', 'KRW'), 'KR');
});

// ── ③ 게이트 — 쌍으로 ──
const T = (over) => ({ symbol: 'QQQ', trade: { entry: 757.2, target: 757.5, costRate: 0.001, ...over } });

test('게이트 발동 — 수수료 빼면 이익이 안 남는 제안은 거부', () => {
  const r = a.feeGate({ symbol: 'QQQ', side: 'BUY' },
    [T({ rrAfterFee: null, rrAfterFeeNote: '수수료를 빼면 이익이 남지 않습니다' })]);
  assert.equal(r.ok, false, '수수료로 손해인 제안이 통과했다');
  assert.match(r.why, /이익이 남지 않습니다/);
  assert.match(r.why, /0\.100%/, '사유에 요율이 없다 — 왜 막혔는지 알 수 없다');
});

test('오탐 금지 — 이익이 남으면 통과 · 판정 불가면 통과', () => {
  assert.equal(a.feeGate({ symbol: 'QQQ' }, [T({ rrAfterFee: 2.4 })]).ok, true, '정상 제안을 막았다');
  // 손익비 계산이 없는 종목(목표가 미제시·요율 조회 실패) → 판정 불가를 거부로 바꾸지 않는다
  assert.equal(a.feeGate({ symbol: 'QQQ' }, [{ symbol: 'QQQ' }]).ok, true, '판정 불가를 거부로 읽었다');
  assert.equal(a.feeGate({ symbol: 'NEW' }, [T({ rrAfterFee: null })]).ok, true, '다른 종목 판단으로 막았다');
  // 🔴 rrAfterFee < 1 은 막지 않는다 — 적립(DCA)은 손익비로 판단하는 게 아니다
  assert.equal(a.feeGate({ symbol: 'QQQ' }, [T({ rrAfterFee: 0.4 })]).ok, true,
    '손익비가 낮다고 막으면 적립 전략이 통째로 멈춘다');
});

// ── ①③ 배선 — 소스로 못박는다(라이브는 실주문이 필요해 테스트가 원리상 못 본다) ──
test('배선 — 수수료 절이 프롬프트가 굳기 전에 들어간다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  const fee = src.indexOf('## 수수료율 (편도 · 왕복은 2배)');
  const freeze = src.indexOf("const userPrompt = lines.join('\\n');");
  assert.ok(fee > 0, '수수료율 절이 없다');
  assert.ok(freeze > 0, '프롬프트가 굳는 자리를 못 찾았다 — 자가 대상을 잃었다');
  assert.ok(fee < freeze,
    `수수료 절(${fee})이 프롬프트 생성(${freeze}) **뒤**에 있다 — 어떤 LLM 호출에도 안 들어간다`);
  // 모델에게 "소액 주문 금지" 를 말하는가
  assert.match(src.slice(fee, freeze), /수수료가 차익을 먹는 주문을 내지 마라/);
});

test('배선 — feeGate 가 실전·백테스트 양쪽에서 불린다(게이트가 두 벌이면 갈라진다)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  const calls = (src.match(/feeGate\(/g) || []).length;
  assert.ok(calls >= 3, `feeGate 호출이 ${calls}회 — 선언 1 + 실전 1 + 백테스트 1 = 3 미만이면 한쪽이 빠졌다`);
  assert.match(src, /analyst\.proposal_fee_blocked/, '거부를 로그로 남기지 않는다 — 조용한 게이트는 죽어도 모른다');
});
