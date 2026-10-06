/**
 * 🎯 장기 목표 배분 — 선언과 괴리 계산 (2026-10-06 신설)
 *
 * 사용자 최종 전략: *"리얼티인컴 같은 방어주/수익 기반으로 QLD 를 모아나간다. 결국
 * QLD/TQQQ 기반 수익률 극대화. 기반 자산=QQQM · 기준 공격=QLD · 모멘텀 기준 공격 후
 * 리밸런싱=TQQQ"*.
 *
 * ## 왜 필요한가
 * 지금 시스템엔 **국면별 기준 배분**(playbook `modelPortfolio` — "신용경색이면 레버리지
 * 0~10%")만 있고 **사용자의 장기 지향점을 담을 자리가 없었다.** 그래서 모델이 매 회차
 * *"지금 위험한가"* 만 보고 *"어디로 가야 하는가"* 를 모른다 ⇒ 레버리지를 **모아가는**
 * 전략이 원리상 성립하지 않는다.
 *
 * 이 모듈은 `riskMetrics` 와 같은 모양이다 — `compute/compare` 가 숫자를 내고
 * `promptSection` 이 **화면과 같은 계산**을 모델에게도 보여준다(두 벌이면 갈라진다).
 *
 * ## 🔴 분모는 한 벌에서 온다
 * 비중 계산은 **직접 하지 않는다** — `analystService.portfolioWeights` 를 그대로 쓴다.
 * 같은 식을 두 번 쓰면 "화면 31.2% / 목표 괴리 60.9%" 처럼 갈라지고, 그건 2026-10-04 에
 * riskMetrics 가 실제로 밟은 자리다(주식만 분모로 재서 도넛과 다른 숫자가 나왔다).
 * ⚠️ 주입 가능하게 둔 것은 테스트가 실물 없이 돌기 위함이고, 기본값이 정본이다
 *    (`orderPrecheck.weightsOf` 와 같은 규율 — lazy require 라 순환 참조도 안 난다).
 *
 * ## ⚠️ 이 파일이 하지 않는 것
 * - **집행하지 않는다.** 괴리는 *제안의 근거*일 뿐이고 주문은 언제나 폰 HITL 승인.
 * - **상한을 강제하지 않는다.** 목표는 나침반이지 울타리가 아니다(사용자 결정: 비율 규칙
 *   없이 운영). 괴리를 *보여줄* 뿐 거부하는 게이트가 아니다.
 */
const fs = require('fs');
const path = require('path');
const { logWarn } = require('./logger');

const TARGET_FILE = process.env.TARGET_ALLOCATION_FILE
  || path.join(__dirname, '..', 'config', 'target-allocation.json');

const DEFAULT_TOLERANCE_BAND_PCT = 3;
const DEFAULT_TOLERANCE_SUM_PCT = 0.5;

/**
 * 목표 배분을 읽고 **검증**한다.
 *
 * 🔴 깨진 설정이면 `null` — 부분적으로 쓰지 않는다. 합이 90 인 목표로 괴리를 계산하면
 *    모든 칸이 "부족하다" 로 나와 **모델을 한 방향으로 민다.** 모르는 것이 틀린 것보다 낫다.
 * ⚠️ 심볼이 카탈로그에 없으면 **그 심볼만** 버리고 warn — 버킷을 통째로 버리면 목표
 *    합이 깨져 위 판정에 걸려 전체가 죽는다(티커 하나 오타가 전략을 통째로 날린다).
 *
 * @param catalog etf-catalog 내용. 넘기지 않으면 regimeService 에서 읽는다(정본 한 벌).
 */
