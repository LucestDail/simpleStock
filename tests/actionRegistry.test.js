const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 액션 레지스트리 가드 (2026-09-21 신설)
 *
 * ## 왜 있나
 *
 * `ACTION_SCHEMA.type` 의 enum 에 **실행부가 없는 액션 5개**가 들어 있었고
 * (`upsertHolding`·`removeHolding`·`updateProfile`·`scheduleTask`·`cancelScheduledTask`),
 * 프롬프트는 모델에게 *"실제로 반영될 자산/설정/예약 변경 사항을 답변 안에 분명히 언급한다"*
 * 라고 시키고 있었다. ⇒ **모델이 "등록했습니다" 라고 답하는데 아무것도 쓰이지 않았다.**
 * 죽은 코드보다 나쁘다 — 사용자에게 **거짓말을 하는 코드**였다.
 *
 * ## 이 가드가 막는 것
 *
 * 1. enum 에 항목이 **말없이 늘어나는 것** — 모든 항목은 아래 REGISTRY 에서
 *    `executor`(실행부 있음) 또는 `proposal`(제안 전용 + 이유) 중 하나로 **계정**돼야 한다.
 *    ★ 개수 문턱(`>= N`)이 아니라 **거꾸로 계정**이다. 문턱은 "빠진 것" 을 못 알려준다.
 * 2. 프롬프트가 **"반영됐다" 고 말하는 것** — 제안 전용인 한 그렇게 말하면 안 된다.
 *
 * ⚠️ 판정은 **주석을 지우고** 한다. 위 설명문에도 금지 문구가 들어 있어서,
 *    안 지우면 이 파일과 소스의 설명 주석이 **거짓 양성**을 만든다.
 */

const SRC = path.join(__dirname, '..', 'server', 'aiService.js');

/**
 * 각 액션의 처분. 새 액션을 enum 에 넣으면 여기에도 넣어야 테스트가 통과한다.
 *  - kind: 'executor' → 실행부가 있다. `executorHint` 문자열이 server/ 어딘가에 실제로 있어야 한다
 *  - kind: 'proposal' → 실행부가 없다(제안만). `why` 필수 — **이유 없는 면제는 곧 구멍**이다
 */
const REGISTRY = {
  scheduleTask: {
    kind: 'proposal',
    why: '예약 생성 실행부·API 가 없다. 모델이 계획만 만들고 아무도 쓰지 않는다. '
      + 'HITL 승인 흐름을 붙일 때 실행부를 함께 만든다.',
  },
  cancelScheduledTask: {
    kind: 'proposal',
    why: 'scheduleTask 와 같다. 취소 실행부가 없다.',
  },
};

/** 줄 단위로 // 주석을 걷어낸다 (문자열 안의 // 를 지우지 않도록 따옴표 상태를 본다) */
function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i += 1;
          else if (c === quote) quote = null;
        } else if (c === "'" || c === '"' || c === '`') {
          quote = c;
        } else if (c === '/' && line[i + 1] === '/') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

function readEnum(src) {
  // ⚠️ 2026-09-21: 처음에 파일 전체에서 첫 `enum:` 을 잡았더니 **다른 스키마**가 걸렸다
  //    (`default, primary, positive, warning`). 앵커를 ACTION_SCHEMA 로 좁힌다 —
  //    "대상이 0건인가" 가 아니라 **"재려던 그것이 대상에 들었나"** 를 물어야 한다.
  const start = src.indexOf('const ACTION_SCHEMA');
  assert.ok(start >= 0, 'ACTION_SCHEMA 선언을 찾지 못했다 — 가드가 대상을 잃었다(통과 아님)');
  const m = src.slice(start).match(/enum:\s*\[([^\]]*)\]/);
  assert.ok(m, 'ACTION_SCHEMA 안에서 type enum 을 찾지 못했다(통과 아님)');
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

