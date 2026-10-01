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

/**
 * 시장별 판정 + VIX 를 한 상태로.
 *
 * 🔴 **`stale`·`ageMin` 은 메타다 — 밴드 판정 산수(`vixBandOf`)는 그대로다** (2026-09-28,
 *    pm1 지시). `marketDataService.getVix()` 가 야후 429 때 최대 60분까지 낡은 값을 재사용
 *    하며 `stale: true` + `ageMin` 을 이미 달아 주는데, 유일한 소비자(`refresh()`)가 그
 *    표시를 버리고 있었다 — 그 값이 그대로 공포 사다리 매수 제안(HITL 승인 문구)까지
 *    흘러가는데, 승인 버튼을 누르는 사람은 그게 낡은 값인지 알 방법이 없었다.
 * ⚠️ `vix` 는 **여전히 숫자(또는 null)**다 — 기존 `compute({vix:26})` 호출부·테스트가
 *    그대로 통과해야 한다(하위호환). stale·나이는 별도 파라미터로 받는다.
 */
function compute({ kr = null, us = null, vix = null, vixStale = false, vixAgeMin = null, manual = [] } = {}) {
  return {
    at: new Date().toISOString(),
    kr: kr ? judgeMarket(kr) : null,
    us: us ? judgeMarket(us) : null,
    vix: vix != null
      ? { value: Number(vix), band: vixBandOf(vix), stale: Boolean(vixStale), ageMin: vixAgeMin ?? null }
      : { value: null, band: null, stale: false, ageMin: null },
    manual: Array.isArray(manual) ? manual : [],
  };
}

/**
 * VIX 가 낡았을 때 사람이 읽는 문장에 붙이는 안내 — **여기 한 곳**에서만 만든다(전이
 * 알림·사다리 제안 reason 이 같은 문구를 쓴다. 따로 두면 다음에 한쪽만 바뀐다).
 * ⚠️ 나이를 몰라도(`ageMin` 없음) 문장이 성립해야 한다 — "확인 불가" 로 완성한다.
 */
