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
  /**
   * 🔴 사양에 없는 **네 번째 유형** — 사용자 보유 2종이 둘 다 여기였다(2026-09-21).
   * 사양의 10항목은 **기업** 을 재는 자다. ETF 에 대면 없는 것을 재게 되므로
   * **100점 총점을 내지 않는다**(`opinion` 도 없다). 대신 펀드에서 실제로 판단 가능한 것만 쓴다.
   */
  FUND: 'ETF·펀드',
};

/**
 * 유형 판정. 🔴 **코드가 정한다** — 모델이 유형을 고르면 점수 기준이 흔들린다
 * (같은 종목이 회차마다 다른 잣대로 평가된다).
 * ⚠️ 시가총액을 못 받으면 유형을 **단정하지 않는다** — `대형주` 로 가정하면 기준이 후해진다.
 */
/**
 * 🔴 **레버리지·인버스 여부는 이름에서 읽는다** (2026-09-21)
 *
 * 사용자의 보유 2종이 **둘 다 2배 레버리지 ETF** 였다(`ProShares Ultra QQQ`,
 * `Roundhill T-REX 2x Long DRAM Daily Target`). 이건 **매수·매도 판단에서 가장 중요한 사실**이다 —
 * 일일 리밸런싱이라 **횡보장에서 가치가 깎인다**(변동성 감쇠). 장기 보유 전제가 성립하지 않는다.
 *
 * ⚠️ **이름으로 추정한 것**이라 그렇게 표시한다. 야후가 배수를 구조화해서 주지 않으므로
 *    이게 지금 가진 유일한 단서다 — **추정임을 감추면 안 된다.**
 */
function leverageHint(name) {
  const n = String(name || '');
  const hits = [];
  if (/\b(3x|ultrapro|triple)\b/i.test(n)) hits.push('3배');
  else if (/\b(2x|ultra|double)\b/i.test(n)) hits.push('2배');
  if (/\b(inverse|short|bear|-1x)\b/i.test(n)) hits.push('인버스(하락 베팅)');
  if (/\bdaily\b/i.test(n)) hits.push('일일 리밸런싱');
  return hits.length ? { leveraged: true, hints: hits, why: `이름에서 추정: "${n}"` } : { leveraged: false, hints: [], why: null };
}

/** 펀드·ETF 인가 — `quoteType` 이 있으면 그것을 믿는다(이름 추측보다 정확하다) */
function isFund(stats) {
  const t = String(stats?.quoteType || '').toUpperCase();
  if (t) return t === 'ETF' || t === 'MUTUALFUND' || t === 'FUND';
  return false;
}

function classify(stats) {
  // 🔴 ETF 에 기업 채점표를 대지 않는다 — `구조적 우위`·`매출·이익 동반 성장` 은 펀드에 없는 축이다.
  //    그대로 채점하면 **모델이 지어낸 숫자**가 "69점 비중축소" 처럼 매도 판단을 끈다.
  if (isFund(stats)) {
    const lv = leverageHint(stats?.name);
    return {
      type: TYPES.FUND,
      assumed: false,
      why: lv.leveraged ? `ETF·펀드 (${lv.hints.join(' · ')})` : 'ETF·펀드',
      fund: true,
      leverage: lv,
    };
  }
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

/**
 * 🔴 **항목 점수를 "모양" 으로 읽는다** (2026-09-21 — 같은 병의 **다섯 번째**)
 *
 * 라이브 첫 평가에서 **10개 항목이 전부 `None`** 으로 나왔다. 모델이 안 채운 게 아니라
 * **내가 못 읽었다.** 로그의 실제 응답:
 * ```
 * 회차1  { "강한 기업 선호": 10, "구조적 우위": 10, … }    ← 평평한 객체(배열이 아니다)
 * 회차2  { "강한_기업_선호": 10, "매출_이익_동반_성장": 10 } ← 공백이 밑줄, `·` 가 `_`
 * ```
 * 스키마에 `items: [{name,score,comment}]` 라고 적었는데 게이트웨이가 네이티브 function
 * calling 을 안 써서 **스키마는 지시일 뿐 강제가 아니다.**
 *
 * ★ 이 저장소에서 같은 비대칭을 이미 네 번 밟았다(도구 호출 키·목록 키·**깊이**·리포트 모양).
 *   그때 배운 처방이 *"키 이름을 열거하지 말고 모양으로 찾는다"* 인데 **여기에 안 퍼뜨렸다** —
 *   *"규칙을 정하면 그 자리에서 적용 범위를 훑을 것"* 을 또 어긴 것이다.
 *
 * ## 무엇으로 가르나
 *
 * 항목 이름을 **정규화**(영숫자·한글만 남김)해 대조한다 ⇒ `강한 기업 선호`·`강한_기업_선호`·
 * `강한기업선호` 가 모두 같은 항목이 된다.
 * ⚠️ **아무 숫자나 줍지 않는다** — 정규화한 키가 **채점표에 있는 이름일 때만** 받는다.
 *    그래서 `total: 88` 같은 걸 항목 점수로 오인하지 않는다.
 */
/**
 * 🔴 **숫자를 버린다** — 모델이 항목에 번호를 붙인다(2026-09-21 라이브, 같은 병 **여섯 번째**).
 *
 * 고친 직후 같은 종목 두 회차가 이렇게 갈렸다:
 * ```
 * 회차A  { "강한 기업 선호": 10, … }                          → 93점 ✅
 * 회차B  { "10개 항목 점수": { "1. 강한 기업 선호": 10.0, … } } → 번호 때문에 불일치 ❌
 * ```
 * ⚠️ 이게 성립하는 **전제는 "채점표 이름에 숫자가 없다"** 는 것이다.
 *    전제가 깨지면 서로 다른 항목이 같은 이름으로 뭉개진다 ⇒ **테스트가 그 전제를 강제한다**
 *    (`ratingShape.test.js` 의 "채점표 이름에 숫자가 없다·정규화 후에도 안 겹친다").
 *    가정을 주석으로만 적으면 다음 사람이 숫자 든 항목을 추가하고 조용히 깨진다.
 */
const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z가-힣]/g, '');

