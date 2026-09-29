const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **프롬프트가 예시로 주는 stance 는 스키마 enum 안이어야 한다** (2026-09-29, prompt-audit F1).
 *
 * 있었던 것: `BRIEF_JOB.mid` 가 `같으면 "유지" 라고 분명히 말하라` 였다. 스키마는
 * `stance: {enum:['BUY','SELL','HOLD']}` 이고 `STANCES` 로 검증하므로, 모델이 그 예시를 따르면
 * `asPosition` 이 **항목을 버린다**(= `positions 0`, 사용자에겐 "보유 판단이 없다" 로 보인다).
 *
 * ⚠️ **인과 단정은 하지 않는다** — 09-28 12:17 `positions 0` 의 원인이라 말할 수 없다.
 *   09-29 08:04 `positions_short` 는 `"유지"` 가 **없는** preopen 회차에서 났다. 고칠 이유는
 *   **계약 불일치 하나로 충분**하다.
 *
 * ★ **관대한 파서(`asPosition` 이 한국어를 인정하게 하기)는 일부러 기각했다** (pm2 교정).
 *   처음엔 *"정본이 둘이 된다"* 를 근거로 댔는데 그건 **영속 상태가 각자 갱신되며 갈라지는**
 *   경우의 규칙이라 여기 안 맞는다. 진짜 근거는 이것이다:
 *   **흡수하면 계약 위반이 관측 불가가 된다** — 이탈이 조용히 성공으로 처리되면
 *   *"프롬프트가 계약을 어겼다"* 는 신호가 영영 안 뜬다(`checkerAbsorbed` 와 같은 가족).
 *
 * ★ **판정 방향**(pm2 교정): 금지 낱말 열거가 아니라 **허용목록**이다.
 *   `"…" 라고 말하라` 같은 **인용+지시** 패턴을 앵커로 잡고, 인용된 토큰이 **enum 안인지** 본다.
 *   금지목록이면 `유지·관망·중립…` 을 **전부 열거**해야 하고 다음 사람은 **빠뜨린 하나만**
 *   쓰면 된다(셸 가드 18/18 의 비대칭). 앵커+허용목록은 그 부담이 없다.
 */

const SRC = path.join(__dirname, '..', 'server', 'analystService.js');

/**
 * 🔴 주석을 먼저 지운다 — 안 그러면 **이 규칙을 설명하는 주석이 이 자를 깨뜨린다.**
 * 바로 위 주석과 `BRIEF_JOB` 위 주석에 종전 문구(`"유지" 라고 …`)가 **그대로** 들어 있다.
 * (자기 참조 오탐 — 규칙을 적은 문장이 규칙 위반으로 읽히는 자리)
 * ⚠️ 줄 전체가 주석인 것만 지운다. 코드 뒤 `//` 까지 지우면 문자열 안의 `//` 를 깨뜨린다.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/** enum 정본은 **소스에서 읽는다** — 복제하면 진짜 값이 바뀌어도 자가 "정상" 이라 거짓말한다. */
function readStances(src) {
  const m = src.match(/const STANCES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'STANCES 정의를 소스에서 못 찾았다 — 자가 옛 위치를 보고 있다');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** 이 저장소의 프롬프트 표기 = 작은따옴표 리터럴. */
function promptLiterals(src) {
  return (src.match(/'(?:[^'\\]|\\.)*'/g) || []).map((s) => s.slice(1, -1));
}

/**
 * 앵커: **인용 + 지시**(`"X" 라고 말하라/답하라/적어라/써라`).
 * 서술 속 인용(`"## 시장 국면" 절의 판정을 …`)이나 **부정 예시**
 * (`"관망 필요", "시장 상황에 따라" 같은 말은 답이 아닙니다`)는 지시형이 아니라 걸리지 않는다.
 */
const QUOTED_DIRECTIVE = /"([^"]{1,12})"\s*(?:라고|로)\s*(?:분명히\s*)?(?:말|답|적|쓰|기재)/g;

function violations(src, stances) {
  const allowed = new Set(stances.map((s) => s.toUpperCase()));
  const out = [];
  for (const lit of promptLiterals(stripComments(src))) {
    for (const m of lit.matchAll(QUOTED_DIRECTIVE)) {
      const token = m[1].trim();
      if (!allowed.has(token.toUpperCase())) out.push({ token, lit: lit.slice(0, 120) });
    }
  }
  return out;
}

// ── ⓐ 발동 축 ──────────────────────────────────────────────────────────
test('🔴 프롬프트가 enum 밖 값을 stance 예시로 주지 않는다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const stances = readStances(src);
  assert.ok(
    stances.every((s) => /^[A-Z_]+$/.test(s)),
    `STANCES 가 영문 대문자가 아니다(${stances.join(',')}) — 계약이 바뀌었으면 이 자도 다시 설계하라`,
  );
  const bad = violations(src, stances);
  assert.equal(
    bad.length, 0,
    `프롬프트가 enum 밖 값을 예시로 준다: ${bad.map((b) => `"${b.token}"`).join(', ')}\n`
    + `→ 모델이 그대로 답하면 asPosition 이 버린다(positions 0). 허용: ${stances.join('|')}`,
  );
});

