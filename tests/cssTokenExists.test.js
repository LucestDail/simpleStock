const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **없는 토큰은 조용히 무효가 된다** — 2026-10-02 실측
 *
 * 보유 표 행을 조이려고 `padding: var(--space-2xs)` 를 썼는데 그런 토큰은 **없었다**
 * (`--space-xxs` 가 맞다). CSS 는 **에러를 내지 않고 그 선언만 버린다** —
 * 빌드도 통과하고 테스트도 통과하는데 **화면만 안 바뀐다.**
 *
 * ★ 이 저장소가 반복해 배운 *"검사 안 한 것을 통과로 보여주지 않는다"* 의 CSS 판이다.
 *   오타 하나가 **조용한 무동작**으로 남고, 다음 사람은 "왜 안 먹지" 를 처음부터 디버깅한다.
 *
 * ⚠️ **폴백이 있으면 봐준다** — `var(--x, 12px)` 는 토큰이 없어도 동작한다(의도적 방어).
 */

const ROOT = path.join(__dirname, '..', 'frontend/src');

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.(vue|css)$/.test(f.name)) out.push(p);
  }
  return out;
}

test('🔴 쓰는 CSS 변수는 전부 정의돼 있다 (없으면 선언이 조용히 버려진다)', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'styles/tokens.css'), 'utf8');
  const defined = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  assert.ok(defined.size > 40, `토큰을 ${defined.size}개만 읽었다 — 파일을 못 읽었을 수 있다(통과 아님)`);

  const files = walk(ROOT);
  assert.ok(files.length >= 5, `대상 파일이 ${files.length}개뿐 — 경로가 틀렸다`);

  const missing = [];
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // ⚠️ 폴백이 있는 것(`var(--x, …)`)은 토큰이 없어도 동작한다 — 봐준다
    for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)) {
      checked += 1;
      if (m[2] === ',') continue;
      // 자기 파일에서 정의한 지역 변수도 유효하다
      if (new RegExp(`${m[1]}\\s*:`).test(src)) continue;
      if (!defined.has(m[1])) missing.push(`${path.relative(ROOT, f)}: ${m[1]}`);
    }
  }
  assert.ok(checked > 100, `검사한 var() 가 ${checked}개뿐 — 이 자가 거의 아무것도 안 봤다`);
  assert.deepEqual(
    [...new Set(missing)], [],
    `없는 토큰을 쓴다(선언이 조용히 버려진다): ${[...new Set(missing)].join(', ')}`
  );
});

/** 🔴 자가 진짜 잡는지 — 없는 토큰을 넣으면 반드시 걸려야 한다(생존 확인) */
test('🔴 탐지기 생존 — 없는 토큰을 넣으면 잡는다', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'styles/tokens.css'), 'utf8');
  const defined = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  const fake = 'color: var(--space-2xs);';
  const hit = [...fake.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)]
    .filter((m) => m[2] === ')' && !defined.has(m[1]));
  assert.equal(hit.length, 1, '실제로 없는 토큰(--space-2xs)을 탐지기가 못 잡는다');
  // 폴백이 있으면 안 잡아야 한다(오탐 축)
  const ok = [...'color: var(--nope, 12px);'.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)]
    .filter((m) => m[2] === ')' && !defined.has(m[1]));
  assert.equal(ok.length, 0, '폴백이 있는데 잡았다 — 오탐하면 다음 사람이 이 가드를 끈다');
});
