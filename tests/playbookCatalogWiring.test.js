/**
 * 🔴 playbook ↔ etf-catalog 배선 가드 (2026-10-01)
 *
 * ## 무엇을 막는가
 * `regimeService` 가 발동 매뉴얼에서 도구상자 카테고리를 끌어올 때, 종전에는
 * **스텝 문자열 안에 카테고리 키가 문자 그대로 박혀 있는가** 로 추측했다
 * (`for (key of catalog.categories) if (step.includes(key)) ...`).
 *
 * 스텝을 심볼이나 한글로 쓰면 **조용히 0개**가 되는데, 도구상자가 비면 프롬프트가
 * "이 목록 밖 티커는 계좌 검증이 거부한다" 를 붙이므로 **매수 제안이 통째로 0** 이 된다.
 * 실측(수정 전): `side_grind` 0개 · `fear_ladder` 는 `kr_broad` 하나뿐 —
 * **VIX 사다리가 발동하는 바로 그 순간, 사라고 한 QQQ·SPY 가 화이트리스트 밖**이었다.
 *
 * ## 자의 방향
 * 이 자는 "카테고리 키를 안 적었다" 가 아니라 **"스텝이 사라고 말한 티커가 도구상자에
 * 실리는가"** 를 본다 — 배선이 다시 끊기면 *끊긴 그 지점*에서 깨진다.
 *
 * ⚠️ 검사 대상이 0건이면 **실패**다(파일 구조가 바뀌어 조용히 안 돌 수 있다).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const regime = require('../server/regimeService');

const playbook = regime.readPlaybook();
const catalog = regime.readCatalog();
const scenarios = playbook.scenarios || [];

/**
 * 🔴 면제 — 스텝 산문에 섞이는 **티커가 아닌 2~5자 영대문자**.
 * ⚠️ 이유 없는 면제는 곧 구멍이다. 그리고 이 목록은 **전체 불변식으로 검사**한다
 *    (아래 "면제는 전부 실제로 지탱한다") — 장식 면제가 쌓이면 진짜 위반을 조용히 봐준다.
 */
const NON_TICKER = {
  // 공포지수 이름. 사다리 규칙(20/25/30/35)을 설명하는 모든 스텝에 나온다 — 거래 대상이 아니다.
  VIX: 'VIX 지수 이름 — 매수 대상이 아니라 밴드 판정 입력',
  // bull_calm 의 `confidence 는 LOW/MEDIUM 로 정직하게`. 확신도 등급이다.
  // (MEDIUM 은 6자라 2~5자 추출 규칙에 애초에 안 걸린다 — LOW 만 면제가 필요하다)
  LOW: 'confidence 등급(LOW/MEDIUM) — 종목이 아니다',
  // fear_ladder modelPortfolio 키 `1배 광범위(QQQ/SPY, KR 이면 069500)` — 시장 코드다.
  // ⚠️ 실제 KR 종목은 6자리 숫자(069500)라 2~5자 영대문자 추출에 안 걸린다.
  KR: '시장 코드(한국) — 종목이 아니다',
};

/** 산문에서 티커 후보(2~5자 영대문자)를 뽑는다 */
const tickersIn = (text) => [...new Set(String(text).match(/\b[A-Z]{2,5}\b/g) || [])];

/**
 * 🔴 **프롬프트에 실제로 실리는 모든 산문** — steps 만 보면 두 번째 표면을 놓친다 (2026-10-01).
 *
 * `promptSection` 은 스텝만 내보내는 게 아니다. `modelPortfolio` 의 **키**를 `기준 배분:` 줄로,
 * `_설명` 의 **값**을 그 아래 괄호 줄로 함께 내보낸다 — 거기에도 티커가 박혀 있다.
 * 실측(수정 전): `bull_calm` 이 `방어(배당 SCHD)` 를 기준 배분으로 보여주는데 SCHD 는
 * 도구상자 밖이었다 ⇒ 같은 화면에서 "이쪽으로 가라" 와 "그건 거부한다" 가 동시에 나갔다.
 * **모델에게 도달 불가능한 목표를 준 것**이고, 나침반이 울타리 밖을 가리키면 소음이다.
 *
 * ⚠️ 첫 판의 자가 steps 만 봐서 이 표면을 **원리상 못 봤다**(사람이 손으로 찾았다).
 *    프롬프트에 실리는 출처가 늘면 여기에 함께 더해야 한다.
 */
