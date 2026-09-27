const { test } = require('node:test');
const assert = require('node:assert/strict');
const trigger = require('../server/analystTrigger');

/**
 * 🔴 **프리장 개장 브리핑** (2026-09-27 사용자 지시 — 월요일 08:00 실전)
 *
 * 지금은 정규장 개장(09:00 KST)부터라 밤사이 미국장 결과를 장 열기 전에 못 받는다.
 * KR 프리마켓 창(08:00~09:00)에 들어서면 하루 한 번 `preopen` 이 뜬다.
 *
 * ⚠️ **KR 만** — US 프리(17:00 KST)까지 켜면 LLM 회차가 하루 1번 더 는다(비용은
 *    사용자 관심사). US 를 켜려면 `analystTrigger.decide` 의 `key !== 'kr'` 조건만 지운다.
 * ⚠️ **재기동으로 놓쳐도 보낸다** — `mid` 과 같은 패턴(전이가 아니라 "이 창에 들어섰는가 +
 *    아직 안 보냈는가"). 08:00~09:00 사이에 재시작돼도 프리장 브리핑은 살아야 한다.
 */

const T = (iso) => Date.parse(iso);
const KR_PRE = { start: T('2026-09-28T08:00:00+09:00'), end: T('2026-09-28T08:50:00+09:00') };
const KR_REG = { start: T('2026-09-28T09:00:00+09:00'), end: T('2026-09-28T15:30:00+09:00') };
const US_PRE = { start: T('2026-09-28T17:00:00+09:00'), end: T('2026-09-28T22:30:00+09:00') };
const US_REG = { start: T('2026-09-28T22:30:00+09:00'), end: T('2026-09-29T05:00:00+09:00') };

const sess = (key, state, regular, preSpan = null) => ({
  key, label: key === 'kr' ? 'KRX' : '미국장', state, regular, preSpan,
});
const kinds = (d) => d.reasons.map((r) => r.kind).sort();

test('🔴 KR: 프리장 창(08:00) 진입에 preopen 이 뜬다 — 같은 날 재발화 없음', () => {
  let st = trigger.decide({
    now: T('2026-09-28T07:00:00+09:00'),
    sessions: [sess('kr', 'closed', KR_REG, KR_PRE)],
    symbols: [],
  }).state;

  let d = trigger.decide({
    now: KR_PRE.start,
    sessions: [sess('kr', 'pre', KR_REG, KR_PRE)],
    symbols: [], state: st,
  });
  assert.ok(kinds(d).includes('preopen'), '프리장 창 진입에 preopen 이 안 떴다');
  st = d.state;

  // 같은 날 다음 틱 — 재발화 없음
  d = trigger.decide({
    now: T('2026-09-28T08:30:00+09:00'),
    sessions: [sess('kr', 'pre', KR_REG, KR_PRE)],
    symbols: [], state: st,
  });
  assert.ok(!kinds(d).includes('preopen'), '🔴 preopen 이 같은 날 반복 발송된다');
});

test('🔴 09:00(정규장 시작)이 지나면 preopen 은 더 이상 안 뜬다', () => {
  // 프리장을 아예 못 보고(재기동 등) 09:00 을 넘겨 처음 도착 — 지나쳤으니 안 보낸다
  const d = trigger.decide({
    now: T('2026-09-28T09:05:00+09:00'),
    sessions: [sess('kr', 'open', KR_REG, KR_PRE)],
    symbols: [], state: {},
  });
  assert.ok(!kinds(d).includes('preopen'), '🔴 09:00 을 지났는데 preopen 이 떴다');
});

test('🔴 회귀 축: KR 정규장 개장(09:00)엔 기존 open 이 여전히 뜬다', () => {
  let st = trigger.decide({
    now: T('2026-09-28T08:30:00+09:00'),
    sessions: [sess('kr', 'pre', KR_REG, KR_PRE)],
    symbols: [],
  }).state;
  const d = trigger.decide({
    now: KR_REG.start,
    sessions: [sess('kr', 'open', KR_REG, KR_PRE)],
    symbols: [], state: st,
  });
  assert.ok(kinds(d).includes('open'), '🔴 프리장을 넣었더니 정규 개장 브리핑이 죽었다');
});

