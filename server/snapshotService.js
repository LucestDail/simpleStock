/**
 * 📈 일일 자산 스냅샷 (2026-10-04 — 성과 리포트 D-10 의 수익률 축)
 *
 * 성과 리포트가 *"수익률 vs KOSPI · 월별 성과"* 를 못 그리던 이유 = **이력이 없어서**다.
 * 여기서 하루 한 줄씩 적재한다. 첫 달은 표가 짧겠지만, **지어낸 과거보다 짧은 진실이 낫다.**
 *
 * ## 설계
 * - JSONL append-only (감사 파일과 같은 규율 — 스냅샷은 "현재 상태" 가 아니라 "일어난 일").
 * - 하루 1건: 같은 KST 날짜가 이미 있으면 **갱신하지 않는다** — 첫 관측이 그날의 값이다
 *   (장중 아무 때나 갱신하면 "그날 수익률" 의 정의가 흔들린다).
 * - 🔴 수량·종목별 금액은 **싣지 않는다** — 총액·현금·레버리지 비중까지만(민감 축 최소화).
 * - 벤치마크(KOSPI·QQQ)는 그날의 지수값을 함께 적는다 — 나중에 받으려면 과거를 못 받는다.
 */
const fs = require('node:fs');
const path = require('node:path');
const { logInfo, logWarn } = require('./logger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'asset-snapshots.jsonl');

/** KST 날짜 키 — UTC 로 적으면 프리장 함정(2026-09-28)의 재발 자리다 */
function kstDay(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * 오늘 스냅샷이 없으면 적재한다. 멱등 — 하루에 몇 번 불려도 1건.
 * @param {object} p { totalKrw, cashPct, leveragePct, benchmarks:{kospi,qqq} }
 */
function recordDaily(p) {
  const day = kstDay();
  // ⚠️ 유효성 검사가 **중복 검사보다 먼저** — 순서가 반대면 "오늘 이미 적재됨" 이
  //    유효하지 않은 입력까지 ok 로 돌려보내 호출자가 결함을 못 본다(자가 잡았다).
  const totalKrw = Number(p?.totalKrw);
  if (!(totalKrw > 0)) {
    // ⚠️ 0·음수 총액은 적지 않는다 — 조회 실패를 "자산이 0" 으로 역사에 박으면 수익률이 거짓이 된다
    logWarn('snapshot.skipped_invalid', { totalKrw: p?.totalKrw });
    return { ok: false, error: 'invalid_total' };
  }
  const rows = readAll();
  if (rows.some((r) => r.day === day)) return { ok: true, skipped: 'already_recorded' };
  const row = {
    day, at: new Date().toISOString(),
    totalKrw: Math.round(totalKrw),
    cashPct: Number(p?.cashPct) || null,
    leveragePct: Number(p?.leveragePct) || null,
    bench: {
      kospi: Number(p?.benchmarks?.kospi) || null,
      qqq: Number(p?.benchmarks?.qqq) || null,
    },
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify(row)}\n`);
    logInfo('snapshot.recorded', { day, totalKrw: row.totalKrw });
    return { ok: true, row };
  } catch (e) {
    logWarn('snapshot.write_failed', { message: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * 성과 집계 — 시계열 + 구간 수익률 + 월별 표.
 * ⚠️ 데이터가 2건 미만이면 수익률은 null — **한 점으로 수익률을 지어내지 않는다.**
 */
function performance() {
  const rows = readAll().sort((a, b) => a.day.localeCompare(b.day));
  if (!rows.length) return { days: 0, series: [], returns: null, monthly: [] };
  const first = rows[0]; const last = rows[rows.length - 1];
  const pct = (a, b) => (a > 0 && b > 0 ? Math.round(((b / a) - 1) * 10000) / 100 : null);
  const monthly = [];
  const byMonth = new Map();
  for (const r of rows) {
    const m = r.day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  for (const [m, list] of byMonth) {
    const a = list[0]; const b = list[list.length - 1];
    monthly.push({
      month: m, days: list.length,
      returnPct: pct(a.totalKrw, b.totalKrw),
      kospiPct: pct(a.bench?.kospi, b.bench?.kospi),
      qqqPct: pct(a.bench?.qqq, b.bench?.qqq),
    });
  }
  return {
    days: rows.length,
    firstDay: first.day, lastDay: last.day,
    series: rows.map((r) => ({ day: r.day, totalKrw: r.totalKrw, kospi: r.bench?.kospi ?? null, qqq: r.bench?.qqq ?? null })),
    returns: rows.length >= 2 ? {
      totalPct: pct(first.totalKrw, last.totalKrw),
      kospiPct: pct(first.bench?.kospi, last.bench?.kospi),
      qqqPct: pct(first.bench?.qqq, last.bench?.qqq),
    } : null,
    monthly,
  };
}

module.exports = { recordDaily, performance, kstDay, _FILE: FILE };
