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
const { APP_TIMEZONE } = require('./time');
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
function kstDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(now);
}

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
  const day = new Date(now).toISOString().slice(0, 10);
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
    // 진행 중 봉 판정: 시세 타임스탬프(없으면 지금)의 **현지 날짜**와 마지막 봉 날짜가 같으면 진행 봉
    const liveDay = String(live?.at || new Date(now).toISOString()).slice(0, 10);
    let bars = cached.bars;
    if (bars.length && bars[bars.length - 1].t === liveDay) bars = bars.slice(0, -1); // 확정 봉만
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
    out.push({ key: k, label: spec[k][0], state: r.state, source: r.source, regular: r.regular || null });
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
    rules: ['개장/폐장(+마감 요약)', '지수 급변', '보유 급변', '목표가·손절선', '종목 경고', '매매 제안'],
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
        const lp = regime.ladderProposals({ prevBand, band: nowBand, cashUsd });
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
      try {
        watched = require('./watchlistService').getWatchedSymbols();
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
      const d = trigger.decide({ now, sessions: await sessionsFor(st.universe, now), symbols: rows, state: st.analyst || {} });
      st.analyst = d.state;
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
      const SCHEDULED = new Set(['open', 'mid', 'close']);
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
          // 🔴 **틱을 막지 않는다** — 분석이 느리다고 알림이 밀리면 안 된다
          Promise.resolve(analystRunner({ reasons: d.reasons, why }))
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
  try {
    const r = await bot.sendProposal(p);
    // 🔴 메시지 id 를 제안에 붙인다 — **이게 없으면 나중에 버튼을 못 지운다**
    if (r?.messageId != null) require('./orderService').attachNotice(p.id, { messageId: r.messageId });
    logInfo('alerts.proposal_sent', { id: p.id, symbol: p.symbol, sent: Boolean(r.sent), messageId: r?.messageId ?? null });
    activity.record('proposal',
      p.conditional
        ? `예약 ${p.side === 'BUY' ? '매수' : '매도'} 제안 ${p.symbol} ${p.quantity}주 · 감시가 ${p.conditional.triggerPrice}`
        : `${p.side === 'BUY' ? '매수' : '매도'} 제안 ${p.symbol} ${p.quantity}주 @ ${p.price}`,
      { proposalId: p.id, symbol: p.symbol, side: p.side, telegram: Boolean(r.sent) });
    return r;
  } catch (e) {
    logError('alerts.proposal_failed', e, { id: p.id });
    return { ok: false, error: e.message };
  }
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