test('🔴 US 는 preSpan 이 있어도 preopen 이 안 뜬다 (사용자가 KR 만 요청)', () => {
  let st = trigger.decide({
    now: T('2026-09-28T16:00:00+09:00'),
    sessions: [sess('us', 'closed', US_REG, US_PRE)],
    symbols: [],
  }).state;
  const d = trigger.decide({
    now: US_PRE.start,
    sessions: [sess('us', 'pre', US_REG, US_PRE)],
    symbols: [], state: st,
  });
  assert.ok(!kinds(d).includes('preopen'), '🔴 US 프리장에 preopen 이 떴다 — KR 전용이어야 한다');
});

test('⚠️ 휴장일(regular·pre 없음)이면 preopen 이 뜨지 않는다', () => {
  const d = trigger.decide({
    now: T('2026-09-28T08:30:00+09:00'),
    sessions: [sess('kr', 'closed', null, null)],
    symbols: [], state: {},
  });
  assert.deepEqual(kinds(d), [], '🔴 휴장일인데 무언가 떴다');
});

/**
 * 🔴 **재기동 재현** — 마감과 같은 취급. 08:00~09:00 사이에 빈 상태(재시작)로 첫 틱이
 * 와도 프리장 브리핑은 살아야 한다(전이 감지가 아니라 "창 안 + 미발화" 로만 판정하기 때문).
 */
test('🔴 재기동 재현: 08:30 에 빈 상태로 첫 틱 → preopen 이 뜬다', () => {
  const d = trigger.decide({
    now: T('2026-09-28T08:30:00+09:00'),
    sessions: [sess('kr', 'pre', KR_REG, KR_PRE)],
    symbols: [], state: {},
  });
  assert.ok(kinds(d).includes('preopen'), '🔴 재기동이 프리장 브리핑을 삼켰다');
});

test('KIND_LABEL 에 preopen 이 있다', () => {
  assert.equal(trigger.KIND_LABEL.preopen, '프리장 개장');
  assert.equal(trigger.describe([{ kind: 'preopen', key: 'kr', label: 'KRX' }]), 'KRX 프리장 개장');
});

// ── 발송 지문·이월 집합에서 preopen 이 안 빠지는가 ─────────────────
const fs = require('node:fs');
const path = require('node:path');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const ANALYST = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf-8'));
const ALERTS = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'alertService.js'), 'utf-8'));

test('🔴 analystService: 발송 지문(SCHEDULED)에 preopen 이 없으면 같은 HOLD 일 때 조용히 삼켜진다', () => {
  const i = ANALYST.indexOf('const SCHEDULED');
  assert.ok(i > 0, 'SCHEDULED 를 못 찾았다');
  const block = ANALYST.slice(i, i + 120);
  assert.match(block, /'preopen'/, '🔴 지문 종류 목록에 preopen 이 없다 — 조용히 삼켜진다');
});

test('🔴 analystService: BRIEF_JOB 에 preopen 성격 문구가 있다', () => {
  const i = ANALYST.indexOf('const BRIEF_JOB');
  assert.ok(i > 0, 'BRIEF_JOB 을 못 찾았다');
  const block = ANALYST.slice(i, i + 2200);
  assert.match(block, /preopen\s*:/, '🔴 preopen 브리핑 성격 문구가 없다 — open 과 같은 글이 나간다');
});

test('🔴 alertService: 이월(SCHEDULED) 집합에 preopen 이 없으면 겹친 회차에서 사라진다', () => {
  const i = ALERTS.indexOf('const SCHEDULED');
  assert.ok(i > 0, 'SCHEDULED 를 못 찾았다');
  const block = ALERTS.slice(i, i + 120);
  assert.match(block, /'preopen'/, '🔴 이월 대상 목록에 preopen 이 없다');
});

test('🔴 marketCalendar.sessionFromCalendar 가 preSpan 을 싣는다', () => {
  const src = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'marketCalendar.js'), 'utf-8'));
  const i = src.indexOf('function sessionFromCalendar');
  assert.ok(i > 0, 'sessionFromCalendar 를 못 찾았다');
  const block = src.slice(i, i + 1400);
  assert.match(block, /preSpan/, '🔴 preSpan 을 반환에 안 싣는다 — 프리장 판정이 원리상 불가능해진다');
});

test('🔴 alertService.sessionsFor 가 preSpan 을 넘긴다', () => {
  const i = ALERTS.indexOf('async function sessionsFor');
  assert.ok(i > 0, 'sessionsFor 를 못 찾았다');
  const block = ALERTS.slice(i, i + 1600);
  assert.match(block, /preSpan/, '🔴 sessionsFor 가 preSpan 을 버린다 — 프리장 브리핑이 원리상 불가능해진다');
});
