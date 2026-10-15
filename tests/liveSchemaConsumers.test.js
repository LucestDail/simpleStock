'use strict';

/**
 * 화면이 **라이브 스키마에 없는 필드**를 읽지 않는다 — 2026-10-15 신설
 *
 * 🔴 **왜 생겼나.** 2026-10-12 에 주문 집행을 걷어내며 `proposals` 를 **백테스트 전용**으로
 *    옮겼다. 라이브 보고서에는 그 칸이 **없다.** 그런데 화면 두 곳이 그대로 읽고 있었고,
 *    둘 다 **`?? 0` / `Array.isArray(...) ? ... : 0`** 으로 메워서 **항상 0** 을 보여줬다:
 *
 *      ① 의사결정 파이프라인 ⑤단계 — 라벨은 10-12 에 *"서술이 채워진 종목"* 으로 바꿔 놓고
 *         값은 `report.proposals?.length ?? 0` 이었다. 모델이 7종목을 **전부 서술한 회차**에도
 *         화면에 *"종목 판단 0"* 이 떴다.
 *      ② 운영 규칙 화면의 "분석 실행" 결과 — `제안 0건` 이 **매번** 떴다.
 *
 * ★ **라벨만 고치고 값을 안 고치면 거짓이 더 그럴듯해진다** — 숫자가 그대로라 아무도 안 본다.
 *   이 저장소가 반복해 밟는 *"형제 중 하나만 고쳐짐"* 의 화면판이고, 2026-10-15 하루에
 *   **본문 조립 사본 → 파이프라인 ⑤ → 분석 실행 메시지** 로 세 번 나왔다.
 *
 * ★ **잡아낸 것은 테스트가 아니라 스크린샷이었다.** 번들에 문자열이 있는지, 바인딩이
 *   선언됐는지는 전부 초록이었다 — *"0 이 떠 있다"* 는 **화면을 봐야** 보인다. 그래서
 *   이 자를 만든다(사람이 매번 스크린샷을 읽을 수는 없다).
 *
 * ⚠️ **`?? 0` 자체를 금지하지 않는다** — 정당한 쓰임이 훨씬 많다. 금지하는 것은
 *    **라이브에 없는 칸**을 읽는 것이다. 없는 칸은 0 이 아니라 **"못 쟀다"** 여야 한다.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'frontend', 'src');

/**
 * 라이브 보고서·응답에서 **사라진** 칸들. 2026-10-12(주문 제거)·10-14(보고서 재정의)에
 * 스키마에서 빠졌고, 라이브 응답에 **존재하지 않는다**.
 * ⚠️ `entry`·`stop`·`target` 은 일반 낱말이라(`e.target` 등) 넣지 않는다 — 오탐이 나면
 *    다음 사람이 이 자를 꺼 버린다. 그 축은 `promptSchemaContract` 가 스키마 쪽에서 잡는다.
 */
const GONE_FIELDS = ['proposals', 'stance', 'created', 'rejected'];

/**
 * 면제 — **이유 없는 면제는 곧 구멍**이다. 각 항목은 아래 ③에서 *"면제 없이 보면 실제로
 * 걸리는가"* 를 검사받는다(장식 면제는 그 자리에서 드러난다).
 */
const EXEMPT = new Map([
  /**
   * 🔴 **지금은 비어 있다 — 그리고 그것이 맞다.**
   *    처음에 `views/BacktestView.vue` 를 *"백테스트는 proposals 를 쓴다"* 며 넣었는데,
   *    아래 ③축이 **그 파일이 `.proposals` 를 한 번도 안 읽는다**고 바로 잡았다.
   *    추측으로 넣은 장식 면제였다(2026-10-14 에 같은 실수로 면제 7개 중 6개를 지웠고
   *    하루 만에 또 했다).
   * ⇒ **면제는 실제로 걸렸을 때 이유와 함께 추가한다.** 미리 깔아 두지 않는다 —
   *    미리 깐 면제는 나중에 진짜 위반이 생겨도 조용히 봐준다.
   */
]);

