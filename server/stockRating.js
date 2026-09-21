const { generateStructuredOutput } = require('./aiService');
const { getStats } = require('./yahooStats');
const { logInfo, logWarn } = require('./logger');

/**
 * 종목 계층 평가 — 10항목 100점 (2026-09-21 사용자 사양)
 *
 * 사용자: *"매수 매도 리포트에서 해당 대상을 **도구처럼 호출**해서 내부 호출 평가 해서
 * 상세하게 **점수 계층화** 처리 후 판정이 가능하도록 구성. **모든건 매수/매도가 최종 목표**임."*
 *
 * ## 🔴 점수와 투자의견은 **코드가** 잇는다
 *
 * 사양이 못박았다 — *"점수와 투자의견 구간이 **절대 어긋나면 안 된다**."*
 * 모델에게 둘 다 맡기면 88점에 "적극 매수" 를 쓴다. ⇒ **모델은 항목 점수만** 매기고
 * 합계·구간·투자의견은 **여기서 계산**한다. 손익비를 코드가 계산한 것과 같은 규율이다.
 *
 * ## 🔴 밸류는 **Yahoo Statistics Current 값만** 쓴다
 *
 * 사양: *"밸류 관련 숫자는 다른 화면, 다른 값, 다른 소스와 섞지 않는다."*
 * ⇒ 프롬프트에 토스 가격을 **넣지 않는다.** 한 스냅샷에서 온 배수들만 넣는다.
 * ⚠️ 못 받은 지표는 **없다고 적는다.** 0 으로 채우면 "PER 0 = 엄청 싸다" 가 된다.
 *
 * ## ⚠️ 이 평가로 **못 하는 것**
 *
 * IR·실적발표·가이던스·backlog·RPO·세그먼트 실적은 **구조화된 출처가 없다.**
 * 웹 검색 텍스트로만 닿으므로 신뢰도가 한 단계 낮다 ⇒ 해당 항목은 모델이
 * **"확인 못 함"** 이라고 적게 하고, 그러면 확신도를 코드가 **내린다.**
 */

/** 사양의 유형 구분 */
const TYPES = {
  LARGE: '대형주',
  SMALL_GROWTH: '중소형 성장주',
  LARGE_DIV: '대형배당주',
};

/**
 * 유형 판정. 🔴 **코드가 정한다** — 모델이 유형을 고르면 점수 기준이 흔들린다
 * (같은 종목이 회차마다 다른 잣대로 평가된다).
 * ⚠️ 시가총액을 못 받으면 유형을 **단정하지 않는다** — `대형주` 로 가정하면 기준이 후해진다.
 */
function classify(stats) {
  const cap = Number(stats?.marketCap);
  const dy = Number(stats?.quality?.dividendYield);
  if (!Number.isFinite(cap) || cap <= 0) return { type: TYPES.LARGE, assumed: true, why: '시가총액 미확인 — 대형주 기준으로 가정' };
  // 배당수익률은 소스에 따라 0.025(비율) 또는 2.5(%) 로 온다 — 둘 다 받는다
  const yieldPct = Number.isFinite(dy) ? (dy > 1 ? dy : dy * 100) : null;
  const BIG = 10e9;
  if (cap >= BIG && yieldPct != null && yieldPct >= 2.5) {
    return { type: TYPES.LARGE_DIV, assumed: false, why: `시총 ${(cap / 1e9).toFixed(1)}B · 배당수익률 ${yieldPct.toFixed(2)}%` };
  }
  if (cap >= BIG) return { type: TYPES.LARGE, assumed: false, why: `시총 ${(cap / 1e9).toFixed(1)}B` };
  return { type: TYPES.SMALL_GROWTH, assumed: false, why: `시총 ${(cap / 1e9).toFixed(2)}B (10B 미만)` };
}

