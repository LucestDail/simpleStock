const { test } = require('node:test');
const assert = require('node:assert/strict');
const trigger = require('../server/analystTrigger');

/**
 * 🔴 **정기 브리핑 6회/일** (2026-09-22 사용자 지시)
 *   미장/국장 × (개장 · 장중 · 마감). 워치독은 그 위에 얹히는 이벤트 대응.
 *
 * ## 시간 정의 — 사용자가 짚은 "데이장/프리장"
 * ```
 * KRX       정규장 09:00–15:30 KST (한국은 서머타임 없음)
 * 미국 프리   17:00–22:30 KST(서머) / 18:00–23:30(표준)
 * 미국 데이   22:30–05:00        / 23:30–06:00      ← **"개장" 은 이것**
 * 미국 애프터 05:00–09:00        / 06:00–10:00
 * ```
 * `sessionFromCalendar` 는 **정규장만 `open`** 으로 본다(프리·애프터는 `pre`/`closed`)
 * ⇒ 개장 트리거는 **프리 시작에 안 뜬다.**
 *
 * ## ★ 고정 시각을 쓰지 않는다
 * 중간 지점을 `regular{start,end}` 에서 유도하므로 **서머타임·조기폐장·공휴일이 자동으로 따라온다.**
 * 오늘 `ss-obs 05:10` 이 겨울에 어긋나던 그 함정의 반대편이다.
 */

const T = (iso) => Date.parse(iso);
// 서머타임 기준 미국 정규장: 22:30 KST ~ 05:00 KST(익일) → 중간 01:45
const US = { start: T('2026-09-22T22:30:00+09:00'), end: T('2026-09-23T05:00:00+09:00') };
const KR = { start: T('2026-09-22T09:00:00+09:00'), end: T('2026-09-22T15:30:00+09:00') };

const sess = (key, state, regular) => ({ key, label: key === 'kr' ? 'KRX' : '미국장', state, regular });
const kinds = (d) => d.reasons.map((r) => r.kind).sort();

test('🔴 개장 = **정규장 시작**(pre→open) — 프리 시작에는 안 뜬다', () => {
  // 프리마켓 시간: 아직 pre. 기준선만 잡고 아무것도 안 뜬다
  let st = trigger.decide({ now: T('2026-09-22T19:00:00+09:00'), sessions: [sess('us', 'pre', US)], symbols: [] }).state;
  // 프리 내내 pre 유지 — 전이가 아니다
  let d = trigger.decide({ now: T('2026-09-22T21:00:00+09:00'), sessions: [sess('us', 'pre', US)], symbols: [], state: st });
  assert.deepEqual(kinds(d), [], '🔴 프리마켓 중에 개장 브리핑이 떴다');
  st = d.state;
  // 22:30 정규장 시작
  d = trigger.decide({ now: US.start, sessions: [sess('us', 'open', US)], symbols: [], state: st });
  assert.deepEqual(kinds(d), ['open'], '🔴 정규장 시작에 개장 브리핑이 안 뜬다');
  assert.equal(d.run, true);
});

test('🔴 마감 = open→closed', () => {
  let st = trigger.decide({ now: US.start, sessions: [sess('us', 'open', US)], symbols: [] }).state;
  const d = trigger.decide({ now: US.end, sessions: [sess('us', 'closed', US)], symbols: [], state: st });
  assert.ok(kinds(d).includes('close'));
});

/** 🔴 중간 = 정규장 중간점. **고정 시각이 아니다** */
test('🔴 장중 브리핑은 정규장 중간점(01:45)에 **한 번만**', () => {
  let st = trigger.decide({ now: US.start, sessions: [sess('us', 'open', US)], symbols: [] }).state;
  // 중간 전 — 안 뜬다
  let d = trigger.decide({ now: T('2026-09-23T01:00:00+09:00'), sessions: [sess('us', 'open', US)], symbols: [], state: st });
  assert.deepEqual(kinds(d), [], '🔴 중간점 전에 떴다');
  st = d.state;
  // 중간점(01:45) 통과
  d = trigger.decide({ now: T('2026-09-23T01:45:00+09:00'), sessions: [sess('us', 'open', US)], symbols: [], state: st });
  assert.deepEqual(kinds(d), ['mid'], '🔴 중간점에 안 떴다');
  st = d.state;
  // 그 뒤 계속 open 이어도 **다시 안 뜬다**
  d = trigger.decide({ now: T('2026-09-23T03:00:00+09:00'), sessions: [sess('us', 'open', US)], symbols: [], state: st });
  assert.deepEqual(kinds(d), [], '🔴 장중 내내 반복해서 뜬다');
});