function load({ file = TARGET_FILE, catalog = null } = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    logWarn('target.unreadable', { file, message: e.message });
    return null;
  }

  const cat = catalog || (() => {
    try { return require('./regimeService').readCatalog(); } catch { return null; }
  })();
  /**
   * ⚠️ 카탈로그를 **못 읽은 것**과 **비어 있는 것**은 다르다. 못 읽었으면 심볼 검증을
   *    건너뛴다 — 건너뛴 것을 "전부 없는 심볼" 로 읽으면 목표가 통째로 비워진다
   *    ("검사 안 한 것" 과 "통과한 것" 을 구분하지 못하는 자를 만들지 말 것).
   */
  const known = new Set();
  for (const c of Object.values(cat?.categories || {})) {
    for (const e of c?.etfs || []) known.add(String(e.symbol).toUpperCase());
  }
  const canCheckSymbols = known.size > 0;
  if (!canCheckSymbols) logWarn('target.symbol_check_skipped', { reason: '카탈로그를 읽지 못했다 — 심볼 검증 없이 진행' });

  const buckets = [];
  for (const b of raw?.buckets || []) {
    const key = String(b?.key || '').trim();
    const targetPct = Number(b?.targetPct);
    if (!key || !Number.isFinite(targetPct)) {
      logWarn('target.bucket_invalid', { key: key || null, targetPct: b?.targetPct ?? null });
      continue;
    }
    const wanted = (b.symbols || []).map((s) => String(s).toUpperCase());
    const symbols = canCheckSymbols ? wanted.filter((s) => known.has(s)) : wanted;
    const dropped = wanted.filter((s) => !symbols.includes(s));
    if (dropped.length) logWarn('target.symbol_not_in_catalog', { bucket: key, dropped });

    buckets.push({
      key,
      name: String(b.name || key),
      targetPct,
      symbols,
      isCash: b.cash === true,
      role: b.role || '',
      note: b.note || '',
      slot: b.slot ? { ...b.slot } : null,
    });
  }

  if (!buckets.length) {
    logWarn('target.no_buckets', { file });
    return null;
  }

  const toleranceSumPct = Number.isFinite(Number(raw?.toleranceSumPct))
    ? Number(raw.toleranceSumPct) : DEFAULT_TOLERANCE_SUM_PCT;
  const sum = buckets.reduce((a, b) => a + b.targetPct, 0);
  if (Math.abs(sum - 100) > toleranceSumPct) {
    logWarn('target.sum_invalid', { sum: Math.round(sum * 10) / 10, tolerance: toleranceSumPct });
    return null;
  }

  return {
    buckets,
    toleranceBandPct: Number.isFinite(Number(raw?.toleranceBandPct))
      ? Number(raw.toleranceBandPct) : DEFAULT_TOLERANCE_BAND_PCT,
    toleranceSumPct,
    sumPct: Math.round(sum * 10) / 10,
  };
}

/**
 * 현재 비중 vs 목표 배분.
 *
 * @param items    보유 [{symbol, marketValue|quantity×lastPrice, leverageFactor}]
 * @param summary  잔고 요약(현금·환율) — 분모에 현금이 들어간다
 * @param catalog  etf-catalog(심볼→카테고리). `weightsOf` 에 그대로 넘어간다
 * @param deps.target   load() 결과(주입하면 재로드 생략)
 * @param deps.weightsOf 비중 계산 — 🔴 **기본값이 정본**이고 분모 동치의 근거다
 *
 * @returns {null|object} `{asOf, totalValue, toleranceBandPct, buckets[], unclassified[], weights}`
 *   buckets[]: `{key, name, targetPct, currentPct, gapPct, direction, symbols, held[], slot, role, note}`
 *   ⚠️ 목표나 비중을 못 구하면 `null` — 0 으로 채우면 "목표 달성" 으로 읽힌다.
 */
