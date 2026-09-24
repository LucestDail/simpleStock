/**
 * 시장 국면 데몬 (2026-09-23, 사용자 지시)
 *
 * *"내부에 명확히 시장분석 데몬이 돌아가서 각 시황/하락장·상승장 대비 구체적 매뉴얼 및
 *  시나리오 대응책들이 구성되어야 · 현재 시장 상황을 객관적 판단하여 매뉴얼 수행"*
 *
 * ## 설계 원칙 — 판정은 코드, 매뉴얼은 데이터, 서술만 LLM
 *
 * 🔴 국면 판정을 LLM 에 맡기면 **회차마다 흔들린다**(채점 LLM 실측: 같은 문장을 ✘/○ 로
 *    가름). 여기는 전부 산수다 — 같은 입력이면 같은 판정. LLM 호출 0.
 * 🔴 매뉴얼(`config/playbook.json`)과 도구상자(`config/etf-catalog.json`)는 데이터다 —
 *    사용자가 편집·승인할 수 있어야 하고, 코드 안에 숨으면 안 된다.
 *
 * ## 판정 축 (전부 이미 있는 데이터)
 *
 * ```
 * trend    지수 종가·20일선·60일선 관계 — last>ma20>ma60 = up · last<ma20<ma60 = down · 그 외 side
 * shock    지수 당일 등락 ≤ -3%  (§17.3 급락)
 * vixBand  0 평온(<20) · 1 진입(20+) · 2 확대(25+) · 3 고공포(30+) · 4 극단(35+)  — 사용자 규칙
 * ```
 *
 * ## 전이만 시끄럽게 (엣지 트리거)
 *
 * 상태는 5분 틱마다 갱신하되, **바뀐 순간에만** 이벤트를 낸다 — 브리핑·장마감 알림과
 * 같은 규율(수평 상태를 반복 알리면 사람이 알림을 끈다).
 * ⚠️ 상태 파일(`data/regime.json`)은 '지금 상태' 라 통째로 덮어쓴다(감사 아님).
 */

const fs = require('node:fs');
const path = require('node:path');
const { logInfo, logWarn } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'regime.json');
const PLAYBOOK_FILE = path.join(__dirname, '..', 'config', 'playbook.json');
const CATALOG_FILE = path.join(__dirname, '..', 'config', 'etf-catalog.json');

// ── 순수 판정 ────────────────────────────────────────────────

function ma(closes, n) {
  if (!Array.isArray(closes) || closes.length < n) return null;
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}

/**
 * 한 시장의 추세·급락 판정. @param closes 일봉 종가 배열(과거→현재), last 는 현재가(장중이면 실시간)
 * ⚠️ 데이터가 모자라면 **null 추세**다 — "모름" 과 "횡보" 는 다르다(추측해 채우지 않는다).
 */
function judgeMarket({ closes = [], last = null } = {}) {
  // ⚠️ Number(null)=0 이 isFinite 를 통과한다 — null 을 0 으로 읽으면 모든 추세가 down/side 가 된다
  const hasLive = last != null && Number.isFinite(Number(last));
  const price = hasLive ? Number(last) : (closes.length ? closes[closes.length - 1] : null);
  const m20 = ma(closes, 20);
  const m60 = ma(closes, 60);
  let trend = null;
  if (price != null && m20 != null && m60 != null) {
    trend = price > m20 && m20 > m60 ? 'up' : price < m20 && m20 < m60 ? 'down' : 'side';
  }
  // 당일 등락: 현재가 vs 마지막 확정 종가(전일)
  const prev = closes.length >= 2 ? closes[closes.length - (hasLive ? 1 : 2)] : null;
  const dayPct = price != null && prev ? ((price - prev) / prev) * 100 : null;
  return {
    trend,
    shock: dayPct != null && dayPct <= -3,
    dayPct: dayPct != null ? Math.round(dayPct * 100) / 100 : null,
    price, ma20: m20, ma60: m60,
  };
}

/** VIX 밴드 — 사용자 규칙(20/25/30/35). null 이면 "확인 못 함" */
function vixBandOf(v) {
  // ⚠️ Number(null)=0 — null 을 "평온" 으로 읽으면 데이터 결손이 안심 신호가 된다
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n >= 35) return 4;
  if (n >= 30) return 3;
  if (n >= 25) return 2;
  if (n >= 20) return 1;
  return 0;
}

const VIX_BAND_LABEL = ['평온(<20)', '공포 진입(20+) — 분할 매수 1단계', '공포 확대(25+) — 2단계', '고공포(30+) — 3단계', '극단 공포(35+) — 최대 단계'];
const TREND_KO = { up: '상승추세', side: '횡보', down: '하락추세' };

