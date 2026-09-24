/**
 * 국면 시퀀스 백테스트 — 상승 → 하락 → 상승 (2026-09-24, 사용자 지시)
 *
 * 🔴 판단은 전부 **제품**(analystService.decideOnContext — 같은 SYSTEM_PROMPT·스키마·
 *    인버스 게이트)이 한다. 이 파일은 세계(가격·VIX)를 만들고 체결·부기만 한다.
 * 🔴 재현성: 고정 시드 LCG — 같은 실행 = 같은 세계.
 * 🔴 레버리지 감쇠는 **일일 수익률 × 배수 누적**으로 자연 재현된다(모형이 아니라 산수).
 * 부작용 0: 제안 등록·발송 없음. LLM 6콜(국면 3 × 리밸런스 2).
 */
const regime = require('/app/server/regimeService');
const analyst = require('/app/server/analystService');

// ── 결정적 의사난수 ──────────────────────────────────────────
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };

// ── 세계 생성: 기초지수 일일 수익률 경로 ─────────────────────
const SCENARIOS = {
  vshape: [
    { label: '상승 A', days: 25, drift: 0.55, noise: 0.9, vix: (i, n) => 16 - (i / n) * 3 },
    { label: '하락',   days: 25, drift: -0.95, noise: 1.4, vix: (i, n) => 17 + (i / n) * 14, shockAt: 12, shockPct: -4.2 },
    { label: '상승 B', days: 25, drift: 0.65, noise: 0.9, vix: (i, n) => 30 - (i / n) * 16 },
  ],
  bull: [ // 지속 상승 — 추세추종이 유리해야 정상
    { label: '상승 1', days: 25, drift: 0.6, noise: 0.9, vix: () => 14 },
    { label: '상승 2', days: 25, drift: 0.5, noise: 1.0, vix: () => 15 },
    { label: '상승 3', days: 25, drift: 0.7, noise: 0.9, vix: () => 13 },
  ],
  bear: [ // 지속 하락 — 방어·인버스·현금이 벤치를 이겨야 정상
    { label: '하락 1', days: 25, drift: -0.5, noise: 1.0, vix: (i, n) => 18 + (i / n) * 6 },
    { label: '하락 2', days: 25, drift: -0.8, noise: 1.3, vix: (i, n) => 24 + (i / n) * 8, shockAt: 10, shockPct: -4.5 },
    { label: '하락 3', days: 25, drift: -0.6, noise: 1.2, vix: (i, n) => 32 + (i / n) * 5 },
  ],
  chop: [ // 횡보 — 감쇠 회피·인컴이 관건
    { label: '횡보 1', days: 25, drift: 0.05, noise: 1.1, vix: () => 17 },
    { label: '횡보 2', days: 25, drift: -0.05, noise: 1.2, vix: () => 19 },
    { label: '횡보 3', days: 25, drift: 0.0, noise: 1.0, vix: () => 18 },
  ],
};
const argOf = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const SCENARIO = String(argOf('--scenario', 'vshape'));
/**
 * 현금 바닥 가드(개선 A/B 대상): 매수 체결이 현금을 초기 자산의 N% 미만으로 떨어뜨리면
 * 수량을 자동 축소 — 사다리 실탄 보전. 0 = 끔(현행).
 */
const CASH_FLOOR_PCT = Number(argOf('--cash-floor', '0'));
const PHASES = SCENARIOS[SCENARIO];
if (!PHASES) { console.error('unknown scenario'); process.exit(1); }
const WARMUP = { days: 70, drift: 0.35, noise: 0.7, vix: () => 15 };

function buildWorld() {
  const rets = []; const vixs = []; const phaseOf = [];
  const push = (ph, i, n) => { rets.push((ph.shockAt === i ? ph.shockPct : ph.drift + rand() * ph.noise * 2) / 100); vixs.push(Math.round(ph.vix(i, n) * 10) / 10); };
  for (let i = 0; i < WARMUP.days; i += 1) { push(WARMUP, i, WARMUP.days); phaseOf.push('워밍업'); }
  for (const ph of PHASES) for (let i = 0; i < ph.days; i += 1) { push(ph, i, ph.days); phaseOf.push(ph.label); }
  return { rets, vixs, phaseOf };
}