test('액션 enum 의 모든 항목이 계정된다 (거꾸로 계정)', () => {
  const src = stripLineComments(fs.readFileSync(SRC, 'utf8'));
  const types = readEnum(src);

  assert.ok(types.length > 0, 'enum 이 비었다 — 공허한 통과 방지');

  const unaccounted = types.filter((t) => !REGISTRY[t]);
  assert.deepEqual(
    unaccounted,
    [],
    `계정되지 않은 액션: ${unaccounted.join(', ')}\n`
      + '새 액션을 넣었으면 tests/actionRegistry.test.js 의 REGISTRY 에 '
      + "executor(실행부 있음) 또는 proposal(제안 전용 + 이유) 로 적어라."
  );

  // 반대 방향 — REGISTRY 에만 있고 enum 에서 사라진 항목 (레지스트리가 낡는 것을 막는다)
  const stale = Object.keys(REGISTRY).filter((t) => !types.includes(t));
  assert.deepEqual(stale, [], `enum 에 없는데 REGISTRY 에 남은 항목: ${stale.join(', ')}`);
});

test('proposal 항목에는 이유가 적혀 있다 (이유 없는 면제는 구멍)', () => {
  for (const [type, entry] of Object.entries(REGISTRY)) {
    if (entry.kind !== 'proposal') continue;
    assert.ok(
      typeof entry.why === 'string' && entry.why.length >= 20,
      `${type} 은 proposal 인데 why 가 없거나 너무 짧다`
    );
  }
});

test('executor 로 적은 항목은 실행부가 실제로 있다', () => {
  const serverDir = path.join(__dirname, '..', 'server');
  const all = fs
    .readdirSync(serverDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(serverDir, f), 'utf8'))
    .join('\n');

  let checked = 0;
  for (const [type, entry] of Object.entries(REGISTRY)) {
    if (entry.kind !== 'executor') continue;
    checked += 1;
    assert.ok(entry.executorHint, `${type} 은 executor 인데 executorHint 가 없다`);
    assert.ok(
      all.includes(entry.executorHint),
      `${type} 의 실행부(${entry.executorHint})를 server/ 에서 찾지 못했다 — `
        + '실행부 없이 executor 로 적으면 "보호받고 있다" 는 착각만 남는다'
    );
  }
  // 지금은 executor 가 0개인 게 정상이다. 그 사실 자체를 남긴다(검사 안 한 것과 구분).
  assert.equal(checked, Object.values(REGISTRY).filter((e) => e.kind === 'executor').length);
});

test('🔴 제안 전용인데 프롬프트가 "반영됐다" 고 말하지 않는다', () => {
  const src = stripLineComments(fs.readFileSync(SRC, 'utf8'));

  // 자기 검사 — 주석 제거가 소스를 통째로 먹지 않았는지 (랜드마크 생존)
  assert.ok(src.includes('ACTION_SCHEMA'), '주석 제거가 소스를 삼켰다');
  assert.ok(src.length > 10000, '주석 제거 후 소스가 비정상적으로 짧다');

  const banned = [
    '실제로 반영될',
    '반영했습니다',
    '포트폴리오에 반영',
  ];
  const hits = [];
  src.split('\n').forEach((line, i) => {
    for (const b of banned) if (line.includes(b)) hits.push(`${i + 1}: ${line.trim().slice(0, 80)}`);
  });
  assert.deepEqual(
    hits,
    [],
    '실행부가 없는데 반영됐다고 말하는 문구가 있다:\n' + hits.join('\n')
  );
});

test('★ 가드의 판별력 — 금지 문구를 넣으면 실제로 잡힌다', () => {
  // 위 테스트가 "우연히 0건" 인지 "볼 줄 아는지" 를 가른다.
  const fake = "const x = { prompt: '실제로 반영될 변경을 언급한다' };";
  const stripped = stripLineComments(fake);
  assert.ok(stripped.includes('실제로 반영될'), '금지 문구를 못 잡는다 — 가드가 죽었다');

  // 그리고 주석 안의 같은 문구는 **안** 잡아야 한다(오탐 축)
  const commented = "const y = 1; // 실제로 반영될 이라고 적혀 있었다";
  assert.ok(
    !stripLineComments(commented).includes('실제로 반영될'),
    '주석을 못 지운다 — 설명 주석이 거짓 양성을 만든다'
  );

  // 문자열 안의 // 를 주석으로 오인하지 않아야 한다
  const url = "const z = 'https://example.com/실제로 반영될';";
  assert.ok(stripLineComments(url).includes('실제로 반영될'), '문자열 안의 // 를 주석으로 잘랐다');
});
