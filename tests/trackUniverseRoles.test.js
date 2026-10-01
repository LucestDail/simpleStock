const { test } = require('node:test');
const assert = require('node:assert/strict');

const { trackUniverse, REENTRY_DAYS } = require('../server/analystTrigger');

/**
 * 감시 대상의 **역할(role)** — 2026-10-01
 *
 * ## 무엇이 아팠나 (라이브 실측)
 *
 * `trackUniverse` 가 `prev` 의 **모든** 항목을 돌며 보유만 빼고 전부 `reentry` 로 적어서,
 * 한 번도 산 적 없는 관심종목(`watch`)이 **첫 틱 다음부터 전부 "최근까지 보유했다 매도"**
 * 로 바뀌어 있었다.
 *
 * ```
 * 2026-10-01 11:3x  watch 플래그 41 · universe role = {reentry: 39, held: 2} · watch 0
 *                   reentry − watched = ∅   ← 39건 전부가 산 적 없는 종목
 * ```
 *
 * 프롬프트의 `## 되살/신규 진입 후보` 절이 이 role 로 라벨을 붙이므로
 * (`reentry: '최근까지 보유했다 매도'`), **모델에게 없는 보유 이력을 사실로 알려주고 있었다.**
 * "지어내지 마라" 를 가르치는 시스템이 스스로 지어낸 자리다.
 *
 * ## 왜 조용했나 — 이 자가 가장 신경 쓰는 축
 *
 * `v.exitedAt` 이 `undefined` 라 `exitedAt != null` 이 false → 만료 검사를 건너뛰고,
 * `exitedAt ?? now` 로 **매 틱 새로 찍혔다.** 만료 조건이 매번 리셋되니 **20일 추적이
 * 영구 추적**이 됐고, 아무 로그도 안 남았다. ⇒ 아래 ③·④ 가 그 축이다.
 *
 * ★ 역할 라벨은 화면에 안 보이지만 **프롬프트에 문장으로 들어간다.** 조용히 틀린 라벨은
 *   조용히 틀린 판단이 된다.
 */

const now = 1_700_000_000_000;
const TICK = 5 * 60_000;
const DAY = 24 * 60 * 60_000;

const roles = (u) => Object.fromEntries(
  Object.entries(u).map(([k, v]) => [k, v.role])
);

test('감시 종목은 틱을 아무리 넘겨도 watch 로 남는다 (되살로 바뀌지 않는다)', () => {
  let u = trackUniverse(null, ['QLD'], [], now, ['AAPL', 'MSFT']);
  assert.deepEqual(roles(u), { QLD: 'held', AAPL: 'watch', MSFT: 'watch' });

  // 🔴 종전 결함은 **두 번째 틱**에서 드러났다 — 한 틱만 재면 못 잡는다
  for (let i = 1; i <= 10; i += 1) {
    u = trackUniverse(u, ['QLD'], [], now + i * TICK, ['AAPL', 'MSFT']);
  }
  assert.deepEqual(roles(u), { QLD: 'held', AAPL: 'watch', MSFT: 'watch' });
});

test('목표·손절 지정(targeted)도 되살로 바뀌지 않는다', () => {
  let u = trackUniverse(null, [], ['TSLA'], now, []);
  assert.equal(u.TSLA.role, 'targeted');
  u = trackUniverse(u, [], ['TSLA'], now + TICK, []);
  assert.equal(u.TSLA.role, 'targeted');
});

test('진짜로 판 종목만 reentry 가 된다', () => {
  const held = trackUniverse(null, ['QLD', 'TQQQ'], [], now, []);
  const sold = trackUniverse(held, ['QLD'], [], now + TICK, []);
  assert.equal(sold.TQQQ.role, 'reentry');
  assert.equal(sold.TQQQ.wasHeld, true);
  assert.equal(sold.TQQQ.exitedAt, now + TICK);
});

