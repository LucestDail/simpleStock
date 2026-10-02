/**
 * 진입·손절·목표의 **현재가 정합성** (2026-10-02 사용자 지적)
 *
 * 화면 실측:
 * ```
 * QLD  진입 92.53 · 손절 89.50 · 목표 97.00   ← 현재가 97.6
 * UUP  진입 29.59 · 손절 28.20 · 목표 31.50   ← 현재가 28.44
 * ```
 * 🔴 종전 검증은 **방향**(`stop < entry < target`)만 봤고 **둘 다 통과한다.**
 *    그런데 **QLD 목표 97 은 현재가 97.6 보다 낮다** — 사자마자 달성된 목표다.
 *    UUP 는 진입이 현재가보다 **4% 높은데**(추격매수) 화면에 그 사실이 없다.
 *
 * ⇒ `last` 를 받아 ①이미 달성된 목표인가 ②진입이 현재가에서 얼마나 먼가를 함께 낸다.
 * ⚠️ **값을 지우지 않는다** — 모델이 쓴 숫자는 남기고 **사실을 덧붙인다.**
 *    다만 **rr 은 null 로** 만든다 — 달성된 목표로 계산한 손익비는 **거짓 확신**이다.
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeTrade } = require('../server/analystService');

test('🔴 매수인데 목표가 현재가 이하 — rr 을 내지 않고 사실을 적는다', () => {
  const t = computeTrade({ side: 'HOLD', entry: 92.53, stop: 89.5, target: 97, last: 97.6 });
  assert.strictEqual(t.error, undefined, '방향은 맞으므로 에러가 아니다');
  assert.strictEqual(t.rr, null, '🔴 달성된 목표로 손익비를 내면 거짓 확신이 된다');
  assert.match(t.levelNote || '', /이미 달성/, '무슨 일인지 적지 않으면 사용자가 모른다');
  // ⚠️ 모델이 쓴 값 자체는 **지우지 않는다**
  assert.ok(t.perShareRisk > 0);
});

test('🔴 매도인데 목표가 현재가 이상 — 같은 판정', () => {
  const t = computeTrade({ side: 'SELL', entry: 50, stop: 55, target: 52, last: 51 });
  assert.strictEqual(t.rr, null);
  assert.match(t.levelNote || '', /이미 달성/);
});

test('⚠️ 멀쩡한 목표는 그대로 — 오탐 0', () => {
  const t = computeTrade({ side: 'BUY', entry: 92.53, stop: 89.5, target: 105, last: 97.6 });
  assert.ok(t.rr > 0, `정상 목표인데 rr 이 비었다: ${JSON.stringify(t)}`);
  assert.strictEqual(t.levelNote, undefined);
});

test('🔴 진입이 현재가에서 얼마나 먼지 — 추격매수와 지정가 대기를 가른다', () => {
  const chase = computeTrade({ side: 'BUY', entry: 29.59, stop: 28.2, target: 31.5, last: 28.44 });
  assert.ok(chase.entryGapPct > 0, '현재가보다 높으면 양수여야 한다(추격매수)');
  assert.strictEqual(chase.entryGapPct, 4.04);

  const wait = computeTrade({ side: 'BUY', entry: 92.53, stop: 89.5, target: 105, last: 97.6 });
  assert.ok(wait.entryGapPct < 0, '현재가보다 낮으면 음수여야 한다(지정가 대기)');
});

test('⚠️ 현재가를 못 구하면 **검사하지 않는다** — 통과가 아니라 미검사', () => {
  const t = computeTrade({ side: 'BUY', entry: 92.53, stop: 89.5, target: 97 });
  assert.strictEqual(t.entryGapPct, undefined, '없는 현재가로 괴리를 지어내면 안 된다');
  assert.strictEqual(t.levelNote, undefined, '못 쟀는데 "달성됐다" 고 단정하면 안 된다');
  assert.ok(t.rr > 0, '현재가가 없으면 종전대로 방향만 보고 rr 을 낸다');
});

test('🔴 배선 — 호출부가 보유·후보 **둘 다**에서 현재가를 찾는다', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(src, /last: Number\(held\?\.lastPrice\)/, '보유 현재가를 안 넘긴다');
  assert.match(src, /tech\?\.\[String\(ps\.symbol\)\.toUpperCase\(\)\]\?\.last/,
    '🔴 후보 종목 현재가를 안 넘긴다 — UUP 가 정확히 그 경우였다');
});

/**
 * 🔴 **괴리가 크면 "먼 가격" 이 아니라 그 종목 가격이 아니다** (2026-10-02 22:07 회차 실측)
 *
 * ```
 * RAM  entry=29.59  stop=28.20  target=31.50   ← RAM 현재가 14.50
 * ```
 * 진입이 **실제가의 2배**(+104%)인데 방향 검사는 통과하고 **손익비 1.37 까지 계산돼**
 * 화면에 떴다. 모델은 **71일 고점(≈28.7)을 진입으로** 썼다 — 근거는 있지만 제안이 아니다.
 * ★ 틀린 진입으로 낸 rr 은 **"1.37" 이라는 그럴듯한 숫자**가 되어 사용자를 설득한다.
 *   그게 제일 위험하다.
 */
