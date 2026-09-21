const { logInfo, logWarn, logError } = require('./logger');

/**
 * 텔레그램 발송 (2026-09-21)
 *
 * 사용자 설계: *"집에서는 종합적인 내 자산 확인 및 에이전트 브리핑 …
 * 외부에 있을때는 텔레그램 통하여 상태 보고, 모멘텀 대응 관련 처리"*
 * ⇒ `lanonly` 로 외부 웹을 닫은 것과 **짝이 맞는다.** 밖에서는 텔레그램이 창구다.
 *
 * ## 🔴 기본이 dry-run 이다 — 코드가 강제한다
 *
 * 피어가 오늘 **변이 테스트 2건을 사용자 폰으로 실제로 보냈다.** 규칙으로 "시험할 때
 * 조심하자" 는 안 지켜진다 ⇒ **스위치를 코드에 박고 기본을 꺼 둔다.**
 * `TELEGRAM_SEND_ENABLED=true` 여야 실제로 나간다. 그 전에는 **로그만** 남는다.
 *
 * ## ⚠️ 회사 맥에서는 `api.telegram.org` 가 403 이다 (Zscaler)
 *
 * 그래서 **로컬에서 실패해도 코드 문제가 아니다.** 검증은 `.25` 에서 한다.
 * 이걸 모르면 멀쩡한 코드를 한참 쫓는다(피어가 그럴 뻔했고 09-15 에는 오진까지 했다).
 *
 * ## 소음을 만들지 않는다
 *
 * 같은 종목·같은 방향의 모멘텀은 **하루 한 번만** 알린다. 5분마다 같은 말을 하면
 * 사람이 알림을 끄고, 그러면 **정작 중요한 것도 안 보게 된다.**
 */

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
/** 🔴 기본 꺼짐. 없으면 꺼짐 — 미설정이 켜짐이 되면 안 된다 */
const SEND_ENABLED = String(process.env.TELEGRAM_SEND_ENABLED || '').trim().toLowerCase() === 'true';
const TIMEOUT_MS = Math.max(3000, Number(process.env.TELEGRAM_TIMEOUT_MS) || 8000);

/** `${symbol}:${direction}:${yyyy-mm-dd}` → true */
const notifiedToday = new Map();

function isConfigured() {
  return Boolean(TOKEN && CHAT_ID);
}

function status() {
  return {
    configured: isConfigured(),
    sendEnabled: SEND_ENABLED,
    // 둘 다여야 실제로 나간다. 화면·로그가 어느 쪽이 막고 있는지 알 수 있어야 한다
    effective: isConfigured() && SEND_ENABLED ? 'live' : 'dry-run',
    reason: !isConfigured() ? 'token_or_chat_missing' : SEND_ENABLED ? null : 'send_disabled',
    dedupeEntries: notifiedToday.size,
  };
}

/** 텔레그램 MarkdownV2 는 까다롭다 — 평문으로 보내고 escape 를 안 쓴다 */
async function send(text, { reason = 'manual' } = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '빈 메시지' };

  if (!isConfigured() || !SEND_ENABLED) {
    // 🔴 조용히 성공으로 만들지 않는다. **안 보냈다는 사실**을 그대로 돌려준다
    logInfo('telegram.dry_run', { reason, chars: body.length, why: status().reason });
    return { ok: true, sent: false, dryRun: true, why: status().reason };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: body, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      // ⚠️ 실패를 빈 결과로 삼키지 않는다 — 안 갔는데 갔다고 믿으면 그게 더 나쁘다
      logWarn('telegram.send_failed', { reason, status: res.status, desc: json.description || null });
      return { ok: false, sent: false, error: json.description || `HTTP ${res.status}` };
    }
    logInfo('telegram.sent', { reason, chars: body.length });
    return { ok: true, sent: true };
  } catch (e) {
    // 회사망에서는 여기로 온다(Zscaler 403/차단). **코드 문제가 아니다**
    logError('telegram.send_error', e, { reason });
    return { ok: false, sent: false, error: e.message };
  }
}

function todayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
}

function money(v, cur) {
  if (v == null) return '-';
  return cur === 'USD'
    ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `₩${Math.round(Number(v)).toLocaleString('ko-KR')}`;
}
const pct = (v) => (v == null ? '-' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);

/** 자산 요약 한 통 */
function formatPortfolio(p) {
  if (!p?.summary) return '보유 현황을 불러오지 못했습니다.';
  const s = p.summary;
  const lines = [
    '📊 자산 현황',
    `평가 ${money(s.value?.krw, 'KRW')}${s.value?.converted ? ' (환산)' : ''}`,
    `평가손익 ${money(s.profit?.krw, 'KRW')} ${pct(s.profitRate)}`,
    `오늘 ${money(s.dailyProfit?.krw, 'KRW')} ${pct(s.dailyRate)}`,
    '',
  ];
  for (const h of p.items || []) {
    lines.push(`· ${h.name} ${pct(h.dailyRate)} (평가 ${pct(h.profitRate)})`);
  }
  return lines.join('\n');
}

/**
 * 모멘텀 알림. **같은 종목·같은 방향은 하루 한 번.**
 * @returns {{sent:number, skipped:number}}
 */
async function notifyMomentum(items, { now = new Date() } = {}) {
  const day = todayKey(now);
  let sent = 0;
  let skipped = 0;
  for (const it of items || []) {
    if (it.dailyRate == null) continue;
    const dir = it.dailyRate >= 0 ? 'up' : 'down';
    const key = `${it.symbol}:${dir}:${day}`;
    if (notifiedToday.has(key)) {
      skipped += 1;
      continue;
    }
    notifiedToday.set(key, true);
    const arrow = dir === 'up' ? '📈' : '📉';
    const r = await send(
      `${arrow} ${it.name} ${pct(it.dailyRate)}\n평가손익 ${pct(it.profitRate)} · 현재 ${money(it.lastPrice, it.currency)}`,
      { reason: 'momentum' }
    );
    if (r.ok) sent += 1;
  }
  if (sent || skipped) logInfo('telegram.momentum', { sent, skipped, day });
  return { sent, skipped };
}

/** 하루가 바뀌면 중복 방지 기록을 비운다(무한히 쌓이지 않게) */
function sweepDedupe(now = new Date()) {
  const day = todayKey(now);
  let removed = 0;
  for (const k of notifiedToday.keys()) {
    if (!k.endsWith(`:${day}`)) {
      notifiedToday.delete(k);
      removed += 1;
    }
  }
  return removed;
}

function _resetForTest() {
  notifiedToday.clear();
}

module.exports = {
  isConfigured,
  status,
  send,
  formatPortfolio,
  notifyMomentum,
  sweepDedupe,
  _resetForTest,
};