/** 유형별 10개 항목 — 사양 그대로 */
const RUBRICS = {
  [TYPES.LARGE]: [
    '강한 기업 선호', '구조적 우위', '숫자로 검증된 성장', '매출·이익 동반 성장', '장기 지속 성장성',
    '실적 기준 경쟁위협 점검', '투자 논리 안정성', '정당한 프리미엄', '이해·추적 가능성', '사용자 투자 스타일 적합성',
  ],
  [TYPES.SMALL_GROWTH]: [
    '시장 규모와 구조 성장성', '제품·기술·IP 경쟁력', 'CEO·경영진 실행력', '매출 성장·수주·backlog',
    '반복매출·장기계약·고객 락인', '3~5년 성장 지속성', '자금조달·희석 리스크', '수익성 개선 경로',
    '밸류 정당성', '추적 가능성·사용자 투자 스타일 적합성',
  ],
  [TYPES.LARGE_DIV]: [
    '강한 기업 선호', '구조적 우위', '숫자로 검증된 성장', '매출·이익 동반 성장', '장기 지속 성장성',
    '실적 기준 경쟁위협 점검', '투자 논리 안정성', '정당한 프리미엄', '이해·추적 가능성', '배당 지속성·안정성',
  ],
};

/**
 * 투자의견 구간 — 사양 그대로. 🔴 **중소형은 문턱이 낮다**(85/75/65/55).
 * ⚠️ 사양이 `90점 초과` 라고 썼다 — 90.0 은 "적극 매수" 가 **아니다.** 그대로 구현한다.
 */
const BANDS = {
  [TYPES.LARGE]: [[90, '적극 매수'], [80, '매수'], [70, '중립'], [60, '비중축소 / 약중립'], [-Infinity, '매도 권고']],
  [TYPES.LARGE_DIV]: [[90, '적극 매수'], [80, '매수'], [70, '중립'], [60, '비중축소 / 약중립'], [-Infinity, '매도 권고']],
  [TYPES.SMALL_GROWTH]: [[85, '적극 매수'], [75, '매수'], [65, '중립'], [55, '관찰 / 고위험 중립'], [-Infinity, '매도 권고']],
};

function opinionFor(type, total) {
  const bands = BANDS[type] || BANDS[TYPES.LARGE];
  for (const [cut, label] of bands) {
    // 🔴 최상위 구간만 **초과**(>)다 — 사양이 "90점 초과" 라고 썼다
    if (cut === bands[0][0] ? total > cut : total >= cut) return label;
  }
  return '매도 권고';
}

/** 사양의 구간표를 텍스트로 (표가 아니라 텍스트로 내라고 명시돼 있다) */
function bandText(type) {
  const rows = {
    [TYPES.LARGE]: ['90점 초과: 적극 매수', '80점 이상 89점 이하: 매수', '70점 이상 79점 이하: 중립', '60점 이상 69점 이하: 비중축소 / 약중립', '59점 이하: 매도 권고'],
    [TYPES.LARGE_DIV]: ['90점 초과: 적극 매수', '80점 이상 89점 이하: 매수', '70점 이상 79점 이하: 중립', '60점 이상 69점 이하: 비중축소 / 약중립', '59점 이하: 매도 권고'],
    [TYPES.SMALL_GROWTH]: ['85점 초과: 적극 매수', '75점 이상 84점 이하: 매수', '65점 이상 74점 이하: 중립', '55점 이상 64점 이하: 관찰 / 고위험 중립', '54점 이하: 매도 권고'],
  };
  return [`${type} 기준`, ...(rows[type] || rows[TYPES.LARGE])].join('\n');
}

const SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'number' },
          comment: { type: 'string' },
        },
        required: ['name', 'score', 'comment'],
      },
    },
    strengths: { type: 'string' },
    weaknesses: { type: 'string' },
    interpretation: { type: 'string' },
    confidence: { type: 'string', enum: ['매우 높음', '높음', '중간~높음', '중간', '낮음'] },
    confidenceWhy: { type: 'string' },
    oneLiner: { type: 'string' },
    unverified: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'confidence', 'oneLiner'],
};

