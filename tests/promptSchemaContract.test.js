const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **프롬프트가 예시로 주는 stance 는 스키마 enum 안이어야 한다** (2026-09-29, prompt-audit F1).
 *
 * 있었던 것: `BRIEF_JOB.mid` 가 `같으면 "유지" 라고 분명히 말하라` 였다. 스키마는
 * `stance: {enum:['BUY','SELL','HOLD']}` 이고 `STANCES` 로 검증하므로, 모델이 그 예시를 따르면
 * `asPosition` 이 **항목을 버린다**(= `positions 0`, 사용자에겐 "보유 판단이 없다" 로 보인다).
 *
 * ⚠️ **인과 단정은 하지 않는다** — 09-28 12:17 `positions 0` 의 원인이라 말할 수 없다.
 *   09-29 08:04 `positions_short` 는 `"유지"` 가 **없는** preopen 회차에서 났다. 고칠 이유는
 *   **계약 불일치 하나로 충분**하다.
 *
 * ★ **관대한 파서(`asPosition` 이 한국어를 인정하게 하기)는 일부러 기각했다** (pm2 교정).
 *   처음엔 *"정본이 둘이 된다"* 를 근거로 댔는데 그건 **영속 상태가 각자 갱신되며 갈라지는**
 *   경우의 규칙이라 여기 안 맞는다. 진짜 근거는 이것이다:
 *   **흡수하면 계약 위반이 관측 불가가 된다** — 이탈이 조용히 성공으로 처리되면
 *   *"프롬프트가 계약을 어겼다"* 는 신호가 영영 안 뜬다(`checkerAbsorbed` 와 같은 가족).
 *
 * ★ **판정 방향**(pm2 교정): 금지 낱말 열거가 아니라 **허용목록**이다.
 *   `"…" 라고 말하라` 같은 **인용+지시** 패턴을 앵커로 잡고, 인용된 토큰이 **enum 안인지** 본다.
 *   금지목록이면 `유지·관망·중립…` 을 **전부 열거**해야 하고 다음 사람은 **빠뜨린 하나만**
 *   쓰면 된다(셸 가드 18/18 의 비대칭). 앵커+허용목록은 그 부담이 없다.
 */

const SRC = path.join(__dirname, '..', 'server', 'analystService.js');

/**
 * 🔴 주석을 먼저 지운다 — 안 그러면 **이 규칙을 설명하는 주석이 이 자를 깨뜨린다.**
 * 바로 위 주석과 `BRIEF_JOB` 위 주석에 종전 문구(`"유지" 라고 …`)가 **그대로** 들어 있다.
 * (자기 참조 오탐 — 규칙을 적은 문장이 규칙 위반으로 읽히는 자리)
 * ⚠️ 줄 전체가 주석인 것만 지운다. 코드 뒤 `//` 까지 지우면 문자열 안의 `//` 를 깨뜨린다.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/** enum 정본은 **소스에서 읽는다** — 복제하면 진짜 값이 바뀌어도 자가 "정상" 이라 거짓말한다. */
function readStances(src) {
  const m = src.match(/const STANCES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'STANCES 정의를 소스에서 못 찾았다 — 자가 옛 위치를 보고 있다');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** 이 저장소의 프롬프트 표기 = 작은따옴표 리터럴. */
function promptLiterals(src) {
  return (src.match(/'(?:[^'\\]|\\.)*'/g) || []).map((s) => s.slice(1, -1));
}

/**
 * 앵커: **인용 + 지시**(`"X" 라고 말하라/답하라/적어라/써라`).
 * 서술 속 인용(`"## 시장 국면" 절의 판정을 …`)이나 **부정 예시**
 * (`"관망 필요", "시장 상황에 따라" 같은 말은 답이 아닙니다`)는 지시형이 아니라 걸리지 않는다.
 */
const QUOTED_DIRECTIVE = /"([^"]{1,12})"\s*(?:라고|로)\s*(?:분명히\s*)?(?:말|답|적|쓰|기재)/g;

function violations(src, stances) {
  const allowed = new Set(stances.map((s) => s.toUpperCase()));
  const out = [];
  for (const lit of promptLiterals(stripComments(src))) {
    for (const m of lit.matchAll(QUOTED_DIRECTIVE)) {
      const token = m[1].trim();
      if (!allowed.has(token.toUpperCase())) out.push({ token, lit: lit.slice(0, 120) });
    }
  }
  return out;
}

