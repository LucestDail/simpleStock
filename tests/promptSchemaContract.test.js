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
/**
 * ⚠️ **2026-10-14 — 지킬 계약이 바뀌었다.**
 *
 * 종전에는 *"프롬프트 예시가 `stance` enum 안인가"* 를 쟀다. 그 enum 이 **스키마에서
 * 사라졌으므로**(보고서 제품으로 재정의) 그 자는 잴 대상이 없다.
 *
 * 🔴 **그런데 같은 가족의 위험은 더 커졌다**: 프롬프트가 *"BUY 라고 분명히 말하라"* 처럼
 *    **행동 어휘를 예시로 주면**, 모델이 그대로 답하고 `asPosition` 이 **그 항목을 버린다**
 *    (= `positions 0`, 사용자에겐 "판단이 없다" 로 보인다). 종전과 **증상이 똑같다.**
 * ⇒ 축을 옮긴다: 프롬프트의 인용 지시문이 **행동 어휘를 모범으로 보여주지 않는가**.
 * ★ 2026-10-14 사주 파이프라인에서 *"✓ 예문이 고정돼 모델이 거짓을 베꼈다"* 와 같은 가족 —
 *   **프롬프트에 사실을 넣는 것과 모범으로 보여주는 것은 힘이 다르다.**
 */
const ACTION_WORDS = ['BUY', 'SELL', 'HOLD', '매수', '매도', '보유', '관망', '유지', '청산', '익절', '손절'];

test('🔴 프롬프트가 행동 어휘를 예시로 주지 않는다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const bad = [];
  for (const lit of promptLiterals(stripComments(src))) {
    for (const m of lit.matchAll(QUOTED_DIRECTIVE)) {
      const token = m[1].trim();
      if (ACTION_WORDS.some((w) => token.toUpperCase() === w.toUpperCase())) {
        bad.push({ token, lit: lit.slice(0, 90) });
      }
    }
  }
  assert.deepEqual(bad, [], `🔴 프롬프트가 행동을 모범으로 보여준다: ${JSON.stringify(bad)}`);
});

test('🔴 자기검증: 행동 어휘 예시를 심으면 이 자가 잡는다', () => {
  const fake = `const X = ['같으면 "HOLD" 라고 분명히 말하라'];`;
  const found = [];
  for (const lit of promptLiterals(fake)) {
    for (const m of lit.matchAll(QUOTED_DIRECTIVE)) {
      if (ACTION_WORDS.some((w) => m[1].trim().toUpperCase() === w.toUpperCase())) found.push(m[1]);
    }
  }
  assert.equal(found.length, 1, '🔴 심은 위반을 못 잡는다 — 이 자는 아무것도 안 보고 있다');
});

test('⚠️ 오탐 없음: 관측 어휘를 인용하는 것은 위반이 아니다', () => {
  const ok = `const X = ['변화가 없으면 "그대로다" 라고 적으세요'];`;
  const found = [];
  for (const lit of promptLiterals(ok)) {
    for (const m of lit.matchAll(QUOTED_DIRECTIVE)) {
      if (ACTION_WORDS.some((w) => m[1].trim().toUpperCase() === w.toUpperCase())) found.push(m[1]);
    }
  }
  assert.deepEqual(found, [], '🔴 멀쩡한 관측 지시문을 위반으로 찍는다 — 오탐하면 다음 사람이 자를 끈다');
});

test('🔴 스키마에 행동 칸이 되살아나지 않는다', () => {
  const a = require('../server/analystService');
  const it = a._REPORT_SCHEMA.properties.positions.items;
  for (const k of ['stance', 'entry', 'stop', 'target', 'scenarioUp', 'scenarioDown']) {
    assert.ok(!(k in it.properties), `🔴 \`${k}\` 칸이 되살아났다 — 칸이 있으면 모델은 채운다`);
  }
  // ★ 판별력 — 관측 칸은 **있어야** 한다(둘 다 없으면 이 테스트는 공허하다)
  for (const k of ['trend', 'rationale', 'evidence', 'risk']) {
    assert.ok(k in it.properties, `🔴 관측 칸 \`${k}\` 이 사라졌다`);
  }
});