/** ⚠️ 지나쳐 버렸으면 **안 보낸다** — "중간 보고" 가 장 끝난 뒤 나가면 거짓이다 */
test('⚠️ 중간점을 지나친 뒤 첫 틱이면 건너뛴다(표시는 남긴다)', () => {
  const st = trigger.decide({ now: US.start, sessions: [sess('us', 'open', US)], symbols: [] }).state;
  const d = trigger.decide({ now: T('2026-09-23T06:00:00+09:00'), sessions: [sess('us', 'closed', US)], symbols: [], state: st });
  assert.ok(!kinds(d).includes('mid'), '🔴 장 끝난 뒤 "중간 보고" 가 나간다');
  // 표시는 남아 다음 틱에도 안 뜬다
  const d2 = trigger.decide({ now: T('2026-09-23T06:05:00+09:00'), sessions: [sess('us', 'open', US)], symbols: [], state: d.state });
  assert.ok(!kinds(d2).includes('mid'));
});

test('🔴 두 시장이 독립이다 (하루 6회)', () => {
  let st = trigger.decide({ now: T('2026-09-22T08:00:00+09:00'), sessions: [sess('kr', 'pre', KR), sess('us', 'closed', US)], symbols: [] }).state;
  const d = trigger.decide({ now: KR.start, sessions: [sess('kr', 'open', KR), sess('us', 'closed', US)], symbols: [], state: st });
  assert.deepEqual(d.reasons.map((r) => `${r.key}:${r.kind}`), ['kr:open'], '🔴 국장 개장에 미장도 같이 떴다');
});

/** ⚠️ 캘린더를 못 읽으면(regular 없음) **중간은 안 돈다** — 추측해서 "중간" 이라 우기지 않는다 */
test('⚠️ regular 가 없으면 중간 브리핑은 돌지 않는다(개장·마감은 상태로 판정)', () => {
  let st = trigger.decide({ now: US.start, sessions: [sess('us', 'open', null)], symbols: [] }).state;
  const d = trigger.decide({ now: T('2026-09-23T01:45:00+09:00'), sessions: [sess('us', 'open', null)], symbols: [], state: st });
  assert.deepEqual(kinds(d), [], '🔴 시간대를 모르는데 중간이라고 판단했다');
});

test('describe 가 종류를 사람 말로 낸다', () => {
  assert.equal(trigger.describe([{ kind: 'open', key: 'us', label: '미국장' }]), '미국장 개장');
  assert.equal(trigger.describe([{ kind: 'mid', key: 'kr', label: 'KRX' }]), 'KRX 장중');
  assert.equal(trigger.describe([{ kind: 'close', key: 'kr', label: 'KRX' }]), 'KRX 마감');
});

// ── 브리핑이 **조용히 사라지지 않는가** ───────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * 🔴 **중복방지 지문이 브리핑을 삼킨다** (pm2 지적, 2026-09-22)
 *
 * 지문을 *"결정만"* 으로 좁힌 건 옳았는데, 그 때문에 **개장·장중·마감이 전부 `HOLD` 면
 * 결정이 같아 둘째·셋째가 안 나간다.** 사용자는 *"개장 브리핑이 안 왔네"* 로 보고,
 * **조용히 사라져 아무도 모른다** — *"점검이 다음 진짜 발송을 삼킨다"* 와 같은 가족이다.
 */
const ANALYST = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf-8'));

test('🔴 지문이 **브리핑 종류**를 포함한다 (같은 HOLD 라도 회차마다 나간다)', () => {
  const i = ANALYST.indexOf('const digest = crypto');
  assert.ok(i > 0, '지문 계산부를 못 찾았다');
  const block = ANALYST.slice(Math.max(0, i - 1200), i + 400);
  assert.match(block, /briefKey/, '🔴 지문에 브리핑 종류가 없다 — 둘째·셋째 브리핑이 삼켜진다');
  assert.match(block, /\bopen\b[\s\S]{0,40}\bmid\b[\s\S]{0,40}\bclose\b/,
    '🔴 예정 브리핑 종류 목록이 없다');
});

/** ⚠️ 날짜가 없으면 **어제 개장과 오늘 개장이 같은 지문**이라 이튿날이 막힌다 */
test('⚠️ 지문의 브리핑 키에 **날짜**가 들어간다', () => {
  const i = ANALYST.indexOf('const briefKey');
  assert.ok(i > 0, 'briefKey 가 없다');
  const block = ANALYST.slice(i, i + 300);
  assert.match(block, /toLocaleDateString|Asia\/Seoul/, '🔴 날짜가 없다 — 이튿날 같은 브리핑이 막힌다');
});

