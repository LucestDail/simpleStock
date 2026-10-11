/**
 * 🔁 **미결(SENT) 제안 종결** — 2026-10-12
 *
 * 사용자: "⚠️ simpleStock 미결 주문 7건 … 이게 계속 오는데 확인 좀 해봐"
 *
 * ## 무엇이 일어났나
 * `status = 'SENT'` 로 바꾸는 코드는 둘인데 **거기서 벗어나는 코드가 0곳**이었다.
 * 10-06 에 보낸 7건이 **6일째 매일** "미결 주문" 알림을 보냈다 — 거래소에서는 진작 끝났고
 * (실측: FILLED 5 · CANCELED 2) 토스 `getOrder` 가 그 답을 **그대로 준다**. 묻지 않았을 뿐이다.
 * 알림 문구는 "확정되면 앱에서 보정하세요" 라고 안내하는데 **보정 기능이 없었다**
 * ("문서가 주장하는 안전망이 실재하지 않는" 가족).
 *
 * ## 이 자가 지키는 것 — 추측하지 않는다
 *   종결: FILLED·CANCELED·REJECTED·EXPIRED 는 그 상태로 확정
 *   보류: 진행 중 상태·빈 응답은 **SENT 유지**(모르는 것을 끝난 것으로 적지 않는다)
 *   보류: 조회 **실패도 종결이 아니다**(다음 회차에 다시 묻는다)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * SENT 제안을 **파일에 심고 모듈을 새로 로드**한다 — 재기동 복원 경로와 같은 모양이다.
 * ⚠️ `list()` 는 **복사본**을 주므로 거기서 status 를 바꿔도 내부 Map 이 안 바뀐다
 *    (첫 판에서 그렇게 짰다가 `checked: 0` 이 나왔다 — 자가 아무것도 안 재고 있었다).
 */
function fresh(orderStatuses, rows = []) {
  for (const k of Object.keys(require.cache)) if (/simpleStock\/server\//.test(k)) delete require.cache[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  process.env.DATA_DIR = dir;
  const file = path.join(dir, 'p.json');
  process.env.ORDERS_FILE = file;
  process.env.ORDERS_AUDIT_FILE = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    at: new Date().toISOString(),
    proposals: rows.map((r, i) => ({
      id: `p${i}`, idempotencyKey: `k${i}`, symbol: r.symbol, side: 'SELL', type: 'LIMIT',
      quantity: 1, price: 100, conditional: null, reason: 't', source: 'manual',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      status: 'SENT', orderId: r.orderId, approvedAt: new Date().toISOString(),
    })),
  }));
  const tc = require.resolve('../server/tossClient');
  require.cache[tc] = { id: tc, filename: tc, loaded: true, exports: {
    ...require(tc),
    getOrder: async (oid) => {
      const v = orderStatuses[oid];
      if (v instanceof Error) throw v;
      return v;
    },
  } };
  return require('../server/orderService');
}

test('종결 — FILLED·CANCELED 는 그 상태로 확정되고 알림 대상에서 빠진다', async () => {
  const o = fresh({ o1: { status: 'FILLED' }, o2: { status: 'CANCELED' } },
    [{ symbol: 'QLD', orderId: 'o1' }, { symbol: 'RAM', orderId: 'o2' }]);
  const r = await o.reconcileSent();
  assert.equal(r.checked, 2);
  assert.equal(r.settled.length, 2, '거래소가 끝났다고 했는데 종결되지 않았다 — 알림이 계속 온다');
  const left = o.list().filter((p) => p.status === 'SENT');
  assert.equal(left.length, 0, 'SENT 가 남았다');
  assert.deepEqual(o.list().map((p) => p.status).sort(), ['CANCELED', 'FILLED']);
});

test('보류 쌍 — 진행 중·빈 응답·조회 실패는 SENT 를 유지한다(추측 금지)', async () => {
  const o = fresh({
    a: { status: 'PENDING' },           // 아직 진행 중
    b: {},                              // 빈 응답
    c: new Error('network down'),       // 조회 실패
  }, [{ symbol: 'X', orderId: 'a' }, { symbol: 'Y', orderId: 'b' }, { symbol: 'Z', orderId: 'c' }]);
  const r = await o.reconcileSent();
  assert.equal(r.settled.length, 0, '모르는 것을 끝난 것으로 적었다');
  assert.equal(r.unresolved.length, 2, '진행 중·빈 응답이 미해결로 안 잡혔다');
  assert.equal(r.failed.length, 1, '조회 실패가 미해결로 안 잡혔다');
  assert.equal(o.list().filter((p) => p.status === 'SENT').length, 3, 'SENT 가 유지되지 않았다');
});

test('대문자 변형 수용 — CANCELLED(영국식)도 종결', async () => {
  const o = fresh({ z: { status: 'cancelled' } }, [{ symbol: 'Q', orderId: 'z' }]);
  const r = await o.reconcileSent();
  assert.equal(r.settled[0]?.status, 'CANCELED', '철자 변형을 못 읽어 영원히 미결로 남는다');
});

test('배선 — 라우트가 실재하고 읽기 전용이다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.post('/api/orders/reconcile'");
  assert.ok(i > 0, '보정 라우트가 없다 — 알림은 "앱에서 보정하라" 는데 할 방법이 없다');
  const body = src.slice(i, i + 500);
  assert.match(body, /reconcileSent\(\)/);
  assert.ok(!/createOrder|execute\(/.test(body), '보정이 주문을 낸다 — 읽기 전용이어야 한다');
});