/** 주석을 지운 소스 — 🔴 grep 이 주석을 코드로 읽는 사고를 2026-10-14 하루에 네 번 밟았다 */
function codeOf(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ')      // Vue 템플릿 주석(여러 줄)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // 블록 주석
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

function vueFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(vue|js)$/.test(e.name)) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

/** 한 파일이 읽는 사라진 칸 목록 */
function goneHitsIn(file) {
  const code = codeOf(file);
  return GONE_FIELDS.filter((f) => new RegExp(`\\.${f}\\b`).test(code));
}

// ── ① 전수 ─────────────────────────────────────────────────────────────────
test('① 화면이 라이브에 없는 칸을 읽지 않는다', () => {
  const files = vueFiles();
  // 자 생존: 대상이 실제로 모였는지 — 0개면 아래 전부가 공허하게 통과한다
  assert.ok(files.length >= 20, `검사 대상이 ${files.length}개뿐 — 수집이 깨졌다`);

  const bad = [];
  for (const f of files) {
    const name = rel(f);
    if (EXEMPT.has(name)) continue;
    const hits = goneHitsIn(f);
    if (hits.length) bad.push(`${name}: ${hits.join(', ')}`);
  }
  assert.deepStrictEqual(
    bad, [],
    '라이브에 없는 칸을 읽는다 — 폴백 때문에 **항상 0** 이 화면에 뜬다:\n  ' + bad.join('\n  '),
  );
});

// ── ② 거꾸로 계정 ──────────────────────────────────────────────────────────
test('② 면제 목록이 실재하는 파일만 가리킨다', () => {
  /**
   * 🔴 파일을 옮기거나 지우면 면제가 **조용히 무의미**해지고, 나중에 같은 이름의 파일이
   *    생기면 **이유 없이 봐준다**. 2026-10-14 에 내가 둔 면제 7개 중 6개가 장식이었다.
   */
  for (const [name] of EXEMPT) {
    assert.ok(
      fs.existsSync(path.join(SRC, name)),
      `면제에 적힌 ${name} 가 없다 — 옮겼으면 면제도 함께 고친다`,
    );
  }
});

// ── ③ 면제가 **지탱하는가** ────────────────────────────────────────────────
test('③ 면제를 빼고 보면 실제로 걸린다 (장식 면제가 아니다)', () => {
  /**
   * 🔴 *"존재하는가"* 가 아니라 *"면제 없이 보면 걸리는가"* 를 묻는다. 아무것도 안 걸리는
   *    파일을 면제해 두면 통과하지만, **나중에 그 파일에 진짜 위반이 생겨도 조용히 봐준다.**
   */
  for (const [name, why] of EXEMPT) {
    const hits = goneHitsIn(path.join(SRC, name));
    assert.ok(
      hits.length > 0,
      `${name} 면제가 장식이다(아무것도 안 걸린다) — 지워라. 적힌 이유: ${why}`,
    );
  }
});

// ── ④ 자 생존 ──────────────────────────────────────────────────────────────
test('④ 이 자가 살아 있다 — 심은 양성을 잡는다', () => {
  /**
   * 🔴 ①이 "0건" 을 내는 것이 *"위반이 없다"* 인지 *"자가 죽었다"* 인지 가른다.
   *    2026-10-15 아침에 번들 검사를 **엉뚱한 경로**로 돌려 새 문구도 0, 옛 문구도 0 이
   *    나온 적이 있다 — 한 방향만 봤으면 "통과" 로 읽었을 것이다.
   */
  const tmp = path.join(require('node:os').tmpdir(), `gone-probe-${process.pid}.vue`);
  fs.writeFileSync(tmp, '<template><b>{{ report.proposals?.length ?? 0 }}</b></template>', 'utf8');
  try {
    assert.deepStrictEqual(goneHitsIn(tmp), ['proposals'], '심은 양성을 못 잡는다');
    // 주석 안에 있으면 잡지 않는다(오탐 축)
    fs.writeFileSync(tmp, '<template><!-- 종전 report.proposals 였다 --><b>ok</b></template>', 'utf8');
    assert.deepStrictEqual(goneHitsIn(tmp), [], '주석을 코드로 읽는다 — 오탐이면 다음 사람이 자를 끈다');
  } finally {
    fs.unlinkSync(tmp);
  }
});
