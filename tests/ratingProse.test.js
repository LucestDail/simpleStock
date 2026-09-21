const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shapeProse, RUBRICS, TYPES } = require('../server/stockRating');

/**
 * 평가 서술 — **모양으로 읽는다** (2026-09-21 · 같은 병 **일곱 번째**)
 *
 * ## 왜 있나
 *
 * 서술 보충 호출을 넣었더니 **발동률 100% · 성공률 0%** 였다(pm2 실측 6/6 `got:false`).
 * 모델은 34~37초를 들여 충실히 답하고 있었고, **키가 회차마다 전부 달랐다.**
 *
 * 🔴 **점수는 모양으로 읽게 고쳐 놓고 서술은 다시 키를 열거했다.** 같은 파일 안에서,
 *    한 시간 전에 적은 규칙을 어겼다 — *"규칙을 정하면 그 자리에서 적용 범위를 훑을 것."*
 *
 * ## 설계: **아무것도 버리지 않는다**
 *
 * 분류되면 분류하고, **안 되면 `interpretation` 에 모은다.** 최악이라도 사용자는
 * 분석 글을 한 칸에 모아서 본다 — 빈 화면보다 낫다.
 * ⚠️ 다만 **강점·약점을 지어내지는 않는다**(pm2 지적) — 못 가르면 합쳐 둘 뿐,
 *    아무 문장이나 "강점" 칸에 넣지 않는다.
 */

const NAMES = RUBRICS[TYPES.LARGE];

/** 🔴 라이브 6회 — 전부 실제 `outputPreview` 에서 가져왔다. 하나도 서로 안 겹친다 */
const LIVE = {
  '회차A 점수 재매김': { overall_score: 8.9, score_components: { '강한 기업 선호': 9.5, '구조적 우위': 9.5 } },
  '회차B 한 덩어리': { analysis: 'NVDA를 평가한 결과, 확정된 항목 점수는 강한 기업 선호 9.5/10, 구조적 우위 9/10 으로 최상위권입니다.' },
  '회차C 두 겹 중첩': { extension: { analysis: { score: 8.92, score_comment: '전반적인 점수는 각 항목별 가중 합산에 기반하며 강한 기업 선호가 최고점입니다.' } } },
  '회차D 항목별 서술': { 확정점수_및_서술: { 강한_기업_선호_10: '시가총액 5367.15B, EV 5333.10B로 대형주 중 최상위권이며 순현금 상태입니다.' } },
  '회차E 한국어 키': { '핵심 요약': '명확한 구조적 우위와 성장성이 반영된 대형 성장주입니다. 다만 프리미엄 부담이 있습니다.', '기업 펀더멘털': '매출성장 105.9% 로 압도적입니다.' },
  '회차F 근거 요약': { 종목: 'NVIDIA (NVDA)', 확정_점수_근거_요약: { 강한_기업_선호_10: 'AI 가속기 시장 지배적 위치와 생태계 락인 효과가 점수 근거입니다.' } },
};

/**
 * 면제 — **이유를 적는다.**
 * `회차A` 는 `{overall_score: 8.9, score_components: {…}}` 로 **숫자밖에 없다.**
 * 모델이 서술 대신 점수를 다시 매긴 회차라 건질 산문이 **실제로 없고**,
 * 숫자를 주우면 확정 점수가 흔들린다 ⇒ **빈 것이 정답**이다(아래에서 따로 못박는다).
 */
const NO_PROSE = new Set(['회차A 점수 재매김']);

test('🔴 산문이 있는 라이브 모양에서는 **무언가는 건진다** (하나도 버리지 않는다)', () => {
  let checked = 0;
  for (const [tag, out] of Object.entries(LIVE)) {
    if (NO_PROSE.has(tag)) continue;
    const p = shapeProse(out, NAMES);
    const got = p.oneLiner || p.strengths || p.weaknesses || p.interpretation || p.comments.size;
    assert.ok(got, `🔴 ${tag} 에서 아무것도 못 건졌다 — 모델은 답했는데 또 버린다`);
    checked += 1;
  }
  // 🔴 대상이 0건이면 통과가 아니라 실패다
  assert.equal(checked, Object.keys(LIVE).length - NO_PROSE.size, '지문 개수가 안 맞는다');
  assert.ok(checked >= 5, `검사한 라이브 모양이 ${checked}개뿐이다`);
});

