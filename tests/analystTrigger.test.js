const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decide, trackUniverse, zScore, describe: describeReasons, CLEAR_RATIO } = require('../server/analystTrigger');

/**
 * 분석 실행 시점 (2026-09-21 사용자 지시)
 *
 * *"장마감 + 모멘텀 발생시점에만 작동해야 LLM 토큰 비용을 아낄 수 있을 거 같은데."*
 *
 * ## 이 자가 지키는 것
 *
 * 1. **전이일 때만** 돈다 — 장이 닫혀 있는 내내, 주가가 높이 떠 있는 내내 부르면 안 된다
 * 2. **판정 불가를 평범함으로 읽지 않는다** — 표본이 없으면 표시를 건드리지 않는다
 * 3. **매도 뒤에도 되살 자리를 본다** — 보유만 보면 판 순간 시야에서 사라진다(사용자 지적)
 */

const DAY = 24 * 60 * 60 * 1000;
/** 평균 0 · σ 1 에 가까운 표본 20개 */
const CALM = [0.9, -1.1, 0.5, -0.4, 1.2, -0.8, 0.3, -0.2, 1.0, -1.0, 0.6, -0.6, 0.8, -0.9, 0.2, -0.3, 1.1, -1.2, 0.4, -0.5];

// ── 모멘텀 자 ────────────────────────────────────────────────

/**
 * 🔴 **고정 %가 아니라 그 종목치고 이상한가** — 실측이 이 설계를 만들었다.
 * 고정 3%: QLD 월 6.4 · RAM 월 **15.4** · SPY 월 **0**  ⇒ 종목마다 30배
 * 2σ:      QLD 1.4 · RAM 1.0 · SPY 1.8 · NVDA 1.6       ⇒ 고르다
 */
test('🔴 같은 3% 라도 종목에 따라 다르게 판정한다 (고정 %의 반대)', () => {
  const calmZ = zScore(3, CALM);                       // 조용한 종목의 3%
  const wildZ = zScore(3, CALM.map((x) => x * 5));     // 변동성 5배 종목의 3%
  assert.ok(calmZ > 2, `조용한 종목의 3% 가 이상하지 않다고 나왔다(z=${calmZ})`);
  assert.ok(wildZ < 1, `🔴 변동성 큰 종목의 3% 를 이상하다고 했다(z=${wildZ}) — RAM 이 매일 걸린다`);
});

test('표본이 적으면 **판정하지 않는다** (0 이 아니라 null)', () => {
  assert.equal(zScore(5, [1, -1, 2]), null, '🔴 3일치로 σ 를 냈다');
  assert.equal(zScore(5, []), null);
  // ⚠️ null 과 0 은 다르다 — 0 은 "평범하다" 는 **판정**이다
  assert.notEqual(zScore(5, CALM), null);
});

test('움직이지 않는 종목은 판정하지 않는다 (σ=0 은 나눌 수 없다)', () => {
  assert.equal(zScore(1, new Array(20).fill(0)), null);
});

// ── 장마감 ──────────────────────────────────────────────────

const S = (key, state) => ({ key, label: key.toUpperCase(), state });

test('🔴 장마감은 **전이일 때만** 부른다 (닫혀 있는 내내가 아니다)', () => {
  // 첫 실행 = 기준선. 부르지 않는다
  let r = decide({ now: 1, sessions: [S('us', 'open')], state: {} });
  assert.equal(r.run, false, '🔴 첫 실행을 사건으로 읽었다');

  // open → closed = 사건
  r = decide({ now: 2, sessions: [S('us', 'closed')], state: r.state });
  assert.equal(r.run, true);
  assert.equal(r.reasons[0].kind, 'close');

  // 계속 닫혀 있음 = 사건 아님
  r = decide({ now: 3, sessions: [S('us', 'closed')], state: r.state });
  assert.equal(r.run, false, '🔴 닫혀 있는 내내 분석을 돌린다 — 비용이 그대로다');
});

test('🔴 첫 실행이 마감 상태여도 부르지 않는다 (기준선이지 전이가 아니다)', () => {
  const r = decide({ now: 1, sessions: [S('us', 'closed')], state: {} });
  assert.equal(r.run, false, '🔴 재기동할 때마다 분석이 돈다 — 배포 11회면 11번이다');
});