function systemPrompt(type) {
  return [
    '당신은 기업·주식 분석 전용 평가자입니다. **좋은 이야기보다 좋은 숫자**,',
    '**싼 회사보다 강한 회사**, 구조적 우위 있는 1등 기업, 장기 보유 논리가 있는 기업을 우선합니다.',
    '**좋은 회사와 좋은 주식은 반드시 구분**해서 설명합니다.',
    '',
    `## 이 종목의 평가 유형: **${type}**`,
    '아래 10개 항목을 **각 10점 만점**으로 매깁니다. 항목 이름을 **그대로** 쓰세요.',
    ...RUBRICS[type].map((n, i) => `${i + 1}. ${n}`),
    '',
    '## 점수 해석',
    '9.5~10.0 매우 강함 · 8.5~9.0 강함 · 7.5~8.0 양호 · 6.5~7.0 보통 이상',
    '5.5~6.0 애매 · 4.5~5.0 약함 · 4.0 이하 명확한 약점',
    '🔴 90점대 총점은 **시대 대표급 초우량주에만** 나옵니다. 후하게 주지 마세요.',
    '',
    '## 밸류 반영 원칙',
    '- 밸류는 10개 중 **1개** 항목입니다. 기업 질이 압도적이면 밸류가 부담돼도 총점은 크게 안 흔들립니다.',
    '- 기업 질이 약하면 **싸도** 점수가 크게 오르지 않습니다.',
    '- `정당한 프리미엄`(또는 `밸류 정당성`)은 **주어진 Yahoo Statistics 값으로만** 판단합니다.',
    '',
    '## 🔴 지어내지 마세요',
    '- 주어지지 않은 숫자(가이던스·backlog·세그먼트·수주)는 **`unverified` 에 적고** 그 항목 점수를',
    '  **보수적으로** 매깁니다. "확인 못 함" 을 강점으로 치지 마세요.',
    '- **총점과 투자의견은 쓰지 마세요.** 시스템이 계산합니다. 당신은 **항목 점수만** 냅니다.',
    '- 취소선·메타 설명("무엇을 반영했다")은 쓰지 않습니다. 한국어로, 숫자 중심으로, 과장 없이.',
  ].join('\n');
}

const fmtNum = (v, d = 2) => (v == null ? '확인 못 함' : Number(v).toFixed(d));
const fmtBig = (v) => (v == null ? '확인 못 함' : `${(Number(v) / 1e9).toFixed(2)}B`);
const fmtPct = (v) => (v == null ? '확인 못 함' : `${(Number(v) * 100).toFixed(2)}%`);

function statsBlock(s) {
  return [
    '## Yahoo Finance Statistics (Current)',
    `주가: ${fmtNum(s.price)} ${s.currency || ''}`,
    `시가총액: ${fmtBig(s.marketCap)}`,
    `Enterprise Value: ${fmtBig(s.enterpriseValue)}`,
    `Trailing P/E: ${fmtNum(s.trailingPE)}`,
    `Forward P/E: ${fmtNum(s.forwardPE)}`,
    `PEG Ratio (5yr expected): ${fmtNum(s.pegRatio)}`,
    `Price/Sales: ${fmtNum(s.priceToSales)}`,
    `Price/Book: ${fmtNum(s.priceToBook)}`,
    `EV/Revenue: ${fmtNum(s.evToRevenue)}`,
    `EV/EBITDA: ${fmtNum(s.evToEbitda)}`,
    '',
    '## 사업 숫자 (Yahoo financialData — 밸류가 아님)',
    `매출성장: ${fmtPct(s.quality.revenueGrowth)} · 이익성장: ${fmtPct(s.quality.earningsGrowth)}`,
    `영업마진: ${fmtPct(s.quality.operatingMargins)} · 순마진: ${fmtPct(s.quality.profitMargins)}`,
    `ROE: ${fmtPct(s.quality.returnOnEquity)} · 부채비율(D/E): ${fmtNum(s.quality.debtToEquity)}`,
    `잉여현금흐름: ${fmtBig(s.quality.freeCashflow)} · 현금: ${fmtBig(s.quality.totalCash)} · 총부채: ${fmtBig(s.quality.totalDebt)}`,
    `배당수익률: ${fmtPct(s.quality.dividendYield)} · 배당성향: ${fmtPct(s.quality.payoutRatio)} · 5년평균배당률: ${fmtNum(s.quality.fiveYearAvgDividendYield)}`,
    `베타: ${fmtNum(s.quality.beta)}`,
    '',
    s.missing.length
      ? `⚠️ **받지 못한 밸류 지표**: ${s.missing.join(', ')} — 이 항목들은 없는 채로 판단하세요.`
      : '모든 밸류 지표를 받았습니다.',
  ].join('\n');
}

/**
 * 한 종목을 평가한다.
 * @returns {Promise<object>} 점수·투자의견·확신도 + 원자료
 */
