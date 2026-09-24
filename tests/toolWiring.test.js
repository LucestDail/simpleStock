/**
 * 채팅 도구 배선 전수 계정 (2026-09-24 — pm2 의 ToolWiringRuleTest 를 이식)
 *
 * my-computer 실사고: readWebPage 가 **코드에는 있고 실행 경로에는 없어서**
 * 검색→읽기 사슬이 말로만 존재했다. 같은 병의 simpleStock 판:
 * 채팅 도구는 선언(TOOL_DECLARATIONS)·구현(runTool case)·안내(decideTools 지침) 3층이라
 * 하나만 빠져도 — 선언만 있으면 "알 수 없는 도구", 구현만 있으면 모델이 모른 채 영영 안 부른다.
 *
 * 🔴 거꾸로 계정: 문턱(>=N)이 아니라 **양방향 전수 대조** — 새 도구가 생기면 자동으로 강제된다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystChat.js'), 'utf8');

function extract() {
  // 선언: TOOL_DECLARATIONS 배열 안의 name — 파일 전체에서 name: '...' 는 도구 선언에만 쓰인다
  const declared = [...src.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
  const cases = [...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
  return { declared, cases };
}

test('🔴 선언·구현이 양방향 전수 일치한다 (한쪽만 있으면 죽은 도구다)', () => {
  const { declared, cases } = extract();
  const d = new Set(declared);
  const c = new Set(cases);
  assert.deepEqual(declared.filter((x) => !c.has(x)), [], '선언만 있고 runTool case 가 없다 — 부르면 "알 수 없는 도구"');
  assert.deepEqual(cases.filter((x) => !d.has(x)), [], '구현만 있고 선언이 없다 — 모델이 존재를 몰라 영영 안 부른다');
  // 🔴 탐지기 생존: 목록이 통째로 비면(추출 패턴이 낡으면) "0 vs 0 일치" 가 통과로 보인다
  assert.ok(declared.length >= 10, `선언 추출이 ${declared.length}개뿐 — 패턴이 낡았거나 도구가 사라졌다`);
  assert.ok(new Set(declared).size === declared.length, '선언에 중복 이름이 있다');
});

test('돈이 걸린 도구(propose 계열)는 decideTools 안내에도 있어야 한다 — 안내 없는 도구는 잘 안 불린다', () => {
  // 안내 블록: decideTools 의 지침 문자열들. propose 계열만 강제한다(전 도구 강제는 과함 —
  // 안내는 soft 층이고, 돈 도구만 "언제 부르는지" 가 반드시 적혀 있어야 한다)
  const { declared } = extract();
  for (const name of declared.filter((n) => n.startsWith('propose_'))) {
    assert.ok(src.includes(`${name}`) && src.split(name).length >= 3,
      `${name} 이 선언 외 다른 곳(안내/구현)에 등장하지 않는다 — 모델이 언제 쓸지 모른다`);
  }
});