// ── ⓐ 발동 축 ──────────────────────────────────────────────────────────
/**
 * ⚠️ **2026-10-14 — 지킬 계약이 바뀌었다.**
 *
 * 종전에는 *"프롬프트 예시가 `stance` enum 안인가"* 를 쟀다. 그 enum 이 **스키마에서
 * 사라졌으므로**(보고서 제품으로 재정의) 그 자는 잴 대상이 없다.
 *
 * 🔴 **그런데 같은 가족의 위험은 더 커졌다**: 프롬프트가 *"BUY 라고 분명히 말하라"* 처럼
 *    **행동 어휘를 예시로 주면**, 모델이 그대로 답하고 `asPosition` 이 **그 항목을 버린다**
 *    (= `positions 0`, 사용자에겐 "판단이 없다" 로 보인다). 종전과 **증상이 똑같다.**
 * ⇒ 축을 옮긴다: 프롬프트의 인용 지시문이 **행동 어휘를 모범으로 보여주지 않는가**.
 * ★ 2026-10-14 사주 파이프라인에서 *"✓ 예문이 고정돼 모델이 거짓을 베꼈다"* 와 같은 가족 —
 *   **프롬프트에 사실을 넣는 것과 모범으로 보여주는 것은 힘이 다르다.**
 */
const ACTION_WORDS = ['BUY', 'SELL', 'HOLD', '매수', '매도', '보유', '관망', '유지', '청산', '익절', '손절'];

test('🔴 프롬프트가 행동 어휘를 예시로 주지 않는다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const bad = [];
  for (const lit of promptLiterals(stripComments(src))) {
    for (const m of lit.matchAll(QUOTED_DIRECTIVE)) {
      const token = m[1].trim();
      if (ACTION_WORDS.some((w) => token.toUpperCase() === w.toUpperCase())) {
        bad.push({ token, lit: lit.slice(0, 90) });
      }
    }
  }
  assert.deepEqual(bad, [], `🔴 프롬프트가 행동을 모범으로 보여준다: ${JSON.stringify(bad)}`);
});

test('🔴 자기검증: 행동 어휘 예시를 심으면 이 자가 잡는다', () => {
  const fake = `const X = ['같으면 "HOLD" 라고 분명히 말하라'];`;
  const found = [];
  for (const lit of promptLiterals(fake)) {
    for (const m of lit.matchAll(QUOTED_DIRECTIVE)) {
      if (ACTION_WORDS.some((w) => m[1].trim().toUpperCase() === w.toUpperCase())) found.push(m[1]);
    }
  }
  assert.equal(found.length, 1, '🔴 심은 위반을 못 잡는다 — 이 자는 아무것도 안 보고 있다');
});

test('⚠️ 오탐 없음: 관측 어휘를 인용하는 것은 위반이 아니다', () => {
  const ok = `const X = ['변화가 없으면 "그대로다" 라고 적으세요'];`;
  const found = [];
  for (const lit of promptLiterals(ok)) {
    for (const m of lit.matchAll(QUOTED_DIRECTIVE)) {
      if (ACTION_WORDS.some((w) => m[1].trim().toUpperCase() === w.toUpperCase())) found.push(m[1]);
    }
  }
  assert.deepEqual(found, [], '🔴 멀쩡한 관측 지시문을 위반으로 찍는다 — 오탐하면 다음 사람이 자를 끈다');
});

test('🔴 스키마에 행동 칸이 되살아나지 않는다', () => {
  const a = require('../server/analystService');
  const it = a._REPORT_SCHEMA.properties.positions.items;
  for (const k of ['stance', 'entry', 'stop', 'target', 'scenarioUp', 'scenarioDown']) {
    assert.ok(!(k in it.properties), `🔴 \`${k}\` 칸이 되살아났다 — 칸이 있으면 모델은 채운다`);
  }
  // ★ 판별력 — 관측 칸은 **있어야** 한다(둘 다 없으면 이 테스트는 공허하다)
  for (const k of ['trend', 'rationale', 'evidence', 'risk']) {
    assert.ok(k in it.properties, `🔴 관측 칸 \`${k}\` 이 사라졌다`);
  }
});

