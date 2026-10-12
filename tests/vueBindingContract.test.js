/**
 * Vue SFC 계약 — **템플릿이 부르는 것이 스크립트에 실재하는가** (2026-10-12 신설)
 *
 * ## 왜 생겼나
 *
 * 리스크 화면을 포트폴리오에 합치는 동안 **같은 종류의 사고를 두 번** 냈고,
 * `npm run build` 는 **두 번 다 통과했다**:
 *
 *   ① 정규식으로 CSS 규칙을 지우다 `</script>` 와 `<style scoped>` 를 **함께 먹었다**
 *      → 파일이 747줄에서 373줄로 줄었는데 빌드는 *"missing end tag"* 라는
 *        **엉뚱한 줄 번호**를 가리켰다(진짜 원인은 블록이 사라진 것).
 *   ② 블록을 되살리다 스크립트 123줄을 빠뜨렸다 → `money`·`gauges`·`metrics` 가 **없는 채로
 *      빌드 성공**. Vue 는 템플릿의 바인딩이 실재하는지 **빌드 시점에 보지 않는다**
 *      (런타임에 `undefined` 로 조용히 비거나 `router is not defined` 로 터진다).
 *
 * ★ 둘 다 **화면을 열어 봐야만** 드러나는데, 열어 보는 것은 사람이다.
 *   ⇒ 이 저장소가 반복해 적어 둔 *"코드가 있다 ≠ 그 경로가 실제로 그렇게 돈다"* 의
 *     프런트엔드판이고, 자가 없으면 **다음 통합에서 그대로 재발한다**.
 *
 * ## 무엇을 재는가 (셋)
 *
 *   ① **SFC 블록 구조** — 열 0 의 `<template>`/`<script setup>`/`<style scoped>` 가 각 1개
 *      ⚠️ **들여쓴 `</template>` 을 같이 세면 안 된다** — Vue 의 `<template v-else-if>` 가
 *         닫을 때 쓰는 것이라 **정상인 파일이 위반으로 찍힌다**(실제로 내 첫 검사가 그랬다).
 *   ② **스타일 중괄호 균형** — 규칙을 지우다 `}` 를 하나 더 먹으면 postcss 가 **다른 파일의
 *      다른 줄**을 가리켜 원인이 가려진다.
 *   ③ **템플릿 바인딩** — 템플릿 식(式)의 최상위 식별자가 스크립트에 실재하는가.
 *
 * ## ⚠️ 오탐이 나면 이 가드는 꺼진다 — 그래서 좁게 판정한다
 *
 * 템플릿 식에서 **최상위 식별자만** 본다. 다음은 대상이 아니다:
 *   · 점 뒤 속성(`summary.profit.krw` 의 `profit`·`krw`) — 런타임 객체 모양이라 여기서 못 센다
 *   · `v-for` 가 그 자리에서 만드는 변수(`h`, `idx`)
 *   · 전역(`Math`·`Number`·`JSON`…)과 문자열 리터럴 안의 낱말
 *   · `$`로 시작하는 Vue 내장(`$event`)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'frontend', 'src');

/** `.vue` 전수 — 디렉토리를 옮겨도 자동으로 따라온다 */
function listVue(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listVue(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

const GLOBALS = new Set([
  'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Date', 'Intl',
  'RegExp', 'Map', 'Set', 'Promise', 'console', 'window', 'document', 'isNaN',
  'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'true', 'false', 'null', 'undefined', 'in', 'of', 'typeof', 'new', 'return',
  'if', 'else', 'void', 'delete', 'instanceof', 'await',
]);

/** 문자열 리터럴을 **먼저 지운다** — 그 안의 낱말을 식별자로 읽으면 오탐이 쏟아진다 */
function stripStrings(expr) {
  return expr.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
}

function templateIdentifiers(tpl) {
  const ids = new Set();
  // `{{ … }}` 와 바인딩 속성(`:x`, `v-if`, `@click` …) 의 식
  const re = /\{\{([\s\S]*?)\}\}|(?:v-if|v-else-if|v-for|v-show|v-model|v-html|v-text|:[\w.[\]-]+|@[\w.]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tpl))) {
    const raw = stripStrings(m[1] || m[2] || '');
    /**
     * `a.b` 의 `b` 와 객체 키(`{ x: … }` 의 `x`) 는 빼고 **최상위**만.
     *
     * 🔴 **첫 판은 `([A-Za-z_$][\w$]*)(?!\s*:)` 였고 자가 거짓말했다.** 정규식은
     *    *"뒤에 `:` 가 오면 안 된다"* 를 만족시키려고 **한 글자 뒤로 물러서서** 매칭한다
     *    (`stroke:` → **`strok`**). 그래서 `strok`·`widt`·`mont`·`symbo` 같은
     *    **존재하지 않는 이름**이 위반으로 쏟아졌다 — 자가 재려던 것을 안 재고
     *    자기가 만든 유령을 세고 있었다.
     * ⇒ 식별자를 **끝까지 먼저 잡고**(`\b` 경계) 그 다음에 `:` 여부로 버린다.
     */
    const idre = /(?<![.\w$])([A-Za-z_$][\w$]*)\b/g;
    let t;
    while ((t = idre.exec(raw))) {
      const rest = raw.slice(t.index + t[1].length);
      if (/^\s*:/.test(rest)) continue; // 객체 키
      ids.add(t[1]);
    }
  }
  return ids;
}

