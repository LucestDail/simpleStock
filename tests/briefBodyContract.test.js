'use strict';

/**
 * 폰으로 나가는 **분석 본문**의 계약 — 2026-10-15 신설
 *
 * 🔴 **왜 생겼나.** 2026-10-12 에 주문 집행을 걷어내고, 10-13 에 "그것을 말하던 것" 을 걷고,
 *    10-14 에 프롬프트를 걷었다. 그런데 10-15 아침에 **본문 조립 코드가 두 벌**인 것이 드러났다
 *    — `analyze()` 안의 자동 발송은 고쳐졌는데 `POST /api/analyst/telegram` 라우트는
 *    자기 사본을 들고 있었고, 거기엔 **사라진 필드 `stance`**(→ `QLD undefined/HIGH`),
 *    **제거된 `created`**(→ `🟡 제안 BUY … (승인 대기)`), **10-13 에 걷어낸 `못 본 것:`** 이
 *    그대로 살아 있었다. 호출처가 0곳이라 *죽은 코드* 로 보였지만, 라우트는 살아 있으므로
 *    **죽은 코드가 아니라 발화 가능한 거짓**이었다.
 *
 * ★ 이 저장소에서 반복되는 **"형제 중 하나만 고쳐짐"** 의 네 번째다. 근본 처방은 규칙을
 *   더하는 것이 아니라 **정본을 하나로 만드는 것**이라, 이 자는 ⓒ축에서 그것을 강제한다.
 *
 * ★ 2026-10-14 에 적은 *"필드 하나를 바꾸면 (ㄱ)만드는 곳 (ㄴ)읽는 곳 (ㄷ)검사하는 곳
 *   (ㄹ)고치는 곳 넷을 전수로 센다"* 중 **(ㄴ)읽는 곳**을 안 센 것이 이 사고다.
 *
 * 축 넷 — **각각 고립해서** 잰다(겹겹 방어는 제품엔 좋고 자에는 함정이다):
 *   ⓐ 실제 라이브 보고서를 먹여 **행동 어휘 0건** (+ 자가 살아 있는지 함께 확인)
 *   ⓑ 본문이 읽는 필드가 **스키마에 실재**
 *   ⓒ 분석 발송의 **본문 조립 정본이 하나**
 *   ⓓ 사라진 이름이 본문 경로에 **되살아나지 않는다**
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const analyst = require('../server/analystService.js');

/**
 * 🔴 **픽스처는 실제 라이브 보고서에서 떴다**(2026-10-14 23:33 UTC 회차).
 *    손으로 지어낸 모양은 *"우리가 상상한 모델 응답"* 이지 모델이 실제로 주는 것이 아니다 —
 *    2026-09-28 my-computer 에서 합성 look-alike 픽스처가 결함을 **원리상 못 보던** 사고가 있었다.
 *    ⚠️ 계좌 평가액은 지웠다(저장소에 들어가는 파일이다). 종목 서술은 원문 그대로다.
 */
const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'liveReport.sample.json'), 'utf8'),
);

