const fs = require('node:fs');
const path = require('node:path');
const telegram = require('./telegramService');
const bot = require('./telegramBot');
const tape = require('./tickerTapeService');
const toss = require('./tossClient');
const tossPortfolio = require('./tossPortfolio');
const { resolveSession } = require('./marketCalendar');
const marketCalendar = require('./marketCalendar');
const trigger = require('./analystTrigger');
const { getDashboardSettings, updateSettings } = require('./settingsService');
const { APP_TIMEZONE, kstDay } = require('./time');
const activity = require('./activityLog');
const { logInfo, logWarn, logError } = require('./logger');

/**
 * 자동 알림 (2026-09-21)
 *
 * 사용자: *"매수매도제안, 시황, 시장 개장/폐장, 돌발 상황, 증시 관련 정보, 어닝콜,
 * 이벤트 발생, 주가 급변, 모멘텀 발생 등 … aim-monitor 처럼 ntfy 말고 텔레그램으로."*
 *
 * ## 🔴 붙이기 전에 있던 사실
 *
 * 전수로 훑어 보니 **자동 발송이 0건**이었다. `notifyMomentum` 은 구현돼 있는데
 * **호출부가 없어서** `TELEGRAM_SEND_ENABLED=true` 로 켜 놓고도 아무것도 안 나갔다.
 * (*"스위치가 켜졌다" 와 "그 경로가 돈다" 는 다르다* — 오늘 여러 번 본 그 가족이다.)
 * ⇒ 이 파일이 그 **호출부**다.
 *
 * ## 무엇을 보내고 무엇을 못 보내나 — **정직하게 가른다**
 *
 * ```
 * ✅ 매수/매도 제안   orderService 에 제안이 생기면 **승인/취소 버튼과 함께**
 * ✅ 시장 개장/폐장   marketCalendar 상태 **전이**에서만
 * ✅ 주가 급변        보유·관심 종목 당일 등락 임계 초과
 * ✅ 모멘텀           위와 같은 축이지만 **보유분 전용**(있던 함수를 이제 실제로 부른다)
 * ✅ 증시 급변        지수·원자재·코인(테이프 29종) 임계 초과
 * ✅ 돌발/이벤트      종목 경고(투자주의·거래정지 등) **신규 발생**
 * ❌ 어닝콜           **데이터가 없다.** 토스 API 에도 야후 테이프에도 일정이 없다.
 *                    지어내지 않는다 — 넣으려면 별도 출처가 필요하다
 * ⚠️ 시황             `/api/analyst/run` 을 자동으로 돌리지 **않는다**. LLM 비용이
 *                    주기적으로 발생하고, 사용자가 화면에서 누르면 텔레그램 버튼이 이미 있다.
 *                    개장·폐장 알림에 **요약 수치**만 함께 싣는다
 * ```
 *
 * ## 🔴 소음을 만들면 사람이 알림을 끈다
 *
 * 그러면 **정작 중요한 것도 안 보게 된다.** 그래서:
 * ```
 * 상태 전이에서만   개장/폐장은 "바뀐 순간" 한 번. 매 틱마다 "지금 장 중" 이 아니다
 * 종목·방향·하루    같은 종목 같은 방향 급변은 하루 한 번
 * 조용한 시간       기본 23:00~07:00 은 **제안 외에는** 보내지 않는다
 * 기본 꺼짐         ALERTS_ENABLED 없으면 한 건도 안 나간다
 * ```
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = process.env.ALERTS_STATE_FILE || path.join(DATA_DIR, 'alerts-state.json');

/** 🔴 기본 꺼짐 */
const ENABLED = String(process.env.ALERTS_ENABLED || '').trim().toLowerCase() === 'true';
const TICK_MS = Math.max(60_000, Number(process.env.ALERTS_TICK_MS) || 5 * 60_000);
/** 종목 당일 등락 임계(%) */
const MOVE_PCT = Math.max(1, Number(process.env.ALERTS_MOVE_PCT) || 5);
/** 지수·원자재 임계(%) — 종목보다 낮게 잡는다(지수가 3% 움직이면 큰 일이다) */
const INDEX_PCT = Math.max(0.5, Number(process.env.ALERTS_INDEX_PCT) || 2.5);
const QUIET_FROM = Number(process.env.ALERTS_QUIET_FROM ?? 23);
const QUIET_TO = Number(process.env.ALERTS_QUIET_TO ?? 7);

let timer = null;
let lastTickAt = null;
let lastError = null;
let sentCount = 0;

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    logError('alerts.state_write_failed', e, {});
  }
}

function kstHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIMEZONE, hour: '2-digit', hour12: false }).format(now));
}
// 🔴 kstDay 는 `./time` 로 옮겼다(2026-09-28) — tossClient.js·analystTrigger.js 도 같은 걸 쓴다.

/** 조용한 시간인가. ⚠️ **제안은 예외** — 사람이 기다리는 것이라 늦춰서는 안 된다 */
/**
 * 🔴 **분석을 언제 돌릴지** (2026-09-21 사용자 지시: *"장마감 + 모멘텀 발생시점에만"*)
 *
 * 실행 자체는 여기서 안 한다 — 대시보드 조립·LLM 은 `server.js` 가 쥐고 있고
 * 여기서 직접 부르면 순환 참조가 된다(`onProposed` 와 같은 이유). **판정만** 하고 넘긴다.
 */
let analystRunner = null;
/** 분석은 88초쯤 걸린다 — 틱이 5분이라 **겹칠 수 있다.** 겹치면 건너뛴다 */
let analystRunning = false;
function setAnalystRunner(fn) { analystRunner = typeof fn === 'function' ? fn : null; }

/**
 * 감시 대상의 **일간 변동 + 과거 분포**를 모은다.
 * ⚠️ 과거 일봉은 **하루 한 번만** 받아 상태에 캐시한다 — 틱마다 받으면 5분에 한 번씩
 *    토스 한도를 태운다(그 종목의 어제까지 분포는 오늘 안 바뀐다).
 */
/**
 * 🔴 감시 종목도 **실시간 등락**으로 판정한다 (2026-09-24 사용자 지적 후 수정).
 *
 * 종전: 보유만 실시간(dailyRate), 감시는 "일봉 마지막 변화" 를 **하루 1회 캐시** —
 * 미장이 밤새 움직여도 감시 41종의 change 는 아침 값 그대로였다. **장중 급등락을
 * 원리상 못 봤고**, 실측으로 미장 내내 모멘텀 후보 0 이 그 증거였다(IonQ +9.8% 인 날에도).
 *
 * 지금: 틱마다 감시 심볼 전체를 `getPrices` **1콜**(200종목/콜·15콜/s — 비용 무시 수준)로
 * 받아 **전일 확정 종가 대비**를 계산한다. 전일 종가는 캔들에서 — ⚠️ 마지막 봉이
 * "오늘 진행 중 봉" 인지 "어제 확정 봉" 인지는 **봉 타임스탬프의 날짜로 판정**한다
 * (추측하면 US 종목이 KST 날짜 경계에서 하루 밀린다). 분포(hist)도 확정 봉만 담는다.
 * getPrices 실패 시 종전 방식으로 폴백하되 warn — 조용히 눈멀지 않는다.
 */