function scriptDefinitions(sc) {
  const d = new Set();
  for (const m of sc.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
  // 구조분해: const { a, b: c } = …
  for (const m of sc.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.includes(':') ? part.split(':')[1] : part;
      const id = name.trim().replace(/\s*=.*$/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(id)) d.add(id);
    }
  }
  for (const m of sc.matchAll(/import\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1]);
  for (const m of sc.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.includes(' as ') ? part.split(' as ')[1] : part;
      const id = name.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) d.add(id);
    }
  }
  /**
   * `defineProps({ a: …, b: … })` — props 는 템플릿에서 그대로 쓴다.
   * ⚠️ **첫 판은 `\n\}\)` 로 끝을 잡아 한 줄짜리 선언을 통째로 놓쳤다**
   *    (`NewsPanel.vue` 가 실제로 한 줄이라 멀쩡한 props 2개가 위반으로 찍혔다).
   *    ⇒ 괄호를 **세어서** 끝을 찾는다. 줄바꿈 모양에 기대지 않는다.
   */
  const dp = sc.indexOf('defineProps(');
  if (dp >= 0) {
    let depth = 0; let end = dp;
    for (let i = dp + 'defineProps'.length; i < sc.length; i += 1) {
      if (sc[i] === '(') depth += 1;
      else if (sc[i] === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    const body = sc.slice(dp, end);
    // `{ a: {...}, b: {...} }` 의 **최상위 키**만 — 중첩(`type:`·`default:`)은 깊이로 거른다
    let lvl = 0;
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === '{') lvl += 1;
      else if (body[i] === '}') lvl -= 1;
      else if (lvl === 1) {
        const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
        if (m && !/[\w$]/.test(body[i - 1] || '')) d.add(m[1]);
      }
    }
  }
  return d;
}

function loopVars(tpl) {
  const v = new Set();
  for (const m of tpl.matchAll(/v-for="\(?\s*([\w$]+)/g)) v.add(m[1]);
  for (const m of tpl.matchAll(/v-for="\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const id = part.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) v.add(id);
    }
  }
  return v;
}

/** 열 0 의 블록 태그만 — 들여쓴 `</template>` 은 `v-else-if` 의 것이다 */
function countBlock(src, tag) {
  return src.split('\n').filter((l) => l === tag).length;
}

const FILES = listVue(SRC);

test('.vue 파일을 실제로 찾았다 — 0건이면 통과가 아니라 실패다', () => {
  // ★ 경로가 바뀌면 조용히 0건이 되고 아래 전부가 **공허하게 통과**한다
  assert.ok(FILES.length >= 10, `.vue 파일이 ${FILES.length}개뿐 — 경로(${SRC})를 확인하라`);
});

test('① SFC 블록 구조 — 편집이 `</script>`·`<style>` 을 먹지 않았는가', () => {
  const bad = [];
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SRC, f);
    if (countBlock(src, '<template>') !== 1) bad.push(`${rel}: <template> ${countBlock(src, '<template>')}개`);
    if (countBlock(src, '</template>') !== 1) bad.push(`${rel}: 열0 </template> ${countBlock(src, '</template>')}개`);
    const hasScript = src.includes('<script setup>') || /\n<script[ >]/.test(src);
    if (hasScript && countBlock(src, '</script>') !== 1) bad.push(`${rel}: </script> ${countBlock(src, '</script>')}개`);
    if (src.includes('<style scoped>') && countBlock(src, '</style>') !== 1) bad.push(`${rel}: </style> 짝 없음`);
  }
  assert.deepEqual(bad, []);
});