// ── ⓑ 2026-10-14 신설: 프롬프트가 **없는 칸**을 쓰라고 가르치지 않는다 ─────────────
/**
 * 🔴 **ⓐ 축은 이것을 원리상 못 본다.** ⓐ 의 앵커는 `"X" 라고 말하라`(따옴표+지시)인데,
 *    실제로 살아남은 위반은 **백틱 필드명 인용**이었다:
 *      · `분할이면 \`entry\` 에 **1차 진입가**를 쓰고`      ← `entry` 는 스키마에서 사라졌다
 *      · `\`BUY\` 를 내려면 아래를 **함께** 보고`            ← enum 자체가 없다
 *      · `근거를 못 대면 \`HOLD\` 로 두세요`                 ← 〃
 *    ⓐ 를 통과하면서 **3건이 살아 있었다**(2026-10-14 오전 배포 후 실측).
 *
 * ★ 이것이 나쁜 이유는 "쓸모없다" 가 아니라 **거짓을 가르친다**는 것이다. 모델은 지시받은
 *   칸을 채우려 하고, 스키마가 거부하면 **그 내용이 서술 문장으로 샌다** — 사용자가 본
 *   *"매수매도 판단이 나왔습니다"* 가 정확히 이 경로다.
 *   2026-10-13 채팅 프롬프트(*"제안으로 등록됩니다"* 라고 가르쳐 놓고 가드가 적발)와 같은 가족:
 *   **가드가 틀린 게 아니라 우리가 거짓을 가르쳤다.**
 *
 * ⚠️ **허용목록은 스키마에서 읽는다**(복제하면 칸이 바뀌어도 자가 "정상" 이라 거짓말한다).
 * ⚠️ 면제는 **이유를 적는다** — 이유 없는 면제는 곧 구멍(이 저장소가 반복해 밟은 자리).
 */
const BACKTICK_TOKEN = /`([A-Za-z_][A-Za-z0-9_.]{1,24})`/g;

/**
 * 면제 — **스키마 칸이 아닌데 프롬프트가 정당하게 인용하는 것**.
 * 각 항목에 이유가 있고, 없으면 여기 넣지 않는다.
 */
/**
 * 🔴 **면제는 0건이다 — 그리고 그것이 옳다.**
 *
 * 첫 판에 7개를 넣었다가 **전부 지웠다.** `when`·`freshness`·`time_range`·`investor`·`true`·
 * `false` 는 이 파일에 **한 번도 안 나오고**(검색 파라미터는 my-computer 쪽이다), `null` 은
 * 6곳에 있지만 **전부 주석**이라 프롬프트 리터럴에는 0건이다.
 * ⇒ **추측으로 넣은 면제가 곧 장식 면제**였고, 아래 ⓓ 테스트가 그것을 잡아냈다.
 * ★ 가드를 만들면서 그 가드가 금지한 바로 그 실수를 했다 — 면제는 **실물로 세고 나서** 넣는다.
 * ⚠️ 비어 있으므로 **지금은 구멍이 0** 이다. 나중에 넣을 일이 생기면 실측 건수를 이유에 적는다.
 */
const NOT_A_FIELD = new Map([]);

/**
 * 🔴 **`_REPORT_SCHEMA` 하나만 보면 오탐한다** — `holdings` 는 **조건부 칸**이라(보유 종목이
 *    있을 때만 붙는다) 기본형에 없고, 그걸 정당하게 인용하는 프롬프트가 위반으로 찍혔다.
 * ⇒ **라이브가 만들 수 있는 최대 집합**을 쓴다. ⚠️ `trades:true`(백테스트)는 **일부러 뺀다** —
 *    넣으면 `proposals` 가 허용돼 라이브 프롬프트의 그 인용을 자가 놓친다.
 */
function schemaFieldNames() {
  const a = require('../server/analystService');
  const collect = (s, into) => {
    for (const k of Object.keys(s?.properties || {})) into.add(k);
    for (const k of Object.keys(s?.properties?.positions?.items?.properties || {})) into.add(k);
    for (const k of Object.keys(s?.properties?.holdings?.items?.properties || {})) into.add(k);
    return into;
  };
  const names = collect(a._REPORT_SCHEMA, new Set());
  const f = a._reportSchemaFor || a.reportSchemaFor;
  if (f) collect(f(['QLD', 'O'], { budget: true }), names);
  return names;
}

/** 프롬프트 리터럴이 백틱으로 인용한 식별자 → 스키마에 없으면 위반. */
function citedUnknownFields(src, allowed) {
  const out = [];
  for (const lit of promptLiterals(stripComments(src))) {
    for (const m of lit.matchAll(BACKTICK_TOKEN)) {
      const tok = m[1];
      const head = tok.split('.')[0];
      if (allowed.has(tok) || allowed.has(head)) continue;
      if (NOT_A_FIELD.has(tok) || NOT_A_FIELD.has(head)) continue;
      out.push({ token: tok, lit: lit.slice(0, 110) });
    }
  }
  return out;
}