async function collectMomentumRows(st, universe, items, now) {
  const bySymbol = new Map((items || []).map((it) => [String(it.symbol).toUpperCase(), it]));
  /**
   * 🔴 **KST 날짜다 — UTC 가 아니다** (2026-09-28 라이브 실측, marketCalendar 캐시 키와
   *    같은 병). 292·373·488행은 이미 `kstDay(now)` 를 쓰는데 이 캔들 캐시 키만 UTC 였다
   *    ⇒ KST 08:00 프리장 창엔 **어제 캔들을 그대로 재사용**해 모멘텀 감시가 하루 묵는다.
   */
  const day = kstDay(now);
  st.candleCache = st.candleCache || {};
  const rows = [];

  // ① 감시(미보유) 심볼의 실시간가 — 한 콜로
  const unheld = Object.keys(universe || {}).filter((s) => !bySymbol.has(s));
  let liveMap = new Map();
  if (unheld.length) {
    try {
      liveMap = await toss.getPrices(unheld);
    } catch (e) {
      logWarn('analyst.trigger_live_prices_failed', { symbols: unheld.length, kind: e?.kind, message: e?.message });
    }
  }

  for (const [sym, meta] of Object.entries(universe || {})) {
    let cached = st.candleCache[sym]?.day === day ? st.candleCache[sym] : null;
    if (!cached || !Array.isArray(cached.bars)) {
      try {
        const c = await toss.getCandles(sym, { interval: '1d', count: 60 });
        const bars = (c.rows || [])
          .filter((r) => Number.isFinite(r.c))
          .map((r) => ({ t: String(r.t || '').slice(0, 10), c: r.c }));
        st.candleCache[sym] = { day, bars: bars.slice(-45) };
        cached = st.candleCache[sym];
      } catch (e) {
        // 🔴 못 받으면 **판정하지 않는다** — 빈 분포로 z 를 내면 아무 날이나 이상해 보인다
        logWarn('analyst.trigger_history_failed', { symbol: sym, kind: e?.kind, message: e?.message });
        continue;
      }
    }

    const held = bySymbol.get(sym);
    const live = held?.dailyRate != null ? null : liveMap.get(sym);
    // 진행 중 봉 판정: 시세 타임스탬프의 날짜와 마지막 봉 날짜가 같으면 진행 봉(확정 봉만 남긴다)
    let bars = cached.bars;
    if (live?.at) {
      const liveDay = String(live.at).slice(0, 10);
      if (bars.length && bars[bars.length - 1].t === liveDay) bars = bars.slice(0, -1); // 확정 봉만
    } else if (bars.length) {
      /**
       * 🔴 **시세 타임스탬프가 없다 — 우리 시계로 날짜를 추측하지 않는다** (2026-09-28).
       *    비교 상대(`bars[].t`)는 **거래소가 준 날짜**다(US 종목이면 미국 거래일). 여기서
       *    UTC 든 KST 든 우리 시간대로 추측하면 오히려 날짜가 어긋난다 — 바로 이 파일에서
       *    막 고친 KST/UTC 캐시 키 사고와 같은 함정이라, "더 나은 추측"으로 바꾸지 않는다.
       *    ⚠️ **보유 종목은 `live` 를 아예 안 받으므로**(바로 위 `held?.dailyRate` 분기) 이
       *    경로를 **항상** 탄다 — 드문 예외가 아니다. 실제 빈도는 이 warn 으로 잰다.
       *    ⇒ **모르면 마지막 봉을 확정 봉으로 단정하지 않는다** — "hist 는 확정 봉만 담는다"
       *    는 불변식을 지키려고 보수적으로 버린다(하루 덜 정확해지는 대가는 감수한다. 안
       *    버리면 아직 움직이는 값이 "전일 종가" 로 굳어 등락률이 거짓이 될 수 있다 — 그게 더 나쁘다).
       *
       * ⚠️ **보유 종목에는 warn 을 남기지 않는다** — 위 분기가 `live` 를 **일부러** 안 주므로
       *    보유 전 종목이 매 틱(5분) 이 경로를 탄다. 그대로 두면 하루 수백 건이 쌓여 **정작
       *    이상한 경우(감시 심볼을 달라고 했는데 안 온 것)를 묻어 버린다.** 오탐하는 경고는
       *    있으나 마나가 아니라 해롭다 — 사람이 로그를 안 보게 만든다. 트림은 양쪽 다 한다.
       */
      if (!held) logWarn('analyst.trigger_live_at_missing', { symbol: sym, role: meta.role });
      bars = bars.slice(0, -1);
    }
    const closes = bars.map((b) => b.c);
    const hist = [];
    for (let i = 1; i < closes.length; i += 1) hist.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);

    let change = null;
    if (held?.dailyRate != null) {
      change = Number(held.dailyRate); // 보유 = 증권사가 준 실시간 등락
    } else if (live?.price != null && closes.length) {
      change = ((live.price - closes[closes.length - 1]) / closes[closes.length - 1]) * 100; // 감시 = 실시간가 vs 전일 확정 종가
    } else if (hist.length) {
      change = hist[hist.length - 1]; // 폴백: 종전 방식(확정 봉 변화) — warn 은 위에서 이미 남았다
    }
    if (!Number.isFinite(change)) continue;
    rows.push({ symbol: sym, dailyChangePct: Math.round(change * 100) / 100, history: hist, role: meta.role });
  }
  // 캐시에서 감시 대상 밖은 버린다
  for (const k of Object.keys(st.candleCache)) if (!universe[k]) delete st.candleCache[k];
  return rows;
}

/**
 * 장마감 판정 대상 — **보유·감시 중인 시장만** 본다(사용자 승인 ③).
 * 지금은 둘 다 미국이라 **05시 한 번**이고, 국내 종목을 사면 15:30 이 자동으로 붙는다.
 */
async function sessionsFor(universe, now) {
  /**
   * 🔴 **두 시장을 항상 본다** (2026-09-22 — 정기 브리핑 6회 체계).
   *
   * 종전엔 `universe` 에 있는 시장만 봤다. 그런데 사용자 보유·감시가 **전부 미국**이라
   * 한국 시장이 집합에 **한 번도 안 들어갔고**, 그러면 *"미장/국장 하루 6번"* 지시에도
   * **국장 브리핑이 원리상 안 뜬다**(실측: universe 11종목 중 한국 0개).
   * ⇒ 사용자는 *"국장 브리핑이 안 오네"* 로 겪고, 로그에는 **아무 흔적도 없다** —
   *    트리거가 실패한 게 아니라 **애초에 후보에 없었기 때문**이다.
   *
   * ⚠️ 보유가 없어도 **증시 시황**은 브리핑 대상이다(사용자가 "증시상황 전반적 분석" 을 요구했다).
   * ⚠️ 시장을 늘려도 **캘린더 호출은 안 늘어난다** — `loadCalendar` 가 시장별 하루 1회 캐시다.
   */
  const markets = new Set(['kr', 'us']);
  for (const sym of Object.keys(universe || {})) markets.add(/^\d{6}$/.test(sym) ? 'kr' : 'us');
  /**
   * 🔴 **실제 캘린더로 판정한다** (2026-09-22). 종전 하드코딩은 실제와 어긋나 있었다:
   *    KRX `09~16` vs 실제 **15:30 마감** · 미국장 `22~06` vs 실제 **22:30~05:00**.
   *    ⇒ 마감 트리거가 KR 은 30분 늦고, US 는 1시간 늦게 돌았다.
   * ⚠️ 폴백을 쓰면 **로그에 남긴다** — 조용히 옛 추정으로 돌아가면 "붙였다" 고 믿게 된다.
   */
  const spec = { kr: ['KRX', 9, 16], us: ['미국장', 22, 6] };
  const out = [];
  for (const k of markets) {
    const r = await marketCalendar.resolveSessionLive(now, k.toUpperCase(), spec[k][1], spec[k][2], APP_TIMEZONE);
    if (r.source === 'fallback') {
      logWarn('alerts.session_fallback', { market: k, why: r.why, error: r.error || null });
    }
    /**
     * 🔴 **`regular{start,end}` 를 함께 넘긴다** (2026-09-22) — 정기 브리핑의 **중간 시점**을
     *    여기서 유도하기 때문이다. 종전엔 `state` 만 넘기고 **시간대를 버렸다**(또 "수집해 놓고 안 쓰는").
     * ⚠️ 폴백 경로에는 `regular` 가 **없다** ⇒ 중간 브리핑은 캘린더가 살아 있을 때만 돈다.
     *    그게 맞다 — 시각을 추측해서 중간이라고 우기면 조기폐장일에 **장 끝난 뒤 "중간 보고"** 가 나간다.
     */
    // 🔴 preSpan 도 함께 넘긴다(2026-09-27, 프리장 브리핑) — 폴백 경로엔 없다(regular 와 같은 사정)
    out.push({ key: k, label: spec[k][0], state: r.state, source: r.source, why: r.why || null, regular: r.regular || null, preSpan: r.preSpan || null });
  }
  return out;
}

function isQuiet(now = new Date()) {
  const h = kstHour(now);
  return QUIET_FROM > QUIET_TO ? h >= QUIET_FROM || h < QUIET_TO : h >= QUIET_FROM && h < QUIET_TO;
}

function status() {
  const st = readState();
  return {
    enabled: ENABLED,
    reason: ENABLED ? null : 'disabled',
    running: Boolean(timer),
    tickMs: TICK_MS,
    lastTickAt,
    lastError,
    sentCount,
    movePct: MOVE_PCT,
    indexPct: INDEX_PCT,
    quiet: `${QUIET_FROM}:00~${QUIET_TO}:00`,
    // 🔴 무엇을 못 보내는지도 함께 — 사용자가 "왜 어닝콜은 안 오지" 를 겪지 않게
    rules: ['개장/폐장(+마감 요약)', '지수 급변', '보유 급변', '목표가·손절선', '종목 경고', '매매 제안', '예약(조건부) 주문 발동/만료'],
    unsupported: ['어닝콜 — 일정 데이터 출처가 없다(토스·야후 모두 미제공)'],
    marks: Object.keys(st).length,
  };
}

// ── 규칙들 ───────────────────────────────────────────────────

/** 🔔 시장 개장/폐장 — **상태가 바뀐 순간에만** */
async function ruleSessions(st, now, out, sup, items, summary) {
  /**
   * 🔴 **정본이 셋이었고 셋 다 다른 답을 냈다** (2026-09-22 실측, 05:21 KST = 미국 마감 21분 뒤):
   * ```
   *   화면(marketDataService, 22~5)  pre     ← "장 전"  ❌
   *   경보(여기, 22~6)               open    ← "장중"   ❌ 폐장 알림이 1시간 늦는다
   *   애널리스트(캘린더)             closed  ← 정답
   * ```
   * 내가 캘린더를 붙일 때 **애널리스트만 갈아끼우고 나머지를 안 훑었다.**
   * ⇒ 셋 다 `resolveSessionLive` 하나를 본다. 조기폐장·서머타임·공휴일까지 따라간다.
   */
  for (const [key, label, s, e] of [['kr', 'KRX', 9, 16], ['us', '미국장', 22, 6]]) {
    const cur = (await marketCalendar.resolveSessionLive(now, key.toUpperCase(), s, e, APP_TIMEZONE)).state;
    const mark = `session:${key}`;
    if (st[mark] === cur) continue;
    const was = st[mark];
    st[mark] = cur;
    // 첫 실행에는 안 보낸다 — 기준선이 없어서 "바뀐 것" 이 아니다
    if (!was) { sup.push(`${label} 상태 기준선 설정(${cur})`); continue; }
    if (cur === 'closed') {
      // 🔴 폐장은 **요약과 함께** — 알림 하나로 그날이 정리된다(사용자 지시)
      out.push({ text: closeSummary(items, summary, label), kind: 'close' });
    } else {
      out.push({ text: `🔔 ${label} ${cur === 'open' ? '개장' : '장 전'}`, kind: 'session' });
    }
  }
}