/** 시장별 판정 + VIX 를 한 상태로 */
function compute({ kr = null, us = null, vix = null, manual = [] } = {}) {
  return {
    at: new Date().toISOString(),
    kr: kr ? judgeMarket(kr) : null,
    us: us ? judgeMarket(us) : null,
    vix: vix != null ? { value: Number(vix), band: vixBandOf(vix) } : { value: null, band: null },
    manual: Array.isArray(manual) ? manual : [],
  };
}

/**
 * 시나리오 매칭 — playbook 의 match 절과 상태를 대조한다.
 * 🔴 여러 개가 맞으면 **전부** 발동한다(예: 하락추세 + VIX 25 는 bear_trend 와 fear_ladder 둘 다).
 */
function matchScenarios(state, playbook) {
  const out = [];
  const anyShock = Boolean(state?.kr?.shock || state?.us?.shock);
  const band = state?.vix?.band;
  for (const sc of playbook?.scenarios || []) {
    const m = sc.match || {};
    if (m.manual) { if (state.manual?.includes(m.manual)) out.push({ ...sc, via: '수동' }); continue; }
    /**
     * 🔴 어느 시장이 발동시켰는지 남긴다 (2026-09-24 시뮬레이션에서 발견) —
     *    디커플링(미장 하락·국장 상승)이면 상반된 매뉴얼 둘이 같이 실리는데,
     *    발동 근원이 없으면 모델이 US 에 상승 성향을 적용하는 식으로 섞어 읽는다.
     */
    let via = null;
    if (m.trend) {
      const hit = ['us', 'kr'].filter((k) => state?.[k]?.trend === m.trend);
      if (!hit.length) continue;
      via = hit.map((k) => k.toUpperCase()).join('·');
    }
    if (m.shock === true && !anyShock) continue;
    if (m.shock === false && anyShock) continue;
    if (m.shock === true) via = ['us', 'kr'].filter((k) => state?.[k]?.shock).map((k) => k.toUpperCase()).join('·') || via;
    if (m.vixBandMin != null && !(band != null && band >= m.vixBandMin)) continue;
    if (m.vixBandMax != null && !(band != null && band <= m.vixBandMax)) continue;
    out.push({ ...sc, via: via || (m.vixBandMin != null ? 'VIX' : via) });
  }
  return out;
}

// ── 상태·전이 ────────────────────────────────────────────────

let current = null;

function loadState() {
  try { current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { current = null; }
  return current;
}

function persist(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    logWarn('regime.persist_failed', { message: e.message });
  }
}

/** 전이 감지 — trend/shock/vixBand 가 **바뀐 것만** 목록으로 */
function diffTransitions(prev, next) {
  const t = [];
  for (const mkt of ['kr', 'us']) {
    const a = prev?.[mkt]?.trend, b = next?.[mkt]?.trend;
    if (b != null && a != null && a !== b) t.push(`${mkt.toUpperCase()} ${TREND_KO[a]} → ${TREND_KO[b]}`);
    const sa = Boolean(prev?.[mkt]?.shock), sb = Boolean(next?.[mkt]?.shock);
    if (sb && !sa) t.push(`${mkt.toUpperCase()} 급락(${next[mkt].dayPct}%)`);
  }
  const va = prev?.vix?.band, vb = next?.vix?.band;
  if (vb != null && va != null && va !== vb) t.push(`VIX ${VIX_BAND_LABEL[va]} → ${VIX_BAND_LABEL[vb]}`);
  return t;
}

/**
 * 수집 → 판정 → 전이 감지. **틱에서 부른다**(5분). 실패한 축은 null 로 남는다 — 추측 금지.
 * @returns {{ state, transitions: string[], scenarios }}
 */