function proseOf(sc) {
  const out = [...(sc.steps || [])];
  for (const [k, v] of Object.entries(sc.modelPortfolio || {})) {
    if (k === '_설명') out.push(String(v)); // 키가 아니라 값이 프롬프트로 나간다
    else out.push(k);
  }
  return out;
}

/** 한 시나리오의 categories 가 품는 ETF 심볼 집합 */
function symbolsOf(sc) {
  const out = new Set();
  for (const key of regime.scenarioCategories(sc, catalog)) {
    for (const e of catalog.categories[key].etfs) out.add(e.symbol);
  }
  return out;
}

// ── (라) 검사 대상이 실재하는가 — 0건 통과를 막는다 ──────────────

test('🔴 검사 대상이 실재한다 — 시나리오 5개 이상 · 카탈로그 카테고리 5개 이상', () => {
  assert.ok(
    scenarios.length >= 5,
    `playbook 시나리오가 ${scenarios.length}개 — 구조가 바뀌어 이 자가 아무것도 안 보고 있다`
  );
  assert.ok(
    Object.keys(catalog.categories || {}).length >= 5,
    'etf-catalog 카테고리가 5개 미만 — 자가 빈 카탈로그를 보고 전부 통과시킬 수 있다'
  );
});

// ── (가)(나) 명시 배선이 있고, 가리키는 곳이 실재하는가 ─────────

test('🔴 모든 시나리오가 categories 배열을 명시한다 (추측 배선으로 떨어지지 않는다)', () => {
  const missing = scenarios.filter((sc) => !Array.isArray(sc.categories)).map((sc) => sc.id);
  assert.deepEqual(
    missing, [],
    `categories 미선언: ${missing.join(', ')} — 코드가 옛 부분문자열 추측으로 떨어진다(조용히 0개가 될 수 있다)`
  );
});

test('🔴 categories 의 모든 원소가 etf-catalog 에 실재한다 (오타가 조용히 버려지지 않는다)', () => {
  const bad = [];
  for (const sc of scenarios) {
    for (const key of sc.categories || []) {
      if (!catalog.categories?.[key]) bad.push(`${sc.id} → ${key}`);
    }
  }
  assert.deepEqual(bad, [], `카탈로그에 없는 카테고리: ${bad.join(' · ')}`);
});

test('빈 categories 는 허용하되 이유를 적어야 한다 (_categoriesNote)', () => {
  for (const sc of scenarios) {
    if (Array.isArray(sc.categories) && sc.categories.length === 0) {
      assert.ok(
        typeof sc._categoriesNote === 'string' && sc._categoriesNote.length > 20,
        `${sc.id}: categories 가 비었는데 _categoriesNote 가 없다 — "추측 미기입" 과 "의도한 빈 값" 이 구분되지 않는다`
      );
    }
  }
});

// ── (다) 핵심 — 사라고 말한 티커가 도구상자에 실리는가 ──────────

test('🔴 프롬프트가 보여주는 티커는 전부 그 시나리오의 도구상자 안에 있다 (steps + modelPortfolio)', () => {
  const violations = [];
  let checkedTickers = 0;
  for (const sc of scenarios) {
    const symbols = symbolsOf(sc);
    for (const line of proseOf(sc)) {
      for (const t of tickersIn(line)) {
        if (NON_TICKER[t]) continue;
        checkedTickers += 1;
        if (!symbols.has(t)) {
          violations.push(
            `${sc.id}: 프롬프트가 '${t}' 를 보여주는데 categories(${(sc.categories || []).join(',') || '없음'}) 의 ETF 집합에 없다`
            + ` — 모델은 "이쪽으로 가라" 와 "그건 거부한다" 를 동시에 받는다 [출처: ${line.slice(0, 40)}]`
          );
        }
      }
    }
  }
  assert.deepEqual(violations, [], `\n  ${violations.join('\n  ')}\n`);
  // 🔴 티커를 한 개도 안 봤으면 통과가 아니라 "검사 못 함" 이다
  assert.ok(checkedTickers >= 5, `검사한 티커가 ${checkedTickers}개 — 추출 정규식이 아무것도 못 잡고 있다`);
});

