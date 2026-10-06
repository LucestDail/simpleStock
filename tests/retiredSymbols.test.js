/**
 * 🔴 정리 완료 종목(retiredSymbols) — 2026-10-06 사용자 지시:
 *    "RAM 전량 매도 걸었어 … 관련된 내부 ram 관련 감시나 목표가 이런거 싹 다 정리해"
 *
 * ## 왜 설정 한 벌이 필요했나
 * 감시 플래그와 목표가를 **손으로 지우는 것만으로는 부족하다** — 보유했다 팔면
 * `trackUniverse` 가 `wasHeld` 를 보고 **`reentry`(되살 후보)로 20일간 되살린다.**
 * 평소엔 옳은 설계지만("매도 뒤 재진입 자리를 봐 준다"), *"다시 안 산다"* 고 선언한
 * 종목에는 **매도 체결 순간 자동으로 돌아오는 유령**이 된다.
 *
 * ## 이 자가 지키는 것 — 네 경로 전부 (하나만 빠지면 그 경로로 되살아난다)
 *   held · reentry · targeted · watch
 * ⚠️ 그리고 **저장 계약**: 정규화에 등재되지 않으면 설정 저장이 **거짓 성공**한다
 *    (10-05 momentumMinPct 가 정확히 그랬다 — 200 OK 인데 파일에 안 남았다).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trigger = require('../server/analystTrigger');
const DAY = 86400000;

test('네 경로 전부 배제 — held·reentry·targeted·watch', () => {
  const now = Date.now();
  // ① held: 보유 중이어도 빠진다(매도 주문이 걸린 상태에서 제안을 더 낼 이유가 없다)
  let u = trigger.trackUniverse({}, ['QLD', 'RAM'], [], now, [], ['RAM']);
  assert.deepEqual(Object.keys(u).sort(), ['QLD'], 'held 경로로 남았다');

  // ② reentry: 보유했다 팔면 되살 후보가 되는데, retired 면 안 된다 ← 핵심
  const prev = { RAM: { role: 'held', since: now - 5 * DAY }, QLD: { role: 'held', since: now - 5 * DAY } };
  u = trigger.trackUniverse(prev, ['QLD'], [], now, [], ['RAM']);
  assert.equal(u.RAM, undefined, '매도 후 reentry 로 되살아났다 — 20일간 유령이 된다');
  // 대조: retired 가 없으면 reentry 로 살아난다(자가 실제로 그 축을 재고 있다는 증거)
  const u2 = trigger.trackUniverse(prev, ['QLD'], [], now, [], []);
  assert.equal(u2.RAM?.role, 'reentry', '대조군이 reentry 가 아니다 — 자가 엉뚱한 것을 재고 있다');

  // ③ targeted: 목표가가 남아 있어도 배제
  u = trigger.trackUniverse({}, [], ['RAM'], now, [], ['RAM']);
  assert.equal(u.RAM, undefined, 'targeted 경로로 남았다');

  // ④ watch: 감시 플래그가 켜져 있어도 배제
  u = trigger.trackUniverse({}, [], [], now, ['RAM'], ['RAM']);
  assert.equal(u.RAM, undefined, 'watch 경로로 남았다');
});

test('대소문자·공백 무시 · 빈 목록은 아무것도 바꾸지 않는다', () => {
  const now = Date.now();
  let u = trigger.trackUniverse({}, ['RAM'], [], now, [], [' ram ']);
  assert.equal(u.RAM, undefined, '소문자·공백 입력이 안 먹었다');
  u = trigger.trackUniverse({}, ['RAM', 'QLD'], [], now, [], []);
  assert.deepEqual(Object.keys(u).sort(), ['QLD', 'RAM'], '빈 목록인데 뭔가 빠졌다');
  u = trigger.trackUniverse({}, ['RAM', 'QLD'], [], now, []);
  assert.deepEqual(Object.keys(u).sort(), ['QLD', 'RAM'], '인자 생략 시 종전 동작이 아니다');
});

test('저장 계약 — 정규화·기본값에 등재돼 저장이 거짓 성공하지 않는다', async () => {
  for (const k of Object.keys(require.cache)) if (/settingsService|dataStore/.test(k)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-'));
  process.env.SIMPLESTOCK_DATA_DIR = process.env.DATA_DIR;
  const ss = require('../server/settingsService');
  const saved = await ss.updateSettings({ dashboard: { retiredSymbols: ['ram', ' RAM ', 'xyz'] } });
  assert.deepEqual(saved.dashboard.retiredSymbols, ['RAM', 'XYZ'], '정규화(대문자·중복제거)가 안 됐다');
  // 🔴 응답에서 통째로 빠지지 않는가 — DASHBOARD_DEFAULTS 미등재 시 여기서 undefined 가 된다
  assert.ok('retiredSymbols' in ss.getDashboardSettings(), 'getDashboardSettings 응답에 키가 없다 — 화면·호출부가 못 읽는다');
});

test('배선 — alertService 가 설정을 trackUniverse 로 넘긴다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'alertService.js'), 'utf8');
  const i = src.indexOf('trackUniverse(');
  assert.ok(i > 0, 'trackUniverse 호출부가 사라졌다');
  assert.match(src.slice(i, i + 300), /retiredSymbols/, 'retired 를 안 넘긴다 — 설정이 있어도 유령이 돌아온다');
});
