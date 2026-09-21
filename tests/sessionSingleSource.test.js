const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **장 세션 정본은 하나여야 한다** (2026-09-22)
 *
 * ## 무슨 일이 있었나 — 셋이 있었고 셋 다 다른 답을 냈다
 * ```
 * 05:21 KST (미국 정규장 마감 21분 뒤)
 *   화면 (marketDataService, 시계 22~5)   pre     "장 전"   ❌
 *   경보 (alertService,      시계 22~6)   open    "장중"   ❌  폐장 요약이 1시간 늦는다
 *   애널 (marketCalendar,    캘린더)      closed            ✅
 * ```
 * 캘린더를 붙일 때 **애널리스트만 갈아끼우고 나머지를 안 훑었다.**
 * 루트 CLAUDE.md 의 *"규칙을 정하면 그 자리에서 적용 범위를 전수로 훑어라"* 를 어긴 것이다.
 *
 * ⚠️ 주석으로는 못 막는다 — 다음 사람이 또 `resolveSession(...)` 을 직접 부르면 그만이다.
 *    ⇒ **소스를 훑어** 시계 폴백을 직접 부르는 곳이 `marketCalendar` 안에만 있는지 본다.
 */

const ROOT = path.join(__dirname, '..', 'server');

/** 주석·문자열을 지우고 **구조로** 본다(설명 주석을 위반으로 읽는 오탐을 막는다) */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * 🔴 **면제에는 이유를 적는다.** 이유 없는 면제는 곧 구멍이다.
 *    `marketCalendar.js` = 폴백 **구현체이자 유일한 합법 호출처**(캘린더 실패 시 내려간다).
 */
const EXEMPT = new Map([['marketCalendar.js', '폴백 구현체 — 캘린더 실패 시 여기서만 내려간다']]);

function serverFiles() {
  return fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));
}

test('🔴 시계 폴백(`resolveSession`)을 직접 부르는 곳은 marketCalendar 뿐이다', () => {
  const files = serverFiles();
  assert.ok(files.length >= 10, `🔴 대상이 ${files.length}개뿐 — 경로가 바뀌었다(조용한 0건 방지)`);

  const offenders = [];
  let scanned = 0;
  for (const f of files) {
    if (EXEMPT.has(f)) continue;
    scanned += 1;
    const code = codeOnly(fs.readFileSync(path.join(ROOT, f), 'utf-8'));
    // `resolveSessionLive(` 는 정본이므로 제외하고, 맨 `resolveSession(` 만 본다
    if (/\bresolveSession\s*\(/.test(code.replace(/\bresolveSessionLive\s*\(/g, 'OK('))) {
      offenders.push(f);
    }
  }
  assert.ok(scanned >= 9, `🔴 검사한 파일이 ${scanned}개뿐이다`);
  assert.deepEqual(offenders, [],
    `🔴 시계 폴백을 직접 부르는 곳이 있다 — 정본이 또 갈라진다: ${offenders.join(', ')}`);
});

/**
 * 🔴 **자의 판별력** — 면제 없이 보면 실제로 걸리는가.
 *    (안 걸리면 위 테스트는 "아무것도 안 보는" 장식이다)
 */
test('🔴 면제를 풀면 marketCalendar 가 **걸린다** (탐지기 생존 확인)', () => {
  const code = codeOnly(fs.readFileSync(path.join(ROOT, 'marketCalendar.js'), 'utf-8'));
  const hit = /\bresolveSession\s*\(/.test(code.replace(/\bresolveSessionLive\s*\(/g, 'OK('));
  assert.equal(hit, true, '🔴 면제 대상에서 아무것도 안 걸린다 — 면제가 장식이고 탐지기가 죽었다');
});

test('🔴 죽은 사본(`getSessionState`)이 되살아나지 않았다', () => {
  for (const f of serverFiles()) {
    const code = codeOnly(fs.readFileSync(path.join(ROOT, f), 'utf-8'));
    assert.ok(!/function\s+getSessionState\s*\(/.test(code),
      `🔴 ${f} 에 세션 판정 사본이 또 생겼다 — marketCalendar 를 쓸 것`);
  }
});

/** 세 소비자가 **같은 함수**를 보는지 */
test('🔴 경보·화면 둘 다 resolveSessionLive 를 부른다', () => {
  for (const f of ['alertService.js', 'marketDataService.js']) {
    const code = codeOnly(fs.readFileSync(path.join(ROOT, f), 'utf-8'));
    assert.match(code, /resolveSessionLive\s*\(/, `🔴 ${f} 가 캘린더 정본을 안 본다`);
  }
});
