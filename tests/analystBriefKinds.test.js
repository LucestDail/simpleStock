const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 회차 종류(preopen/open/mid/close) 열거가 `server/analystService.js` 안에 세 곳
 * (`BRIEF_KINDS`·`BRIEF_JOB`·`SCHEDULED`)으로 흩어져 있다 — 2026-09-28 실사고: `BRIEF_KINDS`
 * 만 `preopen` 갱신을 놓쳐, 프리장·장중 브리핑 2회 연속 "대상 시장: … 판단하라" 지시가
 * 통째로 안 실렸다(보유 종목이 있는데 시황만 오고 종목 판단이 없었다).
 * ⇒ 소스를 직접 읽어 세 열거가 어긋나면 빨간불을 낸다 — 손으로 맞추는 한 다음에 또 어긋난다.
 *
 * "거꾸로 계정" 규율(pm2 의 마스킹 자 — `instanceof String` 하나만 보다 반환 타입 13개가
 * 조용히 우회한 것과 같은 뿌리 — 와 같은 설계):
 * ① 후보를 소스에서 전수로 뽑는다(세 열거의 합집합)
 * ② 각 후보는 [세 곳 모두에 있음 / 면제(이유 명시)] 중 하나여야 한다
 * ③ 어디에도 안 들면(=일부 열거에서만 빠짐) 실패
 * ④ 후보가 0건이면 실패 — 정규식이 깨지거나 변수명이 바뀌면 조용히 통과하면 안 된다
 * ⑤ 면제는 "존재" 가 아니라 "지탱하는가" — 지금은 면제가 없다(세 열거가 완전히 같은
 *    집합이어야 정상). 나중에 의도적으로 갈라야 하는 축이 생기면 `EXEMPTIONS` 에 **이유와
 *    함께** 추가하고, 그 축을 면제 없이 봤을 때 실제로 걸리는지 별도로 확인할 것.
 * ⑥ 변이(자기검증 테스트)로 탐지기 생존을 확인하고, 몇 건이 돌았는지(`# pass`)도 함께 본다.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');

/** `const NAME = new Set(['a', 'b', ...])` 형태에서 문자열 리터럴만 뽑는다 */
function extractSetLiteral(src, varName) {
  const m = src.match(new RegExp(`const ${varName} = new Set\\(\\[([^\\]]*)\\]\\)`));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * `const NAME = { key: '...' + '...', key2: '...' };` 형태에서 **키만** 뽑는다.
 * ⚠️ 값이 여러 줄 문자열(`+ '...'` 연결)이라 줄 시작이 식별자가 아닌 연속행은 안 걸린다.
 */
function extractObjectKeys(src, varName) {
  const startM = src.match(new RegExp(`const ${varName} = \\{`));
  if (!startM) return null;
  const startIdx = startM.index + startM[0].length;
  const endIdx = src.indexOf('\n  };', startIdx);
  if (endIdx === -1) return null;
  const block = src.slice(startIdx, endIdx);
  const keys = [...block.matchAll(/^\s*(\w+):\s*'/gm)].map((x) => x[1]);
  return keys.length ? keys : null;
}

/** 의도적으로 세 열거가 달라야 하는 후보가 생기면 여기에 "이유" 와 함께 추가한다. 지금은 비어 있어야 정상 */
const EXEMPTIONS = {};

function checkAlignment(src) {
  const sets = {
    BRIEF_KINDS: extractSetLiteral(src, 'BRIEF_KINDS'),
    BRIEF_JOB: extractObjectKeys(src, 'BRIEF_JOB'),
    SCHEDULED: extractSetLiteral(src, 'SCHEDULED'),
  };
  for (const [name, arr] of Object.entries(sets)) {
    // 🔴 ④ 검사 대상이 0건이면 "깨끗하다" 가 아니라 자를 의심한다
    assert.ok(Array.isArray(arr) && arr.length > 0, `${name} 을 소스에서 못 뽑았다(정규식이 깨졌거나 변수명이 바뀜) — 검사 대상 0건`);
  }
  const union = new Set(Object.values(sets).flat());
  const problems = [];
  for (const kind of union) {
    if (EXEMPTIONS[kind]) continue; // 이유가 적힌 면제만 건너뛴다
    const missingFrom = Object.entries(sets).filter(([, arr]) => !arr.includes(kind)).map(([name]) => name);
    if (missingFrom.length) problems.push(`'${kind}' 이 ${missingFrom.join(', ')} 에 없다`);
  }
  return problems;
}

test('🔴 회차 종류 열거 3곳(BRIEF_KINDS·BRIEF_JOB·SCHEDULED)이 서로 어긋나지 않는다', () => {
  const problems = checkAlignment(SRC);
  assert.equal(problems.length, 0, problems.join(' / '));
});

test('🔴 자기검증: BRIEF_KINDS 에서 preopen 을 일부러 빼면 이 자가 잡는다(면제 없이 보면 실제로 걸린다)', () => {
  // 2026-09-28 그날의 실제 결함을 그대로 재현한다
  const before = "const BRIEF_KINDS = new Set(['preopen', 'open', 'mid', 'close']);";
  const after = "const BRIEF_KINDS = new Set(['open', 'mid', 'close']);";
  assert.ok(SRC.includes(before), '치환 대상 패턴이 지금 소스와 안 맞는다 — 이 테스트 자체가 무의미해질 뻔했다');
  const broken = SRC.replace(before, after);

  const problems = checkAlignment(broken);
  assert.ok(
    problems.some((p) => p.includes("'preopen'") && p.includes('BRIEF_KINDS')),
    `자가 못 잡았다(장식이었다): ${JSON.stringify(problems)}`
  );
});

test('🔴 자기검증: 추출기가 대상을 못 찾으면(변수명 변경 등) 조용히 통과하지 않고 실패한다', () => {
  const broken = SRC.replace('const BRIEF_KINDS = new Set', 'const RENAMED_XYZ = new Set');
  assert.throws(() => checkAlignment(broken), /BRIEF_KINDS 을 소스에서 못 뽑았다/);
});