test('다음 날 다시 닫히면 **새 사건**이다', () => {
  let r = decide({ now: 1, sessions: [S('us', 'open')], state: {} });
  r = decide({ now: 2, sessions: [S('us', 'closed')], state: r.state });
  r = decide({ now: 3, sessions: [S('us', 'open')], state: r.state });
  r = decide({ now: 4, sessions: [S('us', 'closed')], state: r.state });
  assert.equal(r.run, true, '🔴 이튿날 마감을 못 잡는다');
});

// ── 모멘텀 전이 ──────────────────────────────────────────────

const row = (symbol, pct, history = CALM, role = 'held') => ({ symbol, dailyChangePct: pct, history, role });

test('🔴 모멘텀은 **통과하는 순간** 한 번만 (넘어 있는 내내가 아니다)', () => {
  let r = decide({ now: 1, symbols: [row('QLD', 5)], state: {} });
  assert.equal(r.run, true);
  assert.equal(r.reasons[0].kind, 'momentum');

  r = decide({ now: 2, symbols: [row('QLD', 5.2)], state: r.state });
  assert.equal(r.run, false, '🔴 계속 떠 있는 동안 매번 돈다');
});

test('🔴 내려왔다 다시 넘으면 새 사건이다 (표시를 지운다)', () => {
  let r = decide({ now: 1, symbols: [row('QLD', 5)], state: {} });
  r = decide({ now: 2, symbols: [row('QLD', 0.2)], state: r.state });  // 충분히 내려옴
  assert.equal(r.run, false);
  r = decide({ now: 3, symbols: [row('QLD', 5)], state: r.state });
  assert.equal(r.run, true, '🔴 되돌아온 뒤 다시 넘었는데 안 잡는다');
});

/**
 * 🔴 **히스테리시스** — 문턱 하나로 켜고 끄면 z 가 1.99↔2.01 을 오갈 때마다 새 사건이 된다.
 * 오늘 텔레그램 진동에서 겪은 것과 같은 모양이다.
 */
test('🔴 문턱 바로 아래로만 내려온 것은 표시를 안 지운다 (진동 방지)', () => {
  let r = decide({ now: 1, symbols: [row('QLD', 5)], state: {} });
  const z1 = r.reasons[0].z;
  // 문턱 바로 아래(2σ*0.7 보다는 위)로 내려온 값을 만든다
  const justBelow = 2 * CLEAR_RATIO * 1.05;
  const s = CALM.reduce((a, b) => a + b, 0) / CALM.length;
  const sd = Math.sqrt(CALM.reduce((a, b) => a + (b - s) ** 2, 0) / CALM.length);
  r = decide({ now: 2, symbols: [row('QLD', s + justBelow * sd)], state: r.state });
  assert.equal(r.run, false);
  r = decide({ now: 3, symbols: [row('QLD', 5)], state: r.state });
  assert.equal(r.run, false, `🔴 진동이 그대로 분석 호출이 된다(첫 z=${z1})`);
});

test('🔴 판정 불가(표본 부족)는 표시를 건드리지 않는다', () => {
  let r = decide({ now: 1, symbols: [row('QLD', 5)], state: {} });
  assert.ok(r.state.momentum.QLD, '표시가 없다');
  r = decide({ now: 2, symbols: [row('QLD', 5, [1, -1])], state: r.state });
  assert.ok(r.state.momentum.QLD, '🔴 표본이 없다고 표시를 지웠다 — 다음에 새 사건이 된다');
  assert.equal(r.run, false);
});

test('감시 대상에서 빠진 종목의 표시는 정리한다 (상태가 자라지 않게)', () => {
  let r = decide({ now: 1, symbols: [row('QLD', 5), row('RAM', 6)], state: {} });
  assert.equal(Object.keys(r.state.momentum).length, 2);
  r = decide({ now: 2, symbols: [row('QLD', 0.1)], state: r.state });
  assert.deepEqual(Object.keys(r.state.momentum), [], '🔴 사라진 종목의 표시가 남는다');
});

test('아무 일도 없으면 **안 돈다** (이게 이 기능의 목적이다)', () => {
  let r = decide({ now: 1, sessions: [S('us', 'open')], symbols: [row('QLD', 0.3)], state: {} });
  r = decide({ now: 2, sessions: [S('us', 'open')], symbols: [row('QLD', 0.4)], state: r.state });
  r = decide({ now: 3, sessions: [S('us', 'open')], symbols: [row('QLD', -0.2)], state: r.state });
  assert.equal(r.run, false, '🔴 조용한데 분석이 돈다 — 비용이 안 줄어든다');
});

// ── 감시 대상: 매도 뒤 재진입 ────────────────────────────────