/** ETF 별 일일 수익률 = 기초 r 의 선형 노출(베타×배수) + 자체 드리프트. 카탈로그 대표만 */
const EXPOSURE = {
  QQQ: { beta: 1, lev: 1 }, SPY: { beta: 0.85, lev: 1 }, XLK: { beta: 1.05, lev: 1 },
  QLD: { beta: 1, lev: 2 }, TQQQ: { beta: 1, lev: 3 }, SSO: { beta: 0.85, lev: 2 }, UPRO: { beta: 0.85, lev: 3 },
  SOXX: { beta: 1.3, lev: 1 }, SMH: { beta: 1.3, lev: 1 }, SOXL: { beta: 1.3, lev: 3 },
  SCHD: { beta: 0.35, lev: 1, drift: 0.015 }, JEPI: { beta: 0.3, lev: 1, drift: 0.015 },
  XLP: { beta: 0.2, lev: 1, drift: 0.01 }, VDC: { beta: 0.2, lev: 1, drift: 0.01 }, XLV: { beta: 0.3, lev: 1, drift: 0.01 },
  TLT: { beta: -0.25, lev: 1 }, SHY: { beta: 0, lev: 1, drift: 0.008 }, GLD: { beta: -0.12, lev: 1, drift: 0.02 },
  PSQ: { beta: -1, lev: 1 }, SH: { beta: -0.85, lev: 1 }, QID: { beta: -1, lev: 2 }, SQQQ: { beta: -1, lev: 3 }, SPXU: { beta: -0.85, lev: 3 }, SOXS: { beta: -1.3, lev: 3 },
};

function buildPrices(rets) {
  const px = {}; // sym → [prices]
  for (const [sym, e] of Object.entries(EXPOSURE)) {
    let p = 100; const arr = [];
    for (const r of rets) { p *= 1 + (e.beta * e.lev * r) + ((e.drift || 0) / 100); arr.push(p); }
    px[sym] = arr;
  }
  return px;
}

const ma = (a, n, t) => (t + 1 >= n ? a.slice(t - n + 1, t + 1).reduce((x, y) => x + y, 0) / n : null);
const fmt = (v) => (v == null ? '-' : Number(v).toFixed(2));