/** 📈 지수·원자재·코인 급변 — 하루 한 번씩 */
async function ruleIndices(st, now, out, sup) {
  const t = await tape.getTape();
  const day = kstDay(now);
  for (const i of t.items || []) {
    if (i.changePct == null || Math.abs(i.changePct) < INDEX_PCT) continue;
    const dir = i.changePct >= 0 ? 'up' : 'down';
    const mark = `idx:${i.symbol}:${dir}:${day}`;
    // 🔴 이미 알린 것을 **세어 둔다** — 안 세면 `found:0` 이 "없다" 인지 "걸렀다" 인지 모른다
    if (st[mark]) { sup.push(`${i.label} (오늘 이미 알림)`); continue; }
    st[mark] = 1;
    out.push({
      text: `📈 ${i.label} ${i.changePct >= 0 ? '+' : ''}${i.changePct.toFixed(2)}% (${i.prefix || ''}${Number(i.price).toLocaleString('ko-KR')}${i.suffix || ''})`,
      kind: 'index',
    });
  }
}

/** 📊 보유 종목 급변 + ⚠️ 종목 경고 신규 */
/**
 * 🎯 목표가·손절가 통과 (2026-09-21 사용자 지시).
 *
 * ★ **사람이 정한 기준이라 오경보가 없다** — 그래서 알림 축으로 값이 크다.
 *   급변(5%)은 시장이 정하지만 이건 사용자가 정한다.
 *
 * 🔴 **통과할 때 한 번만** 알린다. 하루 한 번이 아니라 **상태 전이**다 —
 *    목표가를 넘은 뒤 계속 위에 있으면 매 틱 알릴 이유가 없고,
 *    아래로 내려갔다 다시 넘으면 그건 **새 사건**이다.
 * ⚠️ 통화를 환산하지 않는다 — 사용자가 그 종목 화면에서 보는 단위로 적는다.
 */
function ruleTargets(items, st, out, sup) {
  const targets = getDashboardSettings().targets || {};
  for (const h of items) {
    const t = targets[String(h.symbol).toUpperCase()];
    if (!t || h.lastPrice == null) continue;
    const px = Number(h.lastPrice);

    for (const [kind, line, hit] of [
      ['target', t.target, t.target != null && px >= t.target],
      ['stop', t.stop, t.stop != null && px <= t.stop],
    ]) {
      if (line == null) continue;
      const mark = `line:${h.symbol}:${kind}`;
      if (hit && !st[mark]) {
        st[mark] = 1;
        const icon = kind === 'target' ? '🎯' : '🛑';
        const word = kind === 'target' ? '목표가 도달' : '손절선 이탈';
        out.push({
          text: `${icon} ${h.name} ${word} — 기준 ${Number(line).toLocaleString('ko-KR')} · 현재 ${px.toLocaleString('ko-KR')}`
            + ` (평가손익 ${h.profitRate >= 0 ? '+' : ''}${Number(h.profitRate).toFixed(2)}%)`,
          kind: `line-${kind}`,
        });
      } else if (hit && st[mark]) {
        sup.push(`${h.name} ${kind === 'target' ? '목표가' : '손절선'} (이미 통과 상태)`);
      } else if (!hit && st[mark]) {
        // 🔴 되돌아왔으면 표시를 **지운다** — 안 지우면 다음 통과를 영영 못 알린다
        delete st[mark];
      }
    }
  }
}

/**
 * 🔔 장 마감 요약 — 폐장 전이에서 **한 번**.
 * ★ 하루 한 번이라 소음이 없고, 그날 무슨 일이 있었는지 한 줄로 남는다.
 */
function closeSummary(items, summary, label) {
  if (!items.length) return `🔔 ${label} 폐장 — 보유 정보를 받지 못했습니다.`;
  const sorted = [...items].filter((h) => h.dailyRate != null).sort((a, b) => b.dailyRate - a.dailyRate);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const lines = [`🔔 ${label} 폐장 · 오늘 요약`];
  if (summary) {
    lines.push(`평가 ${Math.round(summary.value?.krw || 0).toLocaleString('ko-KR')}원`
      + ` · 오늘 ${summary.dailyRate >= 0 ? '+' : ''}${Number(summary.dailyRate ?? 0).toFixed(2)}%`
      + ` · 누적 ${summary.profitRate >= 0 ? '+' : ''}${Number(summary.profitRate ?? 0).toFixed(2)}%`);
  }
  // ⚠️ 종목이 하나면 best 와 worst 가 같다 — 같은 줄을 두 번 쓰지 않는다
  if (best) lines.push(`▲ ${best.name} ${best.dailyRate >= 0 ? '+' : ''}${best.dailyRate.toFixed(2)}%`);
  if (worst && worst.symbol !== best?.symbol) lines.push(`▼ ${worst.name} ${worst.dailyRate.toFixed(2)}%`);
  return lines.join('\n');
}

async function rulePortfolio(items, st, now, out, sup) {
  const day = kstDay(now);
  for (const h of items) {
    if (h.dailyRate != null && Math.abs(h.dailyRate) >= MOVE_PCT) {
      const dir = h.dailyRate >= 0 ? 'up' : 'down';
      const mark = `move:${h.symbol}:${dir}:${day}`;
      if (st[mark]) sup.push(`${h.name} (오늘 이미 알림)`);
      if (!st[mark]) {
        st[mark] = 1;
        out.push({
          text: `📊 보유 ${h.name} ${h.dailyRate >= 0 ? '+' : ''}${h.dailyRate.toFixed(2)}%`
            + ` · 평가손익 ${h.profitRate >= 0 ? '+' : ''}${Number(h.profitRate).toFixed(2)}%`,
          kind: 'move',
        });
      }
    }
    // ⚠️ 종목 경고 — **신규 발생만**. 이미 지정된 것을 매 틱 알리면 소음이다
    try {
      const w = await toss.getWarnings(h.symbol);
      const cur = (w || []).map((x) => x.type || x).sort().join(',');
      const mark = `warn:${h.symbol}`;
      if (cur && st[mark] !== cur) {
        st[mark] = cur;
        out.push({ text: `⚠️ ${h.name} 종목 경고: ${cur}`, kind: 'warning' });
      } else if (!cur && st[mark]) {
        delete st[mark];
      }
    } catch (e) {
      logWarn('alerts.warnings_failed', { symbol: h.symbol, message: e.message });
    }
    await new Promise((r) => setTimeout(r, 120)); // 한도 5/s
  }
}

/**
 * 🔭 예약(조건부) 주문 감시 — 전이만 알린다 (2026-09-27)
 *
 * `propose_conditional_order` → HITL 승인 → `createConditionalOrder` 로 거래소에
 * 건 뒤를 아무도 안 보고 있었다. 감시가에 닿아 **실제로 주문이 나갔는지**,
 * 만료일이 지나 **조용히 사라졌는지** 사용자가 몰랐다. 여기서 매 틱 열린 목록을
 * 직전과 비교해 **사라진 것만** 사유를 갈라 알린다(엣지 규율 — 다른 규칙들과 같다).
 *
 * 🔴 **`getConditionalOrder` 의 status 필드명은 실물로 확인된 적이 없다.**
 *    여러 후보 필드·값을 넉넉히 훑되, 확신 없는 값은 절대 '발동' 으로 단정하지 않는다
 *    (모르는 것을 발동이라 말하면 돈이 움직인 것처럼 읽힌다 — 이 파일의 지배 규율).
 *    대신 사라질 때마다 **원본 응답을 통째로 로그에 남긴다**(`alerts.conditional_detail`) —
 *    실물이 확인되면 위 후보 목록을 그 필드로 좁힐 것.
 */
function classifyConditionalOutcome(raw) {
  if (!raw || typeof raw !== 'object') return 'unknown';
  const s = String(raw.status ?? raw.state ?? raw.orderStatus ?? raw.conditionalStatus ?? '').toUpperCase();
  if (!s) return 'unknown';
  if (['TRIGGER', 'EXECUT', 'FILL', 'SENT', 'ORDERED', 'COMPLETE'].some((k) => s.includes(k))) return 'triggered';
  if (['EXPIR', 'CANCEL', 'DELET', 'CLOS', 'WITHDRAW'].some((k) => s.includes(k))) return 'ended';
  return 'unknown'; // 🔴 모르면 모른다고 한다 — '발동' 의 기본값이 아니다
}

/** 목록 응답 한 행에서 감시에 필요한 값만 뽑는다. 필드명은 후보를 넉넉히 본다(§위 주석과 같은 이유) */
function extractConditionalMeta(row) {
  const id = row?.conditionalOrderId ?? row?.id;
  if (id == null) return null;
  return {
    id: String(id),
    symbol: row?.symbol ?? row?.first?.symbol ?? '(알수없음)',
    triggerPrice: row?.first?.triggerPrice ?? row?.triggerPrice ?? row?.condition?.triggerPrice ?? null,
    expireDate: row?.expireDate ?? row?.expiryDate ?? null,
  };
}

