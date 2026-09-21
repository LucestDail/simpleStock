const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **서버가 주는 서술을 화면이 버리지 않는다** (2026-09-21)
 *
 * ## 왜 있나
 *
 * 서술 파싱을 고쳐 라이브에서 `interpretation` 에 411~655자가 **3/3 회차 다 도착**했는데,
 * 화면은 `oneLiner`·`weaknesses` 만 그려서 **사용자는 여전히 빈 칸을 봤다.**
 * ⚠️ 모델이 한 덩어리로 답하면 `interpretation` 에만 들어오므로 **그 칸이 주된 출력**이다.
 *
 * ★ "수집해 놓고 안 쓰는" 패턴 — 이 저장소에서 **아홉 번째**이고 이번엔 내가 했다.
 *   파서를 고친 커밋과 화면을 고친 커밋이 **갈라져 있으면** 늘 이렇게 된다
 *   ⇒ 둘을 **자로 묶는다**: 서버가 내보내는 서술 필드는 화면이 **전부** 참조해야 한다.
 */

const RATING_PROSE_FIELDS = [
  'oneLiner', 'strengths', 'weaknesses', 'interpretation',
  // "비었다" 와 "안 물어봤다" 를 구분해 보여주는 칸
  'proseSkipped',
];

const VIEW = path.join(__dirname, '..', 'frontend', 'src', 'views', 'WorkspaceView.vue');
const RATING = path.join(__dirname, '..', 'server', 'stockRating.js');

test('🔴 평가 패널이 서술 필드를 **전부** 렌더한다', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  const tpl = /<template>([\s\S]*)<\/template>/.exec(src)?.[1] || '';
  assert.ok(tpl.length > 1000, '템플릿을 못 읽었다 — 경로가 바뀌었나?');

  // 평가 패널(`<details class="rt">`) 안만 본다
  const panel = /<details[^>]*class="rt"[\s\S]*?<\/details>/.exec(tpl)?.[0];
  assert.ok(panel, '🔴 평가 패널을 못 찾았다 — 자가 헛돈다');

  const missing = RATING_PROSE_FIELDS.filter((f) => !panel.includes(`.${f}`));
  assert.deepEqual(missing, [], `\n🔴 화면이 안 그리는 서술 필드: ${missing.join(', ')}\n   서버는 채워 보내는데 사용자는 못 본다.`);
});

/**
 * 🔴 **자의 판별력** — 서버가 그 필드들을 실제로 내보내는가.
 * 안 내보내면 위 테스트는 "없는 것을 그리라" 고 요구하는 셈이라 무의미하다.
 */
test('🔴 자기검증: 서버가 그 서술 필드들을 실제로 내보낸다', () => {
  const src = fs.readFileSync(RATING, 'utf8');
  for (const f of RATING_PROSE_FIELDS) {
    assert.ok(new RegExp(`^\\s*${f}:`, 'm').test(src), `🔴 서버가 ${f} 를 안 내보낸다 — 자가 유령 필드를 지킨다`);
  }
});

/**
 * 🔴 **배열 메서드를 부르는 필드는 반드시 배열이어야 한다** (2026-09-21 — pm2 가 원인을 찾았다)
 *
 * ## 무슨 일이 있었나
 *
 * `unverified` 가 스키마와 달리 **문자열**로 왔다:
 * ```
 * "보수율, 추적오차, AUM, 구성종목 비중은 주어지지 않아 확인할 수 없습니다."
 * ```
 * `out.unverified || [...]` 는 못 막고(빈 문자열이 아니면 truthy), 템플릿의
 * `v-if="…?.length"` 도 **문자열 길이 62** 라 통과시킨 뒤 `.join()` 에서 죽었다.
 *
 * 🔴🔴 **Vue 는 렌더 예외가 나면 서브트리를 통째로 버린다** ⇒ 종목 판단은 물론
 *      **패널 제목까지** 사라졌다. 즉 **평가 기능을 붙인 커밋이 매매 분석 패널을 죽였고**
 *      API 는 내내 200 이라 밖에서는 정상으로 보였다.
 *
 * ★ 기존 가드(`필드를 참조하는가`)로는 **원리상 못 잡는다** — 이번 건은
 *   *"화면이 안 그린다"* 가 아니라 *"화면이 **죽는다**"* 였다. 그래서 자를 하나 더 둔다.
 */