// ── 백테스트 본체 ────────────────────────────────────────────
(async () => {
  const { rets, vixs, phaseOf } = buildWorld();
  const px = buildPrices(rets);
  const idxCloses = []; { let p = 100; for (const r of rets) { p *= 1 + r; idxCloses.push(p); } }

  const port = { cash: 10000, pos: {} }; // pos: sym → { qty, avg }
  const value = (t) => port.cash + Object.entries(port.pos).reduce((s, [sym, o]) => s + o.qty * px[sym][t], 0);
  const history = [];

  // 리밸런스 시점: 각 국면의 5일째·18일째
  const points = [];
  let cursor = WARMUP.days;
  for (const ph of PHASES) { points.push(cursor + 5, cursor + 18); cursor += ph.days; }

  /**
   * 🔴 VIX 사다리 — 실전과 **같은 함수**(regime.ladderProposals)를 매일 검사.
   *    코드 규칙이라 LLM 없이 돈다(실전 5분 틱의 백테스트 등가). 첫 실행에서 LLM 이
   *    공포 매수를 안 해 -14.7% vs 벤치 -0.7% 였다 — 사다리를 코드로 승격한 뒤의 비교가 목적.
   */
  let prevBand = regime.vixBandOf(vixs[WARMUP.days - 1]);
  const ladderFills = [];
  const dailyLadder = (t) => {
    const band = regime.vixBandOf(vixs[t]);
    const lps = regime.ladderProposals({ prevBand, band, cashUsd: port.cash });
    prevBand = band;
    for (const l of lps) {
      const price = px[l.symbol][t];
      const qty = Math.floor(l.budget / price);
      if (qty <= 0) continue;
      const o = port.pos[l.symbol] || { qty: 0, avg: 0 };
      o.avg = (o.avg * o.qty + price * qty) / (o.qty + qty); o.qty += qty; port.pos[l.symbol] = o;
      port.cash -= price * qty;
      ladderFills.push(`t=${t} 🪜 ${l.band}단계 BUY ${l.symbol} ${qty}주 @ ${fmt(price)}`);
    }
  };

  let lastPoint = WARMUP.days - 1;
  for (const t of points) {
    for (let d = lastPoint + 1; d <= t; d += 1) dailyLadder(d);
    lastPoint = t;
    const closes = idxCloses.slice(0, t + 1).slice(-70);
    const state = regime.compute({ us: { closes }, kr: { closes }, vix: vixs[t] });
    const scenarios = regime.matchScenarios(state, regime.readPlaybook());

    // 후보 절 — 합성 세계의 가격에서 **산수로** 추세 계산(세계와 정합)
    const candLines = Object.keys(EXPOSURE).map((sym) => {
      const last = px[sym][t]; const m20 = ma(px[sym], 20, t); const m60 = ma(px[sym], 60, t);
      const e = EXPOSURE[sym];
      return `- ${sym}(${e.lev !== 1 || e.beta < 0 ? `${e.beta < 0 ? '-' : ''}${Math.abs(e.lev)}x` : '1x'}): 현재 ${fmt(last)} · 20일선 ${fmt(m20)} · 60일선 ${fmt(m60)}`;
    });

    const posLines = Object.entries(port.pos).filter(([, o]) => o.qty > 0).map(([sym, o]) =>
      `- ${sym} 수량 ${o.qty} · 평단 ${fmt(o.avg)} · 현재 ${fmt(px[sym][t])} · 손익 ${fmt(((px[sym][t] - o.avg) / o.avg) * 100)}%`);

    const ctx = [
      `[백테스트 t=${t} · 국면 ${phaseOf[t]}] 아래 데이터만으로 판단하라.`,
      '', '## 계좌', `현금(매수 가능): 달러 ${fmt(port.cash)}`,
      '', '## 보유 종목', posLines.length ? posLines.join('\n') : '(없음)',
      '', regime.promptSection(state, scenarios),
      '', '## 매수 후보 기술 위치 (이 세계의 실계산)', ...candLines,
      '',
      '기준 배분과 국면 매뉴얼에 맞게 포트폴리오를 조정하라 — proposals 로 매수/매도를 내라(없으면 빈 배열).',
      '⚠️ price 는 후보 절의 현재가를 그대로 쓰라. quantity 는 현금·보유 안에서. reason 1문장.',
    ].join('\n');

    const { report, proposals, rejected } = await analyst.decideOnContext({ contextText: ctx, regimeState: state });

    // 모의 체결 — 초과분은 자르고 표시
    const fills = [];
    for (const p of proposals) {
      const sym = String(p.symbol).toUpperCase();
      if (!px[sym]) { fills.push(`✗ ${sym} 카탈로그 밖 — 기각`); continue; }
      const price = px[sym][t];
      let qty = Math.floor(Number(p.quantity) || 0);
      if (qty <= 0) continue;
      if (String(p.side).toUpperCase() === 'BUY') {
        const floorUsd = 10000 * (CASH_FLOOR_PCT / 100);
        const maxQ = Math.floor(Math.max(0, port.cash - floorUsd) / price);
        if (qty > maxQ) { fills.push(`⚠️ ${sym} 수량 ${qty}→${maxQ}(현금 한도)`); qty = maxQ; }
        if (qty <= 0) continue;
        const o = port.pos[sym] || { qty: 0, avg: 0 };
        o.avg = (o.avg * o.qty + price * qty) / (o.qty + qty); o.qty += qty; port.pos[sym] = o;
        port.cash -= price * qty;
        fills.push(`BUY ${sym} ${qty}주 @ ${fmt(price)}`);
      } else {
        const o = port.pos[sym];
        if (!o || o.qty <= 0) { fills.push(`✗ ${sym} 미보유 매도 — 기각`); continue; }
        if (qty > o.qty) { fills.push(`⚠️ ${sym} ${qty}→${o.qty}(보유 한도)`); qty = o.qty; }
        o.qty -= qty; port.cash += price * qty;
        fills.push(`SELL ${sym} ${qty}주 @ ${fmt(price)}`);
      }
    }
    history.push({ t, phase: phaseOf[t], vix: vixs[t], scenarios: scenarios.map((s) => s.name.split(' ')[0]).join('+'), oneLiner: report.marketView, fills, rejected, value: value(t) });
  }

  for (let d = lastPoint + 1; d < rets.length; d += 1) dailyLadder(d);

  // ── 결과 ──
  const T = rets.length - 1;
  const final = value(T);
  const bhQQQ = 10000 / px.QQQ[points[0]] * px.QQQ[T];
  console.log(`\n════════ 백테스트 [${SCENARIO}] cash-floor=${CASH_FLOOR_PCT}% ════════`);
  for (const h of history) {
    console.log(`\n[t=${h.t} · ${h.phase} · VIX ${h.vix} · 발동 ${h.scenarios || '없음'}] 자산 $${fmt(h.value)}`);
    console.log(`  판단: ${String(h.oneLiner || '').slice(0, 100)}`);
    for (const f of h.fills) console.log(`  ${f}`);
    for (const r of h.rejected || []) console.log(`  🛑 게이트 거절: ${r.symbol} — ${String(r.error).slice(0, 60)}`);
    if (!h.fills.length) console.log('  (조정 없음)');
  }
  if (ladderFills.length) { console.log('\n🪜 VIX 사다리(코드) 체결:'); for (const f of ladderFills) console.log(`  ${f}`); }
  console.log(`\n──── 최종 (t=${T}) ────`);
  const posFinal = Object.entries(port.pos).filter(([, o]) => o.qty > 0).map(([s, o]) => `${s} ${o.qty}주($${fmt(o.qty * px[s][T])})`).join(' · ');
  console.log(`포트폴리오: ${posFinal || '(없음)'} · 현금 $${fmt(port.cash)}`);
  console.log(`simpleStock 판단 운용: $10,000 → $${fmt(final)} (${fmt((final / 10000 - 1) * 100)}%)`);
  console.log(`벤치마크 QQQ 단순보유:  $10,000 → $${fmt(bhQQQ)} (${fmt((bhQQQ / 10000 - 1) * 100)}%)`);
  console.log(`참고 TQQQ 단순보유:     $10,000 → $${fmt(10000 / px.TQQQ[points[0]] * px.TQQQ[T])} (감쇠 실증)`);
  console.log(`SUMMARY ${SCENARIO} floor=${CASH_FLOOR_PCT} final=${fmt(final)} bench=${fmt(bhQQQ)} ladders=${ladderFills.length}`);
})();