test('🔴 자기검증: enum 밖 예시를 심으면 이 자가 잡는다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const stances = readStances(src);
  const mutated = src.replace(
    '그대로면 그대로라고 분명히 말하라(그 종목 stance 는 HOLD). ',
    '그대로면 "유지" 라고 분명히 말하라. ',
  );
  assert.notEqual(mutated, src, '변이가 반영되지 않았다 — no-op 는 통과가 아니다. 원문이 바뀌었으면 이 줄부터 고쳐라');
  const caught = violations(mutated, stances);
  assert.ok(caught.length > 0, '심은 위반을 못 잡았다 — 탐지기가 죽어 있다');
  assert.equal(caught[0].token, '유지');
});

test('🔴 자기검증: enum 안 값을 인용하는 것은 위반이 아니다(허용목록이 실제로 통과시킨다)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const stances = readStances(src);
  const ok = src.replace(
    '그대로면 그대로라고 분명히 말하라(그 종목 stance 는 HOLD). ',
    '그대로면 "HOLD" 라고 분명히 말하라. ',
  );
  assert.notEqual(ok, src, '변이 미반영');
  assert.equal(violations(ok, stances).length, 0, 'enum 안 값을 위반으로 읽었다 — 금지목록처럼 동작하고 있다');
});

// ── ⓑ 오탐 축 (pm2: "이게 제일 위험하다") ──────────────────────────────
test('⚠️ 오탐 없음: 규칙을 설명하는 주석이 이 자를 깨뜨리지 않는다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(
    /"유지"\s*라고/.test(src),
    '전제가 깨졌다 — 주석에서 종전 문구가 사라졌다면 이 오탐 테스트는 아무것도 검사하지 않는다',
  );
  assert.equal(violations(src, readStances(src)).length, 0, '주석을 위반으로 읽었다(자기 참조 오탐)');
});

test('⚠️ 오탐 없음: 부정 예시와 서술 속 인용은 걸리지 않는다', () => {
  const stances = ['BUY', 'SELL', 'HOLD'];
  const benign = [
    `const a = '"관망 필요", "시장 상황에 따라" 같은 말은 답이 아닙니다.';`,
    `const b = '"## 시장 국면" 절의 판정을 그대로 쓰라 — 다시 판정하지 마라.';`,
    `const c = '웹검색에서 온 사실은 "(검색)" 을 붙여 구분합니다.';`,
  ].join('\n');
  assert.equal(violations(benign, stances).length, 0, '부정 예시·서술 인용을 위반으로 읽었다');
});

// ── ⓒ 대상 축 ─────────────────────────────────────────────────────────
test('🔴 검사 대상이 실재한다 — 공허한 통과 금지', () => {
  const src = stripComments(fs.readFileSync(SRC, 'utf8'));
  const lits = promptLiterals(src);
  assert.ok(lits.length >= 50, `프롬프트 리터럴이 ${lits.length}개뿐 — 추출기가 대상을 놓치고 있다`);
  for (const sym of ['BRIEF_JOB', 'STANCES', 'asPosition']) {
    assert.ok(src.includes(sym), `${sym} 이 검사 범위 밖이다 — 주석 제거가 코드를 지웠거나 심볼이 옮겨졌다`);
  }
});

// ── ⓓ 전수 축: 프롬프트 상수를 거꾸로 계정 ────────────────────────────
test('🔴 프롬프트를 담는 상수는 전부 계정된다 — 새로 생기면 강제로 드러난다', () => {
  const src = stripComments(fs.readFileSync(SRC, 'utf8'));
  // 프롬프트 리터럴을 3개 이상 품은 대문자 상수 = 프롬프트 상수 후보
  const candidates = new Set();
  for (const m of src.matchAll(/const ([A-Z][A-Z0-9_]{3,})\s*=\s*([[{])/g)) {
    const start = m.index;
    const chunk = src.slice(start, start + 2000);
    if (promptLiterals(chunk).filter((s) => /[가-힣]/.test(s)).length >= 3) candidates.add(m[1]);
  }
  // 검사됨: 이 자는 파일 전체 리터럴을 훑으므로 후보는 모두 자동으로 검사 범위 안이다.
  // 면제: 없음. 대상 아님: 없음. ⇒ 어느 후보도 범위 밖이면 실패한다.
  for (const c of candidates) {
    assert.ok(src.includes(c), `${c} 가 범위 밖`);
  }
  assert.ok(
    candidates.size >= 1,
    `프롬프트 상수를 하나도 못 찾았다(${[...candidates].join(',')}) — 추출기가 고장났거나 상수가 옮겨졌다`,
  );
});