async function ruleConditionalWatch(st, now, out, sup) {
  const listResp = await toss.listConditionalOrders({ status: 'OPEN' });
  // ⚠️ 목록 응답 모양도 실물 미확인 — `list_conditional_orders`(analystChat.js) 와 같은 방식으로 넉넉히 본다
  const rows = Array.isArray(listResp?.items) ? listResp.items : Array.isArray(listResp) ? listResp : [];
  const current = {};
  for (const row of rows) {
    const meta = extractConditionalMeta(row);
    if (meta) current[meta.id] = meta;
  }

  const prev = st.conditionalOpen;
  if (!prev) {
    // 🔴 첫 실행(직전 상태 없음) — 기준선만 잡는다. 재기동 때 있던 예약을 '끝났다' 로 오인하면 안 된다
    st.conditionalOpen = current;
    sup.push('예약 감시 기준선 설정');
  } else {
    const vanished = Object.keys(prev).filter((id) => !(id in current));
    for (const id of vanished) {
      const info = prev[id];
      let detail = null;
      let failedFetch = false;
      try {
        detail = await toss.getConditionalOrder(id);
      } catch (e) {
        failedFetch = true;
        logWarn('alerts.conditional_detail_failed', { id, symbol: info.symbol, message: e.message });
      }
      if (failedFetch) {
        out.push({ text: `예약 ${info.symbol} 이 목록에서 사라졌는데 사유를 확인하지 못했습니다.`, kind: 'conditional-unknown' });
        continue;
      }
      // 🔴 원본을 통째로 남긴다 — status 필드명이 확인되면 위 classifyConditionalOutcome 을 좁힐 근거
      logInfo('alerts.conditional_detail', { id, symbol: info.symbol, raw: detail });
      const outcome = classifyConditionalOutcome(detail);
      if (outcome === 'triggered') {
        out.push({ text: `🎯 예약 발동 — ${info.symbol} 감시가 ${info.triggerPrice ?? '?'} 도달, 주문 나갔습니다`, kind: 'conditional-triggered' });
      } else if (outcome === 'ended') {
        out.push({ text: `⏳ 예약 만료 — ${info.symbol}, 감시가 미도달로 소멸했습니다`, kind: 'conditional-expired' });
      } else {
        logWarn('alerts.conditional_status_unknown', { id, symbol: info.symbol, status: detail?.status ?? detail?.state ?? null });
        out.push({ text: `예약 ${info.symbol} 이 목록에서 사라졌는데 사유를 확인하지 못했습니다.`, kind: 'conditional-unknown' });
      }
    }
    st.conditionalOpen = current;
  }

  // ⏰ 만료 임박 — 오늘 만료되는 열린 예약이 있으면 하루 한 번(날짜 키 — idx 규칙과 같은 패턴)
  const day = kstDay(now);
  const expiringToday = Object.values(current).filter((v) => v.expireDate === day);
  if (expiringToday.length) {
    const mark = `condExpireWarn:${day}`;
    if (st[mark]) {
      sup.push('오늘 만료 예약 경고 (오늘 이미 알림)');
    } else {
      st[mark] = 1;
      out.push({
        text: `⏰ 오늘 만료되는 예약이 있습니다: ${expiringToday.map((v) => `${v.symbol}(감시가 ${v.triggerPrice ?? '?'})`).join(', ')}`,
        kind: 'conditional-expiring',
      });
    }
  }
}

/**
 * 🩺 정기 브리핑 누락 감시 (2026-09-27, pm1 위임 — worker3)
 *
 * 배경: 09-24 15:30 KRX 마감 브리핑이 배포 재기동에 삼켜져 트리거 자체가 **0건**이었다.
 * 위 `analyst.trigger_run_failed` catch 는 "돌다가 실패" 만 잡는다 — "애초에 안 돌았다"
 * 는 잡지 못하고, 그날 사용자에게 간 알림도 **0건**이었다(실패 통보 경로 자체가 안 불렸다).
 *
 * 🔴 **왜 `st.analyst`(analystTrigger 의 내부 전이 상태)로 판정하지 않나** — 그 상태 자체가
 *    "전이 감지를 놓치면 같이 놓친다"(정확히 09-24 사고의 그 축이다). 감시가 감시 대상과
 *    같은 실패 지점을 공유하면 바로 그 실패를 못 본다.
 * ⇒ **독립된 신호**를 쓴다: `analystService.readLast()` — 분석이 **실제로 끝나 저장까지
 *    마쳐야만** 갱신되는 산출물이라, 트리거·틱이 죽어도 이건 그냥 "안 갱신됨" 으로 남는다.
 * ⚠️ **한계(의도적으로 오탐 쪽으로 기운다)** — `analyst-last.json` 은 이어붙이기가 아니라
 *    마지막 1건만 남는다. 이 회차의 reasons 가 마지막 스냅샷에 없어도 `at` 이 기대 시각
 *    이후면 "그사이 뭔가는 돌았다"(시스템은 살아 있다) 로 보고 **알리지 않는다** —
 *    이 파일 첫머리의 규율(소음을 만들면 사람이 알림을 끈다)을 여기서도 따른다.
 */
/**
 * ⚠️ **프리장(08:00~09:00 KST, 한 시간)에도 이 유예를 그대로 쓴다** (2026-09-28 확인).
 *    20분 유예면 판정 시각이 08:20 — 정규장 개장(09:00) 한참 전이라 안전하다. 유예가
 *    창(1시간)보다 길어지면 판정이 정규장 개장 뒤로 밀리므로, 유예값을 늘릴 일이 있으면
 *    이 창을 먼저 다시 확인할 것.
 */
const BRIEF_GRACE_MS = 20 * 60_000;
const BRIEF_STALE_MS = 4 * 24 * 60 * 60_000; // 표시 정리 — st.briefWatch 가 무한히 자라지 않게
// 🔴 preopen 라벨은 analystTrigger.js 의 KIND_LABEL.preopen('프리장 개장')과 같은 문구여야 한다
//    — 두 곳이 다른 말을 하면 사용자가 다른 사건으로 읽는다.
const BRIEF_KIND_LABEL = { preopen: '프리장 개장', open: '개장', mid: '중간', close: '마감' };