async function refresh() {
  const toss = require('./tossClient');
  const market = require('./marketDataService');
  const inputs = { kr: null, us: null, vix: null, manual: current?.manual || [] };
  try {
    const c = await toss.getIndexCandles('KOSPI', { interval: '1d', count: 70 });
    const closes = (c.rows || []).map((r) => r.c).filter(Number.isFinite);
    let lastNow = null;
    try {
      const now = await toss.getIndexPrices(['KOSPI']);
      lastNow = Number(now?.[0]?.lastPrice) || null;
    } catch { /* 장외엔 현재가가 없을 수 있다 — 캔들 마지막으로 */ }
    inputs.kr = { closes, last: lastNow };
  } catch (e) { logWarn('regime.kr_failed', { message: e.message, kind: e.kind }); }
  try {
    // US 지수는 토스 카탈로그에 없다(실측 400) — 대표 현물 QQQ 로 판정한다(1배·감쇠 없음)
    const c = await toss.getCandles('QQQ', { interval: '1d', count: 70 });
    const closes = (c.rows || []).map((r) => r.c).filter(Number.isFinite);
    inputs.us = { closes, last: null };
  } catch (e) { logWarn('regime.us_failed', { message: e.message, kind: e.kind }); }
  try {
    const v = await market.getVix();
    inputs.vix = v?.price ?? null;
  } catch { /* getVix 가 null 을 준다 */ }

  const prev = current || loadState();
  const next = compute(inputs);
  const transitions = prev ? diffTransitions(prev, next) : [];
  current = next;
  persist(next);
  const scenarios = matchScenarios(next, readPlaybook());
  if (transitions.length) {
    logInfo('regime.transition', { transitions, scenarios: scenarios.map((s) => s.id) });
  }
  return { state: next, transitions, scenarios };
}

// ── 매뉴얼·도구상자 로드 (편집 반영을 위해 매번 읽되, mtime 캐시) ──

let pbCache = null; // { mtime, data }
function readPlaybook() {
  try {
    const mtime = fs.statSync(PLAYBOOK_FILE).mtimeMs;
    if (!pbCache || pbCache.mtime !== mtime) pbCache = { mtime, data: JSON.parse(fs.readFileSync(PLAYBOOK_FILE, 'utf8')) };
    return pbCache.data;
  } catch (e) {
    logWarn('regime.playbook_unreadable', { message: e.message });
    return { scenarios: [] };
  }
}

