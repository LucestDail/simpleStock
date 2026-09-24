/**
 * 시나리오 시뮬레이터 — 판단층(LLM) 대표 케이스 (2026-09-24)
 *
 * 결정층 매트릭스(scenario-sim.js)에서 고른 대표 상황을 **실제 분석 프롬프트·스키마**
 * (analystService 의 SYSTEM_PROMPT · REPORT_SCHEMA 그대로)로 태워 stances/proposals 가
 * 어떻게 나오는지 본다.
 *
 * 🔴 부작용 0 보장: generateStructuredOutput 만 부른다 — 제안 등록(orderService)·
 *    텔레그램·saveLast 를 **부르지 않는다.** 모델이 proposals 를 반환해도 종이 위 판단일 뿐이다.
 * ⚠️ LLM 비용: 케이스당 1콜(~2,000tok 출력 캡 안).
 */
const regime = require('../server/regimeService');
const analyst = require('../server/analystService');
const { generateStructuredOutput } = require('../server/aiService');

const ramp = (s, st, n) => Array.from({ length: n }, (_, i) => s + st * i);
const withToday = (c, pct) => [...c, c[c.length - 1] * (1 + pct / 100)];

const CASES = [
  {
    id: 'A', name: '오늘 유사 — US 상승·KR 횡보·VIX 14 · 현금 0',
    us: ramp(100, 0.8, 70), kr: [...Array(50).fill(120), ...Array(20).fill(100), 101], vix: 14,
    cash: '현금(매수 가능): 원화 0 · 달러 1.48\n🔴 **현금이 사실상 0 입니다 — 신규 매수 제안을 내지 마세요.** 매도·보유 판단만 하세요.',
  },
  {
    id: 'B', name: '양시장 하락 + VIX 22(공포 1단계) · 현금 $3,000',
    us: ramp(170, -0.9, 70), kr: ramp(170, -0.9, 70), vix: 22,
    cash: '현금(매수 가능): 원화 0 · 달러 3000',
  },
  {
    id: 'C', name: 'US 급락 -4% + VIX 27(공포 2단계) · 현금 $3,000',
    us: withToday(ramp(100, 0.3, 69), -4), kr: ramp(170, -0.9, 70), vix: 27,
    cash: '현금(매수 가능): 원화 0 · 달러 3000',
  },
  {
    id: 'D', name: '상승장 + VIX 21(경계) · 현금 0 — 매수 여력 없음을 인지하는가',
    us: ramp(100, 0.8, 70), kr: ramp(100, 0.8, 70), vix: 21,
    cash: '현금(매수 가능): 원화 0 · 달러 1.48\n🔴 **현금이 사실상 0 입니다 — 신규 매수 제안을 내지 마세요.** 매도·보유 판단만 하세요.',
  },
];

// 실보유 스냅샷(고정) — 케이스 간 비교가 되게 같은 보유로
const HOLDINGS = [
  '## 종목 정체 (증권사 확정 정보 — 이 밖의 정체는 추측 금지)',
  '- QLD — PROSHARES TRUST PSHS ULTRA QQQ · ETF · 🔴 레버리지 2배 — 일일 리밸런싱 상품(횡보 구간에서 가치가 감쇠한다)',
  '- RAM — ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF · ETF · 🔴 레버리지 2배 · 상장 2026-06-24(약 3개월 — 52주 이력이 존재하지 않는다)',
  '',
  '## 사용자 방침 (결정권자의 지시 — 판단보다 우선)',
  '- RAM: 사용자가 **보유 유지**를 정했다(평단 19.08 회복 대기, 16.0 근접 시 매도 검토).',
  '  급락·구조 악화가 아니면 RAM SELL 제안을 반복하지 마라.',
  '- 이행 방침: 레버리지 축소는 **점진** — 기술적 반등 지점에서 분할 매도 제안(즉시 전량 아님).',
  '',
  '## 보유 종목',
  '- QLD(QLD/US) 수량 99 · 평단 71.78 · 현재 95.98 · 평가손익 33.7% · 당일 -0.4% · 20일선 90.6 · 60일선 89.7 · 최근20일 스윙 86.96~97.82',
  '- RAM(RAM/US) 수량 442 · 평단 19.08 · 현재 14.39 · 평가손익 -24.6% · 당일 -1.6% · 20일선 13.08 · 60일선 13.48 · 최근20일 스윙 11.53~15.35 · 일간변동성 10.76%',
].join('\n');

(async () => {
  for (const c of CASES) {
    const state = regime.compute({ us: { closes: c.us }, kr: { closes: c.kr }, vix: c.vix });
    const scenarios = regime.matchScenarios(state, regime.readPlaybook());
    const prompt = [
      `기준 시각: 2026-09-24 (가상 시나리오 시뮬레이션 — 그러나 판단은 실전과 동일 기준으로)`,
      '',
      '## 계좌',
      c.cash,
      '',
      HOLDINGS,
      '',
      regime.promptSection(state, scenarios),
      '',
      '위 데이터로 시장 판단과 (조건이 맞으면) 매매 제안을 내라.',
    ].join('\n');

    const out = await generateStructuredOutput(
      { systemPrompt: analyst.SYSTEM_PROMPT, userPrompt: prompt, schema: analyst.REPORT_SCHEMA, logLabel: 'scenario_sim' },
      { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] }
    );
    const shaped = analyst.shapeReport(out);
    console.log(`\n════ [${c.id}] ${c.name}`);
    console.log(`발동 매뉴얼: ${scenarios.map((s) => s.name).join(' + ') || '(없음)'}`);
    console.log(`시황 한 줄: ${String(shaped.marketView || '').slice(0, 160)}`);
    for (const p of shaped.positions || []) {
      console.log(`  판단 ${p.symbol}: ${p.stance}(${p.confidence}) — ${String(p.rationale || '').slice(0, 110)}`);
    }
    if ((shaped.proposals || []).length) {
      for (const pr of shaped.proposals) console.log(`  💰 제안: ${pr.side} ${pr.symbol} ${pr.quantity}주 @ ${pr.price} — ${String(pr.reason || '').slice(0, 90)}`);
    } else {
      console.log('  💰 제안: 없음');
    }
  }
})();