/** 면제가 **장식이 아닌지** 확인한다 — 정말로 산문이 없는가 */
test('🔴 면제 검증: 회차A 는 실제로 산문이 없다 (숫자를 주우면 안 된다)', () => {
  const p = shapeProse(LIVE['회차A 점수 재매김'], NAMES);
  assert.equal(p.oneLiner + p.strengths + p.weaknesses + p.interpretation, '',
    '🔴 숫자만 있는 응답에서 서술을 만들어냈다');
  // ⇒ 이 회차는 보충이 **정말로 실패한 것**이라 `rating.prose_empty` 가 떠야 한다
});

test('🔴 항목별 서술은 **그 항목 코멘트**로 붙는다 (회차D·F)', () => {
  for (const tag of ['회차D 항목별 서술', '회차F 근거 요약']) {
    const p = shapeProse(LIVE[tag], NAMES);
    assert.ok(p.comments.has('강한 기업 선호'), `🔴 ${tag}: 항목 코멘트를 못 붙였다`);
    assert.match(p.comments.get('강한 기업 선호'), /시가총액|AI 가속기/);
  }
});

test('한국어 요약 키를 한 줄 요약으로 읽는다 (회차E)', () => {
  const p = shapeProse(LIVE['회차E 한국어 키'], NAMES);
  assert.match(p.oneLiner, /구조적 우위와 성장성/);
  // 나머지 산문도 버리지 않는다
  assert.match(p.interpretation, /매출성장 105.9%/);
});

test('두 겹 중첩도 판다 (회차C)', () => {
  const p = shapeProse(LIVE['회차C 두 겹 중첩'], NAMES);
  assert.match(p.interpretation + p.oneLiner, /가중 합산/);
});

/**
 * 🔴 **숫자는 절대 줍지 않는다.**
 * 회차A 는 `overall_score: 8.9` 로 **점수를 다시 매겼다.** 그걸 받으면 확정 점수가 흔들려
 * 같은 종목이 회차마다 달라진다.
 */
test('🔴 보충 응답의 숫자는 무시한다 (모델이 점수를 다시 매긴다)', () => {
  const p = shapeProse(LIVE['회차A 점수 재매김'], NAMES);
  const all = JSON.stringify(p);
  assert.ok(!all.includes('8.9'), '🔴 모델이 다시 매긴 총점이 서술로 새어 들어왔다');
  assert.equal(p.comments.size, 0, '🔴 숫자를 항목 코멘트로 주웠다');
});

test('강점·약점 키는 제대로 갈라 담는다', () => {
  const p = shapeProse({
    강점: '데이터센터 매출이 전년 대비 세 자릿수로 늘었습니다.',
    리스크: '고객 집중도가 높아 상위 고객 이탈 시 타격이 큽니다.',
  }, NAMES);
  assert.match(p.strengths, /데이터센터/);
  assert.match(p.weaknesses, /고객 집중도/);
  assert.ok(!p.strengths.includes('고객 집중도'), '🔴 약점을 강점 칸에 넣었다');
});

/** ⚠️ 확신도·미확인 목록은 서술이 아니다 — 따로 다룬다 */
test('확신도·미확인 목록을 서술로 줍지 않는다', () => {
  const p = shapeProse({
    confidence: '중간',
    confidenceWhy: '이 문장은 확신도 근거라 서술 칸에 들어가면 안 됩니다 정말로.',
    unverified: ['가이던스 수치를 확인하지 못했습니다 데이터가 없습니다'],
  }, NAMES);
  assert.equal(p.strengths + p.weaknesses + p.oneLiner + p.interpretation, '', '🔴 확신도·미확인이 서술로 샜다');
});

/** ⚠️ 짧은 라벨·열거값을 서술로 치면 잡음이 섞인다 */
test('짧은 문자열은 서술로 치지 않는다', () => {
  const p = shapeProse({ opinion: '매수', type: '대형주', 종목: 'NVDA' }, NAMES);
  assert.equal(p.oneLiner + p.interpretation + p.strengths, '');
});

