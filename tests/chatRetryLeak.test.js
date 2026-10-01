const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

/**
 * 재시도가 **답을 두 배로 보여주던 것** + 증권사 수익률 자기모순 — 2026-10-01 실사고
 *
 * ## 사용자가 실제로 받은 것
 * ```
 * (도구 호출)
 * [도구 결과] get_portfolio({"summary":{"purchase":{...계좌 전체 JSON...}})   ← pass 1
 *
 * 내 포트폴리오 — 3종목, 평가손익 +$188 …                                    ← pass 2
 * ⚠️ 답이 미완으로 끝나 한 번 더 완결을 요청합니다.                            ← 재시도 안내
 * ```
 *
 * ## 세 가지가 겹쳤다
 * ```
 * ① analystChat 은 재시도 때 자기 answer 를 비우는데 **텔레그램은 자기 누적기를 안 비웠다**
 *    ⇒ pass1 + pass2 가 둘 다 발송. 하필 pass1 이 **도구 결과 원문**(잔고·보유 전량)이다
 * ② 성공한 재시도까지 사용자에게 알려서, **완결된 답 뒤에** "미완으로 끝났다" 가 붙었다
 * ③ 그 답의 "+0.98%" 는 모델이 **스스로 다시 계산**한 값이다 — 우리가 준 summary.profitRate
 *    는 **-8.9%** 였다(증권사가 자기 금액 +$220 과 부호가 반대인 rate 를 줬고 우리가 통과시켰다)
 * ```
 * ★ ③이 드러난 경위가 중요하다 — **모델이 우리 숫자를 안 믿고 다시 계산한 덕에** 보였다.
 *   믿었으면 "-8.9%" 가 그대로 폰으로 갔다.
 */

const chatSrc = fs.readFileSync(require.resolve('../server/analystChat'), 'utf8');
const botSrc = fs.readFileSync(require.resolve('../server/telegramBot'), 'utf8');
const portSrc = fs.readFileSync(require.resolve('../server/tossPortfolio'), 'utf8');

// ── ① 재시도 시 누적분 폐기 ──────────────────────────────────────

test('🔴 재시도를 시작하면 소비자에게 "지금까지 받은 것을 버려라" 고 알린다', () => {
  const block = chatSrc.slice(chatSrc.indexOf('retriedFinal = true;'), chatSrc.indexOf("answer = '';", chatSrc.indexOf('retriedFinal = true;')) + 20);
  assert.ok(block.includes("emit('answer_restart'"),
    '재시도 신호가 없으면 소비자는 pass1 을 들고 있다가 pass2 와 함께 보낸다');
});

test('🔴 텔레그램이 그 신호를 받아 누적기를 비운다 (안 비우면 도구 결과 원문이 폰으로 간다)', () => {
  const h = botSrc.slice(botSrc.indexOf('emit: (event, data) =>'), botSrc.indexOf('},', botSrc.indexOf("tool_result'")) + 400);
  assert.ok(/answer_restart/.test(h), '텔레그램 emit 이 answer_restart 를 모른다');
  assert.ok(/answer_restart[\s\S]{0,400}answer = ''/.test(h),
    'answer_restart 를 받고도 누적기를 안 비운다 — pass1+pass2 가 둘 다 나간다');
});

test('누적기를 비울 때 조용하지 않다 (몇 자를 버렸는지 남긴다)', () => {
  assert.ok(/tgbot\.answer_discarded/.test(botSrc),
    '버린 사실이 로그에 없으면 "원래 짧은 답" 과 "버려서 짧은 답" 이 같아 보인다');
});

// ── ② 성공한 재시도는 조용하다 ───────────────────────────────────

test('🔴 재시도가 성공하면 사용자에게 알리지 않는다 (완결된 답 뒤의 경고는 멀쩡한 답을 의심하게 만든다)', () => {
  const i = chatSrc.indexOf("logWarn('chat.final_stub_retry'");
  const win = chatSrc.slice(i, i + 700);
  assert.ok(!win.includes("emit('notice'"),
    '재시도 시작 지점에서 notice 를 보내면 성공한 복구까지 사용자에게 알린다');
});

test('🔴 재시도까지 실패하면 반드시 알린다 (조용한 쪽으로 기울면 미완 답이 그냥 나간다)', () => {
  assert.ok(chatSrc.includes("chat.final_stub_after_retry"), '두 번째 실패를 기록하지 않는다');
  const i = chatSrc.indexOf('chat.final_stub_after_retry');
  assert.ok(chatSrc.slice(i, i + 400).includes("emit('notice'"),
    '두 번 다 미완인데 사용자에게 아무 말도 안 한다');
});

