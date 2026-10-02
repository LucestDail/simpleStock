/**
 * 산문 속 **가격 수치** 검증 (2026-10-02 라이브 실사고)
 *
 * ## 무슨 일이 있었나
 * 15:30 KRX 마감 회차에서 프롬프트는 정확한 값을 줬다:
 * ```
 * QLD  현재 96.84 · 20일선 92.69 · 60일선 90.13
 * RAM  현재 14.55 · 20일선 13.67
 * ```
 * 그런데 모델은 이렇게 썼다:
 * ```
 * QLD  "20일선(약 806) 회복 시 …"  · "60일선(약 732) 이탈 시 …"
 * RAM  "20일선(46.10) 이탈 시 …"   · "52주 고점(48.80) 경신 시도"
 * ```
 * **데이터를 줬는데 무시하고 지어냈다.** QLD 806 은 실제가의 **8배**다.
 * 텔레그램 요약엔 안 갔지만 **웹 화면(`WorkspaceView` 시나리오 줄)에 그대로 뜬다** —
 * 사용자가 "806까지 회복하면" 으로 읽으면 완전히 틀린 판단을 한다.
 *
 * ## 🔴 프롬프트로는 못 고친다
 * 프롬프트에 *"근거 없는 수치는 쓰지 않습니다"* 가 **이미 있었고 안 지켜졌다.**
 * 이 저장소가 2026-09-14 에 배운 것: **프롬프트로 못 고치는 것을 프롬프트로 고치려 하지 말고,
 * 코드가 거부하고 이유를 다음 프롬프트에 돌려준다.**
 *
 * ## ⚠️ 자를 만들면 자의 판별력부터 잰다
 * 첫 판은 "현재가의 2.5배 밖" 만 봤는데 **오탐이 났다** — `20일선`의 **20**,
 * `52주`의 **52**, `60일선`의 **60**, 변동성 `1.11%` 가 전부 걸렸다.
 * ⇒ **단위가 붙은 숫자는 가격이 아니다.** 아래 `UNIT_AFTER` 가 그 축이고,
 *    `tests/proseNumbers.test.js` 가 **그날 실제로 나온 문장들**로 양방향을 잠근다
 *    (QLD·RAM 은 걸려야 하고, BRK.B·O 는 안 걸려야 한다).
 */

/**
 * 숫자 바로 뒤에 오면 **그 숫자는 가격이 아니다**.
 * ⚠️ 금지목록처럼 보이지만 아니다 — 여기 없는 단위가 나오면 **가격으로 보고 검사**하므로
 *    빠뜨려도 **놓침이 아니라 오탐** 쪽으로 기운다. 오탐은 재요청 비용일 뿐이고
 *    놓침은 틀린 숫자가 화면에 뜨는 것이다. **덜 위험한 쪽으로 기울여 둔다.**
 */
const UNIT_AFTER = /^\s*(%|퍼센트|일선|일봉|일|주|개월|년|회|건|배|명|개|σ|시그마|분|초|위|호가|틱)/;

/** 가격처럼 보이는 숫자만 뽑는다 */
function priceNumbers(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0];
    const n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const after = s.slice(m.index + raw.length);
    if (UNIT_AFTER.test(after)) continue;          // 단위가 붙었다 = 가격 아님
    /**
     * 🔴 **비교식 안의 숫자는 기간이다** (2026-10-02 — 같은 자의 **두 번째** 오탐).
     *    `정배열(종가>20>60)` 의 `60` 이 RAM(14.73)의 4.07배로 걸렸다. 이동평균 **기간**인데
     *    뒤에 `)` 가 와서 `UNIT_AFTER` 를 비껴갔다.
     * ⇒ 숫자 **바로 앞이 부등호**(`20>60` 의 60)거나 **바로 뒤가 부등호**(`종가>20>` 의 20)면
     *    가격이 아니라 **비교 대상**이다.
     * ★ 이 가드의 처방은 **문장 교체**라 오탐 하나하나가 멀쩡한 설명을 지운다 —
     *   그래서 계속 **좁히는 쪽**으로 기운다.
     */
    const before = s.slice(Math.max(0, m.index - 1), m.index);
    if (/[><≥≤]/.test(before) || /^\s*[><≥≤]/.test(after)) continue;
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue; // 연도
    if (Math.abs(n) < 1) continue;                  // 비율·확률
    out.push({ raw, n, index: m.index });
  }
  return out;
}

/** 이 숫자가 어느 기준값을 말하려던 것인가 — 바로 앞 낱말로 짐작한다(교체 문구에만 쓴다) */
function refHint(text, index) {
  const before = String(text || '').slice(Math.max(0, index - 14), index);
  if (/20일선/.test(before)) return 'ma20';
  if (/60일선/.test(before)) return 'ma60';
  if (/고점|신고가/.test(before)) return 'high';
  if (/저점|신저가/.test(before)) return 'low';
  return null;
}

