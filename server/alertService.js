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
async function collectMomentumRows(st, universe, items, now) {
  const bySymbol = new Map((items || []).map((it) => [String(it.symbol).toUpperCase(), it]));
  const day = new Date(now).toISOString().slice(0, 10);
  st.candleCache = st.candleCache || {};
  const rows = [];

  for (const [sym, meta] of Object.entries(universe || {})) {
    let hist = st.candleCache[sym]?.day === day ? st.candleCache[sym].changes : null;
    if (!hist) {
      try {
        const c = await toss.getCandles(sym, { interval: '1d', count: 60 });
        const closes = (c.rows || []).map((r) => r.c).filter(Number.isFinite);
        hist = [];
        for (let i = 1; i < closes.length; i += 1) hist.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
        st.candleCache[sym] = { day, changes: hist.slice(-40) };
        hist = st.candleCache[sym].changes;
      } catch (e) {
        // 🔴 못 받으면 **판정하지 않는다** — 빈 분포로 z 를 내면 아무 날이나 이상해 보인다
        logWarn('analyst.trigger_history_failed', { symbol: sym, kind: e?.kind, message: e?.message });
        continue;
      }
    }
    const held = bySymbol.get(sym);
    // 보유 중이면 **실시간 등락**, 아니면 어제 종가 대비(일 단위) — 되살 후보는 그 정도면 된다
    const change = held?.dailyRate != null ? Number(held.dailyRate) : hist[hist.length - 1];
    if (!Number.isFinite(change)) continue;
    // ⚠️ 오늘 값은 분포에서 뺀다 — 자기 자신을 포함해 재면 z 가 줄어든다
    rows.push({ symbol: sym, dailyChangePct: change, history: hist.slice(0, -1), role: meta.role });
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
  const markets = new Set();
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
    out.push({ key: k, label: spec[k][0], state: r.state, source: r.source });
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
          logWarn('analyst.trigger_skipped', { why: 'already_running', reasons: trigger.describe(d.reasons) });
        } else {
          analystRunning = true;
          const why = trigger.describe(d.reasons);
          logInfo('analyst.triggered', { why, reasons: d.reasons });
          // 🔴 **틱을 막지 않는다** — 분석이 느리다고 알림이 밀리면 안 된다
          Promise.resolve(analystRunner({ reasons: d.reasons, why }))
            .catch((e) => logError('analyst.trigger_run_failed', e, { why }))
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
    activity.record('proposal', `${p.side === 'BUY' ? '매수' : '매도'} 제안 ${p.symbol} ${p.quantity}주 @ ${p.price}`,
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
  onProposalSettled, setAnalystRunner, tick, start, stop, status, onProposal, isQuiet, STATE_FILE, _resetForTest };