function compare(items = [], summary = null, catalog = null, deps = {}) {
  const {
    target = load({ catalog }),
    weightsOf = (i, s, c) => require('./analystService').portfolioWeights(i, s, c),
  } = deps;

  if (!target) return null;
  const weights = weightsOf(items || [], summary, catalog);
  if (!weights) {
    logWarn('target.weights_unavailable', { reason: '보유·현금 합이 0 이거나 비중을 못 구했다' });
    return null;
  }

  /**
   * 🔴 **비중은 재계산하지 않고 `weights.holdings[].pct` 를 그대로 합산한다.**
   *    값(달러)에서 다시 나누면 반올림이 갈려 "화면 31.2% / 목표 절 31.3%" 가 된다.
   *    화면과 프롬프트에 같은 숫자가 가는 것이 이 모듈의 존재 이유다.
   */
  const byBucket = new Map(target.buckets.map((b) => [b.key, []]));
  const symToBucket = new Map();
  for (const b of target.buckets) {
    for (const s of b.symbols) {
      // 같은 심볼이 두 버킷에 있으면 **먼저 선언된 쪽**이 이긴다(카탈로그 매핑과 같은 규율)
      if (!symToBucket.has(s)) symToBucket.set(s, b.key);
      else logWarn('target.symbol_duplicate', { symbol: s, kept: symToBucket.get(s), ignored: b.key });
    }
  }

  const unclassified = [];
  for (const h of weights.holdings || []) {
    const sym = String(h.symbol).toUpperCase();
    const bucketKey = symToBucket.get(sym);
    if (bucketKey) byBucket.get(bucketKey).push({ symbol: sym, pct: h.pct, leverage: h.leverage });
    else unclassified.push({ symbol: sym, pct: h.pct, category: h.category, leverage: h.leverage });
  }

  const round1 = (v) => Math.round(v * 10) / 10;
  const band = target.toleranceBandPct;
  const buckets = target.buckets.map((b) => {
    const held = byBucket.get(b.key) || [];
    const currentPct = b.isCash
      ? round1(Number(weights.cashPct) || 0)
      : round1(held.reduce((a, h) => a + (Number(h.pct) || 0), 0));
    const gapPct = round1(currentPct - b.targetPct);
    /**
     * direction — `add`(목표보다 적다) / `trim`(많다) / `ok`(밴드 안).
     * ⚠️ `add` 는 **"지금 사라"가 아니다.** 방향이고, 속도는 국면이 정한다(프롬프트에 명시).
     */
    const direction = Math.abs(gapPct) <= band ? 'ok' : (gapPct < 0 ? 'add' : 'trim');
    return {
      key: b.key,
      name: b.name,
      targetPct: b.targetPct,
      currentPct,
      gapPct,
      direction,
      symbols: b.symbols,
      held,
      isCash: b.isCash,
      slot: b.slot,
      role: b.role,
      note: b.note,
    };
  });

  /**
   * 🔴 **목표에 선언했는데 감시에 없는 심볼** (2026-10-06 라이브에서 잡힌 결함).
   *
   *    예산을 올리자 모델이 `ENTER` 로 돌아섰는데 대상이 **QQQ** 였다 — 목표의 기반 자산은
   *    **QQQM** 인데 그게 **감시에서 꺼져 있어 후보 목록에 올라오지 않았고**, 모델이 가장
   *    가까운(감시중인) QQQ 를 골랐다. 즉 *"목표에 적었다"* 와 *"후보로 도달한다"* 는
   *    다른 층이다 — 이 저장소가 같은 날 네 번째로 밟은 **"등록됐다 ≠ 도달한다"**.
   * ⚠️ 조용히 넘기면 모델이 **매 회차 비슷한 대체 종목을 고르고**, 그 결과는 나중에
   *    `unclassified`(목표 밖 보유)로 쌓인다 — 원인은 안 보이고 증상만 남는다.
   * ⚠️ 감시 목록을 못 읽으면 **빈 배열이 아니라 null** 이다("감시 안 됨" 과 "모름" 을 가른다).
   */
  let unwatchedTargets = null;
  try {
    const ws = (deps.watchState || require('./watchlistService').getWatchlistState)();
    const on = new Set();
    for (const g of (ws?.groups || [])) {
      for (const t of (g.tickers || [])) if (t.watch) on.add(String(t.symbol).toUpperCase());
    }
    unwatchedTargets = [];
    for (const b of buckets) {
      for (const sym of (b.symbols || [])) {
        if (!on.has(String(sym).toUpperCase())) unwatchedTargets.push({ symbol: sym, bucket: b.key });
      }
    }
  } catch (e) {
    logWarn('target.watch_check_failed', { message: e.message });   // 건너뜀은 "전부 감시중" 이 아니다
  }

  return {
    asOf: new Date().toISOString(),
    totalValue: weights.total,
    toleranceBandPct: band,
    buckets,
    unclassified: unclassified.sort((a, b) => b.pct - a.pct),
    unwatchedTargets,
    weights,
  };
}

/**
 * 애널리스트 프롬프트 RAG 절 — 모델이 읽을 장기 목표.
 *
 * 🔴 담아야 하는 것 네 가지(빠지면 모델이 목표를 오독한다):
 *   ① 버킷별 목표·현재·괴리 **숫자** (괴리를 모르면 리밸런싱 제안은 원리상 안 나온다)
 *   ② base_slot 의 **스위칭 규칙** (안 적으면 QQQM·TQQQ 를 둘 다 쌓는 제안이 나온다)
 *   ③ **"장기 목표다 — 국면이 나쁘면 속도를 줄이되 방향을 바꾸지 않는다"**
 *      (안 적으면 모델이 "지금 당장 채워라" 로 읽어 국면 무시가 된다)
 *   ④ `unclassified` 는 **정리 우선순위** (목표에 없는 종목 = 재원으로 바꿀 대상)
 */
