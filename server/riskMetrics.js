/**
 * 📐 포트폴리오 리스크 지표 (2026-10-04 — 포트폴리오·리스크 재편 + 애널리스트 RAG)
 *
 * 사용자: *"하방 변동성 대비 지수나 델타 감마 세타 변동성 같은 부분에 대해서 계산해서
 * … 실제 어떤 부분으로 밸런스를 맞춰나가야할지가 보여야 한다."*
 *
 * 🔴 **정직의 선** — 이 포트폴리오는 현물 ETF·주식이다. 옵션 그릭스를 그대로 흉내 내면
 *    지어낸 수치가 된다. 각 축을 이렇게 옮긴다:
 *    델타  → 지수 델타(Σ 비중 × 레버리지 배수) — "지수가 1% 움직이면 몇 % 움직이는 포트폴리오인가"
 *    감마  → **해당 없음**(현물은 델타가 가격에 따라 변하지 않는다) — 0 이 아니라 N/A 로 말한다
 *    세타  → **해당 없음**(시간 감가 없음) ⚠️단 레버리지 ETF 의 **변동성 감쇠**가 사실상의
 *            세타 역할을 한다 — 횡보 가정 일일 감쇠 근사(½·(k²−k)·σ²_일)를 대신 싣는다
 *    변동성 → 종목별 20일 실현 변동성(연율) + 포트폴리오 가중 변동성(보수적: 상관 1 가정)
 *    하방   → 하방 변동성(음의 일수익률만, 연율) · VaR95(1일, 정규 근사 1.65σ)
 *
 * 밸런스 판정(과/과소 하이라이트)은 **운용 한도와 같은 어원**(orderService 상수)을 쓴다 —
 * 화면 숫자와 게이트 숫자가 갈라지면 안 된다.
 */
const { logWarn } = require('./logger');

/** 일 수익률 배열 → {vol(연율%), downside(연율%), var95pct(1일%)} */
function volStats(rets) {
  if (!rets || rets.length < 10) return { vol: null, downside: null, var95: null };
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const neg = rets.filter((r) => r < 0);
  const dd = neg.length >= 3
    ? Math.sqrt(neg.reduce((a, b) => a + b ** 2, 0) / neg.length)
    : null;
  const ann = (x) => Math.round(x * Math.sqrt(252) * 1000) / 10; // → 연율 %
  return {
    vol: ann(sd),
    downside: dd != null ? ann(dd) : null,
    var95: Math.round(1.65 * sd * 1000) / 10, // 1일 VaR95 %
  };
}

/**
 * @param items 보유 [{symbol, marketValue, leverageFactor, currency}]
 * @param candlesBySymbol Map<symbol, closes[]> — 최근 일봉 종가(과거→현재, 21개 이상이면 계산)
 * @param weights portfolioWeights 결과(있으면 비중 재계산 생략)
 */