/**
 * 🔴 **사용자 지적** — *"매도한다고 판정한 경우 다음 매수 시점 판정이 애매할 거 같은데,
 * 보유종목만 판정해버리면."* 팔면 포트폴리오에서 사라지고 **감시 대상에서도 빠진다.**
 */
test('🔴 팔아서 사라진 종목을 **되살 후보로 남긴다**', () => {
  const t0 = 1_000_000;
  let u = trackUniverse({}, ['QLD', 'RAM'], [], t0);
  assert.deepEqual(Object.keys(u).sort(), ['QLD', 'RAM']);
  assert.equal(u.QLD.role, 'held');

  // RAM 을 팔았다
  u = trackUniverse(u, ['QLD'], [], t0 + DAY);
  assert.equal(u.RAM?.role, 'reentry', '🔴 판 종목이 시야에서 사라졌다 — 되살 자리를 못 본다');
  assert.equal(u.QLD.role, 'held');
});

test('되살 후보도 **모멘텀 감시를 받는다** (그래야 되살 자리에 깨어난다)', () => {
  const r = decide({ now: 1, symbols: [row('RAM', 6, CALM, 'reentry')], state: {} });
  assert.equal(r.run, true);
  assert.equal(r.reasons[0].role, 'reentry', '🔴 역할이 안 실린다 — 분석이 "들고 있을까" 를 묻게 된다');
});

test('기한이 지나면 잊는다 (감시 대상이 무한히 자라지 않게)', () => {
  const t0 = 1_000_000;
  let u = trackUniverse({}, ['RAM'], [], t0);
  u = trackUniverse(u, [], [], t0 + DAY);
  assert.equal(u.RAM.role, 'reentry');
  u = trackUniverse(u, [], [], t0 + 21 * DAY);
  assert.equal(u.RAM, undefined, '🔴 판 종목을 영원히 들고 있는다');
});

test('되샀으면 다시 보유로 돌아온다', () => {
  const t0 = 1_000_000;
  let u = trackUniverse({}, ['RAM'], [], t0);
  u = trackUniverse(u, [], [], t0 + DAY);
  u = trackUniverse(u, ['RAM'], [], t0 + 2 * DAY);
  assert.equal(u.RAM.role, 'held');
  assert.equal(u.RAM.exitedAt, undefined, '되샀는데 매도 시각이 남아 있다');
});

test('목표·손절을 지정한 종목은 보유가 아니어도 본다', () => {
  const u = trackUniverse({}, ['QLD'], ['TSLA'], 1);
  assert.equal(u.TSLA.role, 'targeted');
  // ⚠️ 보유가 우선이다 — 같은 종목이면 'held'
  const u2 = trackUniverse({}, ['QLD'], ['QLD'], 1);
  assert.equal(u2.QLD.role, 'held');
});

/** ⚠️ 관심목록 전체를 넣지 않는다 — 감시는 싸도 **분석은 비싸다** */
test('⚠️ 감시 대상은 보유·되살·지정 셋뿐이다 (관심목록 전체가 아니다)', () => {
  const u = trackUniverse({}, ['QLD'], ['TSLA'], 1);
  assert.equal(Object.keys(u).length, 2, `감시 대상이 ${Object.keys(u).length}개 — 범위가 넓어졌다`);
});

// ── 사람이 읽는 이유 ─────────────────────────────────────────

test('왜 돌았는지 한 줄로 설명한다', () => {
  const r = decide({ now: 2, sessions: [S('us', 'closed')], symbols: [row('QLD', 5)], state: { sessions: { us: 'open' } } });
  const t = describeReasons(r.reasons);
  assert.match(t, /US 마감/);
  assert.match(t, /QLD 모멘텀/);
  assert.match(t, /σ/);
});

/** 🔴 자기검증 — 이 자가 **아무거나 통과시키지 않는지** */
test('🔴 자기검증: 조용한 날을 사건으로 만들지 않는다 (20회 연속)', () => {
  let state = { sessions: { us: 'open' } };
  let fired = 0;
  for (let i = 0; i < 20; i += 1) {
    const r = decide({
      now: i,
      sessions: [S('us', 'open')],
      symbols: [row('QLD', CALM[i % CALM.length])],
      state,
    });
    state = r.state;
    if (r.run) fired += 1;
  }
  assert.equal(fired, 0, `🔴 평범한 등락 20일에 ${fired}번 돌았다 — 비용이 안 준다`);
});
