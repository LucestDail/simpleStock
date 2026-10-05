/**
 * 📊 매매 수명주기 7단계 집계 (2026-10-04 — 성과 리포트 재편)
 *
 * 사용자 정의 7단계: 사전탐색 → 시행준비 → 수행배치 → 업무수행 → 절차마감 → 사후대비 → 업무종료.
 * 기존 데이터(분석 이력·주문 감사·스냅샷·활동 기록)를 이 프레임으로 **집계**한다 —
 * 새 기록 체계를 만드는 게 아니라 이미 쌓이는 것을 단계별로 읽는다(기록이 두 벌이면 갈라진다).
 *
 * 🔴 실주문이 0 인 단계(업무수행 후반~절차마감)는 **"데이터 없음(실주문 0)"** 으로 말한다 —
 *    빈 차트를 그럴듯하게 채우면 성과 리포트가 거짓말이 된다.
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function readJsonl(file) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, file), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/* ── recent 이력 헬퍼 (2026-10-05 — "숫자만 나오고 이력이 안 보인다") ──
 * 각 단계에 recent: [{at, text}] 최근 2~3건을 싣는다. 소스는 이미 이 파일이 읽는
 * 데이터 그대로 — 새 기록 체계를 만들지 않는다. */
const clip = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const sideKo = (s) => (s === 'BUY' ? '매수' : s === 'SELL' ? '매도' : (s || ''));
/** JSONL 은 시간순 append — 끝에서 n건을 떠 최신이 앞에 오게 뒤집는다 */
const lastN = (arr, n = 3) => arr.slice(-n).reverse();
const orderText = (d) => clip([
  sideKo(d.side), d.symbol || '—',
  d.quantity ? `${d.quantity}주` : '',
  d.price != null ? `@${d.price}` : '',
].filter(Boolean).join(' '));

function compute() {
  const audit = readJsonl('orders-audit.jsonl');
  const activity = readJsonl('activity.jsonl');
  const history = require('./analystHistory').list({ limit: 1000 });
  const snapshots = readJsonl('asset-snapshots.jsonl');

  const by = {};
  for (const d of audit) by[d.event] = (by[d.event] || 0) + 1;
  const analyses = activity.filter((a) => a.kind === 'analysis').length;
  const alerts = activity.filter((a) => a.kind === 'alert').length;

  // 수행배치: 제안 가격-현재가 괴리(감사의 proposed 행에 price 가 있으면)
  const proposed = audit.filter((d) => d.event === 'proposed');
  const executed = audit.filter((d) => d.event === 'executed');
  const decided = audit.filter((d) => ['approved', 'rejected', 'executed'].includes(d.event));
  const DECIDED_KO = { approved: '승인', rejected: '거절', executed: '체결' };
  // history 는 list() 가 이미 최신순 — slice 만 한다
  const recentReports = (n) => history.slice(0, n).map((h) => ({
    at: h.at, text: clip(h.marketView || '(시황 요약 없음)'),
  }));

  const stages = [
    {
      key: 'scan', name: '사전탐색',
      desc: '웹 탐색·내부 수치 판정의 시행 횟수',
      metrics: [
        { label: '분석 실행(브리핑 포함)', value: analyses },
        { label: '분석 보고서 이력', value: history.length },
        { label: '알림·이벤트 감지', value: alerts },
      ],
      recent: lastN(activity.filter((a) => a.kind === 'analysis')).map((a) => ({
        at: a.at, text: clip(a.title || '(제목 없음)'),
      })),
    },
    {
      key: 'prepare', name: '시행준비',
      desc: '시장·모멘텀·퀀트·시황 분석으로 매매 근거 취합',
      metrics: [
        { label: '종목 판단 수(이력 합)', value: history.reduce((a, h) => a + (h.positions || 0), 0) },
        { label: '제안으로 이어진 보고서', value: history.filter((h) => (h.proposals || []).length).length },
      ],
      recent: recentReports(3),
    },
    {
      key: 'stage', name: '수행배치',
      desc: '매수/매도 가격 구성 — 하방 괴리(저점 매수)·상방 괴리(고점 매도) 전략',
      metrics: [
        { label: '가격 구성된 제안', value: by.proposed || 0 },
        { label: '가드 차단(가격 괴리·한도)', value: by.blocked || 0 },
      ],
      recent: lastN(proposed).map((d) => ({ at: d.at, text: orderText(d) })),
    },
    {
      key: 'execute', name: '업무수행',
      desc: '매수/매도 시행 · 시행가-시가 이격 · 성공률',
      metrics: [
        { label: '승인', value: by.approved || 0 },
        { label: '실주문 체결', value: by.executed || 0 },
        { label: '거절', value: by.rejected || 0 },
        { label: '만료', value: by.expired || 0 },
      ],
      recent: lastN(decided).map((d) => ({
        at: d.at, text: clip(`${DECIDED_KO[d.event] || d.event} · ${orderText(d)}`),
      })),
      note: (by.executed || 0) === 0 ? '실주문 0 — 이격·성공률은 첫 체결부터 쌓인다(지어내지 않는다)' : null,
    },
    {
      key: 'settle', name: '절차마감',
      desc: '체결 후 정산·정리',
      metrics: [{ label: '정산 건', value: by.executed || 0 }],
      recent: lastN(executed).map((d) => ({ at: d.at, text: clip(`체결 · ${orderText(d)}`) })),
      note: (by.executed || 0) === 0 ? '실주문 0 — 데이터 없음' : null,
    },
    {
      key: 'next', name: '사후대비',
      desc: '포트폴리오·시황 재분석 — 다음 작업 내부 판정',
      metrics: [
        { label: '일일 자산 스냅샷', value: snapshots.length },
        { label: '국면 데몬 가동', value: '5분 주기' },
      ],
      recent: lastN(snapshots).map((s) => ({
        at: s.at || s.day,
        text: clip(`${s.day} 총자산 ₩${Number(s.totalKrw).toLocaleString('ko-KR')}`),
      })),
    },
    {
      key: 'close', name: '업무종료',
      desc: '정보 종합·개념화·이력 관리',
      metrics: [
        { label: '보고서 이력 보존', value: history.length },
        { label: '감사 레코드', value: audit.length },
      ],
      recent: history.slice(0, 3).map((h) => ({
        at: h.at,
        text: clip(`보고서 보존${h.trigger ? ` · ${h.trigger}` : ''} · 판단 ${h.positions ?? 0}건`),
      })),
    },
  ];

  return {
    asOf: new Date().toISOString(),
    stages,
    counts: { ...by, analyses },
    series: snapshots.map((s) => ({ day: s.day, totalKrw: s.totalKrw, kospi: s.bench?.kospi ?? null, qqq: s.bench?.qqq ?? null })),
    trades: executed.map((d) => ({ at: d.at, symbol: d.symbol, side: d.side })),
  };
}

module.exports = { compute };
