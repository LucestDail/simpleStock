/**
 * 10단계 시장 스펙트럼 × 매수 포트폴리오 (2026-09-24, 사용자 지시)
 *
 * 폭등/상승/보합/횡보/약하락/하방압력/하락/폭락/공포/붕괴 — 각 시나리오에서
 * 에이전트가 어떤 포트폴리오를 제시하는지 확인한다.
 *
 * ⚠️ 지난 시뮬의 한계 교정: 국면은 합성인데 후보 시세가 실데이터면 세계가 어긋난다
 *    (하락장 가정인데 인버스가 실제론 약세). 이번엔 **후보 추세도 시나리오에 정합**하게 합성.
 * 🔴 부작용 0 — generateStructuredOutput 만. 제안 등록·발송 없음.
 */
const regime = require('/app/server/regimeService');
const analyst = require('/app/server/analystService');
const { generateStructuredOutput } = require('/app/server/aiService');

const ramp = (s, st, n) => Array.from({ length: n }, (_, i) => s + st * i);
const withToday = (c, pct) => [...c, c[c.length - 1] * (1 + pct / 100)];

/** 카테고리 대표 8종 — 시나리오별로 "추세 위(↑)/아래(↓)" 를 성격에 맞게 배치 */
const UNIVERSE = [
  ['QQQ', '기술 광범위 1x'], ['SOXX', '반도체 1x'], ['SCHD', '배당 1x'],
  ['XLP', '생필품 1x'], ['XLV', '헬스케어 1x'], ['TLT', '채권 1x'], ['GLD', '금 1x'], ['PSQ', '나스닥 인버스 -1x'],
];
/** up=공격 우위 · mixed=방어 우위 · riskoff=방어+인버스만 추세 위 */
const POSTURE = {
  up:      { QQQ: '↑', SOXX: '↑', SCHD: '↑', XLP: '→', XLV: '→', TLT: '↓', GLD: '→', PSQ: '↓' },
  flat:    { QQQ: '→', SOXX: '→', SCHD: '↑', XLP: '↑', XLV: '↑', TLT: '→', GLD: '↑', PSQ: '↓' },
  riskoff: { QQQ: '↓', SOXX: '↓', SCHD: '↓', XLP: '↑', XLV: '↑', TLT: '↑', GLD: '↑', PSQ: '↑' },
};
const MARK = { '↑': '종가>20일선>60일선 (추세 선)', '→': '20일선 부근 횡보', '↓': '종가<20일선<60일선 (추세 붕괴)' };

const CASES = [
  ['폭등',     'up',      () => withToday(ramp(100, 0.8, 69), +4.5), 12, 'up'],
  ['상승',     'up',      () => ramp(100, 0.8, 70),                 14, 'up'],
  ['보합',     'side',    () => [...Array(60).fill(110), ...Array(10).fill(110)], 15, 'flat'],
  ['횡보',     'side',    () => [...Array(50).fill(120), ...Array(20).fill(100), 101], 17, 'flat'],
  ['약하락',   'side',    () => withToday([...Array(50).fill(120), ...Array(19).fill(100)], -1.2), 19, 'flat'],
  ['하방압력', 'down',    () => ramp(130, -0.35, 70),               21, 'riskoff'],
  ['하락',     'down',    () => ramp(170, -0.9, 70),                24, 'riskoff'],
  ['폭락',     'down',    () => withToday(ramp(170, -0.9, 69), -4.5), 28, 'riskoff'],
  ['공포',     'down',    () => withToday(ramp(170, -1.1, 69), -6.5), 33, 'riskoff'],
  ['붕괴',     'down',    () => withToday(ramp(170, -1.4, 69), -9.5), 45, 'riskoff'],
];

const SCHEMA = {
  type: 'object',
  properties: {
    oneLiner: { type: 'string', description: '이 국면 진단 한 문장' },
    cashPct: { type: 'number', description: '현금으로 남길 비율 %' },
    portfolio: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' }, pct: { type: 'number', description: '배분 %' },
          reason: { type: 'string', description: '1문장, 후보 절 숫자 인용' },
        },
        required: ['symbol', 'pct', 'reason'],
      },
    },
  },
  required: ['oneLiner', 'cashPct', 'portfolio'],
};

(async () => {
  for (const [label, , mk, vix, posture] of CASES) {
    const closes = mk();
    const state = regime.compute({ us: { closes }, kr: { closes }, vix });
    const scenarios = regime.matchScenarios(state, regime.readPlaybook());
    const sec = regime.promptSection(state, scenarios);
    const candidates = [
      '## 매수 후보 기술 위치 (이 시나리오 세계의 합성 데이터)',
      ...UNIVERSE.map(([sym, desc]) => `- ${sym}(${desc}): ${MARK[POSTURE[posture][sym]]}`),
    ].join('\n');

    const out = await generateStructuredOutput({
      systemPrompt: analyst.SYSTEM_PROMPT,
      userPrompt: [
        `[가상 시나리오: ${label}] 현금 $10,000 · 기존 보유 없음(신규 구성).`,
        '', sec, '', candidates, '',
        '이 국면에서 매수 포트폴리오를 구성하라 — 발동 매뉴얼과 후보 추세 안에서.',
        '🔴 티커는 위 후보 8종에서만 고른다(다른 티커 금지 — KR 종목은 원화가 없어 못 산다. 현금은 USD).',
        '🔴 pct 는 숫자(예: 25). VIX 단계 금액: 20+=현금의 10% · 25+=20% · 30+=30% · 35+=40% — 현재 VIX 가 어느 구간인지 정확히 적용하라.',
        '매수할 것이 없으면 portfolio 를 비우고 cashPct 100 이 정답이다(억지로 채우지 마라).',
        '⚠️ 길이: oneLiner 1문장 · reason 각 1문장(60자 이내) · 항목 최대 5개. 길면 잘려서 통째로 버려진다.',
      ].join('\n'),
      schema: SCHEMA, logLabel: 'spectrum_sim', maxOutputTokens: 1200,
    }, { oneLiner: '', cashPct: null, portfolio: [] });

    const port = Array.isArray(out.portfolio) ? out.portfolio : (out.portfolio ? [out.portfolio] : []);
    const pctOf = (p) => p.pct ?? p.percent ?? p.allocation ?? p.weight ?? '?';
    const rows = port.map((p) => `${p.symbol} ${pctOf(p)}%`).join(' · ') || '(매수 없음)';
    console.log(`\n■ ${label} (VIX ${vix} · 발동: ${scenarios.map((s) => s.name.split(' ')[0]).join('+') || '없음'})`);
    console.log(`  ${String(out.oneLiner).slice(0, 90)}`);
    console.log(`  💼 ${rows} · 현금 ${out.cashPct}%`);
    for (const p of port.slice(0, 5)) console.log(`     - ${p.symbol} ${pctOf(p)}%: ${String(p.reason).slice(0, 80)}`);
  }
})();