const NAME_KEYS = ['name', 'item', 'title', 'label', '항목', '이름'];
const SCORE_KEYS = ['score', 'points', 'value', '점수', '배점'];
const COMMENT_KEYS = ['comment', 'reason', 'note', 'rationale', '코멘트', '근거', '설명', '평가'];

const firstOf = (o, keys) => {
  for (const k of keys) if (o[k] != null) return o[k];
  return null;
};
const asScore = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 출력 어디에 있든 항목 점수를 긁어모은다.
 * @param {object} want 정규화이름 → 정식이름
 * @param {Map} into 정식이름 → {score, comment}
 */
function collectScores(node, want, into, depth = 0) {
  if (node == null || depth > 6) return;
  if (Array.isArray(node)) {
    for (const v of node) collectScores(v, want, into, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  // ① `{name, score, comment}` 모양 — 이름이 채점표에 있으면 받는다
  const nm = want.get(normName(firstOf(node, NAME_KEYS)));
  const sc = asScore(firstOf(node, SCORE_KEYS));
  if (nm && sc != null && !into.has(nm)) {
    into.set(nm, { score: sc, comment: String(firstOf(node, COMMENT_KEYS) ?? '').trim() });
  }

  // ② `{ "항목명": 10 }` · `{ "항목명": {score, comment} }` 모양
  for (const [key, v] of Object.entries(node)) {
    const hit = want.get(normName(key));
    if (hit && !into.has(hit)) {
      const direct = asScore(v);
      if (direct != null) {
        into.set(hit, { score: direct, comment: '' });
        continue;
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const nested = asScore(firstOf(v, SCORE_KEYS));
        if (nested != null) {
          into.set(hit, { score: nested, comment: String(firstOf(v, COMMENT_KEYS) ?? '').trim() });
          continue;
        }
      }
    }
    collectScores(v, want, into, depth + 1);
  }
}

/**
 * 채점표 이름 순서대로 `{name, score, comment}` 10개를 만든다.
 * ⚠️ **위치 폴백은 이름으로 하나도 못 찾았을 때만** 쓴다 — 이름이 일부 맞는데 위치로 메우면
 *    엉뚱한 항목에 점수가 붙어 **틀린 총점이 조용히 나온다**(빈 것보다 나쁘다).
 */
function shapeScores(out, names) {
  const want = new Map(names.map((n) => [normName(n), n]));
  const found = new Map();
  collectScores(out, want, found);

  let positional = [];
  if (found.size === 0) {
    const arr = Array.isArray(out?.items) ? out.items
      : Object.values(out || {}).find((v) => Array.isArray(v) && v.length === names.length) || [];
    if (arr.length === names.length) positional = arr;
  }

  return names.map((name, i) => {
    const got = found.get(name) || (positional[i] && {
      score: asScore(firstOf(positional[i], SCORE_KEYS) ?? positional[i]),
      comment: String(firstOf(positional[i], COMMENT_KEYS) ?? '').trim(),
    }) || {};
    const n = asScore(got.score);
    return {
      name,
      // ⚠️ 범위를 벗어난 점수는 **자른다** — 12점을 그대로 더하면 100점을 넘는다
      score: n == null ? null : Math.max(0, Math.min(10, n)),
      comment: String(got.comment || '').trim(),
    };
  });
}

/**
 * 🔴 **서술 필드가 배열로 오는 것도 흡수한다** (2026-09-21 라이브 실측).
 *
 * 스키마에 `strengths: {type:'string'}` 이라 적었는데 모델이 **배열**을 줬다:
 * ```
 * 약점: ['일일 리밸런싱으로 인한 변동성 감쇠', '방향이 틀리면 손실 폭이 커짐', …]
 * ```
 * 그대로 내보내면 화면에 **`["a","b","c"]` 라는 날 JSON** 이 찍힌다.
 * 점수 모양 문제와 **같은 가족**이다 — 스키마는 게이트웨이에서 지시일 뿐 강제가 아니다.
 * ⚠️ 빈 값과 못 읽은 값을 섞지 않는다 — 읽을 게 없으면 `''` 다(`"undefined"` 같은 문자열이 아니라).
 */
function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(' · ');
  if (typeof v === 'object') return Object.values(v).map(asText).filter(Boolean).join(' · ');
  return String(v).trim();
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

const FUND_SCHEMA = {
  type: 'object',
  properties: {
    whatItTracks: { type: 'string' },
    holdIt: { type: 'string', enum: ['장기 보유 가능', '중기까지', '단기 전용'] },
    holdWhy: { type: 'string' },
    strengths: { type: 'string' },
    weaknesses: { type: 'string' },
    oneLiner: { type: 'string' },
    unverified: { type: 'array', items: { type: 'string' } },
  },
  required: ['whatItTracks', 'oneLiner'],
};

/**
 * ETF·펀드 읽기 — **100점 총점을 내지 않는다.**
 *
 * 사양의 10항목은 *기업* 을 재는 자다(`구조적 우위`·`매출·이익 동반 성장`).
 * 펀드에 대면 모델은 **그럴듯한 숫자를 지어낸다** — 실측에서 QLD 가 `69점 / 비중축소` 를 받았는데
 * 그건 판단이 아니라 **없는 것을 잰 결과**다. 매도를 끌 수 있으므로 내보내면 안 된다.
 *
 * ⇒ 대신 펀드에서 **실제로 판단 가능한 것**만 낸다: 무엇을 추종하는가 · 보유 기간 적합성 ·
 *    레버리지·일일 리밸런싱 여부. 매수·매도 판단에는 이쪽이 오히려 직접적이다.
 */
async function rateFund(stats, cls, newsText) {
  const lv = cls.leverage || { leveraged: false, hints: [], why: null };
  const out = await generateStructuredOutput({
    systemPrompt: [
      '당신은 ETF·펀드 분석자입니다. **기업 분석을 하지 마세요** — 이 종목은 회사가 아니라 펀드입니다.',
      '매출·영업이익·해자 같은 기업 항목을 논하지 말고, **무엇을 추종하고 어떻게 굴러가는지**만 봅니다.',
      '',
      '## 답할 것',
      '- `whatItTracks`: 무엇을 추종하는가(지수·섹터·자산). **모르면 모른다고 쓰세요.**',
      '- `holdIt`: `장기 보유 가능` / `중기까지` / `단기 전용` 중 하나 + `holdWhy` 근거',
      '- `strengths` / `weaknesses` / `oneLiner`',
      '',
      '## 🔴 레버리지·인버스면 반드시 짚으세요',
      '일일 리밸런싱 상품은 **횡보장에서 가치가 깎입니다**(변동성 감쇠). 방향이 맞아도 손실이 날 수 있습니다.',
      '장기 보유 전제가 성립하지 않으므로 `holdIt` 을 후하게 주지 마세요.',
      '',
      '## 🔴 지어내지 마세요',
      '보수율·추적오차·AUM·구성종목 비중은 **주어지지 않았습니다.** 추측하지 말고 `unverified` 에 적으세요.',
      '총점·점수는 쓰지 않습니다. 한국어로, 과장 없이.',
    ].join('\n'),
    userPrompt: [
      `# ${stats.name} (${stats.symbol})`,
      `유형: ETF·펀드${lv.leveraged ? ` — ${lv.hints.join(' · ')} (${lv.why})` : ''}`,
      `주가: ${fmtNum(stats.price)} ${stats.currency || ''}`,
      stats.exchange ? `거래소: ${stats.exchange}` : '',
      `베타: ${fmtNum(stats.quality?.beta)}`,
      `배당수익률: ${fmtPct(stats.quality?.dividendYield)}`,
      '',
      '⚠️ 시가총액·PER·PBR 등 기업 지표는 **펀드에 존재하지 않습니다.** 없다고 지적하지 마세요.',
      newsText ? `\n## 최근 뉴스\n${newsText.slice(0, 2000)}` : '',
    ].filter(Boolean).join('\n'),
    schema: FUND_SCHEMA,
    logLabel: 'fund_rating',
    fallback: { whatItTracks: '', oneLiner: '' },
  });

  const notes = [];
  if (lv.leveraged) {
    notes.push(`🔴 ${lv.hints.join(' · ')} 상품 — 일일 리밸런싱이면 **횡보장에서 가치가 깎입니다**(변동성 감쇠). 장기 보유 전제가 성립하지 않습니다.`);
    notes.push(`⚠️ 배수는 **이름에서 추정**했습니다(${lv.why}). 운용사 문서로 확인하세요.`);
  }

  logInfo('rating.fund', { symbol: stats.symbol, leveraged: lv.leveraged, holdIt: out.holdIt || null });

  return {
    symbol: stats.symbol,
    name: stats.name,
    type: TYPES.FUND,
    typeWhy: cls.why,
    typeAssumed: false,
    isFund: true,
    leverage: lv,
    // 🔴 **총점·투자의견을 내지 않는다** — 화면이 "평가 못 함" 과 "0점" 을 구분해야 한다
    total: null,
    maxTotal: null,
    opinion: null,
    scoreNotApplicable: '기업 채점표(10항목 100점)는 **회사** 를 재는 자입니다. ETF 에는 매출·이익·해자가 없어 점수를 내지 않습니다.',
    items: [],
    bandText: '',
    description: asText(out.whatItTracks),
    holdIt: out.holdIt || null,
    holdWhy: asText(out.holdWhy),
    strengths: asText(out.strengths),
    weaknesses: asText(out.weaknesses),
    interpretation: '',
    confidence: '낮음',
    confidenceWhy: ['펀드는 보수율·추적오차·구성종목을 이 시스템이 받지 못합니다.', ...notes].join(' '),
    oneLiner: asText(out.oneLiner),
    unverified: out.unverified || ['보수율', '추적오차', 'AUM', '구성종목 비중'],
    notes,
    missingValueMetrics: [],
    links: stats.links,
    stats: { price: stats.price, beta: stats.quality?.beta ?? null, dividendYield: stats.quality?.dividendYield ?? null },
    at: stats.at,
  };
}

/**
 * 한 종목을 평가한다.
 * @returns {Promise<object>} 점수·투자의견·확신도 + 원자료
 */
async function rate(symbol, { newsText = '' } = {}) {
  const stats = await getStats(symbol);
  const cls = classify(stats);
  const type = cls.type;

  // 🔴 ETF·펀드는 **기업 채점을 하지 않는다** — 없는 축을 재면 지어낸 숫자가 나온다
  if (type === TYPES.FUND) return rateFund(stats, cls, newsText);

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
  const items = shapeScores(out, names);

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
    description: asText(out.description),
    items,
    total,
    maxTotal: 100,
    opinion,
    bandText: bandText(type),
    strengths: asText(out.strengths),
    weaknesses: asText(out.weaknesses),
    interpretation: asText(out.interpretation),
    confidence: order[confIdx],
    confidenceWhy: [asText(out.confidenceWhy), downgrades.length ? `(자동 하향: ${downgrades.join(' · ')})` : ''].filter(Boolean).join(' '),
    oneLiner: asText(out.oneLiner),
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

module.exports = { rate, classify, opinionFor, bandText, shapeScores, asText, leverageHint, RUBRICS, TYPES, BANDS };
