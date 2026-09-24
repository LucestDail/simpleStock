/**
 * 시나리오 시뮬레이터 — 결정층(코드) 전수 (2026-09-24, 사용자 지시)
 *
 * "나스닥/코스닥 시점별 모의 가상 케이스" 를 국면 데몬에 넣어 **어떤 매뉴얼이 발동하고
 * 프롬프트에 무엇이 실리는지** 를 표로 낸다. 전부 순수 함수 — LLM 0 · 네트워크 0 · 부작용 0.
 *
 * 사용법: node verify/scenario-sim.js          (매트릭스 표)
 *        node verify/scenario-sim.js --case 7  (그 케이스의 실제 프롬프트 절 전문)
 */
const regime = require('../server/regimeService');

const ramp = (start, step, n) => Array.from({ length: n }, (_, i) => start + step * i);
/** 마지막 봉에 당일 등락을 심는다 */
const withToday = (closes, pct) => [...closes, closes[closes.length - 1] * (1 + pct / 100)];

// 시장 모양 합성기 — 나스닥(QQQ 대용)·코스닥 공용
const SHAPES = {
  '상승추세': () => ramp(100, 0.8, 70),
  '횡보(반등초입)': () => [...Array(50).fill(120), ...Array(20).fill(100), 101].flat(),
  '하락추세': () => ramp(170, -0.9, 70),
  '급락(-4%)': () => withToday(ramp(100, 0.3, 69), -4),
  '하락중 급락(-5%)': () => withToday(ramp(170, -0.8, 69), -5),
};

const CASES = [
  // [나스닥 모양, 코스닥 모양, VIX, 설명]
  ['상승추세', '상승추세', 14, '양시장 순항'],
  ['상승추세', '횡보(반등초입)', 14, '미장 순항 · 국장 횡보 (오늘 실제와 유사)'],
  ['횡보(반등초입)', '횡보(반등초입)', 17, '양시장 방향 없음'],
  ['하락추세', '상승추세', 18, '미장 하락 · 국장 상승 (디커플링)'],
  ['하락추세', '하락추세', 22, '양시장 하락 + 공포 진입(VIX 22)'],
  ['급락(-4%)', '횡보(반등초입)', 19, '미장 급락 당일 · VIX 아직 평온'],
  ['급락(-4%)', '하락추세', 27, '미장 급락 + 공포 확대(VIX 27)'],
  ['하락중 급락(-5%)', '하락중 급락(-5%)', 33, '패닉 — 양시장 급락 + 고공포(VIX 33)'],
  ['하락중 급락(-5%)', '하락추세', 38, '극단 공포(VIX 38)'],
  ['상승추세', '상승추세', 21, '상승장인데 VIX 만 20 돌파 (경계 케이스)'],
];

function run() {
  const caseIdx = process.argv.indexOf('--case');
  const only = caseIdx > 0 ? Number(process.argv[caseIdx + 1]) : null;

  console.log('# 시나리오 → 발동 매뉴얼 매트릭스 (판정은 전부 산수 — 같은 입력 = 같은 결과)\n');
  CASES.forEach(([us, kr, vix, desc], i) => {
    const state = regime.compute({
      us: { closes: SHAPES[us]() },
      kr: { closes: SHAPES[kr]() },
      vix,
    });
    const scenarios = regime.matchScenarios(state, regime.readPlaybook());
    const fmt = (m) => `${regime.TREND_KO[m.trend] || '판정불가'}${m.shock ? '·🔴급락' : ''}(${m.dayPct}%)`;
    console.log(`[${i}] ${desc}`);
    console.log(`    입력: 나스닥 ${us} · 코스닥 ${kr} · VIX ${vix}`);
    console.log(`    판정: US ${fmt(state.us)} · KR ${fmt(state.kr)} · VIX 밴드 ${state.vix.band}`);
    console.log(`    발동: ${scenarios.length ? scenarios.map((s) => s.name).join(' + ') : '(없음 — 기본 성향)'}`);
    if (only === i) {
      console.log('\n──── 이 케이스가 분석 프롬프트에 싣는 절(전문) ────');
      console.log(regime.promptSection(state, scenarios));
    }
    console.log('');
  });
}

run();