// ── ③ 수익률 자기모순 ───────────────────────────────────────────

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
let logged = [];
/**
 * ⚠️ `deriveRatePct` 는 private 이라 소스에서 떼어 와 돈다. 그 안에서 부르는
 *    `reportRateMismatch` 를 **이 범위에 세워 둬야** 한다 — 안 그러면 ReferenceError 가
 *    나고 *"계산이 틀렸다"* 로 읽힌다(실제로 한 번 그렇게 깨졌다).
 */
const reportRateMismatch = (label, reported, derived) => { logged.push({ e: 'toss.rate_mismatch', f: { label, reported, derived } }); return true; };
eval(portSrc.match(/function ratePct[\s\S]*?\n}/)[0]);
eval(portSrc.match(/function deriveRatePct[\s\S]*?\n}/)[0]);

test('🔴 증권사 수익률이 자기 금액과 어긋나면 **유도값을 따로 낸다** (라이브에서 받은 바로 그 값)', () => {
  logged = [];
  // toss 실측: amount +$220.235 · purchase $14,146.88 · rate "-0.087"(= -8.7%)
  const r = deriveRatePct({ krw: '0', usd: '220.235217' }, { krw: '0', usd: '14146.884783' }, ratePct('-0.087'), 'profit');
  assert.ok(r > 1 && r < 2, `계산값이 ${r} — +1.56% 근처여야 한다`);
  assert.ok(r > 0, '🔴 부호가 반대면 사용자는 손실 구간으로 읽는다');
  assert.equal(logged.length, 1, '어긋난 사실을 안 남기면 다음 사람이 왜 두 값이 다른지 모른다');
  assert.equal(logged[0].e, 'toss.rate_mismatch');
});

test('증권사 값과 맞으면 경고하지 않는다 (오탐 축)', () => {
  logged = [];
  const r = deriveRatePct({ krw: '0', usd: '100' }, { krw: '0', usd: '1000' }, 10, 'profit');
  assert.equal(r, 10);
  assert.equal(logged.length, 0, '맞는데도 경고하면 로그가 소음이 된다');
});

test('통화가 섞이면 계산하지 않고 증권사 값을 쓴다 (환율 없이 합치면 지어내는 것이다)', () => {
  logged = [];
  assert.equal(deriveRatePct({ krw: '5000', usd: '100' }, { krw: '100000', usd: '1000' }, -3, 'profit'), -3);
  assert.equal(logged.length, 0);
});

test('매입액이 0이면 나누지 않는다', () => {
  assert.equal(deriveRatePct({ krw: '0', usd: '100' }, { krw: '0', usd: '0' }, 7, 'profit'), 7);
  assert.equal(deriveRatePct(null, null, null, 'profit'), null);
});

test('원화 전용 계좌에서도 계산한다', () => {
  assert.equal(deriveRatePct({ krw: '5000', usd: '0' }, { krw: '100000', usd: '0' }, 5, 'profit'), 5);
});

test('🔴 증권사 값을 **덮어쓰지 않는다** — 그 필드의 의미를 우리가 모른다', () => {
  /**
   * 처음엔 `profitRate` 를 계산값으로 **갈아끼웠다.** 그런데 저장소에 캡처된 실제 응답
   * (`tests/tossClient.test.js:448`)에서도 같은 괴리가 있었다 — amount −272.72 /
   * purchase 15,539.90 = **−1.75%** 인데 rate 는 **−9.88%**.
   * ⇒ **오늘 생긴 버그가 아니라 일관되게 다른 필드**이고, 실현 손익 포함 같은 **다른
   *   의미**일 수 있다. 의미를 모르는 제3자 값을 우리 해석으로 덮으면 **맞았을 때도
   *   틀렸을 때도 아무도 모르게 된다.** 기존 테스트가 그 성급함을 잡았다.
   */
  assert.ok(/profitRate: ratePct\(r\?\.profitLoss\?\.rate\)/.test(portSrc),
    '증권사 원본을 덮어썼다 — 의미를 모르는 값을 갈아끼우면 안 된다');
  assert.ok(/profitRateDerived:/.test(portSrc), '유도값을 나란히 안 싣는다');
});

test('⚠️ 일간 수익률은 손대지 않는다 — 기준이 다르다(전일 평가액)', () => {
  // 실측에서 dailyProfitLoss.rate(0.0132)는 자기 금액과 **맞았다**. 고칠 것만 고친다.
  assert.ok(/dailyRate: ratePct\(r\?\.dailyProfitLoss\?\.rate\)/.test(portSrc),
    '일간까지 매입액 기준으로 다시 계산하면 그건 다른 수치가 된다');
});