test('🔴 스키마가 array 라고 선언한 필드는 서버가 asList() 로 강제한다', () => {
  const src = fs.readFileSync(RATING, 'utf8');

  /**
   * 🔴 **템플릿 모양에 기대지 않는다.**
   *    첫 판은 템플릿에서 `.join(` 을 찾았는데, 그걸 고치고 나니 **검사 대상이 0건**이 됐다 —
   *    즉 *"고치면 자가 꺼지는"* 자였다. 불변식은 화면이 아니라 **계약(스키마)** 에 있다:
   *    **모델이 채우는 array 필드는 모델이 문자열로 줄 수 있다** ⇒ 반드시 정규화해야 한다.
   */
  const declared = new Set();
  for (const m of src.matchAll(/(\w+):\s*\{\s*type:\s*'array'/g)) declared.add(m[1]);
  assert.ok(declared.size > 0, '🔴 스키마에서 array 필드를 하나도 못 찾았다 — 자가 헛돈다');

  /**
   * 면제 — **이유를 적는다.**
   * `items` 는 모델 값이 아니라 `shapeScores()` 가 **항상 배열로 만들어** 낸다(모양이 코드 소유).
   */
  const EXEMPT = new Map([['items', 'shapeScores() 가 항상 배열을 만든다 — 모델 값이 아니다']]);

  const problems = [];
  let checked = 0;
  for (const f of declared) {
    if (EXEMPT.has(f)) continue;
    checked += 1;
    // 반환 객체에서 그 필드가 `asList(` 를 거치는가. `|| []` 는 **문자열을 못 막는다**
    const lines = [...src.matchAll(new RegExp(`^\\s*${f}:\\s*(.+)$`, 'gm'))].map((m) => m[1]);
    assert.ok(lines.length, `🔴 ${f} 를 반환하는 자리를 못 찾았다`);
    for (const ln of lines) {
      if (/type:\s*'array'/.test(ln)) continue; // 스키마 선언 줄 자체는 건너뛴다
      if (!/asList\(/.test(ln)) problems.push(`.${f} — asList() 없이 내보낸다: ${ln.trim().slice(0, 80)}`);
    }
  }
  assert.ok(checked > 0, `🔴 검사한 필드가 0건이다(면제 ${EXEMPT.size}건) — 자가 헛돈다`);
  assert.deepEqual(problems, [], `\n🔴 문자열로 오면 화면이 **통째로 사라진다**:\n${problems.join('\n')}`);
});

/** 🔴 면제가 장식이 아닌지 — `items` 는 정말 코드가 만드는가 */
test('🔴 면제 검증: items 는 모델 모양과 무관하게 항상 배열이다', () => {
  const { shapeScores, RUBRICS, TYPES } = require('../server/stockRating');
  for (const bad of [null, 'items 가 문자열로 왔습니다', { a: 1 }, 42]) {
    const r = shapeScores(bad, RUBRICS[TYPES.LARGE]);
    assert.ok(Array.isArray(r), `🔴 ${JSON.stringify(bad)} 에서 배열이 아닌 것을 냈다`);
    assert.equal(r.length, 10);
  }
});

/**
 * 🔴 **화면 쪽 방어도 있어야 한다.**
 * 서버만 고치면 **다음에 다른 필드가 같은 모양으로 또 죽인다.** 한 겹 방어는 뚫린다.
 */
test('🔴 목록 렌더는 배열이 아니어도 죽지 않는다 (화면 자체 방어)', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /function listText\(/, '🔴 화면 쪽 방어 헬퍼가 없다');

  // 실제로 안 죽는지 **동작으로** 확인한다(존재만 보면 장식이다)
  const body = /function listText\(v\) \{([\s\S]*?)\n\}/.exec(src)?.[1];
  assert.ok(body, 'listText 본문을 못 읽었다');
  // eslint-disable-next-line no-new-func
  const listText = new Function('v', body);
  assert.equal(listText('문자열로 왔습니다'), '문자열로 왔습니다', '🔴 문자열에서 죽거나 비운다');
  assert.equal(listText(['a', 'b']), 'a / b');
  for (const v of [null, undefined, [], '']) assert.equal(listText(v), '', `${JSON.stringify(v)} 처리 실패`);
});

/** 🔴 렌더 예외를 조용히 버리지 않는다 — 42회가 나도 흔적이 없었다 */
test('🔴 렌더 오류 흔적을 남긴다 (조용히 사라지지 않게)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'main.js'), 'utf8');
  assert.match(main, /errorHandler/, '🔴 렌더 예외가 조용히 버려진다 — 다음 사람이 몇 시간을 쓴다');
  const mounts = (main.match(/createApp\([^)]*\)/g) || []).length;
  const traps = (main.match(/installErrorTrap\(/g) || []).length - 1; // 정의 1회 제외
  assert.ok(traps >= mounts - 1, `🔴 마운트 ${mounts}개 중 ${traps}개만 보호된다 — 빠진 경로에서 또 조용해진다`);
});