/** 검사 대상 필드 — 모델이 쓴 산문만 본다(코드가 채운 자리는 제외) */
const FIELDS = ['scenarioUp', 'scenarioDown', 'rationale', 'risk'];

/**
 * 보유·후보 종목 산문에서 **기준값과 동떨어진 가격 수치**를 찾는다.
 *
 * @param {Array} positions  보고서의 positions
 * @param {Object} refBySymbol  { SYM: {last, ma20, ma60, swingHigh, swingLow} }
 * @param {number} factor  허용 배수(기본 2.5 — 20·60일선·52주 고저가 전부 이 안에 든다)
 */
function findPriceOutliers(positions = [], refBySymbol = {}, { factor = 2.5 } = {}) {
  const hits = [];
  for (const p of positions || []) {
    // ⚠️ 코드가 채운 자리는 **모델이 쓴 글이 아니다** — 검사하면 자기 글을 검사하는 것이다
    if (p?._codeFilled) continue;
    const sym = String(p?.symbol || '').toUpperCase();
    const ref = refBySymbol[sym];
    const cur = Number(ref?.last);
    // ⚠️ 기준이 없으면 **통과가 아니라 미검사**다 — 호출자가 셀 수 있게 따로 돌려준다
    if (!(cur > 0)) continue;
    for (const f of FIELDS) {
      const text = p?.[f];
      if (!text) continue;
      for (const { raw, n, index } of priceNumbers(text)) {
        const a = Math.abs(n);
        /**
         * 🔴 **과대만 본다** (2026-10-02 라이브 오탐 → 좁힘).
         *
         * 첫 판은 양쪽(`cur*2.5` 초과 **또는** `cur/2.5` 미만)을 봤고 **라이브에서 오탐이 났다**:
         * QLD(현재 97.49) 산문의 `20` 이 ratio 0.21 로 걸려 **멀쩡했을 수 있는 시나리오가
         * 코드 문구로 교체됐다.** 작은 정수는 거의 항상 기간·배수·순번이지 가격이 아니다.
         *
         * 지금까지 **진짜 이탈 3건이 전부 과대**였다(806 vs 96.84 · 46.10 vs 14.55 ·
         * 90.97 vs 14.73). 오탐 1건만 과소였다.
         *
         * ⚠️ **놓치는 것을 적어 둔다**: *"QLD 가 9.6까지 하락"* 같은 **과소 날조는 안 잡힌다.**
         *    그래도 이쪽이 맞다 — 이 가드의 처방은 **문장 교체**라, 오탐은 멀쩡한 설명을
         *    지운다. *"오탐이 해롭다" 와 "놓침이 해롭다" 가 둘 다 참일 때, 처방이 파괴적인
         *    쪽이면 오탐을 먼저 줄인다.*
         */
        if (a <= cur * factor) continue;
        hits.push({
          symbol: sym, field: f, raw, value: n, current: cur,
          ratio: Math.round((a / cur) * 100) / 100,
          hint: refHint(text, index),
          // ⚠️ **걸린 문맥을 남긴다** — 안 남기면 사후에 오탐인지 가릴 수 없다
          //    (실제로 QLD 원문이 교체돼 버려 무엇이 걸렸는지 영영 못 봤다).
          context: String(text).slice(Math.max(0, index - 18), index + raw.length + 14),
        });
      }
    }
  }
  return hits;
}

/** 기준값이 없어 **검사하지 못한** 종목 — 0건을 "통과" 로 읽지 않기 위해 함께 센다 */
function unverifiable(positions = [], refBySymbol = {}) {
  return (positions || [])
    .filter((p) => p && !p._codeFilled)
    .map((p) => String(p.symbol || '').toUpperCase())
    .filter((s) => !(Number(refBySymbol[s]?.last) > 0));
}