test('reentry 의 exitedAt 은 틱마다 새로 찍히지 않는다 (만료가 리셋되면 안 된다)', () => {
  const held = trackUniverse(null, ['QLD', 'TQQQ'], [], now, []);
  const sold = trackUniverse(held, ['QLD'], [], now + TICK, []);
  let u = sold;
  for (let i = 1; i <= 10; i += 1) {
    u = trackUniverse(u, ['QLD'], [], now + TICK + i * TICK, []);
  }
  assert.equal(u.TQQQ.exitedAt, sold.TQQQ.exitedAt, 'exitedAt 이 갱신되면 20일 만료가 영원히 안 온다');
});

test(`reentry 는 ${REENTRY_DAYS}일째에 빠진다`, () => {
  const held = trackUniverse(null, ['QLD', 'TQQQ'], [], now, []);
  const sold = trackUniverse(held, ['QLD'], [], now + TICK, []);
  const exitedAt = sold.TQQQ.exitedAt;

  const 하루전 = trackUniverse(sold, ['QLD'], [], exitedAt + (REENTRY_DAYS - 1) * DAY, []);
  assert.ok('TQQQ' in 하루전, `${REENTRY_DAYS - 1}일째엔 남아 있어야 한다`);

  const 당일 = trackUniverse(sold, ['QLD'], [], exitedAt + REENTRY_DAYS * DAY, []);
  assert.ok(!('TQQQ' in 당일), `${REENTRY_DAYS}일째엔 빠져야 한다 (경계는 >=)`);
});

test('팔았는데 감시 표시도 돼 있으면 reentry 가 이긴다 (보유 이력이 더 많은 정보다)', () => {
  const held = trackUniverse(null, ['QLD', 'TQQQ'], [], now, []);
  const sold = trackUniverse(held, ['QLD'], [], now + TICK, ['TQQQ']);
  assert.equal(sold.TQQQ.role, 'reentry');
});

test('라이브에 남은 잘못된 reentry 는 wasHeld 표시가 없어 watch 로 되돌아온다', () => {
  /**
   * 마이그레이션 코드를 따로 두지 않은 근거다 — 라이브 39건이 전부 이 모양이고
   * (`reentry − watched = ∅` 실측), `wasHeld` 가 없으므로 다음 틱에 제자리를 찾는다.
   */
  const 잘못된상태 = {
    QLD: { role: 'held', since: now },
    AAPL: { role: 'reentry', exitedAt: now, since: now },   // wasHeld 없음 = 결함이 만든 것
  };
  const u = trackUniverse(잘못된상태, ['QLD'], [], now + TICK, ['AAPL']);
  assert.equal(u.AAPL.role, 'watch');
  assert.equal(u.AAPL.wasHeld, undefined);
});

test('wasHeld 가 있는 진짜 reentry 는 마이그레이션에서 살아남는다', () => {
  // ⚠️ 위 테스트의 **반대 축**. 둘 다 없으면 "전부 지운다" 도 통과해 버린다.
  const 진짜 = {
    QLD: { role: 'held', since: now },
    TQQQ: { role: 'reentry', wasHeld: true, exitedAt: now, since: now },
  };
  const u = trackUniverse(진짜, ['QLD'], [], now + TICK, ['TQQQ']);
  assert.equal(u.TQQQ.role, 'reentry');
  assert.equal(u.TQQQ.exitedAt, now, '되살 시각이 보존돼야 만료가 제때 온다');
});

test('exitedAt 을 모르는 held-아닌 항목은 되살로 만들지 않는다', () => {
  // "모르면 지어내지 않는다" — now 로 메우면 만료가 영원히 안 온다(종전 결함의 직접 원인)
  const u = trackUniverse(
    { ZZZZ: { role: 'reentry', wasHeld: true, since: now } },   // exitedAt 없음
    [], [], now + TICK, []
  );
  assert.ok(!('ZZZZ' in u));
});