/** 🔴 자기검증 — 빈 응답에서 무언가를 만들어내면 이 자는 거짓말이다 */
test('🔴 자기검증: 빈 응답에서는 아무것도 만들지 않는다', () => {
  for (const empty of [{}, null, { a: null }, { b: 3 }, []]) {
    const p = shapeProse(empty, NAMES);
    assert.equal(p.oneLiner + p.strengths + p.weaknesses + p.interpretation + p.description, '',
      `🔴 ${JSON.stringify(empty)} 에서 서술을 지어냈다`);
    assert.equal(p.comments.size, 0);
  }
});

/**
 * 🔴 **경로에 따라 서술을 받을지 가른다** (2026-09-21 — pm2 비용 실측)
 *
 * 보충은 호출당 **34~37초**라 평가가 7초 → 45초가 된다. 리포트는 보유 종목마다 평가를
 * 부르고 **화면 진입 시 자동 분석**이 도니, 2종목이면 페이지를 열 때마다 **+84초**다.
 * pm2 는 *"끄자"* 고 했는데, 끄면 사양의 절반이 영영 안 나온다 ⇒ **가른다**:
 *   리포트 내부 호출 = 점수만 · 사용자가 상세를 열면 = 서술까지
 * ⚠️ 그리고 `RATING_PROSE=off` 로 **전면 차단 손잡이**도 남긴다(느려지면 즉시 되돌린다).
 */
function freshRate(replies, env = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/stockRating|aiService|yahooStats/.test(k)) delete require.cache[k];
  }
  const before = process.env.RATING_PROSE;
  if ('RATING_PROSE' in env) process.env.RATING_PROSE = env.RATING_PROSE;
  else delete process.env.RATING_PROSE;
  const calls = [];
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: { generateStructuredOutput: async (o) => { calls.push(o.logLabel); return replies.shift() ?? {}; }, getAiSettings: () => ({}) },
  };
  const yPath = require.resolve('../server/yahooStats');
  const realY = require(yPath);
  require.cache[yPath] = {
    id: yPath, filename: yPath, loaded: true,
    exports: { ...realY, getStats: async () => ({ symbol: 'NVDA', name: 'NVIDIA Corporation', quoteType: 'EQUITY', marketCap: 5.36e12, price: 180, currency: 'USD', quality: {}, links: {}, missing: [], at: 'now' }) },
  };
  return { rating: require('../server/stockRating'), calls, restore: () => { if (before === undefined) delete process.env.RATING_PROSE; else process.env.RATING_PROSE = before; } };
}
const FLAT = Object.fromEntries(NAMES.map((n, i) => [n, i < 4 ? 10 : 9]));

test('🔴 리포트 경로(`withProse:false`)는 보충을 **안 부른다** (종목당 35초를 안 쓴다)', async () => {
  const { rating, calls, restore } = freshRate([FLAT]);
  const r = await rating.rate('NVDA', { withProse: false });
  restore();
  assert.deepEqual(calls, ['stock_rating'], '🔴 리포트 경로에서 보충을 불렀다 — 자동 분석이 느려진다');
  assert.equal(r.total, 94, '점수는 그대로 나와야 한다');
  // 🔴 "비었다" 와 "안 물어봤다" 를 구분해 남긴다
  assert.match(r.proseSkipped || '', /빠른 평가/, '🔴 왜 서술이 없는지 화면이 알 수 없다');
});

test('상세 경로(기본값)는 보충을 부르고 **모양으로** 읽는다', async () => {
  const { rating, calls, restore } = freshRate([FLAT, LIVE['회차E 한국어 키']]);
  const r = await rating.rate('NVDA');
  restore();
  assert.deepEqual(calls, ['stock_rating', 'stock_rating_prose']);
  assert.match(r.oneLiner, /구조적 우위와 성장성/, '🔴 라이브 모양을 또 못 읽었다');
  assert.equal(r.proseSkipped, null, '서술을 받았는데 "건너뛰었다" 로 적혔다');
});

