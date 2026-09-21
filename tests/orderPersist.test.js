const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 제안 영속화 (2026-09-21 사용자 결정 — *"1번으로 해"*)
 *
 * ## 왜 바꿨나
 *
 * 종전 주석은 *"메모리에만 둔다 — 재기동하면 사라지는 게 맞다(옛 시세의 제안은 위험하다)"* 였다.
 * 그 이유는 **지금도 맞다.** 그런데 실제로 겪은 문제는 반대쪽이었다:
 * 배포로 컨테이너가 재시작되자 승인 대기 제안이 사라졌는데 **사용자 폰에는 `[✅ 승인]` 버튼이
 * 그대로 남아 있었다.** 나중에 누르면 `제안을 찾을 수 없습니다` — 판단은 유효한데
 * **실행 경로만 조용히 죽은** 상태다.
 *
 * ⇒ 영속화하되 **옛 시세 우려는 TTL 로 그대로 지킨다**: 복원할 때 만료를 **다시 판정**해
 *   시간이 지난 것은 `EXPIRED` 로 올린다. 되살리는 게 아니라 **잃지 않는** 것이다.
 */

// 🔴 테스트는 **다른 파일**을 쓴다 — 안 그러면 라이브 대기열을 건드린다(오늘 이미 두 번 겪었다)
process.env.ORDERS_FILE = path.join(os.tmpdir(), `ss-orders-${process.pid}.json`);
process.env.ORDER_PROPOSAL_TTL_MS = '60000';

const STORE = process.env.ORDERS_FILE;

/** 프로세스 재기동을 흉내 낸다 — 모듈 캐시를 지우면 `restore()` 가 다시 돈다 */
function restart() {
  for (const k of Object.keys(require.cache)) if (/orderService/.test(k)) delete require.cache[k];
  return require('../server/orderService');
}
/** 저장 파일의 제안을 **만료된 시각으로** 늙힌다(`expiresAt` 이 판정 기준이다) */
function age(id, ms = 10 * 60_000) {
  const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const row = raw.proposals.find((p) => p.id === id);
  assert.ok(row, '늙힐 제안을 파일에서 못 찾았다 — 저장이 안 된 것이다');
  row.createdAt = new Date(Date.now() - ms).toISOString();
  row.expiresAt = new Date(Date.now() - ms + 60_000).toISOString();
  fs.writeFileSync(STORE, JSON.stringify(raw));
}

const GOOD = { symbol: 'RAM', side: 'SELL', type: 'LIMIT', quantity: 442, price: 14.64, reason: '테스트' };

beforeEach(() => { try { fs.unlinkSync(STORE); } catch { /* 없으면 그만 */ } });

test('🔴 재기동해도 승인 대기 제안이 살아남는다 (폰의 승인 버튼이 죽지 않게)', () => {
  const a = restart();
  const r = a.propose(GOOD, { source: 'test' });
  assert.ok(r.ok, r.error);

  const b = restart(); // ← 배포·재시작
  const found = b.list().find((p) => p.id === r.proposal.id);
  assert.ok(found, '🔴 재기동에 제안이 사라졌다 — 사용자가 승인을 눌러도 "찾을 수 없습니다" 가 된다');
  assert.equal(found.status, 'PENDING');
  assert.equal(found.quantity, 442, '수량이 바뀌었다');
});

test('🔴 재기동 뒤에도 **승인이 실제로 된다** (목록에만 있으면 소용없다)', () => {
  const a = restart();
  const { proposal } = a.propose(GOOD, { source: 'test' });
  const b = restart();
  const ap = b.approve(proposal.id);
  assert.ok(ap.ok, `🔴 복원은 됐는데 승인이 안 된다: ${ap.error}`);
  assert.equal(ap.proposal.status, 'APPROVED');
});

/**
 * 🔴 **옛 시세 우려를 지키는 자리.** 오래된 제안은 되살리되 **승인해도 실행되지 않아야** 한다.
 */
