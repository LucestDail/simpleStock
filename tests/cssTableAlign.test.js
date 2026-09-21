const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 표 정렬 특이도 가드 (2026-09-21)
 *
 * ## 왜 있나
 *
 * 사용자: *"수량 평단, 평가손익 금일 변동치가 각 항목과 위치가 안맞는데"*
 * 원인은 데이터가 아니라 **CSS 특이도**였다:
 * ```
 * .holdings th { text-align: left; }   ← (0,1,1)
 * .ta-r        { text-align: right; }  ← (0,1,0)  **진다**
 * ```
 * `<th class="ta-r">` 라고 적어도 헤더만 왼쪽에 남아 **데이터가 밀린 것처럼** 보인다.
 * ★ 증상과 원인이 **반대편**이라 데이터 쪽 정렬을 아무리 고쳐도 안 맞는다.
 *
 * 그리고 **같은 날 내가 새 표(`.rtable`)에 같은 버그를 또 넣었다.**
 * ⇒ *"한 곳 고치면 저장소 전체를 스캔"* 의 CSS 판본을 자동화한다.
 *
 * ## 무엇을 검사하나
 *
 * `<X> th { … text-align … }` 규칙이 있는 표에서, 템플릿의 `<th class="c">` 에 쓰인
 * 클래스 `c` 가 **정렬 유틸**이면(스타일 어딘가에서 `text-align` 을 준다)
 * `<X> th.c` 로 **명시적으로 이기는 규칙**이 있어야 한다.
 *
 * 🔴 **대상이 0건이면 실패한다** — 패턴이 안 잡히는데 통과하면 "검사 안 한 것" 이
 *    "통과한 것" 으로 보인다(이 워크스페이스가 여러 번 밟은 실패 모드).
 */

const ROOT = path.join(__dirname, '..', 'frontend', 'src');

function vueFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...vueFiles(p));
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

/** `<style>` 블록만 뽑는다 — 템플릿의 문자열을 CSS 로 읽지 않으려고 */
function styleOf(src) {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let s = '';
  let hit;
  while ((hit = m.exec(src))) s += hit[1];
  // 🔴 주석을 먼저 지운다 — 설명문 안의 CSS 예시를 규칙으로 읽으면 오탐이다
  //    (이 파일 위쪽 주석에도 `.holdings th { text-align: left; }` 예시가 있다)
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

function templateOf(src) {
  const m = /<template>([\s\S]*)<\/template>/;
  return m.exec(src)?.[1] || '';
}

test('표 헤더 정렬 유틸이 `X th` 규칙에 지지 않는다', () => {
  const files = vueFiles(ROOT);
  assert.ok(files.length >= 3, `.vue 파일을 못 찾았다(${files.length}) — 경로가 바뀌었나?`);

  let scanned = 0;
  const problems = [];

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const css = styleOf(src);
    const tpl = templateOf(src);

    // ① `<선택자> th { … text-align … }` 를 가진 표를 찾는다
    const thRules = [...css.matchAll(/(^|\s)(\.[\w-]+)\s+th\s*\{([^}]*)\}/g)]
      .filter((m) => /text-align/.test(m[3]))
      .map((m) => m[2]);
    if (!thRules.length) continue;

    /**
     * ② `<th class>` 를 **그 표 안에서만** 모은다.
     * ⚠️ 첫 판은 파일 전체의 `<th class>` 를 모아 `.holdings th` 와 `.rtable__r` 를 짝지어
     *    **오탐 3건**을 냈다. 가드가 오탐하면 있으나 마나가 아니라 **해롭다**(다음 사람이 끈다).
     */
    function thClassesOf(tableClass) {
      const open = new RegExp(`<table[^>]*\\bclass="[^"]*\\b${tableClass}\\b[^"]*"[\\s\\S]*?<\\/table>`, 'g');
      const found = new Set();
      for (const block of tpl.match(open) || []) {
        for (const m of block.matchAll(/<th\b[^>]*\bclass="([^"]+)"/g)) {
          for (const c of m[1].split(/\s+/)) if (c) found.add(c);
        }
      }
      return found;
    }

    for (const sel of thRules) {
      for (const cls of thClassesOf(sel.slice(1))) {
        // 그 클래스가 **정렬 유틸**인가 — 어딘가에서 text-align 을 주는가
        const util = new RegExp(`\\.${cls}\\b[^{]*\\{[^}]*text-align`);
        if (!util.test(css)) continue;
        scanned += 1;
        // ③ `sel th.cls` 로 이기는 규칙이 있어야 한다
        const beats = new RegExp(`\\${sel}\\s+th\\.${cls}\\b`);
        if (!beats.test(css)) {
          problems.push(
            `${path.relative(ROOT, f)}: \`${sel} th\` 가 \`.${cls}\` 를 이긴다 — ` +
              `\`${sel} th.${cls}\` 로 명시하라(헤더만 반대쪽에 붙는다)`
          );
        }
      }
    }
  }

  // 🔴 검사 대상이 0건이면 통과가 아니라 실패다
  assert.ok(scanned > 0, '검사한 (표 × 정렬유틸) 조합이 0건이다 — 자가 헛돌고 있다');
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});