test('🔴 summary 가 실제로 그 계산을 쓴다 (순수 함수만 재면 "안 불린다" 를 못 잡는다)', () => {
  /**
   * 변이 검증에서 이 구멍이 드러났다 — `deriveRatePct` 를 직접 불러 재는 테스트는
   * **호출부를 떼어내도 전부 통과**했다. 로직이 맞아도 안 불리면 사용자는 그대로
   * -8.9% 를 본다.
   */
  const i = portSrc.indexOf('const summary = {');
  const block = portSrc.slice(i, portSrc.indexOf('accountType:', i));
  assert.ok(/profitRateDerived:\s*deriveRatePct\(/.test(block),
    'summary 가 유도값을 안 만든다 — 계산이 배선에서 빠졌다');
  // 그리고 **프롬프트가 그 값을 실제로 쓰는지**까지 본다(만들어 놓고 안 쓰면 소용없다)
  const ana = fs.readFileSync(require.resolve('../server/analystService'), 'utf8');
  /**
   * ⚠️ **이름이 있는지만 보면 안 된다** — 변이 검증에서 조건을 `false &&` 로 막아도
   *    이름은 그대로 남아 통과했다. **분기가 실제로 두 값을 비교하는지**까지 본다.
   */
  assert.ok(/summary\.profitRateDerived\s*!=\s*null/.test(ana),
    '유도값을 만들어 놓고 프롬프트가 안 쓴다 — "수집해 놓고 안 쓰는" 그 자리다');
  assert.ok(/Math\.abs\(summary\.profitRateDerived\s*-\s*summary\.profitRate\)/.test(ana),
    '두 값을 비교하지 않으면 "다르다" 를 영영 못 알린다');
});

// ── ④ 내가 만든 경고가 로그를 삼켰다 (라이브 실측 후 추가) ───────────
//
// 🔴 `toss.rate_mismatch` 를 배포하고 3.3시간 만에 **284건**이 쌓였다
//    (시간당 86 → 117 로 증가). `getHoldings` 는 화면 폴링·브리핑·채팅마다 불리는데
//    괴리 자체는 상수(약 10%p)라, 가격이 틱할 때마다 **같은 사실을 다시 외쳤다.**
// ⚠️ 몇 시간 전에 `watchlist.stale_quote_dropped` 에서 똑같은 것을 고치고,
//    교훈을 적어 놓고, **같은 세션에서 또 만들었다.** 그래서 규칙이 아니라 **자**로 옮긴다.

const toss = require('../server/tossPortfolio');
const HOUR = 60 * 60_000;

test('🔴 같은 괴리가 이어지면 매번 외치지 않는다 (3.3시간에 284건이던 것)', () => {
  toss._resetRateMismatchForTest();
  const t0 = 1_700_000_000_000;
  let n = 0;
  // 가격만 틱하고 괴리는 그대로인 상황 — 라이브에서 실제로 이랬다
  for (let i = 0; i < 60; i += 1) {
    if (toss.reportRateMismatch('profit', -8.70 - i * 0.001, 1.50 + i * 0.001, t0 + i * 1000)) n += 1;
  }
  assert.equal(n, 1, `60번 호출에 ${n}건 — 같은 사실을 반복해 찍으면 옆의 진짜 경고가 묻힌다`);
});

test('괴리가 **달라지면** 다시 말한다 (조용히 묻으면 변화를 놓친다)', () => {
  toss._resetRateMismatchForTest();
  const t0 = 1_700_000_000_000;
  assert.equal(toss.reportRateMismatch('profit', -8.7, 1.5, t0), true, '처음은 말해야 한다');
  assert.equal(toss.reportRateMismatch('profit', -8.7, 1.5, t0 + 1000), false);
  assert.equal(toss.reportRateMismatch('profit', -2.0, 1.5, t0 + 2000), true, '괴리가 10%p→3%p 로 바뀌었는데 침묵했다');
});

test('한 시간에 한 번은 생존 신호를 낸다 (조용한 것과 검사가 멈춘 것은 다르다)', () => {
  toss._resetRateMismatchForTest();
  const t0 = 1_700_000_000_000;
  toss.reportRateMismatch('profit', -8.7, 1.5, t0);
  assert.equal(toss.reportRateMismatch('profit', -8.7, 1.5, t0 + HOUR - 1000), false, '아직 한 시간이 안 됐다');
  assert.equal(toss.reportRateMismatch('profit', -8.7, 1.5, t0 + HOUR + 1000), true, '한 시간이 지나도 침묵하면 "고쳐졌다" 와 구분이 안 된다');
});

test('필드가 다르면 따로 센다 (하나가 다른 하나를 가리면 안 된다)', () => {
  toss._resetRateMismatchForTest();
  const t0 = 1_700_000_000_000;
  assert.equal(toss.reportRateMismatch('profit', -8.7, 1.5, t0), true);
  assert.equal(toss.reportRateMismatch('daily', -8.7, 1.5, t0), true, '다른 필드인데 앞 필드 때문에 삼켜졌다');
});