test('🔴 진입이 현재가에서 +104% — 손익비를 내지 않고 사실을 적는다', () => {
  const t = computeTrade({ side: 'HOLD', entry: 29.59, stop: 28.2, target: 31.5, last: 14.5 });
  assert.strictEqual(t.entryFar, true);
  assert.strictEqual(t.rr, null, '🔴 틀린 진입으로 낸 rr 이 사용자를 설득한다');
  assert.strictEqual(t.rrAfterFee, null);
  assert.match(t.levelNote || '', /가격대가 맞는지/);
  assert.strictEqual(t.entryGapPct, 104.07);
  // ⚠️ 모델이 쓴 값 자체는 **지우지 않는다**
  assert.ok(t.perShareRisk > 0);
});

test('⚠️ 오탐 0 — 정당한 ±30% 레벨은 살아 있다', () => {
  /**
   * ⚠️ **처음에 쓴 케이스가 틀렸다** — `entry 70 · last 100 · target 84` 는 목표가
   *    현재가 **아래**라 *"이미 달성"* 판정이 **맞다**(자가 맞고 내 케이스가 틀렸다).
   *    ⇒ 목표는 **현재가 위**로 둬서 **괴리 축만** 재게 한다. 한 테스트가 두 축을
   *      섞어 재면 어느 쪽이 걸렸는지 알 수 없다.
   */
  for (const [entry, last] of [[92.53, 97.6], [130, 100], [70, 100]]) {
    const target = Math.max(entry, last) * 1.2;      // 항상 현재가 위
    const t = computeTrade({ side: 'BUY', entry, stop: entry * 0.95, target, last });
    assert.ok(!t.entryFar, `정당한 레벨이 죽었다: entry=${entry} last=${last}`);
    assert.ok(t.rr > 0, `rr 이 사라졌다: entry=${entry} last=${last} → ${JSON.stringify(t)}`);
  }
});

test('⚠️ 상한은 설정으로 바꿀 수 있고 **기본이 넉넉하다**', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  assert.match(src, /ANALYST_ENTRY_GAP_MAX_PCT/, '운영에서 조절할 수 없으면 오탐 시 코드를 고쳐야 한다');
  assert.match(src, /\|\| 50;/, '기본값이 좁으면 정당한 레벨을 죽인다');
});

/**
 * 🔴 **진입만 비어 오는 반쪽** (2026-10-02 라이브 — 프롬프트를 고친 직후 나왔다)
 *
 * `QLD entry=null stop=92.70 target=103.72` — 손절·목표는 있는데 **진입이 없다.**
 * `computeTrade` 가 `진입가 없음` 으로 끝나 **손익비·수량이 통째로 안 나오고**,
 * 화면엔 `손절 92.7 · 목표 103.72` 만 떠서 **무엇 대비 손절인지 알 수 없다.**
 *
 * ⚠️ 내가 *"값을 못 정하면 비우십시오"* 를 넣은 **직후** 났다 —
 *    ★**지시를 하나 넣으면 그게 어디까지 적용될지 본다.** 의도한 칸(0 대신 비우기)을 넘어 번졌다.
 */
test('🔴 진입이 비면 현재가로 메우고 **표시를 남긴다**', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(src, /if \(!ps\.entry && \(ps\.stop \|\| ps\.target\)\)/, '반쪽을 메우는 분기가 없다');
  assert.match(src, /_entryFromPrice = true/, '🔴 코드가 메웠다는 표시가 없으면 모델 값과 구분이 안 된다');
  assert.match(src, /analyst\.entry_filled_from_price/, '메운 사실이 로그에 안 남는다');
  // ⚠️ **전부 비어 있으면 메우지 않는다** — 그건 "레벨 없음" 이지 반쪽이 아니다
  assert.match(src, /ps\.stop \|\| ps\.target/, '조건이 좁지 않으면 레벨 없는 종목까지 메운다');
});

test('⚠️ 화면이 **코드가 메운 값**을 구분해 보여준다', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const vue = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'WorkspaceView.vue'), 'utf8');
  assert.match(vue, /ps\._entryFromPrice/, '화면이 표시를 안 읽는다');
  assert.match(vue, /\.pos__auto \{/, '🔴 클래스에 규칙이 없으면 맨몸으로 나간다');
});