/** 모델에게 돌려줄 문구 — **맞는 값을 함께 준다**(거부만 하면 같은 답을 또 낸다) */
function retryNote(hits, refBySymbol) {
  const bySym = new Map();
  for (const h of hits) {
    if (!bySym.has(h.symbol)) bySym.set(h.symbol, []);
    bySym.get(h.symbol).push(h);
  }
  const out = ['## 🔴 직전 답변에 **제공하지 않은 가격**이 들어갔습니다 — 다시 답하세요'];
  for (const [sym, list] of bySym) {
    const r = refBySymbol[sym] || {};
    const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '-');
    out.push(
      `- **${sym}**: ${list.map((h) => `\`${h.raw}\`(${h.field})`).join(', ')} 는 현재가 ${fmt(r.last)} 의 `
      + `${list[0].ratio}배 수준입니다. 이 종목의 실제 값은 `
      + `현재가 ${fmt(r.last)} · 20일선 ${fmt(r.ma20)} · 60일선 ${fmt(r.ma60)}`
      + (r.swingLow != null || r.swingHigh != null ? ` · 최근20일 스윙 ${fmt(r.swingLow)}~${fmt(r.swingHigh)}` : '')
      + ' 입니다.'
    );
  }
  out.push('**위 숫자만** 인용하세요. 다른 종목·지수의 값을 가져오지 마세요.');
  return out.join('\n');
}

/**
 * 재요청까지 실패하면 **그 문장을 코드가 교체한다.**
 * ⚠️ 조용히 지우지 않는다 — 무엇이 일어났는지 화면에 적는다(사용자가 이유를 알아야 한다).
 * ⚠️ 코드가 "지어내는" 것이 아니다 — 쓰는 값은 **우리가 모델에게 준 바로 그 값**이다.
 */
function replaceWithFacts(position, ref) {
  const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '-');
  return {
    ...position,
    scenarioUp: `20일선 ${fmt(ref?.ma20)} 회복 시 반등 시도 (코드 대체 — 모델이 제공하지 않은 수치를 썼습니다)`,
    scenarioDown: `60일선 ${fmt(ref?.ma60)} 이탈 시 추가 하락 (코드 대체 — 모델이 제공하지 않은 수치를 썼습니다)`,
    _priceFabricated: true,
  };
}


/**
 * 🔴 **주제가 바뀌는 것** — 가격 검증이 원리상 못 보는 축 (2026-10-02 dryRun 실측)
 *
 * ```
 * QLD scenarioUp: "SOXX가 20일선을 지키며 고점을 경신하면 상승 추세가 이어질 것입니다."
 * RAM scenarioUp: "반도체 모멘텀이 지속되며 SOXX가 120일 고점을 돌파하면 상승할 수 있습니다."
 * ```
 * QLD(나스닥100 2배)의 시나리오가 **SOXX(반도체 ETF)** 기준이다. 종목이 통째로 바뀌었다.
 * 그 회차의 `prose_price_check` 는 **`outliers: 0`** 이었다 — 산문에 **숫자가 0개**라
 * 가격 자가 볼 것이 없었기 때문이다. ★ *"0건이 통과가 아니다"* 의 또 다른 얼굴.
 *
 * ## ⚠️ 오탐 축을 먼저 정했다
 * **다른 티커를 말하는 것 자체는 정상**이다 — QLD 는 QQQ 2배라 *"QQQ 가 오르면 QLD 도"* 가
 * 자연스럽고, RAM 은 DRAM·반도체를 말해야 한다. 막으면 **멀쩡한 설명을 죽인다.**
 * ⇒ 좁게 판정한다: **자기 자신을 한 번도 안 부르면서 다른 종목만 주어로 쓰는 경우.**
 *    `QLD` 도 `리얼티 인컴` 같은 자기 이름도 안 나오고 `SOXX` 만 나오면 — 그건 바뀐 것이다.
 */
function findSubjectDrift(positions = [], knownSymbols = [], nameBySymbol = {}) {
  const known = [...new Set((knownSymbols || []).map((s) => String(s).toUpperCase()).filter(Boolean))];
  const hits = [];
  for (const p of positions || []) {
    if (p?._codeFilled) continue;
    const sym = String(p?.symbol || '').toUpperCase();
    if (!sym) continue;
    const text = FIELDS.map((f) => p?.[f] || '').join(' ');
    if (!text.trim()) continue;
    const says = (s) => new RegExp(`(^|[^A-Za-z0-9.])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9.]|$)`, 'i').test(text);
    // 자기 티커 또는 자기 이름(한글 포함)을 부르는가
    const selfName = String(nameBySymbol[sym] || '').trim();
    if (says(sym) || (selfName && text.includes(selfName))) continue;
    const others = known.filter((k) => k !== sym && says(k));
    if (others.length) hits.push({ symbol: sym, others, sample: text.slice(0, 90) });
  }
  return hits;
}

/** 모델에게 돌려줄 문구 — **무엇을 틀렸는지 종목 단위로** 짚는다 */
function driftNote(hits) {
  return [
    '## 🔴 직전 답변이 **다른 종목 이야기를 하고 있습니다** — 다시 답하세요',
    ...hits.map((h) => `- **${h.symbol}** 의 판단인데 본문이 ${h.others.join(', ')} 만 말합니다: "${h.sample}…"`),
    '각 종목의 `rationale`·`risk`·`scenarioUp`·`scenarioDown` 은 **그 종목 자신**에 대한 것이어야 합니다.',
    '기초자산·업종을 근거로 드는 것은 좋지만, **그 종목 이름을 반드시 함께** 쓰세요.',
  ].join('\n');
}

module.exports = {
  priceNumbers, findPriceOutliers, unverifiable, retryNote, replaceWithFacts, refHint,
  findSubjectDrift, driftNote,
  UNIT_AFTER, FIELDS,
};