test('② 스타일 중괄호 균형 — 규칙을 지우다 `}` 를 먹지 않았는가', () => {
  const bad = [];
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const i = src.indexOf('<style');
    if (i < 0) continue;
    const j = src.lastIndexOf('</style>');
    const css = src.slice(i, j).replace(/\/\*[\s\S]*?\*\//g, ''); // 주석 속 중괄호 제외
    const o = (css.match(/\{/g) || []).length;
    const c = (css.match(/\}/g) || []).length;
    if (o !== c) bad.push(`${path.relative(SRC, f)}: { ${o}개 vs } ${c}개`);
  }
  assert.deepEqual(bad, []);
});

test('③ 템플릿이 부르는 것이 스크립트에 실재한다', () => {
  const bad = [];
  let checked = 0;
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('<script setup>')) continue; // Options API 는 대상 아님(이 저장소엔 없다)
    const tpl = src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>'));
    const sc = src.slice(src.indexOf('<script setup>'), src.lastIndexOf('</script>'));
    const defined = scriptDefinitions(sc);
    const loop = loopVars(tpl);
    checked += 1;
    for (const id of templateIdentifiers(tpl)) {
      if (GLOBALS.has(id) || defined.has(id) || loop.has(id)) continue;
      if (id.startsWith('$')) continue; // $event 등 Vue 내장
      bad.push(`${path.relative(SRC, f)}: \`${id}\` — 템플릿은 부르는데 **스크립트에 없다**`);
    }
  }
  // ★ 대상이 0건이면 "위반 없음" 이 아니라 "안 쟀다"
  assert.ok(checked >= 10, `검사한 SFC 가 ${checked}개뿐 — 탐지가 빠졌다`);
  assert.deepEqual(bad, []);
});

test('④ 자기검증 — 바인딩을 지우면 실제로 잡는다', () => {
  // 가드가 **무엇을 잡는지** 모르면 초록불은 아무 뜻이 없다(이 저장소의 변이 검증 규율)
  const tpl = '<template><p>{{ money(x) }}</p></template>';
  const scOk = '<script setup>\nconst x = 1;\nfunction money(v) { return v; }\n</script>';
  const scBad = '<script setup>\nconst x = 1;\n</script>';
  const ids = templateIdentifiers(tpl);
  assert.ok(ids.has('money') && ids.has('x'), '최상위 식별자를 못 뽑는다');
  assert.ok(scriptDefinitions(scOk).has('money'), '함수 선언을 못 읽는다');
  assert.ok(!scriptDefinitions(scBad).has('money'), '없는 것을 있다고 한다');
});

test('⑤ 오탐 방지 — 흔한 모양을 위반으로 읽지 않는다', () => {
  const sc = `<script setup>
import { ref, computed } from 'vue';
import BenchChart from '../components/BenchChart.vue';
const { a, b: renamed } = useThing();
const list = ref([]);
</script>`;
  const d = scriptDefinitions(sc);
  for (const id of ['ref', 'computed', 'BenchChart', 'a', 'renamed', 'list']) {
    assert.ok(d.has(id), `${id} 를 정의로 못 읽는다 — 이러면 멀쩡한 화면이 빨간불이 된다`);
  }
  // 문자열 안의 낱말은 식별자가 아니다
  const ids = templateIdentifiers(`<template><p :class="'issue--ok'">{{ 'hello' }}</p></template>`);
  assert.ok(!ids.has('issue'), '문자열 속 낱말을 식별자로 읽는다');
  // 객체 키도 아니다
  const ids2 = templateIdentifiers(`<template><p :class="{ down: over }">x</p></template>`);
  assert.ok(ids2.has('over') && !ids2.has('down'), '객체 키를 식별자로 읽는다');
});