let ctCache = null;
function readCatalog() {
  try {
    const mtime = fs.statSync(CATALOG_FILE).mtimeMs;
    if (!ctCache || ctCache.mtime !== mtime) ctCache = { mtime, data: JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')) };
    return ctCache.data;
  } catch (e) {
    logWarn('regime.catalog_unreadable', { message: e.message });
    return { categories: {} };
  }
}

// ── 분석 프롬프트 절 ─────────────────────────────────────────

/**
 * 현재 국면 + 발동 매뉴얼 + 관련 도구상자를 프롬프트 절로.
 * ⚠️ 발동한 시나리오가 참조하는 카테고리만 싣는다 — 전체 카탈로그를 실으면 길이(=시간)가 는다.
 */
function promptSection(state = current, scenarios = null) {
  if (!state) return '';
  const lines = ['## 시장 국면 (코드 판정 — 이 판정을 그대로 쓰고 다시 판정하지 마라)'];
  for (const mkt of ['kr', 'us']) {
    const m = state[mkt];
    if (!m) continue;
    lines.push(`- ${mkt.toUpperCase()}: ${m.trend ? TREND_KO[m.trend] : '판정 불가(데이터 부족)'}${m.dayPct != null ? ` · 당일 ${m.dayPct}%` : ''}${m.shock ? ' · 🔴급락' : ''}`);
  }
  lines.push(`- VIX: ${state.vix?.value ?? '확인 못 함'}${state.vix?.band != null ? ` — ${VIX_BAND_LABEL[state.vix.band]}` : ' (확인 못 함이면 낮다고 가정 금지)'}`);

  const active = scenarios || matchScenarios(state, readPlaybook());
  if (active.length) {
    lines.push('', '## 발동된 매뉴얼 (이 스텝 안에서만 제안하라)');
    const catalog = readCatalog();
    const wantCats = new Set();
    for (const sc of active) {
      // via = 발동 근원 — 디커플링에서 "이 매뉴얼은 어느 시장 얘기인가" 를 모델이 안다
      lines.push(`### ${sc.name}${sc.via ? ` — 발동: ${sc.via}` : ''}${sc.via && sc.via !== 'VIX' && sc.via.length <= 5 ? ' (이 시장에만 적용)' : ''}`);
      for (const st of sc.steps) {
        lines.push(`- ${st}`);
        for (const key of Object.keys(catalog.categories || {})) if (st.includes(key)) wantCats.add(key);
      }
    }
    if (wantCats.size) {
      lines.push('', '## 도구상자 (티커는 이 안에서만 — 지어내지 마라)');
      for (const key of wantCats) {
        const cat = catalog.categories[key];
        // market 표기 — 시뮬 실측: 모델이 달러 현금으로 KR 종목 매수를 제안했다(통화 불일치)
        lines.push(`- ${cat.name}: ${cat.etfs.map((e) => `${e.symbol}(${e.leverage}x${e.market === 'KR' ? '·KR원화' : ''})`).join(' · ')}`);
      }
      lines.push('⚠️ 이 목록 밖 티커·현금 통화와 다른 시장의 매수 제안은 **계좌 검증이 거부한다** — 내지 마라.');
    }
  }
  return lines.join('\n');
}

/**
 * 🔴 발동 매뉴얼이 가리키는 **매수 후보의 실데이터** (2026-09-24 시뮬 E 실증).
 *
 * 도구상자에 티커 이름만 실었더니 — 상승장 + 현금 $5,000 에서도 **매수 제안 0**.
 * 모델이 "확인 안 된 값을 지어내지 마라" 규율에 눌려 정직하게 침묵한 것이다(그게 맞다).
 * ⇒ 이름이 아니라 **시세·추세**를 준다: 발동 카테고리의 1배 ETF(미보유·US 우선 4개)를
 *    캔들로 요약해 "매수 후보 기술 위치" 절을 만든다. 판단 함수는 호출자(analystService)의
 *    summarizeCandles 를 **그대로 받아 쓴다** — 자를 새로 만들지 않는다.
 * ⚠️ 실패한 후보는 건너뛴다(빈 값 지어내기 금지) · 후보 수 상한 4(길이 = 시간).
 */
async function candidateSection(scenarios, { heldSymbols = [], summarize, getCandles } = {}) {
  if (!scenarios?.length || typeof summarize !== 'function' || typeof getCandles !== 'function') return '';
  const catalog = readCatalog();
  const held = new Set(heldSymbols.map((s) => String(s).toUpperCase()));
  const wanted = [];
  for (const sc of scenarios) {
    for (const st of sc.steps || []) {
      for (const key of Object.keys(catalog.categories || {})) {
        if (!st.includes(key)) continue;
        for (const e of catalog.categories[key].etfs) {
          // 1배(정방향·인버스 -1 포함 — 인버스 헤지는 사용자 결정 09-24) · 미보유 · KR 은 원화 현금이 있어야 의미
          if (Math.abs(e.leverage) !== 1 || held.has(e.symbol) || e.market === 'KR') continue;
          /**
           * 🔴 카테고리당 1개 (2026-09-24 시뮬 실측) — 생필품이 XLP·VDC 로 두 자리를 먹어
           *    상한에 인버스(PSQ)가 **항상 잘렸다.** 같은 카테고리 둘은 정보가 거의 같다 —
           *    다양성이 상한 안에서 우선이다.
           */
          if (wanted.some((w) => w.categoryKey === key)) break;
          if (!wanted.some((w) => w.symbol === e.symbol)) wanted.push({ symbol: e.symbol, name: e.name, category: catalog.categories[key].name, categoryKey: key });
        }
      }
    }
  }
  const lines = [];
  for (const w of wanted.slice(0, 6)) {
    try {
      const c = await getCandles(w.symbol, { interval: '1d', count: 120 });
      const t = summarize(c.rows || []);
      if (!t) continue;
      lines.push(`- ${w.symbol}(${w.category} · ${w.name}): 현재 ${t.last} · 20일선 ${t.ma20 ? t.ma20.toFixed(2) : '-'} · 60일선 ${t.ma60 ? t.ma60.toFixed(2) : '-'} · ${t.bars}일 고점대비 ${t.fromHighPct != null ? t.fromHighPct.toFixed(1) : '-'}%`);
    } catch { /* 못 받은 후보는 싣지 않는다 — 지어내기 금지 */ }
  }
  if (!lines.length) return '';
  return [
    '## 매수 후보 기술 위치 (도구상자 실데이터 — 미보유·1배)',
    ...lines,
    '현금이 있고 매뉴얼이 매수를 허용하는 국면이면, 이 중 추세가 선(종가>20>60) 후보로 **구체적 매수 제안을 내라.** 근거는 위 숫자 인용.',
  ].join('\n');
}

/** 수동 국면(지정학 등) 토글 — 코드가 판정할 수 없는 축은 사람이 발동한다 */
function setManual(tags) {
  const state = current || loadState() || compute({});
  state.manual = [...new Set((tags || []).map(String))];
  current = state;
  persist(state);
  return state.manual;
}

function getState() { return current || loadState(); }

module.exports = {
  compute, judgeMarket, vixBandOf, matchScenarios, diffTransitions, promptSection,
  refresh, getState, setManual, readPlaybook, readCatalog, candidateSection,
  VIX_BAND_LABEL, TREND_KO,
};