test('🔴 프롬프트가 스키마에 없는 칸을 쓰라고 가르치지 않는다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const allowed = schemaFieldNames();
  // ★ 판별력 먼저 — 허용목록이 비면 이 자는 **모든 것을 위반으로** 찍거나 아무것도 안 본다
  assert.ok(allowed.size >= 8, `🔴 스키마 칸을 ${allowed.size}개만 읽었다 — 자가 엉뚱한 곳을 본다`);
  assert.ok(allowed.has('trend') && allowed.has('positions'), '🔴 허용목록이 실제 칸을 못 담았다');

  const bad = citedUnknownFields(src, allowed);
  assert.deepEqual(bad, [], `🔴 없는 칸을 요구한다(모델은 지시받은 칸을 채우려 하고, 거부되면 서술로 샌다): ${JSON.stringify(bad, null, 1)}`);
});

test('🔴 자기검증: 없는 칸을 심으면 이 자가 잡는다', () => {
  const fake = "const X = ['분할이면 `entry` 에 1차 진입가를 쓰고'];";
  const bad = citedUnknownFields(fake, schemaFieldNames());
  assert.equal(bad.length, 1, '🔴 심은 위반을 못 잡는다');
  assert.equal(bad[0].token, 'entry');
});

test('⚠️ 오탐 없음: 실재하는 칸을 인용하는 것은 위반이 아니다', () => {
  const ok = "const X = ['`rationale` 에 한 문장으로 적고 `trend` 는 배열로 쓰세요'];";
  assert.deepEqual(citedUnknownFields(ok, schemaFieldNames()), [],
    '🔴 멀쩡한 인용을 위반으로 찍는다 — 오탐하면 다음 사람이 자를 끈다');
});

test('⚠️ 면제 목록이 장식이 아니다 — 면제 없이 보면 실제로 걸린다', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const allowed = schemaFieldNames();
  const useless = [];
  for (const [tok, why] of NOT_A_FIELD) {
    assert.ok(why && why.length > 10, `🔴 면제 \`${tok}\` 에 이유가 없다 — 이유 없는 면제는 곧 구멍`);
    const hit = promptLiterals(stripComments(src))
      .some((l) => [...l.matchAll(BACKTICK_TOKEN)].some((m) => m[1] === tok || m[1].split('.')[0] === tok));
    if (!hit && !allowed.has(tok)) useless.push(tok);
  }
  /**
   * ⚠️ 전부가 장식이면 이 목록은 **아무것도 지탱하지 않는다**(한 항목 고정이 아니라 목록 불변식).
   * ⚠️ **빈 목록은 통과시킨다** — 면제가 없으면 장식도 없다. `0 < 0` 으로 쓰면 *"면제를 전부
   *    지운 깨끗한 상태"* 가 영구 실패가 되고, 그러면 다음 사람이 **쓸모없는 면제를 되살린다.**
   */
  assert.ok(NOT_A_FIELD.size === 0 || useless.length < NOT_A_FIELD.size,
    `🔴 면제 목록이 통째로 장식이다: ${JSON.stringify(useless)} — 지우거나 이유를 다시 보라`);
});

// ── ⓒ 2026-10-14 신설: 프롬프트가 **행동을 명령하지 않는다** ────────────────────
/**
 * 🔴 **ⓑ(칸 실재)로도 못 잡는 것이 있었다.** 가장 직접적인 명령은 칸 이름을 안 썼다:
 *      `당신이 낼 것은 **지금 사고팔 것인가**다.`        ← 매매 판단을 명령한다
 *      `점수가 높아도 **매수 제안을 내지 마라.**`
 *      `부족한 버킷은 … **분할로** 채우는 것이 맞다고 판단하라.`
 *    2026-10-14 오전에 스키마·시스템 프롬프트를 보고서로 바꾸고도 `analyze()` 가 조립하는
 *    **사용자 프롬프트에 31줄**이 살아 있었다(실측). 사용자가 폰에서 본
 *    *"매수매도 판단이 나왔습니다"* 의 경로가 이것이다.
 *
 * ★ **판정 축 = 행동 어휘 + 지시형 어미.** 어휘 열거만으로는 진다 —
 *   *"외국인 **순매수** +1,200억"* 은 **수급 데이터**이고 *"**매수** 제안을 내지 마라"* 는 지시다.
 *   둘을 가르는 것은 낱말이 아니라 **문장이 명령인가**이다.
 * ⚠️ 그래도 완전하지 않다(어휘는 유한 목록이다) — 그래서 **ⓑ 와 함께** 쓴다.
 *   ⓑ 는 구조(칸 실재), ⓒ 는 어법. 한쪽만으로는 2026-10-14 의 3건·1건이 각각 샜다.
 * 🔴 **겹겹이라 서로를 가린다** — 그래서 각 축은 **자기 변이로 따로** 검증한다.
 */