/** ⚠️ 모멘텀은 지문을 빠져나가면 안 된다 — 같은 판단으로 두 번 튀는 건 새 소식이 아니다 */
test('⚠️ 모멘텀은 지문에서 빠져나가지 **않는다**', () => {
  const i = ANALYST.indexOf('const brief =');
  const block = ANALYST.slice(i, i + 260);
  assert.match(block, /SCHEDULED\.has/, '🔴 예정 브리핑만 거르는 게 아니다');
  assert.ok(!/momentum/.test(block), '🔴 모멘텀이 지문을 빠져나간다 — 같은 판단이 반복 발송된다');
});

/**
 * 🔴 **건너뛴 브리핑이 사라진다** (pm2 지적)
 * 분석은 ~70초, 틱은 5분. 겹치면 건너뛰는데 **전이 표시는 이미 소비돼 다음 틱에 안 뜬다.**
 */
const ALERTS = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'alertService.js'), 'utf-8'));

test('🔴 실행이 막히면 **예정 브리핑을 이월**한다', () => {
  const i = ALERTS.indexOf('already_running');
  assert.ok(i > 0, '건너뛰기 분기를 못 찾았다');
  const block = ALERTS.slice(Math.max(0, i - 400), i + 300);
  assert.match(block, /analystCarry/, '🔴 이월이 없다 — 겹친 회차의 브리핑이 조용히 사라진다');
  assert.match(block, /SCHEDULED\.has/, '🔴 모멘텀까지 이월하면 지나간 돌파를 나중에 알리는 거짓이 된다');
});

test('🔴 이월분이 다음 틱에 **실제로 얹힌다**', () => {
  const i = ALERTS.indexOf('const carried');
  assert.ok(i > 0, '🔴 이월분을 읽는 곳이 없다 — 저장만 하고 안 쓰면 "수집해 놓고 안 쓰는" 그것이다');
  const block = ALERTS.slice(i, i + 300);
  assert.match(block, /d\.reasons = \[\.\.\.carried/, '🔴 이월분이 reasons 에 안 붙는다');
  assert.match(block, /d\.run = true/, '🔴 이월분이 있어도 실행되지 않는다');
});

test('🔴 실행에 들어가면 이월분을 **비운다**(영원히 반복되지 않게)', () => {
  const i = ALERTS.indexOf('analystRunning = true');
  const block = ALERTS.slice(i, i + 200);
  assert.match(block, /analystCarry = \[\]/, '🔴 이월분이 안 비워진다 — 매 틱 브리핑이 반복된다');
});

/** ⚠️ `sessionsFor` 가 시간대를 넘겨야 중간점을 계산할 수 있다 */
test('⚠️ sessionsFor 가 regular{start,end} 를 넘긴다', () => {
  const i = ALERTS.indexOf('out.push({ key: k');
  const block = ALERTS.slice(i, i + 200);
  assert.match(block, /regular/, '🔴 시간대를 버린다 — 중간 브리핑이 원리상 불가능해진다');
});

/**
 * 🔴 **브리핑 종류가 프롬프트까지 닿는가** — 안 닿으면 개장·장중·마감이 **전부 같은 글**이 된다.
 *    하루 6번인데 내용이 구분되지 않으면 **셋째부터 안 읽고**, 그러면 진짜 소식도 같이 묻힌다.
 */
test('🔴 브리핑 성격이 프롬프트에 실린다', () => {
  const i = ANALYST.indexOf('const BRIEF_JOB');
  assert.ok(i > 0, '🔴 브리핑 성격 문구가 없다 — 세 브리핑이 같은 글이 된다');
  const block = ANALYST.slice(i, i + 1800);
  for (const k of ['open', 'mid', 'close']) {
    assert.ok(new RegExp(`\\b${k}\\s*:`).test(block), `🔴 ${k} 브리핑 문구가 없다`);
  }
  assert.match(block, /lines\.push/, '🔴 만들어만 놓고 프롬프트에 안 넣는다("수집해 놓고 안 쓰는")');
  assert.match(block, /briefKinds/, '🔴 트리거에서 종류를 안 읽는다');
});

test('⚠️ 종류가 겹치면 **둘 다** 싣는다 (이월로 개장+장중이 한 회차에 올 수 있다)', () => {
  const i = ANALYST.indexOf('const briefKinds');
  const block = ANALYST.slice(i, i + 400);
  assert.match(block, /for \(const k of briefKinds\)/, '🔴 하나만 싣는다 — 이월된 브리핑이 조용히 사라진다');
});

/**
 * 🔴 **국장 브리핑이 원리상 안 뜨던 것** (2026-09-22 배포 직후 발견)
 *
 * `sessionsFor` 가 `universe` 에 있는 시장만 봤는데, 사용자 보유·감시가 **전부 미국**이라
 * 한국이 후보 집합에 **한 번도 안 들어갔다**(실측: 11종목 중 한국 0개).
 * ⇒ *"미장/국장 하루 6번"* 지시에도 **실제로는 3번**이고, 사용자는 *"국장 브리핑이 안 오네"* 로 겪는데
 *   **로그에 아무 흔적이 없다** — 트리거가 실패한 게 아니라 **애초에 후보가 아니었다.**
 * ★ *"0건" 을 "안 일어났다" 로 읽는* 그 병의 반대편이다 — 여기선 **일어날 수가 없었다.**
 */
test('🔴 보유가 전부 미국이어도 **국장이 후보에 든다**', () => {
  const src = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'alertService.js'), 'utf-8'));
  const i = src.indexOf('async function sessionsFor');
  assert.ok(i > 0, 'sessionsFor 를 못 찾았다');
  const block = src.slice(i, i + 400);
  assert.match(block, /new Set\(\['kr', 'us'\]\)/,
    '🔴 universe 에서만 시장을 뽑는다 — 한국 종목이 0개면 국장 브리핑이 영영 안 뜬다');
});