test('🔴 자가 두 표면을 다 본다 — steps 전용·modelPortfolio 전용 티커가 둘 다 검사 대상이다', () => {
  // 09-30 교훈의 적용: "대상이 0건인가" 가 아니라 **"재려던 그것이 대상에 들었나"**.
  // steps 만 보던 첫 판은 modelPortfolio 표면을 원리상 못 봤다 — 그 구멍이 다시 생기면 여기서 깨진다.
  const stepOnly = new Set();
  const mpOnly = new Set();
  for (const sc of scenarios) {
    const inSteps = new Set((sc.steps || []).flatMap(tickersIn).filter((t) => !NON_TICKER[t]));
    const mpLines = proseOf(sc).filter((l) => !(sc.steps || []).includes(l));
    const inMp = new Set(mpLines.flatMap(tickersIn).filter((t) => !NON_TICKER[t]));
    for (const t of inSteps) if (!inMp.has(t)) stepOnly.add(`${sc.id}:${t}`);
    for (const t of inMp) if (!inSteps.has(t)) mpOnly.add(`${sc.id}:${t}`);
  }
  assert.ok(stepOnly.size > 0, 'steps 에만 있는 티커가 0건 — steps 축이 검사 대상에서 빠졌을 수 있다');
  assert.ok(
    mpOnly.size > 0,
    'modelPortfolio 에만 있는 티커가 0건 — 두 번째 표면이 검사 대상에서 빠졌다(첫 판의 구멍이 그대로다)'
  );
});

test('🔴 면제는 전부 실제로 지탱한다 — 장식 면제가 없다', () => {
  // 면제를 빼면 실제로 위반이 되는가? 안 되면 그 면제는 장식이고, 장식 면제는 진짜 위반을 봐준다.
  const dead = [];
  for (const [token, reason] of Object.entries(NON_TICKER)) {
    assert.ok(reason && reason.length > 5, `면제 ${token} 에 이유가 없다`);
    const loadBearing = scenarios.some((sc) => {
      const symbols = symbolsOf(sc);
      return proseOf(sc).some((line) => tickersIn(line).includes(token)) && !symbols.has(token);
    });
    if (!loadBearing) dead.push(token);
  }
  assert.deepEqual(
    dead, [],
    `장식 면제(빼도 아무것도 안 걸린다): ${dead.join(', ')} — 지워라. 안 지우면 나중에 같은 이름의 진짜 티커를 봐준다`
  );
});

// ── 배선이 실제로 한 벌인가 (복제가 이 결함의 뿌리였다) ─────────

test('🔴 프롬프트 도구상자와 매수 후보가 같은 판정을 탄다 (두 벌이면 갈라진다)', async () => {
  const fear = scenarios.find((sc) => sc.id === 'fear_ladder');
  assert.ok(fear, 'fear_ladder 시나리오가 없다');

  const state = regime.compute({ us: { closes: Array.from({ length: 70 }, (_, i) => 100 + i) }, vix: 26 });
  const section = regime.promptSection(state, [fear]);

  // candidateSection 은 외부 호출을 쓰므로 주입한다(네트워크 없이 판정만 본다)
  const asked = [];
  const cand = await regime.candidateSection([fear], {
    heldSymbols: [],
    getCandles: async (symbol) => { asked.push(symbol); return { rows: [{ c: 100 }] }; },
    summarize: () => ({ last: 100, ma20: 100, ma60: 100, bars: 120, fromHighPct: -5 }),
  });

  assert.ok(asked.length > 0, '매수 후보가 0개 — 도구상자는 있는데 후보가 비었다(배선이 갈라졌다)');
  for (const symbol of asked) {
    assert.ok(
      section.includes(symbol),
      `후보 ${symbol} 가 프롬프트 도구상자에 없다 — 모델이 "목록 밖" 으로 읽어 제안을 못 낸다`
    );
    assert.ok(cand.includes(symbol), `후보 ${symbol} 가 후보 절에 안 실렸다`);
  }
});

test('🔴 VIX 사다리가 하드코딩한 QQQ 가 fear_ladder 도구상자 안에 있다', () => {
  // ladderProposals 는 symbol:'QQQ' 를 상수로 낸다. 그 종목이 화이트리스트 밖이면
  // 계좌 검증이 거부해 **사다리가 발동해도 체결로 못 간다**(이 작업이 고친 바로 그 구멍).
  const proposals = regime.ladderProposals({ prevBand: 0, band: 1, cashUsd: 10000 });
  assert.ok(proposals.length > 0, '사다리 제안이 0건 — 이 단언이 공허해졌다');
  const fear = scenarios.find((sc) => sc.id === 'fear_ladder');
  const symbols = symbolsOf(fear);
  for (const p of proposals) {
    assert.ok(symbols.has(p.symbol), `사다리가 ${p.symbol} 를 제안하는데 fear_ladder 도구상자에 없다`);
  }
});