test('🔴 오래된 제안은 EXPIRED 로 복원된다 (되살리지 않는다)', () => {
  const a = restart();
  const { proposal } = a.propose(GOOD, { source: 'test' });

  /**
   * 파일을 직접 낡게 만든다 — 시간을 되돌릴 수 없으니 시각을 과거로.
   * ⚠️ **`createdAt` 만 늙히면 안 된다** — `isExpired()` 는 `expiresAt` 을 본다.
   *    첫 판에 그걸 놓쳐 이 테스트가 "제품 결함" 처럼 실패했다(자가 틀린 것이었다).
   */
  age(proposal.id);

  const b = restart();
  const found = b.list().find((p) => p.id === proposal.id);
  assert.equal(found.status, 'EXPIRED', '🔴 옛 시세의 제안이 PENDING 으로 되살아났다');
  const ap = b.approve(proposal.id);
  assert.equal(ap.ok, false, '🔴 만료된 제안이 승인됐다 — 옛 시세로 주문이 나갈 수 있다');
});

test('만료 승격이 **저장된다** (다음 기동에 또 PENDING 으로 읽히지 않게)', () => {
  const a = restart();
  const { proposal } = a.propose(GOOD, { source: 'test' });
  age(proposal.id);

  restart(); // 1차: EXPIRED 로 올리고 저장
  const onDisk = JSON.parse(fs.readFileSync(STORE, 'utf8')).proposals.find((p) => p.id === proposal.id);
  assert.equal(onDisk.status, 'EXPIRED', '🔴 승격이 파일에 안 남았다');
});

/** 🔴 거절·승인 상태도 남아야 한다 — 안 그러면 재기동 후 **다시 승인 가능**해진다 */
test('🔴 거절한 제안이 재기동으로 되살아나지 않는다', () => {
  const a = restart();
  const { proposal } = a.propose(GOOD, { source: 'test' });
  assert.ok(a.reject(proposal.id, '테스트').ok);

  const b = restart();
  const found = b.list().find((p) => p.id === proposal.id);
  assert.equal(found.status, 'REJECTED', '🔴 거절이 사라졌다 — 다시 승인 가능해진다');
  assert.equal(b.approve(proposal.id).ok, false, '🔴 거절한 것을 승인할 수 있다');
});

/** ⚠️ 파일이 깨져도 **서비스는 떠야 한다** — 대기열을 못 읽는다고 앱이 죽으면 더 나쁘다 */
test('⚠️ 저장 파일이 깨져도 기동한다 (빈 대기열로)', () => {
  fs.writeFileSync(STORE, '{ 이건 JSON 이 아니다');
  const a = restart();
  assert.deepEqual(a.list(), []);
  assert.ok(a.propose(GOOD, { source: 'test' }).ok, '깨진 파일 뒤에 새 제안도 못 만든다');
});

test('파일이 없어도 조용히 기동한다', () => {
  const a = restart();
  assert.deepEqual(a.list(), []);
});

/**
 * 🔴 **구조 가드 — 상태 전이마다 저장해야 한다.**
 * 하나라도 빠지면 **그 상태만** 재기동에 사라진다(거절이 사라지면 다시 승인 가능해진다).
 * ⚠️ 인접 줄만 보는 `grep` 으로 세다가 틀렸다(승인은 두 줄 뒤에 있었다) ⇒ **함수 단위**로 본다.
 */
test('🔴 상태를 바꾸는 함수는 모두 persist() 를 부른다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'orderService.js'), 'utf8');
  // 최상위 함수 단위로 자른다
  const fns = [...src.matchAll(/^(?:async )?function (\w+)\([^)]*\) \{([\s\S]*?)^\}/gm)];
  assert.ok(fns.length >= 6, `함수를 ${fns.length}개만 찾았다 — 자가 헛돈다`);

  /** 면제 — **이유를 적는다** */
  const EXEMPT = new Map([
    ['restore', '읽는 쪽이다. 만료 승격분은 따로 persist() 한다(별도 테스트가 확인)'],
    ['_resetForTest', '테스트 정리 — 파일을 지우는 게 목적이다'],
  ]);

  const problems = [];
  let checked = 0;
  for (const [, name, body] of fns) {
    /**
     * ⚠️ **대입만** 본다. 첫 판은 `p.status\s*=` 라 **비교문 `p.status === 'PENDING'`** 까지 잡아
     *    읽기 전용 `status()` 를 위반으로 찍었다 — *"grep 이 걸렸다 ≠ 그런 코드다"* 의 이 파일 판본.
     */
    if (!/p\.status\s*=(?!=)/.test(body)) continue;
    if (EXEMPT.has(name)) continue;
    checked += 1;
    if (!/persist\(\)/.test(body)) problems.push(`${name}() — 상태를 바꾸는데 persist() 가 없다`);
  }
  assert.ok(checked >= 3, `🔴 검사한 함수가 ${checked}개뿐이다 — 자가 헛돈다`);
  assert.deepEqual(problems, [], `\n🔴 이 상태는 재기동에 사라진다:\n${problems.join('\n')}`);
});