test('🔴 보충이 항목 코멘트를 채우되 **점수는 안 건드린다**', async () => {
  const { rating, restore } = freshRate([FLAT, LIVE['회차D 항목별 서술']]);
  const r = await rating.rate('NVDA');
  restore();
  const it = r.items.find((x) => x.name === '강한 기업 선호');
  assert.match(it.comment, /시가총액/, '코멘트를 못 채웠다');
  assert.equal(it.score, 10, '🔴 보충이 점수를 덮었다 — 같은 종목이 회차마다 달라진다');
  assert.equal(r.total, 94);
});

test('`RATING_PROSE=off` 면 상세 경로에서도 안 부른다 (되돌릴 손잡이)', async () => {
  const { rating, calls, restore } = freshRate([FLAT], { RATING_PROSE: 'off' });
  await rating.rate('NVDA');
  restore();
  assert.deepEqual(calls, ['stock_rating']);
});

/**
 * 🔴 **빈 값을 먼저 버린다** (2026-09-21 pm2 라이브 실측)
 * `{ "분석": "", "서술": "…" }` 처럼 빈 키와 내용 있는 키가 섞여 온다.
 * 빈 것을 먼저 채택하면 **내용을 잃는다.**
 */
test('🔴 빈 키와 내용 있는 키가 섞여도 내용을 잃지 않는다 (라이브 실측)', () => {
  const p = shapeProse({ 분석: '', 서술: 'NVIDIA의 확정 점수는 기업의 질, 성장, 안정성, 밸류에 기반합니다.' }, NAMES);
  assert.match(p.interpretation + p.oneLiner, /기업의 질, 성장/);
});

test('🔴 빈 값이 강점·약점 칸을 차지하지 않는다', () => {
  const p = shapeProse({ 강점: '   ', 장점: '데이터센터 매출이 세 자릿수로 늘었습니다 실제로요.' }, NAMES);
  assert.match(p.strengths, /데이터센터/);
});

/**
 * 🔴 **모델이 되뇐 총점·투자의견은 버린다** (라이브: `"종합 9.2 / 10 · '강한 매수' 성격"`)
 *
 * 사양: *"점수와 투자의견 구간이 **절대 어긋나면 안 된다**."*
 * 코드가 낸 `92점 · 적극 매수` 옆에 모델이 제멋대로 쓴 등급이 같이 보이면 어느 쪽이 맞는지 모른다.
 * ⚠️ 문단 전체가 아니라 **그 줄만** 버린다 — 나머지 분석은 값이 있다.
 */
test('🔴 되뇐 등급 줄만 버리고 나머지 서술은 지킨다 (라이브 실측)', () => {
  const live = { analysis: "종합 9.2 / 10 · '강한 매수' 성격\n점수는 이미 확정되었습니다.\nNVDA는 시가총액 5,367B USD 입니다." };
  const p = shapeProse(live, NAMES);
  const all = p.interpretation + p.oneLiner + p.strengths;
  assert.ok(!/강한\s*매수/.test(all), '🔴 모델이 되뇐 등급이 남았다 — 코드가 낸 의견과 충돌한다');
  assert.match(all, /시가총액 5,367B/, '🔴 되뇐 줄을 지우면서 멀쩡한 서술까지 날렸다');
});

/** 🔴 오탐 검사 — 정상 서술에 숫자가 많다. 넓게 잡으면 분석을 통째로 지운다 */
test('🔴 오탐 검사: 숫자 많은 정상 서술을 지우지 않는다', () => {
  for (const t of [
    '매출성장 105.9%·이익성장 127.8%로 10점 영업마진 66.24% 입니다.',
    'ROE 117.21%·부채비율 16.97 이며 Trailing P/E 28.10 입니다.',
    '숫자로 검증된 성장: 매출성장 105.9%는 10/10점의 타당한 근거입니다.',
  ]) {
    const p = shapeProse({ analysis: t }, NAMES);
    assert.ok((p.interpretation + p.oneLiner).length > 0, `🔴 정상 서술을 지웠다: ${t}`);
  }
});