// ── 매수 후보 선별 — 라운드로빈 (2026-10-01) ────────────────────

const byId = (id) => scenarios.find((sc) => sc.id === id);
const picks = (ids) => regime.roundRobinCandidates(ids.map(byId), catalog, new Set()).map((w) => w.symbol);

/**
 * 🔴 **회귀 잠금 — 단일 발동은 종전과 글자 그대로 같아야 한다.**
 *
 * 라운드로빈은 시나리오가 둘 이상일 때만 순차와 갈린다(한 줄에서 1개씩 = 순차).
 * 단일 발동이 압도적으로 흔하므로 **거기서 회귀를 내면 이 변경은 손해**다.
 * 아래 값은 순차 구현에서 **실측해 받아 적은 것**이다 — 순서까지 못박는다.
 */
const SINGLE_GOLDEN = {
  bull_calm: ['QQQ', 'SOXX', 'SPY', 'SCHD'],
  side_grind: ['QQQ', 'SOXX', 'XLP', 'XLV', 'GLD', 'SCHD'],
  /**
   * ⚠️ 2026-10-01 **순서만** 바뀌었다 — `inverse_hedge` 를 playbook 선언 맨 앞으로 옮겼기 때문이다.
   * (라운드로빈에서 bear_trend 가 상한 6 중 3~4칸만 받아 선언 끝의 PSQ 가 **하락장 조합마다**
   *  잘리고 있었다 — 헤지가 가장 필요한 순간에만 없어지는 모양이라 09-24 결함의 재발이다.)
   * 🔴 **집합은 그대로다**(5종 동일) — 단독 발동은 상한 미만이라 아무도 안 잘린다. 집합이 바뀌면 회귀다.
   */
  bear_trend: ['PSQ', 'XLP', 'XLV', 'TLT', 'GLD'],
  shock_day: [],
  fear_ladder: ['QQQ', 'SPY'],
  war_geopolitics: ['ITA', 'XLE', 'GLD'],
};

test('🔴 회귀 잠금 — 단일 시나리오 6종의 후보가 순차 구현과 순서까지 동일하다', () => {
  // 대상 계정: 모든 시나리오가 골든에 들어 있어야 한다(새 시나리오가 조용히 빠지지 않게)
  const uncovered = scenarios.map((sc) => sc.id).filter((id) => !(id in SINGLE_GOLDEN));
  assert.deepEqual(uncovered, [], `골든에 없는 시나리오: ${uncovered.join(',')} — 추가하고 실측값을 적어라`);
  for (const [id, expected] of Object.entries(SINGLE_GOLDEN)) {
    assert.ok(byId(id), `시나리오 ${id} 가 playbook 에서 사라졌다`);
    assert.deepEqual(picks([id]), expected, `${id} 단일 발동 후보가 바뀌었다(순차 대비 회귀)`);
  }
});

test('🔴 라운드로빈 — 발동한 모든 시나리오가 최소 1칸을 받는다 (앞 시나리오가 상한을 독식하지 않는다)', () => {
  // 실측 결함: side_grind(카테고리 6개)가 혼자 상한 6을 먹어 fear_ladder 의 SPY 가 통째로 밀렸다.
  const catOwner = new Map(); // categoryKey → 그 카테고리를 선언한 시나리오들
  for (const sc of scenarios) for (const k of regime.scenarioCategories(sc, catalog)) {
    if (!catOwner.has(k)) catOwner.set(k, new Set());
    catOwner.get(k).add(sc.id);
  }
  const combos = [
    ['side_grind', 'fear_ladder'],
    ['bear_trend', 'fear_ladder'],
    ['bear_trend', 'side_grind'],
    ['side_grind', 'fear_ladder', 'war_geopolitics'],
  ];
  const eligible = (k) => catalog.categories[k].etfs.some((e) => Math.abs(e.leverage) === 1 && e.market !== 'KR');
  let starvationChecks = 0;
  for (const ids of combos) {
    const scs = ids.map(byId);
    const got = regime.roundRobinCandidates(scs, catalog, new Set());
    const claimed = new Set(got.map((w) => w.categoryKey));
    scs.forEach((sc, i) => {
      // 🔴 "내 카테고리가 채워졌나" 가 아니라 **"내가 집었나"** 로 센다 — 카테고리를 공유하면
      //    남이 채운 것을 자기 몫으로 착각한다(첫 판이 그 착각으로 순차 변이를 놓쳤다).
      if (got.some((w) => w.scenarioIdx === i)) return;
      starvationChecks += 1;
      // 0칸이 정당하려면 내 카테고리가 전부 '남이 가져갔거나 / 쓸 수 있는 ETF 가 없거나' 여야 한다
      const unexplained = regime.scenarioCategories(sc, catalog).filter((k) => !claimed.has(k) && eligible(k));
      assert.deepEqual(
        unexplained, [],
        `[${ids.join('+')}] 에서 ${sc.id} 가 한 칸도 못 받았는데 아직 아무도 안 가져간 카테고리가 남아 있다: ${unexplained.join(',')}`
        + ` — 앞 시나리오가 상한 ${regime.CANDIDATE_MAX} 을 독식했다 (받은 것: ${got.map((w) => w.symbol).join(',')})`
      );
    });
  }
  // ⚠️ 굶은 시나리오가 하나도 없으면 위 단언은 한 번도 안 돌았다 — 그건 통과가 아니라 미실행이다.
  //    (라운드로빈이 정상이면 0건이 맞으므로 실패시키지 않고, 사실만 남긴다)
  assert.ok(starvationChecks >= 0, '도달 불가');
});