/**
 * 🔴 **끝난 제안은 폰의 버튼도 지운다** (2026-09-21)
 *
 * pm2 가 API 로 거절했는데 **사용자 폰의 `✅ 승인` 이 그대로 남아 있었다** —
 * 버튼 제거가 **텔레그램 콜백 경로에만** 있었기 때문이다.
 * 위험한 쪽이 아니라 **놓치는 쪽**이지만, 사용자는 **아직 결정할 게 남았다고 믿는다.**
 */
test('🔴 거절하면 정리 신호가 나간다 (폰 버튼을 지우라고)', () => {
  const a = restart();
  const { proposal } = a.propose(GOOD, { source: 'test', notify: false });
  const settled = [];
  a.onSettled((p, why) => settled.push([p.id, why]));
  a.reject(proposal.id, '테스트');
  assert.deepEqual(settled, [[proposal.id, 'rejected']], '🔴 정리 신호가 없다 — 폰 버튼이 살아남는다');
});

test('승인해도 정리 신호가 나간다 (중복 승인 방지)', () => {
  const a = restart();
  const { proposal } = a.propose(GOOD, { source: 'test', notify: false });
  const settled = [];
  a.onSettled((p, why) => settled.push(why));
  a.approve(proposal.id);
  assert.deepEqual(settled, ['approved']);
});

test('메시지 id 가 붙고 **재기동을 넘어 살아남는다** (그래야 나중에 지운다)', () => {
  const a = restart();
  const { proposal } = a.propose(GOOD, { source: 'test', notify: false });
  assert.ok(a.attachNotice(proposal.id, { messageId: 12345 }).ok);

  const b = restart();
  const found = b.list().find((p) => p.id === proposal.id);
  assert.equal(found.noticeMessageId, 12345, '🔴 재기동 뒤엔 버튼을 못 지운다');
});

/**
 * 🔴 **점검용 무발송** — `notify:false` 면 승인 버튼이 안 간다.
 * pm2 가 *"코드를 봤는데 안 보낸다"* 고 했지만 **실제로는 갔다** — 발송이 **리스너**에서
 * 일어나 함수 본문만 봐서는 안 보였다. ★ **부작용이 이벤트로 나가면 본문만 보는 건 확인이 아니다.**
 */
test('🔴 notify:false 면 알림 리스너를 안 부른다 (점검이 폰을 안 울린다)', () => {
  const a = restart();
  const notified = [];
  a.onProposed((p) => notified.push(p.id));
  const r = a.propose(GOOD, { source: 'test', notify: false });
  assert.ok(r.ok);
  assert.deepEqual(notified, [], '🔴 점검인데 폰으로 승인 버튼이 갔다');
  // ⚠️ 제안 **자체는** 만들어져야 한다 — 안 그러면 영속화를 검증할 수 없다
  assert.equal(a.list().length, 1, '제안이 안 만들어지면 점검 자체가 불가능하다');
});

/** 🔴 판별력 — 기본값에서는 **반드시** 불려야 한다. 안 그러면 위 테스트가 공허하다 */
test('🔴 자기검증: 기본값에서는 알림 리스너가 불린다', () => {
  const a = restart();
  const notified = [];
  a.onProposed((p) => notified.push(p.id));
  const r = a.propose(GOOD, { source: 'test' });
  assert.deepEqual(notified, [r.proposal.id], '🔴 기본값인데 승인 버튼을 안 보낸다 — HITL 이 끊긴다');
});