const ACTION_NOUN = '(?:사고팔|사거나|매수|매도|진입|청산|익절|손절|분할|축소|증액|담|팔)';
const IMPERATIVE = '(?:세요|하라|해라|하지\\s*마|말라|내라|내지\\s*마|두라|두세요|잡으세요|채우)';
const ACTION_ORDER = new RegExp(`${ACTION_NOUN}[^.。]{0,18}${IMPERATIVE}`, 'g');

/**
 * 🔴 **어미 앵커만으로는 가장 중요한 한 줄을 놓쳤다** — 실측으로 확인했다.
 *    `당신이 낼 것은 지금 **사고팔 것인가**다.` 는 **명령형 어미가 없다**(단정형 "~다").
 *    그런데 실질은 *"네가 낼 산출물은 매매 판단이다"* 라는 **역할 규정**이라 가장 강하게 작동한다.
 * ⇒ 둘째 앵커: 행동 어휘가 **`것인가`(산출물 규정)** 와 함께 오는가.
 *    ⚠️ *"지금 어떤 상태인가"* 는 행동 어휘가 없어 걸리지 않는다(오탐 축에서 확인).
 */
const ROLE_AS_ACTION = new RegExp(`${ACTION_NOUN}[^.。]{0,8}것인가`, 'g');

function actionOrders(src) {
  const out = [];
  for (const lit of promptLiterals(stripComments(src))) {
    for (const re of [ACTION_ORDER, ROLE_AS_ACTION]) {
      for (const m of lit.matchAll(re)) out.push({ hit: m[0], lit: lit.slice(0, 110) });
    }
  }
  return out;
}

test('🔴 프롬프트가 행동을 명령하지 않는다', () => {
  const bad = actionOrders(fs.readFileSync(SRC, 'utf8'));
  assert.deepEqual(bad, [], `🔴 프롬프트가 매매 행동을 지시한다(이 제품은 보고서만 쓴다): ${JSON.stringify(bad, null, 1)}`);
});

test('🔴 자기검증: 실제로 들어냈던 네 문장을 되살리면 전부 잡는다', () => {
  // ⚠️ 지어낸 예시가 아니라 **2026-10-14 에 이 파일에서 실제로 지운 문장들**이다
  const removed = [
    "const a = ['🔴 위 투자의견은 기업의 질이고, 당신이 낼 것은 지금 사고팔 것인가다.'];",
    "const b = ['점수가 높아도 **매수 제안을 내지 마라.** 보유 중이면 위험을 적어라.'];",
    "const c = ['목표 배분에서 부족한 버킷은 이 금액 안에서 **분할로** 채우는 것이 맞다고 판단하라.'];",
    "const d = ['보유 기간과 손절선을 그 전제로 잡으세요. 기업 점수와 같은 잣대로 비교하지 마세요.'];",
  ];
  const missed = removed.filter((r) => actionOrders(r).length === 0);
  assert.deepEqual(missed, [], `🔴 되살린 문장을 못 잡는다 — 이 자는 그 회귀를 막지 못한다`);
});

test('⚠️ 오탐 없음: 수급 데이터와 서술 지시는 위반이 아니다', () => {
  const ok = [
    "const a = ['⚠️ **순매수(매수−매도) 금액**이다. 지수 등락과 **누가 샀는지**를 붙여서 설명하라 — '];",
    "const b = ['공매도·대차잔고 상승 = 하방 압력 축적 · 신용융자 상승 = 개인 레버리지 매수(과열 신호)'];",
    "const c = ['- QLD 수량 90 · 평단 101.3 · 현재 97.1'];",
    "const d = ['`rationale` 에 지금 어떤 상태인지 한 문장으로 적으세요'];",
  ];
  const bad = ok.flatMap((o) => actionOrders(o));
  assert.deepEqual(bad, [], `🔴 사실 서술을 지시로 찍는다 — 오탐하면 다음 사람이 자를 끈다: ${JSON.stringify(bad)}`);
});