function briefClock(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

/**
 * 캘린더 `regular{start,end}` 에서 오늘의 기대 회차(프리장·개장·중간·마감)를 유도한다.
 * ⚠️ 고정 시각 하드코딩 금지 — `regular` 가 없으면(휴장일 또는 캘린더 폴백) **회차가 없다**.
 *    폴백일 때 중간 브리핑을 안 돌리는 `analystTrigger.decide` 와 같은 규율이다.
 *
 * 🔴 **프리장(preopen) 회차 — 2026-09-28**: 오늘 KR 프리장 브리핑이 실제로 안 떴는데
 *    (원인은 캘린더 캐시 UTC 날짜 키 — 이미 고쳐 배포됨) 이 감시는 애초에 프리장을
 *    기대 회차로 안 세서 **원리상 아무 말도 못 했다**. 침묵이 정상으로 읽혀 더 나빴다.
 *    ⇒ `preSpan` 이 있을 때만(휴장일·캘린더 폴백·US 는 없음) 회차를 하나 더 만든다 —
 *    `regular` 없으면 회차를 안 만드는 것과 같은 규율. 시장 이름은 하드코딩하지 않는다
 *    (`preSpan` 유무로 자연히 KR 만 갈린다 — analystTrigger.js 의 `key !== 'kr'` 과 달리
 *    여기는 감시라 시장이 늘어도 그대로 따라가는 게 맞다).
 */
function briefOccasions(sessions) {
  const out = [];
  for (const s of sessions || []) {
    const pre = s?.preSpan;
    /**
     * 🔴 **US 프리장은 애초에 안 돈다 — 감시가 없는 사건을 기대했다** (2026-09-30 실측
     * — 17:20 KST에 "미국장 프리장 개장 브리핑이 예정 시각에 돌지 않았습니다" 오탐이
     * 사용자 폰으로 갔다). `analystTrigger.js`(280행)는 프리장 브리핑을 **KR 만** 낸다
     * — 2026-09-27 사용자 지시로 "US 프리(17:00) 까지 켜면 LLM 회차가 하루 1번 더 는다"
     * 는 이유로 일부러 뺐다. 그런데 이 감시(`briefOccasions`)는 `preSpan` 이 있으면
     * 시장을 안 가리고 회차를 만든다 — **트리거가 안 하는 일을 감시가 기대한 것**이다.
     * ⇒ 감시도 트리거와 같은 축(KR 만)으로 좁힌다. US 프리장을 켜려면 **둘 다** 고친다
     *    (analystTrigger.js 의 `key !== 'kr'` 도 함께 지운다 — 한쪽만 고치면 이 사고가
     *    반대 방향으로 재발한다: 이번엔 트리거가 살아도 감시가 못 본다).
     */
    if (pre && Number.isFinite(pre.start) && s?.key === 'kr') {
      out.push({ market: s.key, label: s.label, kind: 'preopen', at: pre.start });
    }
    const reg = s?.regular;
    if (!reg || !Number.isFinite(reg.start) || !Number.isFinite(reg.end)) continue;
    out.push({ market: s.key, label: s.label, kind: 'open', at: reg.start });
    out.push({ market: s.key, label: s.label, kind: 'mid', at: reg.start + (reg.end - reg.start) / 2 });
    out.push({ market: s.key, label: s.label, kind: 'close', at: reg.end });
  }
  return out;
}

/**
 * 🔴 **"확인된 휴장" 과 "캘린더를 못 읽어서 모른다" 를 가른다** (2026-09-28, 09-24·25 KR
 * 침묵 조사 후속 — pm1 승인).
 *
 * `briefOccasions` 는 `s.regular` 유무만 보고 회차를 만드는데, 그 둘은 원인이 다르다:
 * ```
 * source:'calendar' + regular:null   캘린더를 읽었고 오늘은 거래일이 아니다 — 확인된 휴장
 * source:'fallback'  + regular:null  캘린더를 못 읽었다(레이트리밋 등) — **모른다**
 * ```
 * 앞쪽은 회차가 없는 게 맞다(조용해야 한다 — 09-24·25 추석이 그랬다). 뒤쪽은 조용하면 안
 * 된다 — 09-24·25 는 실제로 휴장이었지만, **캘린더가 실패했을 때도 겉보기 증상이 똑같아서**
 * "휴장인가 보다" 로 오판하기 쉽다(그날 캘린더의 `MARKET_INFO` 버킷은 limit 3 이라 소진되면
 * 실제로 실패한다). ⇒ `source !== 'calendar'` 인데 `regular` 가 없으면 별도로 경고한다.
 *
 * ⚠️ **`source` 값을 열거하지 않는다(fail-loud)** — 알려진 값은 `'calendar'` 뿐이고,
 *    `resolveSessionLive`(marketCalendar.js)가 내는 다른 모든 값(`'fallback'` 포함, 미래에
 *    생길 수 있는 제3의 값도)은 "확인 안 됨" 으로 취급해 경고 쪽에 붙인다. `'fallback'` 을
 *    열거해 막으면 다음에 새 값이 생길 때 또 뚫린다.
 */
// 하루 한 번만 — occasion 마크(market:kind:epoch)와 같은 정리 규율을 타도록 날짜도 epoch 로
function kstDayEpoch(nowMs) {
  return Date.parse(`${kstDay(nowMs)}T00:00:00+09:00`);
}
function calendarUnknownMark(key, nowMs) {
  return `${key}:calendar_unknown:${kstDayEpoch(nowMs)}`;
}
/** `unconfigured` 면제 자체를 로그로 남기는 하루 1회 표시 — 위 마크와 **키를 가른다**(같으면 하나가 다른 하나를 덮는다) */
function calendarUnconfiguredMark(key, nowMs) {
  return `${key}:calendar_unconfigured_skip:${kstDayEpoch(nowMs)}`;
}

async function ruleBriefWatch(st, now, out, sup) {
  const analystService = require('./analystService');
  st.briefWatch = st.briefWatch || {};
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  /**
   * 🔴 **첫 실행엔 기준선만** — `ruleSessions` 와 같은 규율. 이 표시가 없다는 건 이 기능이
   *    방금 배포됐다는 뜻이지, 오늘 회차가 실제로 빠졌다는 뜻이 아니다. 소급 경고하면
   *    배포 직후 그날 지난 회차 전부가 한꺼번에 쏟아진다.
   */
  const firstRun = !st.briefWatchSeeded;
  st.briefWatchSeeded = true;

  const sessions = await sessionsFor({}, now);

  /**
   * ⚠️ 이 검사는 **위 firstRun 규율을 안 탄다** — 과거 회차를 소급 판단하는 게 아니라
   *    "지금 이 순간 캘린더를 읽었는가" 를 즉시 관측하는 것이라, 배포 직후 첫 틱이어도
   *    캘린더를 못 읽었으면 그 사실을 그대로 알리는 게 맞다.
   */
  for (const s of sessions || []) {
    if (s?.regular) continue; // 정규장이 있다 — 확인 여부를 따질 필요가 없다(정상 거래일)
    const key = String(s?.key || '');
    if (!key) continue;
    if (s.source === 'calendar') continue; // 캘린더를 읽었고 오늘은 거래일이 아니다 — 확인된 휴장, 오탐 금지
    /**
     * ⚠️ **`why:'unconfigured'` 는 이 경고의 대상이 아니다** — 토스 자격증명 자체가
     *    없다는 뜻이라(`tossClient.js` `kind:'unconfigured'`), **캘린더만** 못 읽은 게
     *    아니라 이 배포 전체가 그 상태로 설정된 것이다(개발·테스트 환경이 전형). 그런
     *    환경에서 매 틱 이 경고를 울리면 "라이브 캘린더가 죽었다" 신호와 "이 인스턴스는
     *    원래 자격증명이 없다" 신호가 뒤섞인다 — 실측(합본 스위트)으로 발견: 자격증명을
     *    안 주는 다른 테스트가 이 경고 때문에 깨졌다.
     *
     * ⚠️ **그런데 조용히 넘어가지는 않는다** (2026-09-28, pm1 지시) — 오늘 하루 종일 쫓은
     *    것이 "침묵이 정상으로 읽힌다" 였는데, 이 면제 자체가 새 침묵이 되면 안 된다.
     *    폰 알림은 안 내되(그 판단은 그대로 — 매 틱 울릴 소음이다) **로그 한 줄은 하루
     *    1회** 남긴다. "라이브에서 자격증명이 빠지면 다른 게 먼저 터진다" 는 확인 안 된
     *    추측이라 그 위에 침묵을 놓지 않는다.
     */
    if (s.why === 'unconfigured') {
      const skipMark = calendarUnconfiguredMark(key, nowMs);
      if (!st.briefWatch[skipMark]) {
        st.briefWatch[skipMark] = 'skipped';
        logWarn('alerts.calendar_unknown_skipped', { market: key, why: s.why });
      }
      continue;
    }
    const mark = calendarUnknownMark(key, nowMs);
    if (st.briefWatch[mark]) continue; // 오늘 이미 알렸다
    st.briefWatch[mark] = 'alerted';
    out.push({
      text: `⚠️ ${s.label || key.toUpperCase()} 거래일 확인 불가 — 브리핑 판정을 못 했습니다`,
      kind: 'calendar_unknown',
    });
  }

  /**
   * 🔴 **마감(close) 회차는 유예(20분)가 지나기 전에 이미 사라진다** (2026-09-30 라이브
   *    실측 — `briefWatch` 에 `kr:close`·`us:close` 마크가 **단 한 번도 없었다**, 여러 날치
   *    보존 기간 안에서 preopen·open·mid 는 전부 정상 기록되는데 close 만 0건).
   *
   *    원인: `marketCalendar.sessionFromCalendar` 는 장이 닫히는 **그 순간** `regular` 를
   *    `null` 로 접는다("확인된 휴장" 과 구분하려는 설계 — `⚠️ 휴장이면 regular:null` 주석
   *    참조). `briefOccasions` 는 `regular` 가 있을 때만 close 항목을 낸다. 그런데 이 판정은
   *    **유예가 지난 뒤**(`nowMs >= o.at + GRACE`, 마감 20분 뒤)에야 일어난다 — 그 시점이면
   *    장은 이미 닫혀 `regular` 가 사라진 뒤라 애초에 판정할 항목 자체가 없다. open·mid 는
   *    유예 시각이 아직 장중이라(09:20·12:35 < 15:30) 이 함정을 피해 간다 — **close 만 걸린다.**
   *    (`tests/alertsBriefWatch.test.js`의 "preSpan 이 없으면…" 테스트 주석이 이 함정을 이미
   *    한 번 밟고 시나리오를 장중 창으로 우회했었다 — 우회했을 뿐 고치지는 않았다.)
   *
   * ⇒ **장이 열려 있어 `regular` 를 볼 수 있을 때 오늘의 회차를 스냅샷**해 두고, 닫힌 뒤에는
   *    그 스냅샷으로 판정한다. 날짜가 바뀌면 버린다(내일 회차와 안 섞이게).
   *
   * ⚠️ **시장 단위가 아니라 `market:kind` 단위로 캐시한다** — `preopen` 은 `preSpan` 에서
   *    나오는데 `preSpan` 은 `regular` 와 달리 폐장 뒤에도 안 사라진다(`sessionFromCalendar`
   *    의 'closed' 분기도 `preSpan` 은 그대로 싣는다). 그래서 마감 뒤에도 kr 은
   *    `liveOccasions` 에 **preopen 하나만 계속 잡힌다** — 시장 단위로 "이 시장이 live 에
   *    있으면 캐시를 안 쓴다" 로 짜면 그 preopen 하나 때문에 **정작 필요한 close 캐시가
   *    영원히 안 쓰인다.** 종류별로 갈라야 preopen 은 매 틱 실물로 갱신되고 open·mid·close
   *    는 장중에 마지막으로 본 값이 폐장 뒤에도 남는다.
   */
  const today = kstDay(nowMs);
  if (!st.briefOccasionsCache || st.briefOccasionsCache.date !== today) {
    st.briefOccasionsCache = { date: today, byKey: {} };
  }
  const liveOccasions = briefOccasions(sessions);
  const merged = new Map(Object.entries(st.briefOccasionsCache.byKey || {}));
  for (const o of liveOccasions) merged.set(`${o.market}:${o.kind}`, o); // 실물이 있으면 항상 그것으로 갱신
  st.briefOccasionsCache.byKey = Object.fromEntries(merged);

  for (const o of merged.values()) {
    if (nowMs < o.at + BRIEF_GRACE_MS) continue; // 아직 유예 시간 안 — 판정을 미룬다
    const mark = `${o.market}:${o.kind}:${o.at}`;
    if (st.briefWatch[mark]) continue; // 이 회차는 이미 판정을 끝냈다(정상이든 경고든) — 같은 회차 재알림 금지
    if (firstRun) { st.briefWatch[mark] = 'seeded'; continue; }

    let ranAfter = false;
    try {
      const last = analystService.readLast();
      const lastAt = last?.at ? Date.parse(last.at) : NaN;
      ranAfter = Number.isFinite(lastAt) && lastAt >= o.at;
    } catch (e) {
      // 읽기 자체가 실패하면 "안 돌았다" 로 단정하지 않는다 — 판정을 다음 틱으로 미룬다(표시 안 남김)
      logWarn('alerts.brief_watch_read_failed', { message: e.message });
      continue;
    }

    if (ranAfter) {
      st.briefWatch[mark] = 'ok';
      sup.push(`${o.label} ${BRIEF_KIND_LABEL[o.kind]} 브리핑 확인됨`);
      continue;
    }
    st.briefWatch[mark] = 'alerted';
    out.push({
      text: `⚠️ ${o.label} ${BRIEF_KIND_LABEL[o.kind]} 브리핑이 예정 시각(${briefClock(o.at)})에 돌지 않았습니다 — 트리거 누락 가능`,
      kind: 'brief_missing',
    });
  }

  // 오래된 표시는 지운다(무한히 자라지 않게) — 키 끝의 epoch 로 나이를 잰다(마크 포맷: market:kind:epoch)
  for (const k of Object.keys(st.briefWatch)) {
    const ts = Number(k.slice(k.lastIndexOf(':') + 1));
    if (Number.isFinite(ts) && nowMs - ts > BRIEF_STALE_MS) delete st.briefWatch[k];
  }
}

/**
 * 한 바퀴. 🔴 **부분 실패를 전체 실패로 만들지 않는다** — 규칙 하나가 죽어도 나머지는 돈다.
 */
/**
 * 한 바퀴.
 *
 * ## 🔴 **"돈다" 와 "보낸다" 는 다른 축이다** (2026-09-21 실사고)
 *
 * 첫 판은 `force` 하나가 **둘 다** 열었다. 나는 그걸 *"점검용"* 이라 부르며
 * *"켜기 전에 한 번 돌려 보자"* 고 안내했고 — **사용자 폰으로 12건이 실제로 나갔다.**
 * `ALERTS_ENABLED` 는 꺼져 있었지만 아래층 `TELEGRAM_SEND_ENABLED` 가 켜져 있었고,
 * `force` 가 위층 스위치만 건너뛰었기 때문이다.
 *
 * ★ **이름이 동작을 보증하지 않는다.** "점검용" 이라 부르려면 **코드가 점검용**이어야 한다.
 * ⇒ 두 축을 갈랐다:
 * ```
 * 돌 것인가   ENABLED || force
 * 보낼 것인가 ENABLED && !dryRun      ← force 만으로는 **절대 안 보낸다**
 * ```
 * 일부러 실제로 보내 보려면 `{force:true, send:true}` 로 **명시**해야 한다.
 * 되돌릴 수 없는 행위는 **명시적으로 적었을 때만** 일어난다.
 *
 * @param {object} o
 * @param {boolean} [o.force]  꺼져 있어도 **돌린다**(보내지는 않는다)
 * @param {boolean} [o.dryRun] 켜져 있어도 **안 보낸다**
 * @param {boolean} [o.send]   force 로 돌리면서 **일부러** 보낸다(기본 false)
 */
async function tick({ force = false, dryRun = false, send: sendOverride = false } = {}) {
  if (!ENABLED && !force) return { ran: false, why: 'disabled' };
  // 🔴 발송 판정을 **한 곳에서** 낸다 — 흩어 두면 또 한쪽만 보고 지나간다
  const willSend = dryRun ? false : (ENABLED || sendOverride);
  const now = new Date();
  const st = readState();
  const out = [];
  /**
   * 🔴 **걸러진 것을 센다.** 피어 지적: `found: 0` 만 보면
   *    *"알릴 게 없다"* 인지 *"이미 알려서 걸렀다"* 인지 **구분이 안 된다.**
   *    오늘 내내 쓴 *"0 은 '없다' 가 아니라 '못 봤다' 일 수 있다"* 가 여기도 걸린다.
   */
  const suppressed = [];
  const failed = [];

  /**
   * 🔴 시장 국면 데몬 (2026-09-23 사용자 지시) — 판정은 산수, **전이만** 알린다(엣지).
   *    실패해도 틱은 계속 돈다(국면은 곁가지가 아니라 축이지만, 다른 알림을 볼모로 잡지 않는다).
   */
  try {
    const regime = require('./regimeService');
    const prevBand = st.lastVixBand ?? null;
    const { state: rgState, transitions, scenarios } = await regime.refresh();
    const nowBand = rgState?.vix?.band ?? null;
    st.lastVixBand = nowBand;
    /**
     * 🔴 VIX 사다리 = 코드가 제안 (2026-09-24 백테스트 실증 — LLM 은 공포에서 안 산다).
     *    밴드 **상승 전이**에서만, 가용 달러 현금 기준. 승인은 폰(HITL 불변).
     */
    if (willSend && nowBand != null && prevBand != null && nowBand > prevBand) {
      try {
        const h = await tossPortfolio.getHoldings({});
        const cashUsd = Number(h?.summary?.cash?.usd?.amount || 0);
        /**
         * 🔴 **VIX stale/나이를 사다리 제안에도 넘긴다** (2026-09-28, pm1 위임).
         *    `rgState.vix` 는 `regimeService.compute()` 가 만든 그 값 그대로다 — 여기서
         *    새로 추측하지 않는다. `rgState`/`rgState.vix` 가 없을 수 있어(국면 갱신 실패)
         *    옵셔널 체이닝으로 막는다(없으면 `ladderProposals` 기본값 false/null 이 먹어
         *    종전과 동일하게 동작 — 회귀 없음).
         */
        const lp = regime.ladderProposals({
          prevBand, band: nowBand, cashUsd,
          vixValue: rgState?.vix?.value ?? null,
          vixStale: Boolean(rgState?.vix?.stale),
          vixAgeMin: rgState?.vix?.ageMin ?? null,
        });
        if (lp.length) {
          const pr = await toss.getPrices(lp.map((x) => x.symbol));
          const orderService = require('./orderService');
          for (const l of lp) {
            const price = pr.get(l.symbol)?.price;
            if (!(price > 0)) { logWarn('alerts.ladder_no_price', { symbol: l.symbol }); continue; }
            const qty = Math.floor(l.budget / price);
            if (qty <= 0) continue;
            // 🔴 살 수 없는 제안을 만들지 않는다 — 구조 가드가 이 누락을 잡았다(propose 호출부는 계좌 검증 필수)
            const chk = await orderService.checkAccountLimits({ symbol: l.symbol, side: 'BUY', quantity: qty, price, exemptCashFloor: true });
            if (!chk.ok) { logWarn('alerts.ladder_blocked', { symbol: l.symbol, kind: chk.kind, error: chk.error }); continue; }
            const r = orderService.propose(
              { symbol: l.symbol, side: 'BUY', type: 'LIMIT', quantity: qty, price: Math.round(price * 100) / 100, reason: l.reason },
              { source: 'vix-ladder' }
            );
            logInfo('alerts.ladder_proposed', { band: l.band, symbol: l.symbol, qty, ok: r.ok });
            if (r.ok) out.push({ rule: 'vix-ladder', band: l.band, symbol: l.symbol });
          }
        }
      } catch (e) {
        failed.push({ rule: 'vix-ladder', message: e.message });
        logWarn('alerts.ladder_failed', { message: e.message });
      }
    }
    if (transitions.length && willSend) {
      const scLine = scenarios.length ? `\n발동 매뉴얼: ${scenarios.map((s) => s.name).join(' · ')}` : '';
      await telegram.send(`📐 시장 국면 전이\n${transitions.join('\n')}${scLine}`, { reason: 'alert:regime' });
      out.push({ rule: 'regime', transitions });
    } else if (transitions.length) {
      suppressed.push({ rule: 'regime', why: dryRun ? 'dryRun' : 'disabled' });
    }
  } catch (e) {
    failed.push({ rule: 'regime', message: e.message });
    logWarn('alerts.regime_failed', { message: e.message });
  }

  /**
   * 🔴 보유는 **한 번만** 받아 규칙들이 나눠 쓴다.
   *    종전에는 `rulePortfolio` 안에서 받았는데, 목표선·폐장 요약이 생기며 **세 번 부를 뻔했다**
   *    (토스 한도 5/s 를 그냥 태우는 짓이다).
   * ⚠️ 못 받아도 **나머지 규칙은 돈다** — 지수·세션은 보유와 무관하다.
   */
  let items = [];
  let summary = null;
  try {
    const p = await tossPortfolio.getHoldings({});
    items = p.items || [];
    summary = p.summary || null;
  } catch (e) {
    failed.push('holdings');
    logWarn('alerts.portfolio_failed', { kind: e.kind, message: e.message });
  }

  /**
   * 🔴 **안 가진 종목의 목표선은 지운다** (2026-09-21 사용자 지시).
   *
   * ⚠️⚠️ **보유를 못 읽었으면 절대 지우지 않는다.** `items` 가 비었다고 지우면
   *    토스가 잠깐 죽은 날 사용자가 설정한 기준선이 **통째로 사라진다.**
   *    ★ 오늘 내내 쓴 *"0 은 '없다' 가 아니라 '못 봤다' 일 수 있다"* 가 **가장 비싸게** 걸리는 자리다.
   *    ⇒ 보유 조회가 **성공했고 종목이 하나 이상**일 때만 정리한다.
   */
  if (!failed.includes('holdings') && items.length) {
    try {
      const cur = getDashboardSettings().targets || {};
      const held = new Set(items.map((h) => String(h.symbol).toUpperCase()));
      const stale = Object.keys(cur).filter((sym) => !held.has(sym));
      if (stale.length) {
        const kept = Object.fromEntries(Object.entries(cur).filter(([sym]) => held.has(sym)));
        // ⚠️ 비동기다 — 기다리지 않으면 다음 틱이 옛 값을 읽어 **같은 것을 또 지운다**
        await updateSettings({ dashboard: { targets: Object.keys(kept).length ? kept : null } });
        // 조용히 지우지 않는다 — 사용자가 설정한 값이다
        logWarn('alerts.targets_pruned', { removed: stale });
        /**
         * 🔴 **보통 알림과 같은 길로 보낸다** — 직접 `activity.record` 만 하면
         *    타임라인에는 남는데 **텔레그램으로는 안 간다**(사용자 설정이 바뀐 일인데).
         *    같은 길로 보내면 조용한 시간·발송 스위치도 **자동으로 같이 지켜진다.**
         */
        out.push({ text: `🧹 보유하지 않는 종목의 기준선을 정리했습니다: ${stale.join(', ')}`, kind: 'prune' });
      }
    } catch (e) {
      logWarn('alerts.prune_failed', { message: e.message });
    }
  }

  for (const [name, fn] of [
    ['sessions', (a, b, c, d) => ruleSessions(a, b, c, d, items, summary)],
    ['indices', ruleIndices],
    ['portfolio', (a, b, c, d) => rulePortfolio(items, a, b, c, d)],
    ['targets', (a, b, c, d) => ruleTargets(items, a, c, d)],
    ['conditional', ruleConditionalWatch],
  ]) {
    try {
      await fn(st, now, out, suppressed);
    } catch (e) {
      failed.push(name);
      logWarn('alerts.rule_failed', { rule: name, message: e.message });
    }
  }

  /**
   * 🔴 **분석을 돌릴 때인가** (2026-09-21 사용자 지시: *"장마감 + 모멘텀 발생시점에만"*)
   *
   * ⚠️ **보유를 못 읽었으면 감시 대상을 갱신하지 않는다** — 토스가 잠깐 죽은 걸
   *    "다 팔았다" 로 읽으면 보유 종목이 통째로 **되살 후보**로 바뀐다.
   *    ★ 목표선을 지우지 않는 것과 **같은 이유**이고, 오늘 내내 쓴
   *      *"0 은 '없다' 가 아니라 '못 봤다' 일 수 있다"* 가 여기서도 제일 비싸다.
   */
  if (!failed.includes('holdings')) {
    try {
      const targeted = Object.keys(getDashboardSettings().targets || {});
      /**
       * ⚠️ **관심종목 전체가 아니라 "감시" 표시한 것만** 넣는다 (2026-09-22 사용자 지적).
       *    지금 관심종목은 테마 프리셋으로 대량 추가된 것이라, 전부 넣으면
       *    **내가 고른 41종목이 분석 빈도를 정한다.** 표시는 기본 꺼짐이다.
       */
      let watched = [];
      let watchMins = new Map();
      try {
        watched = require('./watchlistService').getWatchedSymbols();
        watchMins = require('./watchlistService').getWatchThresholds();
      } catch (e) {
        /**
         * 🔴 **조용히 삼키지 않는다** — 종전엔 빈 catch 라, 이게 던지면 감시 표시가
         *    **통째로 무시되면서 아무 흔적이 없었다.** 사용자는 별을 켜 놓고
         *    "왜 안 되지" 만 겪는다. *"버려지는 경로는 반드시 남긴다"* 를 내가 또 어겼다.
         */
        logWarn('analyst.trigger_watched_failed', { message: e.message });
      }
      st.universe = trigger.trackUniverse(st.universe, items.map((i) => i.symbol), targeted, now, watched);
      const rows = await collectMomentumRows(st, st.universe, items, now);
      // 🎚️ 종목·그룹별 모멘텀 하한(2026-10-05) — 판정은 trigger.decide 가 row 단위로 쓴다
      for (const r of rows) {
        const m = watchMins.get(String(r.symbol || '').toUpperCase());
        if (m != null) r.minMovePct = m;
      }
      const d = trigger.decide({ now, sessions: await sessionsFor(st.universe, now), symbols: rows, state: st.analyst || {} });
      st.analyst = d.state;
      /**
       * 🔴 **정기 브리핑이 왜 안 떴는지 남긴다** (2026-09-30).
       *
       * 09-30 08:00 프리장이 안 떴는데 **로그에 아무 흔적이 없어** 원인을 손계산으로 찾았다
       * (`sameDayMark` 의 UTC 폴백이 어제 저장값과 매칭해 조용히 건너뛰고 있었다).
       * `decide()` 는 순수라 로거를 안 쓰므로 **탈락 사유를 `skipped` 로 넘겨받아 여기서** 찍는다.
       *
       * ⚠️ **하루 1회만** — 틱이 5분이라 그냥 찍으면 프리장 창 한 시간에 12번 울린다.
       *    소음이 되면 아무도 안 읽고, **그건 침묵과 같다.**
       * ⚠️ 마커는 `kind:key → 날짜` 라 **키 개수가 고정**된다(회차종류×시장). 날짜를 키에 넣으면
       *    briefWatch 처럼 무한히 자라 정리 코드가 또 필요해진다.
       */
      st.briefSkipLog = { ...(st.briefSkipLog || {}) };
      for (const sk of d.skipped || []) {
        const markKey = `${sk.kind}:${sk.key}`;
        const day = kstDay(now);
        if (st.briefSkipLog[markKey] === day) continue;
        st.briefSkipLog[markKey] = day;
        logWarn('analyst.brief_skipped', sk);
      }
      /**
       * 🔴 **건너뛴 정기 브리핑을 이월한다** (2026-09-22, pm2 지적).
       *
       * 분석은 ~70초 걸리고 틱은 5분이라 겹치면 건너뛰는데, 종전엔 **그 회차를 잃었다.**
       * 개장 브리핑이 마침 모멘텀 분석과 겹치면 **조용히 안 오고**, 사용자는
       * *"개장 브리핑이 안 왔네" * 로 본다. 전이 표시는 `decide()` 안에서 이미 소비돼
       * **다음 틱에는 다시 안 뜬다.**
       * ⇒ 실행이 막힌 회차의 **예정 브리핑만** 들고 있다가 다음 틱에 얹는다.
       * ⚠️ **모멘텀은 이월하지 않는다** — 지나간 순간의 돌파를 나중에 알리는 건 거짓이다.
       */
      const SCHEDULED = new Set(['preopen', 'open', 'mid', 'close']);
      const carried = Array.isArray(st.analystCarry) ? st.analystCarry : [];
      if (carried.length) {
        d.reasons = [...carried, ...d.reasons];
        d.run = true;
      }
      /**
       * 🔴 **점검(dryRun)은 분석을 부르지 않는다** (2026-09-22)
       *
       * 종전엔 `tick({dryRun:true})` 가 알림만 막고 **분석은 그대로 돌렸다** —
       * LLM 이 돌고 텔레그램·제안까지 나갈 수 있었다. 오늘 `analyst/run` 과
       * `propose()` 에 문을 낸 것과 **같은 병이 세 번째**다.
       * ⚠️ 판정은 그대로 하고 **실행만** 막는다 — 그래야 *"돌 뻔했는지"* 를 점검으로 볼 수 있다.
       */
      if (d.run && dryRun) {
        logInfo('analyst.trigger_dry_run', { why: trigger.describe(d.reasons), reasons: d.reasons });
      } else if (d.run && analystRunner) {
        if (analystRunning) {
          // 분석은 88초쯤 걸리고 틱은 5분이다 — 겹치면 **건너뛴다**(쌓아 두지 않는다)
          // 🔴 단 **예정 브리핑은 이월한다** — 잃으면 사용자가 "안 왔네" 로 겪는다
          const keep = d.reasons.filter((r) => SCHEDULED.has(r?.kind));
          st.analystCarry = keep;
          logWarn('analyst.trigger_skipped', {
            why: 'already_running', reasons: trigger.describe(d.reasons), carried: keep.length,
          });
        } else {
          analystRunning = true;
          st.analystCarry = []; // 실행에 들어갔으니 이월분을 비운다
          const why = trigger.describe(d.reasons);
          logInfo('analyst.triggered', { why, reasons: d.reasons });
          /**
           * 🔴 **감시 종목의 오늘 움직임을 분석에 함께 넘긴다** (2026-10-01)
           *
           * `collectMomentumRows` 는 5분마다 유니버스 **전체**(실측 41종)의 등락과 분포를
           * 이미 계산한다. 그런데 그 rows 는 `trigger.decide()` 에만 쓰이고 **분석 프롬프트로는
           * 안 갔다.** 정기 회차(preopen/open/mid/close)의 `reasons` 에는 스케줄 사유 하나뿐이라
           * `## 되살/신규 진입 후보` 절은 `kind==='momentum'` 을 하나도 못 찾는다 ⇒ 모델이 보는
           * 종목이 **보유 2 + 후보 2 = 4개**뿐이었다. 41종을 지켜보면서 판단에는 0개가 들어간 것 —
           * 이 저장소가 반복해 밟은 ***"수집해 놓고 안 쓰는"*** 자리다.
           *
           * ⚠️ **새 API 호출이 0건**이다. 이미 받아 둔 값을 그대로 넘기기만 한다.
           * ⚠️ 트리거 사유가 아니라 **보고 재료**다 — 제안 대상이 아님은 프롬프트가 못박는다.
           */
          // 🔴 **틱을 막지 않는다** — 분석이 느리다고 알림이 밀리면 안 된다
          Promise.resolve(analystRunner({ reasons: d.reasons, why, momentumRows: rows }))
            .catch((e) => {
              logError('analyst.trigger_run_failed', e, { why });
              // 🔴 브리핑 실패를 폰에도 알린다 (2026-09-23) — 로그만 남기면 사용자는
              //    "브리핑이 안 왔다" 를 눈치로만 안다(09-22~23 이틀 연속 실제로 그랬다)
              telegram.send(`⚠️ ${why} 분석에 실패했습니다(${String(e?.message || '').slice(0, 80)}). 다음 회차에 다시 시도합니다.`, { reason: 'task_failed' })
                .catch((e2) => logError('analyst.failure_notify_failed', e2, { why }));
            })
            .finally(() => { analystRunning = false; });
        }
      } else if (d.run) {
        // 🔴 판정은 났는데 실행기가 없다 — 조용히 넘기면 "왜 안 돌지" 를 겪는다
        logWarn('analyst.trigger_no_runner', { why: trigger.describe(d.reasons) });
      }
    } catch (e) {
      failed.push('analyst_trigger');
      logWarn('analyst.trigger_failed', { message: e.message });
    }
  }

  // 🩺 정기 브리핑 누락 감시 — 홀딩 성공 여부와 무관하게 독립으로 돈다(위 ruleBriefWatch 참조)
  try {
    await ruleBriefWatch(st, now, out, suppressed);
  } catch (e) {
    failed.push('brief_watch');
    logWarn('alerts.brief_watch_failed', { message: e.message });
  }

  // 조용한 시간에는 **묶어서 미루지 않고 그냥 건너뛴다** — 아침에 어제 것이 쏟아지면 그게 더 나쁘다
  const quiet = isQuiet(now);
  let sent = 0;
  for (const a of out) {
    if (quiet) continue;
    if (!willSend) continue;
    const r = await telegram.send(a.text, { reason: `alert:${a.kind}` });
    /**
     * 🔴 **`r.ok` 가 아니라 `r.sent` 를 센다.**
     *    `telegram.send` 는 dry-run 에서도 `{ok:true, sent:false}` 를 준다 —
     *    `r.ok` 로 세면 **안 보내고도 "보냈다"** 고 보고한다(테스트를 쓰다 걸렸다).
     *    ★ 오늘 `force` 사고와 **같은 병**이다: *보낸 척하는 숫자*.
     */
    if (r.sent) sent += 1;
    // 🔴 보낸 것은 **타임라인에도** 남긴다 — 로그 파일에만 있으면 사람이 못 본다
    activity.record('alert', a.text, { alertKind: a.kind, sent: Boolean(r.sent) });
  }

  writeState(st);
  lastTickAt = now.toISOString();
  lastError = failed.length ? `규칙 실패: ${failed.join(',')}` : null;
  sentCount += sent;
  // ★ 몇 건을 **찾았고** 몇 건을 **보냈는지** 따로 남긴다 — 조용한 시간에 걸러진 것을 구분한다
  logInfo('alerts.tick', { found: out.length, suppressed: suppressed.length, sent, willSend, quiet, failedRules: failed });
  return {
    ran: true,
    found: out.length,
    // ★ 왜 0 인지 말해 준다 — 걸러진 것과 없는 것은 다르다
    suppressed: suppressed.length,
    suppressedWhy: suppressed.slice(0, 10),
    sent,
    // 🔴 **보냈는지**와 **왜 안 보냈는지**를 함께 낸다 — 점검하는 사람이 착각하지 않게
    willSend,
    why: willSend ? null : dryRun ? 'dry-run' : ENABLED ? null : 'alerts_disabled',
    quiet,
    failed,
    // 안 보냈을 때는 **나갔을 내용**을 돌려준다(그게 점검의 목적이다)
    preview: willSend ? undefined : out.map((a) => a.text),
  };
}

function start() {
  if (!ENABLED) {
    logInfo('alerts.not_started', status());
    return false;
  }
  if (timer) return true;
  // 기동 직후 한 번 — 다만 **첫 틱은 기준선을 만드는 용도**라 개장/폐장은 안 나간다(ruleSessions 참조)
  tick().catch((e) => logError('alerts.first_tick_failed', e, {}));
  timer = setInterval(() => tick().catch((e) => logError('alerts.tick_failed', e, {})), TICK_MS);
  logInfo('alerts.started', { tickMs: TICK_MS });
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * 제안이 생기면 **즉시** 버튼과 함께 보낸다(주기 틱을 기다리지 않는다).
 * ⚠️ 조용한 시간에도 보낸다 — 사람이 기다리는 것이고, 제안에는 **유효기간**이 있다.
 */
/**
 * 제안이 끝났다 — **폰의 승인 버튼을 지운다.**
 * ⚠️ 조용시간을 보지 않는다. 이건 새 알림이 아니라 **이미 보낸 것의 정리**다.
 */
async function onProposalSettled(p, why) {
  try {
    const r = await bot.clearProposalButtons(p, why);
    logInfo('alerts.proposal_cleared', { id: p.id, why, cleared: Boolean(r.ok), reason: r.why || null });
    return r;
  } catch (e) {
    // 🔴 버튼을 못 지워도 상태 전이는 끝났다 — 삼키되 **조용하지 않게**
    logError('alerts.proposal_clear_failed', e, { id: p.id, why });
    return { ok: false, error: e.message };
  }
}

async function onProposal(p) {
  if (!ENABLED) return { ok: false, why: 'disabled' };
  let r;
  try {
    r = await bot.sendProposal(p);
    // 🔴 메시지 id 를 제안에 붙인다 — **이게 없으면 나중에 버튼을 못 지운다**
    if (r?.messageId != null) require('./orderService').attachNotice(p.id, { messageId: r.messageId });
  } catch (e) {
    logError('alerts.proposal_failed', e, { id: p.id });
    r = { ok: false, sent: false, error: e.message };
  }
  logInfo('alerts.proposal_sent', { id: p.id, symbol: p.symbol, sent: Boolean(r.sent), messageId: r?.messageId ?? null });

  /**
   * 🔴 **승인 버튼이 실제로 안 갔으면 사용자가 그 사실을 안다** (2026-09-28, pm1 지시 —
   *    브리핑 문구 "승인 버튼이 곧 옵니다" 는 약속인데, 이 발송이 실패하면(예외든
   *    `sent:false` 든) 로그만 남고 사용자는 기다리다 10분 TTL 로 조용히 만료됐다.
   *    `orderService.js:89~92` 의 그 거울상 — "있다고 했는데 안 왔다").
   * ⚠️ **예외와 `sent:false` 를 한 곳에서 같이 본다** — 위 catch 가 실패를 `r.sent=false`
   *    로 접어 넣으므로, 아래 이 한 검사가 **둘 다** 잡는다. 따로 두면 한쪽만 고치기 쉽다.
   * ⚠️ **후속 알림도 실패할 수 있다**(텔레그램 자체가 죽은 경우) — 더 쫓지 않고 `logError`
   *    로 끝낸다. 그리고 그 실패를 **"보냈다" 로 기록하지 않는다** — 이번 사고의 핵심이다.
   */
  if (!r?.sent) {
    try {
      const fu = await telegram.send(
        `⚠️ ${p.symbol} 제안의 승인 버튼을 보내지 못했습니다 — 앱에서 확인해 주세요`,
        { reason: 'proposal_button_failed' }
      );
      if (!fu?.sent) logError('alerts.proposal_followup_failed', new Error(fu?.error || 'unknown'), { id: p.id });
    } catch (e2) {
      logError('alerts.proposal_followup_failed', e2, { id: p.id });
    }
  }

  /**
   * 🔴 **`telegram` 값은 버튼 성공 여부만 말한다** — 후속 알림 성공을 여기 섞으면
   *    "가렸다고 로그에 찍혔는데 실제론 원본이 나갔다"(pm2 가 오늘 잡은 사고)와 같은
   *    모양이 된다. `r` 은 위에서 후속 알림과 무관하게 유지되므로 그대로 쓴다.
   */
  activity.record('proposal',
    p.conditional
      ? `예약 ${p.side === 'BUY' ? '매수' : '매도'} 제안 ${p.symbol} ${p.quantity}주 · 감시가 ${p.conditional.triggerPrice}`
      : `${p.side === 'BUY' ? '매수' : '매도'} 제안 ${p.symbol} ${p.quantity}주 @ ${p.price}`,
    { proposalId: p.id, symbol: p.symbol, side: p.side, telegram: Boolean(r.sent) });
  return r;
}

function _resetForTest() {
  stop();
  lastTickAt = null;
  lastError = null;
  sentCount = 0;
}

module.exports = {
  onProposalSettled, setAnalystRunner, tick, start, stop, status, onProposal, isQuiet, STATE_FILE, _resetForTest,
  // 시뮬레이션·검증용 — 모멘텀 평가가 무엇을 보는지 밖에서 잴 수 있어야 한다(질문에 로그로만 답하지 않는다)
  collectMomentumRows };