async function rate(symbol, { newsText = '' } = {}) {
  const stats = await getStats(symbol);
  const cls = classify(stats);
  const type = cls.type;

  const out = await generateStructuredOutput({
    systemPrompt: systemPrompt(type),
    userPrompt: [
      `# ${stats.name} (${stats.symbol})`,
      stats.sector ? `섹터: ${stats.sector} / ${stats.industry || '-'}` : '',
      '',
      statsBlock(stats),
      newsText ? `\n## 최근 뉴스(외부 검색 — 날짜와 출처를 확인하고 쓰세요)\n${newsText.slice(0, 2500)}` : '',
    ].filter(Boolean).join('\n'),
    schema: SCHEMA,
    logLabel: 'stock_rating',
    fallback: { items: [], confidence: '낮음', oneLiner: '' },
  });

  // 🔴 **합계·의견은 코드가 낸다** — 사양: "점수와 투자의견 구간이 절대 어긋나면 안 된다"
  const names = RUBRICS[type];
  const items = names.map((name, i) => {
    const got = (out.items || []).find((x) => String(x.name || '').trim() === name) || (out.items || [])[i] || {};
    const n = Number(got.score);
    return {
      name,
      // ⚠️ 범위를 벗어난 점수는 **자른다** — 12점을 그대로 더하면 100점을 넘는다
      score: Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null,
      comment: String(got.comment || '').trim(),
    };
  });

  const scored = items.filter((x) => x.score != null);
  // 🔴 **항목이 비면 총점을 만들지 않는다.** 없는 것을 0 으로 치면 "매도 권고" 가 된다
  const total = scored.length === names.length
    ? Math.round(scored.reduce((a, b) => a + b.score, 0) * 10) / 10
    : null;
  const opinion = total == null ? null : opinionFor(type, total);

  /**
   * 확신도 — 모델이 고르되 **자료가 비면 코드가 내린다.**
   * ⚠️ 밸류 지표를 절반도 못 받았는데 "매우 높음" 이면 그건 자신감이 아니라 착각이다.
   */
  const order = ['낮음', '중간', '중간~높음', '높음', '매우 높음'];
  let confIdx = Math.max(0, order.indexOf(out.confidence || '중간'));
  const downgrades = [];
  if (stats.missing.length >= 3) { confIdx = Math.min(confIdx, 1); downgrades.push(`밸류 지표 ${stats.missing.length}개 미수신`); }
  if ((out.unverified || []).length >= 3) { confIdx = Math.min(confIdx, 2); downgrades.push(`확인 못 한 항목 ${out.unverified.length}건`); }
  if (scored.length < names.length) { confIdx = 0; downgrades.push(`항목 ${names.length - scored.length}개 미채점`); }

  const result = {
    symbol: stats.symbol,
    name: stats.name,
    type,
    typeWhy: cls.why,
    typeAssumed: cls.assumed,
    description: out.description || '',
    items,
    total,
    maxTotal: 100,
    opinion,
    bandText: bandText(type),
    strengths: out.strengths || '',
    weaknesses: out.weaknesses || '',
    interpretation: out.interpretation || '',
    confidence: order[confIdx],
    confidenceWhy: [out.confidenceWhy || '', downgrades.length ? `(자동 하향: ${downgrades.join(' · ')})` : ''].filter(Boolean).join(' '),
    oneLiner: out.oneLiner || '',
    unverified: out.unverified || [],
    missingValueMetrics: stats.missing,
    links: stats.links,
    stats: {
      price: stats.price, marketCap: stats.marketCap, enterpriseValue: stats.enterpriseValue,
      trailingPE: stats.trailingPE, forwardPE: stats.forwardPE, pegRatio: stats.pegRatio,
      priceToSales: stats.priceToSales, priceToBook: stats.priceToBook,
      evToRevenue: stats.evToRevenue, evToEbitda: stats.evToEbitda,
    },
    at: new Date().toISOString(),
  };

  if (total == null) logWarn('rating.incomplete', { symbol: stats.symbol, scored: scored.length, need: names.length });
  logInfo('rating.done', { symbol: stats.symbol, type, total, opinion, confidence: result.confidence });
  return result;
}

module.exports = { rate, classify, opinionFor, bandText, RUBRICS, TYPES, BANDS };