function vixStaleNote(vix) {
  if (!vix?.stale) return '';
  const age = vix.ageMin != null ? `${vix.ageMin}분 전 값` : '확인 불가';
  return ` (VIX ${vix.value ?? '?'} — ${age}, 갱신 실패)`;
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
  // 🔴 밴드 판정은 그대로 — stale 표시는 사람이 읽는 문장에만 덧붙인다(vixStaleNote 참조)
  if (vb != null && va != null && va !== vb) t.push(`VIX ${VIX_BAND_LABEL[va]} → ${VIX_BAND_LABEL[vb]}${vixStaleNote(next?.vix)}`);
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
    // 🔴 표시를 버리지 않는다 — v?.stale/ageMin 이 여기서 사라지면 아래로 전달할 방법이 없다
    inputs.vixStale = Boolean(v?.stale);
    inputs.vixAgeMin = v?.ageMin ?? null;
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

// ── 시나리오 → 도구상자 카테고리 (판정 한 벌) ────────────────

/**
 * 🔴 발동 시나리오가 끌어올 카탈로그 카테고리 키를 정한다 — **판정은 이 한 함수** (2026-10-01).
 *
 * ## 왜 고쳤나
 * 종전에는 `promptSection` 과 `candidateSection` 이 **각자** 이렇게 추측했다:
 * `for (key of catalog.categories) if (step.includes(key)) want.add(key)`
 * — 즉 스텝 문자열 안에 `tech_broad` 같은 **키가 문자 그대로 박혀 있어야만** 잡혔다.
 * 스텝을 심볼이나 한글로 쓰면 **조용히 0개**가 되는데, 도구상자가 비면 프롬프트가
 * "이 목록 밖 티커는 계좌 검증이 거부한다" 를 붙이므로 **매수 제안이 통째로 0** 이 된다.
 *
 * 실측(수정 전): `side_grind` 0개(스텝이 `QLD→QQQ` 라 키가 없다) ·
 * `fear_ladder` **kr_broad 하나뿐**(스텝이 `QQQ·SPY 계열` 이라 `tech_broad`·`sp_broad` 가 없다)
 * ⇒ VIX 사다리가 발동하는 **바로 그 순간, 사라고 한 종목이 화이트리스트 밖**이었다.
 *
 * ## 왜 한 함수인가
 * 같은 로직이 두 곳에 **복제**돼 있던 것이 이 결함의 뿌리다 — 복제된 자는 갈라진다.
 * 프롬프트(도구상자)와 후보 산출이 서로 다른 집합을 보면, 모델에게 보여준 목록과
 * 실제 후보가 어긋나도 아무도 모른다.
 *
 * ⚠️ `categories` 가 **없는** 시나리오(사용자가 손으로 추가할 수 있다)는 옛 추측으로
 *    떨어지되 **반드시 warn 을 남긴다** — 조용히 0개가 되면 지금 결함이 그대로 재발한다.
 * ⚠️ 카탈로그에 없는 키는 **그 키만 버리고 warn** — 조용히 버리면 오타가 영원히 안 보인다.
 *
 * @returns {string[]} 카탈로그에 실재하는 카테고리 키 (선언 순서 유지)
 */
function scenarioCategories(sc, catalog) {
  const known = catalog?.categories || {};
  if (Array.isArray(sc?.categories)) {
    const out = [];
    for (const raw of sc.categories) {
      const key = String(raw);
      if (!Object.prototype.hasOwnProperty.call(known, key)) {
        logWarn('regime.playbook_unknown_category', { scenario: sc.id ?? null, category: key });
        continue;
      }
      if (!out.includes(key)) out.push(key);
    }
    return out;
  }
  // ── 폴백: 옛 부분문자열 추측 (조용히 0개가 되는 그 경로다 — 그래서 시끄럽게 한다)
  logWarn('regime.playbook_categories_missing', { scenario: sc?.id ?? null });
  const out = [];
  for (const st of sc?.steps || []) {
    for (const key of Object.keys(known)) if (st.includes(key) && !out.includes(key)) out.push(key);
  }
  return out;
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
      /**
       * 국면별 모델 포트폴리오 기준선 (2026-09-24) — 제안은 이 기준선과의 괴리를 줄이는 방향.
       * ⚠️ 울타리가 아니라 나침반(사용자 결정: 비율 상한 강제 없음).
       */
      if (sc.modelPortfolio) {
        const mp = Object.entries(sc.modelPortfolio).filter(([k]) => k !== '_설명');
        lines.push(`  기준 배분: ${mp.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
        if (sc.modelPortfolio._설명) lines.push(`  (${sc.modelPortfolio._설명})`);
      }
      for (const st of sc.steps) lines.push(`- ${st}`);
      // 🔴 판정은 scenarioCategories 한 곳 — candidateSection 과 같은 함수를 탄다(두 벌이면 갈라진다)
      for (const key of scenarioCategories(sc, catalog)) wantCats.add(key);
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
const CANDIDATE_MAX = 6;

/**
 * 🔴 **시나리오 라운드로빈** — 발동한 매뉴얼마다 최소 한 칸을 보장한다 (2026-10-01).
 *
 * 종전에는 시나리오를 **순서대로** 돌며 채웠다. 그래서 앞 시나리오가 상한 6을 혼자
 * 먹으면 **뒤 시나리오는 한 칸도 못 받았다.** 실측: `side_grind`(카테고리 6개)가 혼자
 * 상한을 채워 함께 발동한 `fear_ladder` 의 **SPY 가 통째로 밀렸다** — 공포 사다리가
 * 사라고 지목한 바로 그 종목이다.
 *
 * ★ 이것은 09-24 에 고친 병이 **한 층 위에서 재발한 것**이다. 그때는 *카테고리* 하나가
 *   두 칸을 먹어 인버스가 잘렸고(처방: 카테고리당 1개), 지금은 *시나리오* 하나가 여섯
 *   칸을 먹어 뒤 시나리오가 통째로 잘렸다. **같은 처방을 그 층에 적용한다.**
 * ★ 상한을 올리는 것은 이 비대칭을 **없애지 않고 뒤로 미룰 뿐**이다(시나리오가 셋이면
 *   다시 같은 일이 난다) — 그래서 상한 6은 그대로 둔다.
 *
 * ⚠️ **발동 시나리오가 하나뿐이면 결과가 종전과 글자 그대로 같다**(한 줄에서 1개씩 빼는
 *    것 = 순차). 단일 발동이 압도적으로 흔하므로 거기서 회귀를 내면 안 된다 —
 *    `playbookCatalogWiring.test.js` 가 6종 전부를 **순서까지** 못박는다.
 * ⚠️ **카테고리당 1개·같은 심볼 1회는 전역 규칙**이다(시나리오별이 아니다) — 두 시나리오가
 *    `gold` 를 공유해도 GLD 는 한 번만 나온다. 라운드로빈이 그 규칙을 깨면 안 된다.
 */
function roundRobinCandidates(scenarios, catalog, held) {
  // 시나리오별 '카테고리 줄' — 각 칸은 그 카테고리에서 쓸 수 있는 ETF 후보들(선언 순서)
  const queues = scenarios.map((sc) => scenarioCategories(sc, catalog).map((key) => ({
    key,
    // 1배(정방향·인버스 -1 포함 — 인버스 헤지는 사용자 결정 09-24) · 미보유 · KR 은 원화 현금이 있어야 의미
    etfs: catalog.categories[key].etfs.filter(
      (e) => Math.abs(e.leverage) === 1 && !held.has(e.symbol) && e.market !== 'KR'
    ),
  })));
  const cursor = queues.map(() => 0);
  const usedCats = new Set();
  const usedSyms = new Set();
  const wanted = [];
  let progressed = true;
  // 한 바퀴에 시나리오마다 1개씩 — 아무도 못 집으면 멈춘다(큐 고갈 = 무한루프 방지)
  while (wanted.length < CANDIDATE_MAX && progressed) {
    progressed = false;
    for (let i = 0; i < queues.length && wanted.length < CANDIDATE_MAX; i += 1) {
      while (cursor[i] < queues[i].length) {
        const slot = queues[i][cursor[i]];
        cursor[i] += 1;
        if (usedCats.has(slot.key)) continue; // 🔴 카테고리당 1개 — 전역
        const e = slot.etfs.find((x) => !usedSyms.has(x.symbol)); // 🔴 같은 심볼 1회 — 전역
        if (!e) continue;
        usedCats.add(slot.key);
        usedSyms.add(e.symbol);
        /**
         * ⚠️ `scenarioIdx` = **그 칸을 실제로 집어 간 시나리오**. 공정성을 검사하려면
         *    "내 카테고리가 채워졌나" 가 아니라 "내가 집었나" 를 봐야 한다 — 카테고리를
         *    공유하면(예: side_grind·fear_ladder 가 둘 다 tech_broad) 남이 채운 것을 보고
         *    **자기가 받은 줄 착각**한다. 실제로 첫 판 테스트가 그 착각으로 변이를 놓쳤다.
         */
        wanted.push({ symbol: e.symbol, name: e.name, category: catalog.categories[slot.key].name, categoryKey: slot.key, scenarioIdx: i });
        progressed = true;
        break;
      }
    }
  }
  return wanted;
}

async function candidateSection(scenarios, { heldSymbols = [], summarize, getCandles } = {}) {
  if (!scenarios?.length || typeof summarize !== 'function' || typeof getCandles !== 'function') return '';
  const catalog = readCatalog();
  const held = new Set(heldSymbols.map((s) => String(s).toUpperCase()));
  // 🔴 판정은 scenarioCategories 한 곳 — promptSection(도구상자)과 반드시 같은 집합이어야 한다.
  //    어긋나면 "모델에게 보여준 목록" 과 "후보로 시세를 뜬 목록" 이 갈라지는데 아무도 모른다.
  const wanted = roundRobinCandidates(scenarios, catalog, held);
  const lines = [];
  for (const w of wanted) {
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

/**
 * 🔴 VIX 공포 사다리 — **코드가 제안을 만든다** (2026-09-24 백테스트 실증).
 *
 * 백테스트에서 VIX 27(2단계) 정면인데 모델이 매수를 안 냈고, 그 미집행이 -14.7% vs
 * 벤치 -0.7% 의 큰 몫이었다(회복 구간을 현금으로 구경). 프롬프트 강화는 3전 3패 —
 * 사다리는 **기계적 규칙**(밴드 상승 전이 × 단계 금액 × 1배 광범위)이라 LLM 판단이
 * 필요 없는 자리다. 판단은 코드, 승인은 사람(HITL 불변 — 이 함수는 제안 내용만 만든다).
 *
 * @returns [{symbol, side:'BUY', budget, band, reason}] — 수량·가격은 호출자가 시세로 확정
 * ⚠️ 전이(prev<next)에서만 — 같은 밴드에 머무는 동안 반복 제안하지 않는다(엣지 규율).
 * ⚠️ 사용자 확정(09-24): 단계 금액 = 가용 현금의 10/20/30/40%.
 *
 * 🔴 **stale 이어도 그대로 발화한다 — 발화 조건은 바꾸지 않는다** (2026-09-28, pm1 설계 결정).
 *    사다리의 존재 이유가 "LLM 은 공포에서 안 산다" 라 막으면 제일 필요한 순간에 안 산다.
 *    최종 결정은 HITL(사람 승인)이다 — 우리가 할 일은 판단을 대신하는 게 아니라 **사실을
 *    보여주는 것**이다. ⇒ `vixValue`/`vixStale`/`vixAgeMin` 을 받으면 `reason` 에 낡은
 *    정도를 적는다(신선하면 문구는 그대로 — 군더더기 금지).
 * ⚠️ **실제 호출부(`alertService.js`)는 아직 이 파라미터를 안 넘긴다** — 그 파일은 범위
 *    밖이라 여기서는 건드리지 않는다(보고 참조). 안 넘기면 `vixStale` 기본값 false 라
 *    reason 은 종전과 동일하다(회귀 없음).
 */
const LADDER_PCT = [null, 0.10, 0.20, 0.30, 0.40];
function ladderProposals({
  prevBand = null, band = null, cashUsd = 0, vixValue = null, vixStale = false, vixAgeMin = null,
} = {}) {
  if (band == null || prevBand == null || band <= prevBand) return [];
  if (!(cashUsd > 0)) return [];
  const out = [];
  const staleNote = vixStaleNote({ stale: vixStale, value: vixValue, ageMin: vixAgeMin });
  // 여러 밴드를 한 번에 건너뛰면(22→33) 지나간 단계도 각각 — 단 금액은 그 시점 잔여 현금 기준 순차 차감
  let cash = cashUsd;
  for (let b = prevBand + 1; b <= band; b += 1) {
    const pct = LADDER_PCT[b];
    if (!pct) continue;
    const budget = Math.floor(cash * pct);
    if (budget < 10) continue;
    cash -= budget;
    out.push({
      symbol: 'QQQ', side: 'BUY', budget, band: b,
      reason: `VIX 공포 사다리 ${b}단계(사용자 규칙) — 가용 현금의 ${pct * 100}% 를 1배 광범위에 분할 매수${staleNote}`,
    });
  }
  return out;
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
  refresh, getState, setManual, readPlaybook, readCatalog, candidateSection, ladderProposals,
  scenarioCategories, roundRobinCandidates, CANDIDATE_MAX,
  vixStaleNote, VIX_BAND_LABEL, TREND_KO,
};
