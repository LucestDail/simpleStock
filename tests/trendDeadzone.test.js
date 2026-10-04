/**
 * 추세 분리 마진 (2026-10-04) — "추세는 이동평균이 벌어져야 추세다."
 * 근거: chop 백테스트 판정 6지점 중 4지점이 노이즈 순간 정렬로 가짜 up/down →
 * 플레이북 추세 시나리오 발동 → 로테이션 손실(-5.3%/-7.4%).
 * ε=1% 스윕(고정 시드 4세계): chop 전 지점 side · vshape/bull/bear 라벨 변화 0.
 */
const test = require('node:test');
const assert = require('node:assert');
const regime = require('../server/regimeService');

/** last 가 배열 끝값이 되게 70개 종가를 만든다 */
const closesEndingAt = (m60, m20, last) => {
  // 앞 40개 = m60 수준 보정값, 뒤 20개 = m20 평균이 정확히 m20 이 되게, 마지막은 last
  const head = Array.from({ length: 50 }, () => (m60 * 60 - m20 * 20) / 40);
  const tail = Array.from({ length: 19 }, () => (m20 * 20 - last) / 19);
  return [...head, ...tail, last];
};

test('마진 안의 순간 정렬은 side — 종전엔 이것이 가짜 up 이었다', () => {
  // last 100.5 > m20 100.2 > m60 100.0 — 전부 1% 미만 분리
  const st = regime.compute({ us: { closes: closesEndingAt(100.0, 100.2, 100.5) }, vix: 18 });
  assert.strictEqual(st.us.trend, 'side');
});

test('마진 밖의 정렬은 여전히 up/down — 추세장을 건드리지 않는다', () => {
  const up = regime.compute({ us: { closes: closesEndingAt(100, 102, 104) }, vix: 18 });
  assert.strictEqual(up.us.trend, 'up', '2% 분리 상승이 up 이 아니면 데드존이 과하다');
  const down = regime.compute({ us: { closes: closesEndingAt(104, 102, 100) }, vix: 18 });
  assert.strictEqual(down.us.trend, 'down');
});

test('TREND_SEP 이 공개돼 있다 — 하니스·튜닝이 같은 값을 본다', () => {
  assert.ok(regime.TREND_SEP > 0 && regime.TREND_SEP <= 0.02, `이상값: ${regime.TREND_SEP}`);
});