/** 주석·문자열을 지운 소스 — 🔴 grep 이 주석을 코드로 읽는 사고를 2026-10-14 하루에 네 번 밟았다 */
function codeOf(rel) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/** 중괄호 균형으로 함수 본문을 뜬다 — 🔴 정규식으로 끝을 추정하면 짧게 잘려 "0건" 이 나온다(10-14 실패) */
function bodyOf(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

// ── ⓐ 행동 어휘 ────────────────────────────────────────────────────────────
/**
 * 이 제품은 **보고서**다. 폰 본문에 처방이 들어가면 사용자가 2026-10-14 에 물은
 * *"우리 매수/매도 안 하는데 왜 자꾸 매수매도 판단이 나오는거야?"* 가 그대로 재발한다.
 *
 * ⚠️ **수급 데이터의 `매수`·`매도` 는 여기 안 온다** — 본문은 모델 서술만 싣는다.
 *    프롬프트 쪽 어휘 축은 `promptSchemaContract` 가 따로 잰다(대상이 다르다).
 */
const ACTION_WORDS = [
  '진입', '손절', '목표가', '익절', '매수', '매도', '분할', '청산',
  'BUY', 'SELL', 'HOLD', '손익비', 'R:R', '여력', '승인 대기', '제안',
];

test('ⓐ 라이브 보고서로 만든 본문에 행동 어휘가 없다', () => {
  const body = renderBody(SAMPLE);

  const hits = {};
  for (const w of ACTION_WORDS) {
    const n = body.split(w).length - 1;
    if (n) hits[w] = n;
  }
  assert.deepStrictEqual(hits, {}, `본문에 행동 어휘가 있다: ${JSON.stringify(hits)}`);
});

test('ⓐ-2 그 자가 살아 있다 — 있어야 하는 낱말은 실제로 잡힌다', () => {
  /**
   * 🔴 **"0건" 을 믿기 전에 대상이 있었는지 본다.** 본문이 비었거나 포매터가 빈 배열을
   *    돌려줘도 ⓐ 는 초록불이다. 2026-10-15 아침에 실제로 이 함정을 밟았다 —
   *    `analyst.telegram` 로그에 본문이 안 담겨 "행동 어휘 0건" 이 **아무것도 재지 않았다**.
   */
  const body = renderBody(SAMPLE);
  assert.ok(body.length > 1000, `본문이 너무 짧다(${body.length}자) — 포매터가 비었을 수 있다`);
  for (const w of ['추세', '변동성', '관찰', '근거']) {
    assert.ok(body.includes(w), `본문에 "${w}" 가 없다 — 자가 빈 문자열을 재고 있다`);
  }
  // 일부러 심은 양성: 행동 어휘가 들어오면 ⓐ 가 반드시 잡는지
  const poisoned = `${body}\n  진입: 54.3 · 손절 52.5`;
  const caught = ACTION_WORDS.filter((w) => poisoned.includes(w));
  assert.ok(caught.includes('진입') && caught.includes('손절'), '자가 심은 양성을 못 잡는다');
});

// ── ⓑ 본문이 읽는 필드가 스키마에 실재 ───────────────────────────────────────
test('ⓑ 본문 조립이 읽는 보고서 필드가 전부 스키마에 있다', () => {
  const src = codeOf('server/analystService.js');
  const body = bodyOf(src, 'function composeBriefBody');
  assert.ok(body, 'composeBriefBody 를 못 찾았다 — 이름이 바뀌었으면 이 자도 함께 고친다');

  const schemaFields = positionSchemaFields();
  assert.ok(schemaFields.size >= 5, `스키마 필드가 ${schemaFields.size}개뿐 — 수집이 깨졌다`);

  // 포지션 변수에서 읽는 속성만 — report 자신의 필드(marketView 등)는 별도 허용
  const REPORT_LEVEL = new Set(['marketView', 'momentumRead', 'positions', 'at']);
  const JS_BUILTIN = new Set(['length', 'push', 'join', 'filter', 'map', 'slice', 'trim', 'symbol']);

  const bad = [];
  for (const m of body.matchAll(/\b(?:ps|p|pos|position)\.([A-Za-z_]\w*)/g)) {
    const f = m[1];
    if (JS_BUILTIN.has(f) || REPORT_LEVEL.has(f) || schemaFields.has(f)) continue;
    bad.push(f);
  }
  assert.deepStrictEqual(
    [...new Set(bad)], [],
    `본문이 스키마에 없는 필드를 읽는다: ${[...new Set(bad)].join(', ')}`
      + ' — 모델이 안 주는 칸이라 undefined 가 폰으로 간다',
  );
});

// ── ⓒ 정본이 하나 ──────────────────────────────────────────────────────────
test('ⓒ 분석 본문 조립의 정본이 하나다', () => {
  /**
   * 🔴 **이 축이 오늘의 사고를 직접 막는다.** 규칙을 더해도 사본이 둘이면 한쪽은 반드시
   *    뒤처진다 — 2026-10-15 에 `server.js` 라우트가 정확히 그랬다.
   */
  const files = ['server.js', 'server/analystService.js'];
  const definers = [];
  const assemblers = [];

  for (const rel of files) {
    const src = codeOf(rel);
    if (/function\s+composeBriefBody/.test(src)) definers.push(rel);
    // 제목 줄을 자기 손으로 만드는 곳 = 사본을 들고 있다는 표식
    for (const m of src.matchAll(/\[\s*'(?:[^']*)분석'\s*\]/g)) assemblers.push(`${rel}: ${m[0]}`);
  }

  assert.strictEqual(definers.length, 1, `composeBriefBody 정의가 ${definers.length}곳이다: ${definers}`);
  assert.deepStrictEqual(
    assemblers, [],
    `본문 제목을 직접 만드는 사본이 남아 있다: ${assemblers.join(' | ')}`
      + ' — composeBriefBody 를 쓰게 고친다',
  );
});

// ── ⓓ 사라진 이름이 되살아나지 않는다 ────────────────────────────────────────
test('ⓓ 제거된 보고서 필드를 본문 경로에서 읽지 않는다', () => {
  /**
   * 면제는 **이유와 함께**만 둔다 — 2026-10-14 에 내가 둔 면제 7개 중 **6개가 장식**이라
   * 내가 같이 만든 자가 지웠다. 여기 면제가 늘어나면 그때마다 "정말 지탱하는가" 를 묻는다.
   *
   * 백테스트 경로(`asProposal`·`computeTrade`·`STANCES`)는 **살아 있는 생산자가 있다** —
   * 모의 매매는 주문이 아니라 시뮬레이션 입력이다(2026-10-12 확정). 그래서 대상이 아니다.
   */
  const GONE = ['stance', 'created', 'rejected', 'scenarioUp', 'scenarioDown'];
  const src = codeOf('server.js');
  const body = bodyOf(src, "app.post('/api/analyst/telegram'");
  assert.ok(body, '/api/analyst/telegram 라우트를 못 찾았다 — 지웠다면 이 자도 함께 고친다');

  const found = GONE.filter((f) => new RegExp(`\\.${f}\\b`).test(body));
  assert.deepStrictEqual(
    found, [],
    `발송 라우트가 제거된 필드를 읽는다: ${found.join(', ')}`,
  );
  assert.ok(!/못 본 것/.test(body), '2026-10-13 에 걷어낸 "못 본 것:" 줄이 되살아났다');
});

// ── 헬퍼 ───────────────────────────────────────────────────────────────────

/** 공용 포매터로 본문 문자열을 만든다 — 반환 모양이 바뀌면 여기만 고친다 */
function renderBody(report) {
  assert.strictEqual(
    typeof analyst.composeBriefBody, 'function',
    'composeBriefBody 가 export 돼 있지 않다 — 본문을 테스트에서 못 잰다',
  );
  const r = analyst.composeBriefBody(report);
  const parts = Array.isArray(r) ? r : [...(r.prose || []), ...(r.detail || [])];
  return parts.join('\n');
}

/** 스키마가 내는 position 필드 집합 */
function positionSchemaFields() {
  const out = new Set();
  const collect = (schema) => {
    const pos = schema?.properties?.positions?.items?.properties;
    for (const k of Object.keys(pos || {})) out.add(k);
  };
  if (analyst._REPORT_SCHEMA) collect(analyst._REPORT_SCHEMA);
  if (typeof analyst.reportSchemaFor === 'function') {
    collect(analyst.reportSchemaFor(['QLD', 'O'], { budget: true }));
  }
  return out;
}
