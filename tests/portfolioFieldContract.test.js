/**
 * 🔴 **화면이 읽는 서버 필드가 실재하는가** (2026-10-12 신설)
 *
 * ## 왜 생겼나 — 같은 실수를 **세 번** 했다
 *
 * | 내가 쓴 것 | 실제 | 증상 |
 * |---|---|---|
 * | `targetAllocation.evaluate()` | `compare()` | 500 |
 * | `buckets[].actualPct`·`label` | `currentPct`·`name` | 조용히 빈 칸 |
 * | `summary.profitLoss.amount` | `summary.profit`(**객체**) | 화면에 `—` |
 *
 * 전부 **없는 필드를 추정해 쓴 것**이고, 전부 **조용히 빈다**. 테스트는 초록이고
 * API 는 200 이라 아무도 모른다 — 사용자가 화면을 보고서야 안다.
 *
 * ⇒ 이 자는 **서버가 실제로 내보내는 모양**을 못박는다. 서버가 필드 이름을 바꾸면
 *    여기가 먼저 깨져서 **화면을 고쳐야 한다는 것**을 알려 준다.
 * ⚠️ 화면 쪽은 자동으로 못 잡는다(`.vue` 템플릿은 런타임에만 평가된다) —
 *    그래서 **계약을 여기 적어** 두고 화면이 그 이름만 쓰게 한다.
 */
const test = require('node:test');
const assert = require('node:assert');

test('🔴 `summary.profit` 은 **객체**다 — 숫자로 쓰면 화면이 빈다', () => {
  const ta = require('../server/tossPortfolio');
  const src = require('node:fs').readFileSync(require.resolve('../server/tossPortfolio'), 'utf8');
  /**
   * 🔴 **요약의 `profit` 은 `pair()` 로 조립된다** — `{ krw, usd, converted }`.
   *    (토스 원본은 `profitLoss.amount` 인데 서버가 이름과 모양을 바꿔 내보낸다.
   *     내가 **토스 원본 이름을 보고** `profitLoss.amount` 로 썼다가 화면이 비었다.)
   * ⚠️ 행(`items[]`)의 `profit` 은 **숫자**다 — 같은 이름이 층에 따라 다르다.
   */
  assert.match(src, /profit:\s*pair\(/, '🔴 요약의 profit 이 pair() 로 안 만들어진다 — 모양이 바뀌었다면 화면도 함께 고칠 것');
  assert.match(src, /profit:\s*num\(/, '🔴 행의 profit 이 숫자가 아니다 — 화면이 숫자로 읽는다');
  assert.ok(typeof ta.getHoldings === 'function');
});

test('🔴 `targetAllocation` 의 공개 이름은 `compare` 다 (`evaluate` 가 아니다)', () => {
  const ta = require('../server/targetAllocation');
  assert.equal(typeof ta.compare, 'function', '🔴 compare 가 없다 — server.js 가 이 이름으로 부른다');
  assert.equal(ta.evaluate, undefined, '⚠️ evaluate 가 생겼다면 둘 중 하나는 죽은 이름이다 — 화면·서버가 갈린다');
});

test('🔴 버킷 행의 필드 이름 — `currentPct`·`name`(`actualPct`·`label` 아님)', () => {
  const ta = require('../server/targetAllocation');
  const cmp = ta.compare(
    [{ symbol: 'SOXX', quantity: 10, lastPrice: 500, marketValue: 5000, leverageFactor: 1 }],
    { cash: { usd: 5000 }, value: { usd: 10000 } },
    require('../server/regimeService').readCatalog(),
  );
  assert.ok(cmp && Array.isArray(cmp.buckets) && cmp.buckets.length, 'compare 가 버킷을 안 냈다');
  const b = cmp.buckets[0];
  for (const k of ['key', 'name', 'targetPct', 'currentPct', 'gapPct', 'direction', 'symbols']) {
    assert.ok(k in b, `🔴 버킷에 \`${k}\` 가 없다 — 화면이 이 이름으로 읽는다`);
  }
  assert.ok(!('actualPct' in b), '⚠️ actualPct 가 생겼다 — 화면은 currentPct 를 읽는다(둘이 갈린다)');
  assert.ok(Array.isArray(cmp.unclassified), '🔴 unclassified 가 배열이 아니다 — 화면이 "목표 밖" 을 못 그린다');
});

test('🔴 `portfolioRules.diagnose` 의 판정 행 모양', () => {
  const pr = require('../server/portfolioRules');
  const r = pr.diagnose({ maxWeightPct: 50, positionCount: 7, leveragePct: 40.4, cashPct: 3.7 });
  for (const k of ['checks', 'overCount', 'unknownCount']) assert.ok(k in r, `${k} 가 없다`);
  const c = r.checks[0];
  for (const k of ['key', 'label', 'actual', 'limit', 'unit', 'status']) {
    assert.ok(k in c, `🔴 판정 행에 \`${k}\` 가 없다 — 화면이 이 이름으로 읽는다`);
  }
  assert.ok(['ok', 'over', 'unknown'].includes(c.status), 'status 가 셋 중 하나가 아니다');
});