test('🔴 scenarioIdx 는 "집어 간 시나리오" 를 가리킨다 — 공유 카테고리에서 남의 몫을 자기 것으로 세지 않는다', () => {
  // side_grind·fear_ladder 는 tech_broad 를 공유한다. 라운드로빈에서 tech_broad(QQQ)는
  // 먼저 도는 side_grind(idx 0)가 집고, fear_ladder(idx 1)는 sp_broad(SPY)를 집어야 한다.
  const got = regime.roundRobinCandidates([byId('side_grind'), byId('fear_ladder')], catalog, new Set());
  const qqq = got.find((w) => w.symbol === 'QQQ');
  const spy = got.find((w) => w.symbol === 'SPY');
  assert.ok(qqq && spy, `QQQ·SPY 둘 다 있어야 한다 — 받은 것: ${got.map((w) => w.symbol).join(',')}`);
  assert.equal(qqq.scenarioIdx, 0, 'QQQ 는 먼저 도는 side_grind 가 집어야 한다');
  assert.equal(spy.scenarioIdx, 1, 'SPY 는 fear_ladder 가 집어야 한다 — 이게 0이면 귀속이 거짓말이다');
  // 모든 칸에 귀속이 붙어 있다(누락이 있으면 공정성 검사가 조용히 헐거워진다)
  for (const w of got) assert.equal(typeof w.scenarioIdx, 'number', `${w.symbol} 에 scenarioIdx 가 없다`);
});

test('🔴 공포 사다리가 지목한 SPY 가 side_grind 와 함께 발동해도 살아남는다 (이 작업이 고친 그 자리)', () => {
  const got = picks(['side_grind', 'fear_ladder']);
  assert.ok(got.includes('SPY'), `SPY 가 밀렸다 — 받은 것: ${got.join(',')}`);
  assert.ok(got.includes('QQQ'), `QQQ 가 밀렸다 — 받은 것: ${got.join(',')}`);
});

/**
 * 🔴 인버스 헤지(PSQ)는 **하락장 조합에서 살아남아야 한다** (2026-10-01).
 *
 * 09-24 에 *"생필품이 XLP·VDC 로 두 자리를 먹어 인버스가 항상 잘렸다"* 를 **카테고리당 1개**로
 * 고쳤는데, 같은 종목이 **한 층 위(시나리오 라운드로빈)에서 다시 잘리고 있었다.**
 * ★ 헤지는 **하락장에서만 의미가 있는데 하필 하락장 조합에서만 잘렸다** — 가장 필요한
 *   순간에만 없어지는 결함이라, 단독 발동만 보면 영영 안 보인다.
 * ⚠️ 알고도 두면 고친 게 아니라 **한 층 옮긴 것**이다(이 워크스페이스가 타임아웃 역전에서
 *    세 번 밟은 그 모양).
 */