/**
 * 🔴 **보유가 없는 시장도 브리핑이 나와야 한다** (2026-09-22 사용자 지시)
 *   *"국장도 국장 관련 종합적인 웹 검색 및 종목 없으면 전반적인 시황 브리핑을 해야해."*
 *
 * 종전엔 웹 검색이 **보유 종목으로만** 질의를 만들어, 한국 보유가 0이면
 * 국장 브리핑의 검색이 **통째로 비었다.** 그러면 지수 숫자만 있고 **왜 그런지가 없다.**
 */
const MCP = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server', 'mcpClient.js'), 'utf-8'));

test('🔴 시장 단위 검색 주제를 만든다 (보유 0인 시장)', () => {
  const i = ANALYST.indexOf('const marketSubjects');
  assert.ok(i > 0, '🔴 시장 주제가 없다 — 보유 없는 시장은 검색이 빈다');
  const block = ANALYST.slice(i, i + 400);
  assert.match(block, /!items\.some/, '🔴 "보유가 없는 시장" 을 가리지 않는다');
  assert.match(block, /market: m/, '🔴 시장 표시가 없어 종목 질의로 만들어진다');
});

test('🔴 검색 호출에 시장 주제가 **실제로 실린다**', () => {
  const i = ANALYST.indexOf('searchMarketNews(');
  const block = ANALYST.slice(i - 80, i + 160);
  assert.match(block, /marketSubjects/, '🔴 만들어만 놓고 안 넘긴다("수집해 놓고 안 쓰는")');
  assert.ok(/\[\.\.\.marketSubjects,\s*\.\.\.items\]/.test(block),
    '⚠️ 시장 주제가 **앞에** 와야 maxSubjects 로 잘릴 때 시황이 먼저 살아남는다');
});

test('🔴 buildQuery 가 시장 주제에 **다른 질의**를 낸다 — 그리고 SEO 자석 문구로 돌아가지 않는다', () => {
  const i = MCP.indexOf('function buildQuery');
  const block = MCP.slice(i, i + 900);
  assert.match(block, /subject\?\.market/, '🔴 시장 주제를 구분 안 한다');
  assert.match(block, /증시 마감 시황/, '🔴 시황 질의가 없다');
  // 실측(09-24): "주가 뉴스 전망" 질의는 5/5 가 점술·토론방 댓글·광고였다 — 질의 문구가 곧 소스 품질이다
  assert.doesNotMatch(block, /주가 뉴스 전망/, '🔴 SEO 자석 질의로 회귀했다');
});

/** 🔴 개인정보 가드가 약해지지 않았는가 — 자유 질의를 받게 열면 호출부로 샌다 */
test('🔴 buildQuery 는 여전히 **정해진 칸만** 읽는다 (수량·금액 차단 유지)', () => {
  const i = MCP.indexOf('function buildQuery');
  const block = MCP.slice(i, i + 500);
  assert.ok(!/subject\?\.query|subject\.query/.test(block),
    '🔴 자유 질의 칸이 생겼다 — 수량·금액을 안 싣는다는 보장이 호출부로 샌다');
});

/** ⚠️ 프롬프트가 "이 시장엔 보유가 없다" 를 말해야 한다 — 안 하면 남의 시장 종목 얘기를 쓴다 */
test('🔴 보유 없는 시장이면 프롬프트가 **시황을 요구**한다', () => {
  const i = ANALYST.indexOf('for (const m of briefMarkets)');
  assert.ok(i > 0, '🔴 대상 시장을 프롬프트에 안 쓴다');
  const block = ANALYST.slice(i, i + 900);
  assert.match(block, /보유·감시 종목이 없다/, '🔴 보유 없음을 안 알린다');
  assert.match(block, /전반적 시황/, '🔴 시황을 요구하지 않는다');
  assert.match(block, /지어내지 마라/, '🔴 없는 종목을 지어낼 여지를 남긴다');
});