function compute({ items = [], candlesBySymbol = new Map(), cashPct = null, leveragePct = null } = {}) {
  const stockTotal = items.reduce((a, h) => a + (Number(h.marketValue) || 0), 0);
  /**
   * 🔴 분모는 **현금 포함 평가액**이다 (2026-10-04 첫 라이브에서 잡음) — 주식만 분모로 재면
   *    QLD 가 60.9% 로 나와 도넛(42.9%)·집중 게이트(현금 포함 equity)와 **다른 숫자**가 된다.
   *    자와 게이트가 분모를 달리 쓰면 "한도 초과" 판정이 과장된다. cashPct 를 모르면 주식만으로
   *    재되 그 사실이 weightBasis 로 드러난다.
   */
  const total = cashPct != null && cashPct < 100 && stockTotal > 0
    ? stockTotal / (1 - cashPct / 100)
    : stockTotal;
  const per = [];
  for (const h of items) {
    const w = total > 0 ? (Number(h.marketValue) || 0) / total : 0;
    const closes = candlesBySymbol.get(String(h.symbol).toUpperCase()) || [];
    const rets = [];
    for (let i = 1; i < closes.length; i += 1) {
      const a = Number(closes[i - 1]); const b = Number(closes[i]);
      if (a > 0 && b > 0) rets.push(b / a - 1);
    }
    const st = volStats(rets.slice(-21));
    const lev = Number(h.leverageFactor) || 1;
    per.push({
      symbol: h.symbol, weightPct: Math.round(w * 1000) / 10, leverage: lev,
      vol20dAnnPct: st.vol, downsideAnnPct: st.downside, var95DayPct: st.var95,
      // 레버리지 감쇠 근사(횡보 가정, 일일 %): ½(k²−k)σ² — "사실상의 세타"
      decayDayPct: st.vol != null && lev > 1
        ? Math.round(0.5 * (lev * lev - lev) * ((st.vol / 100 / Math.sqrt(252)) ** 2) * 100 * 10000) / 10000
        : null,
    });
  }
  // 지수 델타 — 주식 비중만(현금 제외). 베타 데이터가 없어 β=1 가정은 스트레스와 같은 전제
  const stockWeight = cashPct != null ? (100 - cashPct) / 100 : 1;
  const indexDelta = per.reduce((a, p) => a + (p.weightPct / 100) * p.leverage, 0) * (cashPct != null ? 1 : 1);
  // 포트폴리오 변동성 — 상관 1 보수 가정(분산 효과를 지어내지 않는다)
  const known = per.filter((p) => p.vol20dAnnPct != null);
  const portVol = known.length
    ? Math.round(known.reduce((a, p) => a + (p.weightPct / 100) * p.vol20dAnnPct, 0) * 10) / 10
    : null;
  const portVar = known.length
    ? Math.round(known.reduce((a, p) => a + (p.weightPct / 100) * (p.var95DayPct || 0), 0) * 100) / 100
    : null;

  // 밸런스 판정 — 게이트와 같은 상수
  const { SINGLE_POSITION_MAX_PCT } = require('./orderService');
  /**
   * 🔴 레버리지 한도 30 → **40** (2026-10-06 사용자 결정).
   *
   * 왜 40 인가 — 실측에서 **의미 있는 값이 하나뿐이었다**: 그날 레버리지 48.5%,
   * 사용자가 걸어 둔 QLD 20주 매도가 체결되면 **36.0%**. 35 는 둘 다 초과해 무의미하고
   * 50 은 48.5% 를 통과시켜 **사실상 한도 해제**다. 40 만이 "걸어 둔 조치가 끝나면
   * 경고가 풀리고, 더 늘리면 다시 짖는다" 를 만든다.
   * ⚠️ 한도를 올린 것은 48.5% 가 **안전해졌다는 뜻이 아니다** — 레버리지 2배 상품
   *    40% 는 지수 −10% 에 계좌 −8% 다(단일 상품 감쇠는 별도). 공격적 기조
   *    (2026-10-02 사용자 결정)에서 **감수하기로 한 값**이고, 그 이상은 여전히 경고한다.
   * ⚠️ 이 한도는 **경고 축**이다 — 플레이북 시나리오의 "레버리지 신규 금지" 문장은
   *    별개로 살아 있다(그쪽이 실제로 모델의 신규 진입을 막는 쪽이다).
   */
  const LEVERAGE_MAX_PCT = Math.max(0, Number(process.env.LEVERAGE_MAX_PCT ?? 40));
  const LIMITS = { leverage: LEVERAGE_MAX_PCT, single: SINGLE_POSITION_MAX_PCT, cashMin: 10 };
  const issues = [];
  if (leveragePct != null && leveragePct > LIMITS.leverage) {
    issues.push({ axis: 'leverage', level: 'over', msg: `레버리지 노출 ${leveragePct}% — 기준 ${LIMITS.leverage}% 초과. 1배 전환(QLD→QQQ 류)·축소가 보완책.` });
  }
  for (const p of per) {
    if (p.weightPct > LIMITS.single) {
      issues.push({ axis: 'single', symbol: p.symbol, level: 'over', msg: `${p.symbol} 비중 ${p.weightPct}% — 종목 한도 ${LIMITS.single}% 초과(추가 매수는 게이트가 막는다). 분산 필요.` });
    }
    if (p.decayDayPct != null && p.decayDayPct > 0.02) {
      issues.push({ axis: 'decay', symbol: p.symbol, level: 'warn', msg: `${p.symbol} 레버리지 감쇠 ≈ 일 ${p.decayDayPct}% (횡보 가정) — 횡보가 길어지면 보유 자체가 비용.` });
    }
  }
  if (cashPct != null && cashPct < LIMITS.cashMin) {
    issues.push({ axis: 'cash', level: 'under', msg: `현금 ${cashPct}% — 최소 ${LIMITS.cashMin}% 미만. 사다리 실탄·기회 대응력이 없다.` });
  }
  if (cashPct != null && cashPct > 40) {
    issues.push({ axis: 'cash', level: 'over', msg: `현금 ${cashPct}% — 과다(기회비용). 기준 배분으로의 분할 진입 검토.` });
  }

  return {
    asOf: new Date().toISOString(),
    indexDelta: Math.round(indexDelta * 100) / 100,
    gamma: null, theta: null, // 현물 — 해당 없음(지어내지 않는다). 감쇠는 per[].decayDayPct
    greeksNote: '현물 포트폴리오 — 감마·세타 해당 없음. 레버리지 감쇠(일일 근사)가 사실상의 세타다.',
    portfolioVolAnnPct: portVol,
    portfolioVar95DayPct: portVar,
    volNote: '상관 1 보수 가정(분산 효과를 지어내지 않는다) · 20일 실현 변동성 연율',
    cashPct, leveragePct,
    weightBasis: cashPct != null ? '현금 포함 평가액' : '주식 합계(현금 모름)',
    per, issues, limits: LIMITS,
  };
}

/** 애널리스트 프롬프트 RAG 절 — 화면과 같은 계산을 모델도 본다(두 벌이면 갈라진다) */
function promptSection(m) {
  if (!m) return '';
  const lines = ['## 포트폴리오 리스크 지표 (코드 계산 — 재계산하지 말 것)'];
  lines.push(`- 지수 델타 ${m.indexDelta} (지수 1% → 포트폴리오 ≈ ${m.indexDelta}%) · 변동성(연) ${m.portfolioVolAnnPct ?? '?'}% · VaR95(1일) ${m.portfolioVar95DayPct ?? '?'}%`);
  for (const i of m.issues) lines.push(`- 🔴 ${i.msg}`);
  if (!m.issues.length) lines.push('- 한도 위반 없음');
  return lines.join('\n');
}

module.exports = { compute, promptSection, _volStats: volStats };