test('🔴 인버스 헤지(PSQ)가 하락장 조합 전부에서 후보로 살아남는다 (09-24 결함의 한 층 위 재발)', () => {
  const bearCombos = [
    ['bear_trend'],
    ['bear_trend', 'fear_ladder'],
    ['bear_trend', 'side_grind'],
    ['bear_trend', 'side_grind', 'fear_ladder'],
  ];
  for (const ids of bearCombos) {
    const got = picks(ids);
    assert.ok(
      got.includes('PSQ'),
      `[${ids.join('+')}] 에서 PSQ 가 밀렸다 — 헤지가 가장 필요한 국면에서 기술 위치 숫자를 못 받는다.`
      + ` playbook 의 bear_trend categories 에서 inverse_hedge 가 뒤로 밀렸는지 보라 (받은 것: ${got.join(',')})`
    );
  }
  // ⚠️ 단독 발동은 상한(6) 미만(5종)이라 **아무도 안 잘린다** — 집합이 바뀌면 그건 순서 변경이 아니라 회귀다
  assert.deepEqual(
    [...picks(['bear_trend'])].sort(),
    ['GLD', 'PSQ', 'TLT', 'XLP', 'XLV'],
    'bear_trend 단독 발동의 후보 **집합**이 바뀌었다(순서만 바뀌어야 한다)'
  );
});

test('🔴 라운드로빈이 전역 규칙을 깬 적 없다 — 상한·카테고리당 1개·같은 심볼 1회·1배·미보유·KR제외', () => {
  const combos = [
    ['side_grind', 'fear_ladder'],
    ['bear_trend', 'side_grind', 'fear_ladder'],
    ['bull_calm', 'side_grind'],
    ['side_grind', 'fear_ladder', 'war_geopolitics'],
  ];
  const sym2etf = new Map();
  for (const c of Object.values(catalog.categories)) for (const e of c.etfs) sym2etf.set(e.symbol, e);
  let checked = 0;
  for (const ids of combos) {
    const got = regime.roundRobinCandidates(ids.map(byId), catalog, new Set(['GLD']));
    checked += got.length;
    assert.ok(got.length <= regime.CANDIDATE_MAX, `[${ids.join('+')}] 상한 초과: ${got.length}`);
    assert.equal(new Set(got.map((w) => w.symbol)).size, got.length, `[${ids.join('+')}] 같은 심볼이 두 번`);
    assert.equal(new Set(got.map((w) => w.categoryKey)).size, got.length, `[${ids.join('+')}] 같은 카테고리가 두 번`);
    for (const w of got) {
      const e = sym2etf.get(w.symbol);
      assert.equal(Math.abs(e.leverage), 1, `${w.symbol} 는 1배가 아니다`);
      assert.notEqual(e.market, 'KR', `${w.symbol} 는 KR 종목이다(원화 현금 필요)`);
      assert.notEqual(w.symbol, 'GLD', '보유 종목(GLD)이 후보에 올라왔다');
    }
  }
  assert.ok(checked >= 12, `검사한 후보가 ${checked}개 — 조합이 전부 비어 공허하게 통과했다`);
});

// ── 폴백·오타 경로가 조용하지 않은가 ────────────────────────────

test('🔴 categories 가 없으면 옛 추측으로 떨어지되 조용하지 않다 (warn)', () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (line) => { warned.push(String(line)); };
  try {
    const keys = regime.scenarioCategories(
      { id: 'legacy_shape', steps: ['방어 카테고리(staples) 확대'] },
      catalog
    );
    assert.deepEqual(keys, ['staples'], '폴백이 옛 동작을 재현하지 못한다(하위호환 깨짐)');
  } finally { console.warn = orig; }
  assert.ok(
    warned.some((w) => w.includes('regime.playbook_categories_missing') && w.includes('legacy_shape')),
    `폴백이 조용했다 — 조용한 폴백이 이 결함의 원인이었다. 받은 로그: ${warned.join(' | ') || '(없음)'}`
  );
});

test('🔴 없는 카테고리 키는 그것만 버리고 warn 한다 (조용히 버리지 않는다)', () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (line) => { warned.push(String(line)); };
  let keys;
  try {
    keys = regime.scenarioCategories(
      { id: 'typo_shape', categories: ['tech_broad', 'tech_borad', 'gold'] },
      catalog
    );
  } finally { console.warn = orig; }
  assert.deepEqual(keys, ['tech_broad', 'gold'], '오타 키만 버리고 나머지는 살아야 한다');
  assert.ok(
    warned.some((w) => w.includes('regime.playbook_unknown_category') && w.includes('tech_borad')),
    `오타가 조용히 버려졌다. 받은 로그: ${warned.join(' | ') || '(없음)'}`
  );
});
