/**
 * 종목 정체 — 정식명 · 유형 · 레버리지 배수 · 상장일 (2026-09-22)
 *
 * 🔴 배경: 보유 종목 이름이 "RAM" 하나뿐이라 모델이 정체를 **회차마다 지어냈다**
 *    (17시 dryRun "2배 일일 리밸런싱 상품" ↔ 21시 채팅 "레버리지가 아닌 일반 종목" — 정반대.
 *    같은 답에서 램리서치(LRCX) 실적을 근거로 들었는데 RAM 은 **DRAM 지수 2배 ETF** 다).
 *    레버리지 여부는 보유/매도 판단의 **전제**다 — 전제가 없으면 답이 뒤집힌다.
 *
 * 🔴 토스가 이미 전부 준다 — `englishName` · `leverageFactor` · `listDate`.
 *    종전 `getStockInfo` 가 받아 놓고 **버리고 있었다**("수집해 놓고 안 쓰는" 패턴, pm2 실측).
 *    그래서 처방은 새 API 가 아니라 **버리던 필드를 담는 것**이다.
 *
 * 붙이는 자리는 `tossPortfolio.getHoldings` **한 곳**(값을 받는 자리) — 분석 프롬프트·
 * 채팅 도구·화면(/api/portfolio)이 전부 그 items 를 물려받는다. 세 곳에 각각 붙이면
 * 하나가 빠진 채 "채워진 척" 한다.
 */

const toss = require('./tossClient');
const { logWarn } = require('./logger');

/** 정적 정보(정식명·배수·상장일)다 — 하루 안에 바뀌지 않는다. 6시간이면 충분하다. */
const CACHE_MS = 6 * 60 * 60 * 1000;
/** sym → { at, info } */
const cache = new Map();

/**
 * 심볼들의 정체를 가져온다(캐시 우선, 빠진 것만 한 번에 조회).
 * ⚠️ 실패는 **빈 값**이지 예외가 아니다 — 정체는 곁가지고 보유 조회를 죽이면 안 된다.
 *    다만 조용하지도 않다(`identity.fetch_failed`).
 */
async function fetchIdentity(symbols) {
  const now = Date.now();
  const want = [...new Set((symbols || []).map((s) => String(s || '').trim()).filter(Boolean))];
  const out = new Map();
  const misses = [];
  for (const s of want) {
    const hit = cache.get(s);
    if (hit && now - hit.at < CACHE_MS) out.set(s, hit.info);
    else misses.push(s);
  }
  if (misses.length) {
    try {
      const fresh = await toss.getStockInfo(misses);
      for (const s of misses) {
        const info = fresh.get(s) || null;
        // 못 받은 심볼도 캐시한다 — 매 틱 다시 두드리면 정체 하나에 호출이 샌다
        cache.set(s, { at: now, info });
        if (info) out.set(s, info);
      }
    } catch (e) {
      logWarn('identity.fetch_failed', { symbols: misses.length, kind: e?.kind, message: e?.message });
    }
  }
  return out;
}

/**
 * 보유/감시 항목에 정체 필드를 붙인다 — **원본 name 은 덮지 않는다**(토스 화면과 어긋나면
 * 사용자가 못 알아본다). `officialName` 을 따로 둔다.
 * infoMap 을 주면 순수하게 동작한다(테스트용) — 없으면 직접 가져온다.
 */
async function enrich(items, infoMap = null) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const map = infoMap || (await fetchIdentity(list.map((i) => i.symbol)));
  return list.map((it) => {
    const info = map.get?.(it.symbol) || null;
    if (!info) return it;
    const lf = Number(info.leverageFactor);
    return {
      ...it,
      officialName: info.englishName || null,
      securityType: info.securityType || null,
      // ⚠️ 값이 없을 때 1 로 채우지 않는다 — "1배 확정" 과 "모른다" 는 다르다
      leverageFactor: Number.isFinite(lf) && lf > 0 ? lf : null,
      listDate: info.listDate || null,
    };
  });
}

/** 한 종목의 정체 한 줄 — 프롬프트용. 확정/미확인을 가른다. */
function describeLine(it, now = Date.now()) {
  const parts = [`- ${it.symbol} — ${it.officialName || it.name || '정식명 확인 못 함'}`];
  parts.push(it.securityType || '유형 확인 못 함');
  if (it.leverageFactor != null && it.leverageFactor >= 2) {
    parts.push(`🔴 레버리지 ${it.leverageFactor}배 — 일일 리밸런싱 상품(횡보 구간에서 가치가 감쇠한다. 장기 보유 판단의 전제로 깔 것)`);
  } else if (it.leverageFactor === 1) {
    parts.push('레버리지 아님(1배)');
  } else if (String(it.securityType || '').toUpperCase() === 'ETF') {
    parts.push('레버리지 배수 확인 못 함');
  }
  if (it.listDate) {
    const days = Math.floor((now - Date.parse(it.listDate)) / 86400000);
    parts.push(
      Number.isFinite(days) && days >= 0 && days < 370
        ? `상장 ${it.listDate}(약 ${Math.max(1, Math.round(days / 30))}개월 — **52주 이력이 존재하지 않는다**)`
        : `상장 ${it.listDate}`
    );
  }
  return parts.join(' · ');
}

/**
 * 프롬프트에 싣는 "## 종목 정체" 절.
 * 🔴 규칙까지 같이 싣는다 — 데이터만 주면 모델이 그 옆에 자기 추측을 덧붙인다.
 */
function sectionFromItems(items, now = Date.now()) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.symbol);
  if (!list.length) return '';
  return [
    '## 종목 정체 (증권사 확정 정보 — 이 밖의 정체는 추측 금지)',
    ...list.map((it) => describeLine(it, now)),
    '',
    '🔴 종목이 무엇인지(사업 내용·레버리지 여부)는 **위 정보만** 근거로 말한다.',
    '   티커 글자에서 추측하지 않는다 — 티커가 비슷한 **다른 회사와 혼동 금지**.',
    '🔴 시세 이력은 **상장일 이후**만 존재한다. 캔들 요약의 고·저는 그 창 안의 값이다 —',
    '   "52주 고점" 처럼 창보다 긴 기간의 이름을 지어 붙이지 말 것.',
  ].join('\n');
}

function _resetForTest() {
  cache.clear();
}

module.exports = { fetchIdentity, enrich, describeLine, sectionFromItems, _resetForTest };