function promptSection(cmp) {
  if (!cmp) return '';
  const L = ['## 장기 목표 배분 (사용자 선언 — 코드 계산, 재계산하지 말 것)'];
  L.push('');
  L.push('| 버킷 | 목표 | 현재 | 괴리 | 방향 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const b of cmp.buckets) {
    const arrow = b.direction === 'add' ? '부족(모을 여지)' : b.direction === 'trim' ? '초과(줄일 여지)' : '적정';
    const gap = `${b.gapPct > 0 ? '+' : ''}${b.gapPct}%p`;
    L.push(`| ${b.name} | ${b.targetPct}% | ${b.currentPct}% | ${gap} | ${arrow} |`);
  }
  L.push('');
  L.push(`- 괴리 허용 밴드 ±${cmp.toleranceBandPct}%p 안은 '적정' 으로 본다(가격만 움직여도 비중은 매일 흔들린다).`);

  // 버킷별 구성·역할 — 어느 종목으로 그 칸을 채우는지
  for (const b of cmp.buckets) {
    if (b.isCash) continue;
    const heldTxt = b.held.length
      ? b.held.map((h) => `${h.symbol} ${h.pct}%`).join(' · ')
      : '보유 없음';
    L.push(`- **${b.name}** (${b.symbols.join('/') || '현금'}): 보유 ${heldTxt} — ${b.role}`);
  }

  // ② 스위칭 규칙 — 슬롯을 선언한 버킷마다
  const slots = cmp.buckets.filter((b) => b.slot?.primary && b.slot?.momentum);
  for (const b of slots) {
    const maxOfSlot = Number(b.slot.momentumMaxPctOfSlot) || 0;
    const maxOfTotal = Math.round((b.targetPct * maxOfSlot) / 100 * 10) / 10;
    L.push('');
    L.push(`### ${b.name} — 스위칭 규칙 (🔴 한 슬롯이다)`);
    L.push(`- 이 ${b.targetPct}% 는 **한 칸**이다. ${b.slot.primary} 와 ${b.slot.momentum} 를 **둘 다 쌓는 칸이 아니다** — 같은 방향을 배수만 다르게 중복 보유하지 않는다(사실상 고배수 한 종목이 된다).`);
    L.push(`- 평시: ${b.slot.primary} 100%.`);
    L.push(`- 모멘텀 확정 시(종가>20일선>60일선 정배열 + VIX 평온): 슬롯의 최대 ${maxOfSlot}%(= 전체의 ${maxOfTotal}%)를 ${b.slot.momentum} 로 **교체**한다. 추가 매수가 아니라 교체다.`);
    L.push(`- 모멘텀이 꺾이면 ${b.slot.momentum} → ${b.slot.primary} 로 되돌린다.`);
  }

  // ④ 미분류 = 정리 우선순위
  L.push('');
  if (cmp.unclassified.length) {
    const txt = cmp.unclassified.map((u) => `${u.symbol} ${u.pct}%`).join(' · ');
    L.push(`### 목표 밖 보유 — 🔴 정리 우선순위`);
    L.push(`- ${txt}`);
    L.push('- 이 종목들은 **장기 목표 배분에 없다.** 목표 칸(특히 부족한 칸)을 채울 재원으로 전환하는 것이 우선이다. ⚠️ 당장 전량 매도하라는 뜻은 아니다 — 손익·국면·세금을 보고 순서를 정하되, **새로 늘리는 대상은 아니다**.');
  } else {
    L.push('- 목표 밖 보유: 없음(모든 보유가 목표 버킷 안에 있다).');
  }

  // ③ 가장 중요한 경계 — 맨 끝에 둔다(길이에 밀려도 마지막은 남는다)
  L.push('');
  L.push('### 🔴 이 목표를 읽는 법');
  L.push('- **이것은 장기 목표다. 국면이 나쁘면 목표로 가는 *속도*를 줄이되 *방향*을 바꾸지 않는다.**');
  L.push('- 괴리를 "지금 당장 채워라" 로 읽지 말 것 — 그러면 국면 판정이 무의미해진다. 위험 국면에서는 분할·소액·대기가 정답이고, 그래도 **방향은 목표 쪽**이다.');
  L.push('- 국면별 기준 배분(아래 매뉴얼)과 충돌하면 **국면이 단기 우선**이다. 이 목표는 어디로 가는지를 말하고, 국면은 지금 얼마나 가도 되는지를 말한다.');
  return L.join('\n');
}

module.exports = { load, compare, promptSection, TARGET_FILE };
