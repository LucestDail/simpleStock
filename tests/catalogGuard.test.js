/**
 * 🛡️ ETF 카탈로그 가드 (2026-10-05) — 카탈로그는 **매수 도구상자**다. 여기 있으면
 * 시나리오 발동 시 LLM 후보로 올라가므로, 자격 없는 종목이 섞이면 못 사는 것을 제안한다.
 *
 * ① 단일종목(개별주) 레버리지·인버스 ETF 금지 — 국내 증권사 매수 불가(사용자 지시).
 *    🔴 이름으로 판별할 수 없어(금지목록 비대칭) **방향을 뒤집는다**: leverage≠1 인 항목은
 *    지수·섹터·상품 기반으로 사람이 검증한 **허용목록**에 있어야 한다. 새 레버리지를
 *    넣으려면 이 목록에 의식적으로 추가해야 하고, 그 순간이 검증 시점이다.
 * ② leverage 필드는 **실제 배수**다 — 집중 상한·감쇠·인버스 게이트가 숫자로 읽는다.
 *    "레버리지 성격"(MSTR 사건) 같은 비유를 숫자에 넣으면 리스크 계산이 거짓말한다.
 */
const test = require('node:test');
const assert = require('node:assert');
const cat = require('../config/etf-catalog.json');

/** 지수·섹터·상품 기반 레버리지/인버스 — 전부 기초자산이 복수 종목이거나 상품이다 */
const LEVERAGED_ALLOWED = new Set([
  // 지수 롱
  'QLD', 'TQQQ', 'SSO', 'UPRO', 'SPXL', 'TNA', 'KORU', 'FNGU', 'BULZ', '122630',
  // 섹터·테마 롱
  'SOXL', 'RAM', 'TECL', 'LABU', 'CURE', 'WEBL', 'RETL', 'NAIL', 'ROM', 'USD', 'DPST', 'DFEN',
  // FAS 추가 2026-10-06 — 사용자 섹터 표의 '매매 후보'. 검증: Direxion Daily Financial
  //   Bull 3X = **Russell 1000 금융 서비스 지수** 3배(단일종목 아님) ⇒ 허용 대상.
  //   ★ 이 가드가 내가 검증 없이 추가하려던 것을 잡았다(설계대로 작동).
  'FAS',
  // 상품·금리·변동성
  'NUGT', 'GDXU', 'TMF', 'TYD', 'UCO', 'BITU', 'UVXY',
  // 인버스(지수·섹터·금리)
  'PSQ', 'SH', 'QID', 'SQQQ', 'SPXU', 'SOXS', 'SPXS', 'SRTY', 'SDS', 'DXD', 'TWM', 'SSG',
  'REW', 'SKF', 'SRS', 'DUG', 'TBT', 'PST', 'TTT', '114800',
]);

function allEtfs() {
  const out = [];
  for (const [key, c] of Object.entries(cat.categories || {})) {
    for (const e of c.etfs || []) out.push({ ...e, category: key });
  }
  return out;
}

test('레버리지(≠1x) 항목은 전부 허용목록 안 — 단일종목 레버리지가 섞이면 실패', () => {
  const lev = allEtfs().filter((e) => e.leverage != null && Math.abs(Number(e.leverage)) !== 1);
  assert.ok(lev.length >= 20, `레버리지 항목이 ${lev.length}개뿐 — 자가 대상을 잃었다(통과 아님)`);
  const outside = lev.filter((e) => !LEVERAGED_ALLOWED.has(e.symbol));
  assert.deepEqual(
    outside.map((e) => `${e.category}/${e.symbol}(${e.leverage}x)`), [],
    '허용목록 밖 레버리지 — 단일종목이면 제거, 지수·섹터면 목록에 검증 후 추가'
  );
});

test('🔴 재발 금지 — 과거에 섞였던 단일종목 레버리지가 되돌아오면 즉시 실패', () => {
  const syms = new Set(allEtfs().map((e) => e.symbol));
  for (const bad of ['NVDL', 'TSLL', 'TSLR', 'MSTU', 'CONL', 'NVD', 'NVDS', 'SMCZ', 'PLTU', 'AMDL', 'MSTZ']) {
    assert.ok(!syms.has(bad), `${bad} 가 카탈로그에 되돌아왔다 — 국내 매수 불가 종목이다`);
  }
});

test('leverage 필드는 배수다 — 주식(비 ETF 성격 표기)에 2x 가 붙으면 실패', () => {
  // MSTR 사건의 고정: "레버리지 성격" 은 desc 에, 숫자는 1 에
  const mstr = allEtfs().find((e) => e.symbol === 'MSTR');
  if (mstr) assert.equal(Number(mstr.leverage) || 1, 1, 'MSTR 은 주식이다 — 배수가 아니라 성격이다');
});
