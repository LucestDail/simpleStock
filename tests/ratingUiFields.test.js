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
