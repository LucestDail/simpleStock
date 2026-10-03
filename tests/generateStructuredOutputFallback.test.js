const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 `generateStructuredOutput(options, fallback, extraOptions={})` 는 `fallback` 이
 * **2번째 위치 인자**다(`server/aiService.js:1112`). 그런데 호출부 7곳이 `fallback` 을
 * 1번째 인자(`options`) 안의 **속성**으로 주고 있었다 — 그 값은 함수가 받는 `fallback` 과
 * 무관하고, 실제로 받는 `fallback` 은 `undefined` 다. JSON 파싱이 실패하면(`safeParseJson`)
 * 이 `undefined` 가 조용히 반환된다 — 예외는 없다(2026-09-28 pm1 위임, worker2 조사).
 *
 * ⚠️ 이건 "12:17 positions:0" 미스터리와 **다른 결함**이다 — 그 회차는 파싱 자체가
 * 성공했다. 이건 **파싱이 실패했을 때만** 드러나는 별개의 잠재 결함이다.
 *
 * `safeParseJson` 은 건드리지 않는다 — 파싱 실패 시 `ai.json_parse_fallback` 을 **이미**
 * 조건 없이 로깅한다(어떤 fallback 값이든 무관하게). 그러니 이 파일의 책임은
 * "fallback 이 옳게 전달되는가" 하나뿐이다.
 *
 * "거꾸로 계정" 규율(`tests/analystBriefKinds.test.js` 와 같은 설계):
 * ① 후보(호출부)를 소스에서 전수로 뽑는다(server/ 전체, 하드코딩된 파일 목록이 아니다 —
 *    새 호출부가 생겨도 자동으로 잡히게)
 * ② 각 후보는 [위치 인자로 준다 / 이유 있는 면제] 중 하나여야 한다
 * ③ 어디에도 안 들면(=fallback 이 옵션 객체의 속성으로만 있음) 실패
 * ④ 후보가 0건이면 실패 — 정규식이 깨지거나 함수명이 바뀌면 조용히 통과하면 안 된다
 * ⑤ 면제는 "존재" 가 아니라 "지탱하는가" — 지금은 면제가 없다. 나중에 진짜로 fallback 이
 *    필요 없는 호출부가 생기면 `EXEMPTIONS` 에 **이유와 함께** 추가할 것.
 * ⑥ 변이(자기검증 테스트)로 탐지기 생존을 확인한다.
 */

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');

/** server/ 아래 .js 전부(재귀) — 새 파일·새 호출부가 생겨도 자동으로 스캔 대상에 들어간다 */
function listServerFiles(dir = SERVER_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listServerFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 문자열/주석을 건너뛰며 `openIdx` 의 여는 문자(`(`/`{`/`[`)와 짝이 맞는 닫는 문자의
 * 인덱스를 찾는다. 같은 종류의 문자만 세므로(다른 종류가 안에 섞여도 무관) 인자 목록
 * 전체를 한 번에 못 찾는 문제 없이 "이 호출의 닫는 괄호가 어디인가" 를 정확히 찾는다.
 */
function findMatchingBracket(src, openIdx) {
  const CLOSE_OF = { '(': ')', '{': '}', '[': ']' };
  const open = src[openIdx];
  const close = CLOSE_OF[open];
  if (!close) throw new Error(`괄호 문자가 아니다: ${JSON.stringify(open)}`);
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error('괄호 짝을 못 찾았다 — 소스가 균형이 깨졌거나 스캐너가 낡았다');
}

/** `openIdx`(여는 문자)~`closeIdx`(닫는 문자) 안을, 중첩을 감안해 최상위 콤마로 가른다 */
function splitTopLevelArgs(src, openIdx, closeIdx) {
  const args = [];
  let depth = 0;
  let start = openIdx + 1;
  let i = openIdx + 1;
  while (i < closeIdx) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < closeIdx && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < closeIdx && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < closeIdx && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  const last = src.slice(start, closeIdx).trim();
  if (last) args.push(last);
  return args.map((a) => a.trim());
}

/** 객체 리터럴 소스(`argSrc`, `{`로 시작)의 **최상위**(중첩 아닌) 자리에 `key:` 가 있는지 */
function objectHasTopLevelKey(argSrc, key) {
  if (!argSrc.startsWith('{')) return false;
  const closeIdx = findMatchingBracket(argSrc, 0);
  const re = new RegExp(`^\\s*${key}\\s*:`);
  let depth = 1; // index 0 의 '{' 를 이미 연 상태
  let i = 1;
  while (i < closeIdx) {
    const c = argSrc[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < closeIdx && argSrc[i] !== quote) {
        if (argSrc[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '/' && argSrc[i + 1] === '/') {
      while (i < closeIdx && argSrc[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && argSrc[i + 1] === '*') {
      i += 2;
      while (i < closeIdx && !(argSrc[i] === '*' && argSrc[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if ('([{'.includes(c)) { depth += 1; i += 1; continue; }
    if (')]}'.includes(c)) { depth -= 1; i += 1; continue; }
    if (depth === 1 && re.test(argSrc.slice(i))) return true;
    i += 1;
  }
  return false;
}

/**
 * 소스 텍스트에서 `generateStructuredOutput(` 호출부를 전수로 찾는다.
 * 함수 **정의부**(`function generateStructuredOutput(`)는 호출이 아니므로 제외한다.
 */
function findCallSites(src) {
  const sites = [];
  const callRe = /generateStructuredOutput\s*\(/g;
  let m;
  while ((m = callRe.exec(src))) {
    const nameStart = m.index;
    const before = src.slice(Math.max(0, nameStart - 12), nameStart);
    if (/function\s+$/.test(before)) continue; // 정의부는 건너뛴다
    // ai.generateStructuredOutput( 처럼 앞에 점(.)이 붙는 형태도 이 정규식이 그대로 잡는다
    // (m.index 는 'generateStructuredOutput' 시작이라 점은 포함 안 됨 — 문제 없음)
    const openParenIdx = m.index + m[0].length - 1; // '(' 의 인덱스
    const closeParenIdx = findMatchingBracket(src, openParenIdx);
    const args = splitTopLevelArgs(src, openParenIdx, closeParenIdx);
    const line = src.slice(0, nameStart).split('\n').length;
    sites.push({ line, args, nameStart, closeParenIdx });
  }
  return sites;
}

function classifySite(site) {
  const { args } = site;
  if (args.length >= 2) return { kind: 'positional', detail: `위치 인자 ${args.length}개(정상)` };
  if (args.length === 1) {
    const first = args[0];
    if (objectHasTopLevelKey(first, 'fallback')) {
      return {
        kind: 'property-bug',
        detail: 'fallback 이 1번째 인자(options) 안의 속성으로 들어 있다 — 함수는 2번째 위치 인자로 받는다. 실제로 받는 fallback 은 undefined 다',
      };
    }
    return { kind: 'single-no-fallback', detail: '인자가 1개인데 fallback 이 위치·속성 어디에도 없다' };
  }
  return { kind: 'no-args', detail: '인자가 없다 — 호출 형태 자체가 이상하다' };
}

/** 주어진 소스 텍스트 하나를 스캔해 분류 결과를 낸다(파일 라벨은 보고용) */
function scanSource(fileLabel, src) {
  return findCallSites(src).map((site) => ({ file: fileLabel, line: site.line, ...classifySite(site) }));
}

function scanAllServerFiles() {
  const results = [];
  for (const file of listServerFiles()) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    results.push(...scanSource(rel, src));
  }
  return results;
}

/**
 * 의도적으로 fallback 이 필요 없는 호출부가 생기면 `"file:line": "이유"` 로 추가한다.
 * 지금은 비어 있어야 정상 — 현재 저장소의 모든 실제 호출부는 위치 인자로 fallback 을 준다
 * (`tickerLookupService.js:190` 도 `null` 을 **2번째 위치 인자**로 명시적으로 준다 — 면제가
 * 아니라 이미 준수하는 사례다).
 */
const EXEMPTIONS = {};

function checkCompliance(results) {
  // 🔴 ④ 검사 대상이 0건이면 "깨끗하다" 가 아니라 자를 의심한다(함수명이 바뀌었거나
  //    정규식이 깨졌을 때 조용히 통과하는 것을 막는다)
  assert.ok(results.length > 0, '검사 대상 0건 — generateStructuredOutput 호출부를 하나도 못 찾았다(추출기가 깨졌다)');
  const problems = [];
  for (const r of results) {
    if (r.kind === 'positional') continue;
    const key = `${r.file}:${r.line}`;
    if (EXEMPTIONS[key]) continue; // 이유가 적힌 면제만 건너뛴다
    problems.push(`${key} — ${r.detail} [${r.kind}]`);
  }
  return problems;
}

// ── ① 메인 검사 ──────────────────────────────────────────────

test('🔴 generateStructuredOutput 호출부 전수 — fallback 은 반드시 위치 인자로 준다', () => {
  const results = scanAllServerFiles();
  // 2026-09-28 시점 실측 15곳(정의부 제외). 새 호출부가 생기면 늘어날 수 있으니 하한만 건다 —
  // 줄어들면(=호출부가 사라지면) 추출기가 뭔가를 놓쳤다는 뜻이라 그대로 잡힌다(④ 와 별개 축).
  /**
   * ⚠️ 하한 15 → 10 (2026-10-03). v2(매니저 보고·대화 그래프·예약 분석) 제거로 호출부
   *    5곳이 **정당하게** 사라졌다 — 숫자가 줄어든 것은 추출기 결함이 아니라 현실이다.
   *    ★ 하한을 갱신할 때는 **왜 줄었는지**를 적는다. 안 적으면 다음 사람이
   *      "추출기가 깨졌나" 와 "코드가 줄었나" 를 못 가른다.
   */
  assert.ok(results.length >= 10, `호출부가 10곳보다 적게 잡혔다(${results.length}) — 추출기가 일부를 놓쳤을 수 있다`);
  const problems = checkCompliance(results);
  assert.equal(problems.length, 0, `fallback 을 속성으로 주는 호출부가 남아 있다:\n${problems.join('\n')}`);
});

// ── ⑥ 자기검증 — 되돌리면 잡히는가 ──────────────────────────────

/**
 * 실제 파일을 건드리지 않고, 읽어들인 소스 텍스트를 **메모리에서** 되돌려(mutate) 검사한다.
 * `analystService.js:1240`(trade_analyst) 호출부를 "고치기 전" 형태(속성 스타일)로 되돌려
 * checkCompliance 가 실제로 잡는지 본다.
 */
function mutateSiteToPropertyStyle(src, targetLine) {
  const site = findCallSites(src).find((s) => s.line === targetLine);
  if (!site) throw new Error(`대상 호출부(${targetLine}행)를 소스에서 못 찾았다 — 이 테스트가 무의미해질 뻔했다`);
  assert.ok(site.args.length >= 2, `대상이 이미 인자 ${site.args.length}개뿐이라 되돌릴 필요가 없다(테스트 전제 붕괴)`);
  const [optsArg, fallbackArg] = site.args;
  assert.ok(optsArg.startsWith('{') && optsArg.endsWith('}'), '1번째 인자가 객체 리터럴이 아니다 — 테스트 전제 붕괴');
  const inner = optsArg.slice(1, -1).replace(/\s*$/, '');
  const mutatedCall = `generateStructuredOutput({${inner},\n    fallback: ${fallbackArg},\n  })`;
  return src.slice(0, site.nameStart) + mutatedCall + src.slice(site.closeParenIdx + 1);
}

test('🔴 자기검증: trade_analyst 호출부(analystService.js) 를 속성 스타일로 되돌리면 이 자가 잡는다', () => {
  const file = path.join(SERVER_DIR, 'analystService.js');
  const src = fs.readFileSync(file, 'utf8');
  /**
   * 🔴 **행 번호로 찾지 않는다** (2026-09-29 수정). 종전에는 `s.line >= 1235 && s.line <= 1250`
   *    이었는데, 같은 파일에 **주석 몇 줄을 더하자 행이 밀려 자가 깨졌다** — 제품은 멀쩡한데
   *    자가 빨간불을 냈다. 바로 아래 stockRating 자기검증은 행 번호를 안 쓰고 있었다
   *    (**형제 중 하나만 취약했던** 전형). 이제 호출부 본문의 `logLabel` 로 찾는다.
   */
  const before = findCallSites(src).find(
    (s) => classifySite(s).kind === 'positional' && src.slice(s.nameStart, s.closeParenIdx).includes('trade_analyst'),
  );
  assert.ok(before, "trade_analyst logLabel 을 가진 위치 인자 호출부를 못 찾았다 — 소스가 바뀌었다");

  const broken = mutateSiteToPropertyStyle(src, before.line);
  const results = scanSource('server/analystService.js', broken);
  const problems = checkCompliance(results);
  assert.ok(
    problems.some((p) => p.startsWith(`server/analystService.js:${before.line}`) && p.includes('property-bug')),
    `자가 못 잡았다(장식이었다): ${JSON.stringify(problems)}`
  );
});

test('🔴 자기검증: stockRating.js 의 세 호출부 중 하나를 되돌려도 잡는다(파일이 달라도 동작 확인)', () => {
  const file = path.join(SERVER_DIR, 'stockRating.js');
  const src = fs.readFileSync(file, 'utf8');
  const sites = findCallSites(src).filter((s) => classifySite(s).kind === 'positional');
  assert.ok(sites.length >= 1, 'stockRating.js 에서 위치 인자 호출부를 하나도 못 찾았다 — 소스가 바뀌었다');
  const target = sites[0];

  const broken = mutateSiteToPropertyStyle(src, target.line);
  const results = scanSource('server/stockRating.js', broken);
  const problems = checkCompliance(results);
  assert.ok(
    problems.some((p) => p.startsWith(`server/stockRating.js:${target.line}`) && p.includes('property-bug')),
    `자가 못 잡았다: ${JSON.stringify(problems)}`
  );
});

// ── ⑥ 자기검증 — 추출기 자체가 깨지면(개명 모사) 조용히 통과하지 않는가 ──────

test('🔴 자기검증: 호출부 이름이 바뀌면(개명 모사) 추출기가 0건으로 조용히 통과하지 않고 실패한다', () => {
  const renamedResults = [];
  for (const file of listServerFiles()) {
    const src = fs.readFileSync(file, 'utf8').replace(/generateStructuredOutput/g, 'generateStructuredOutputRenamed');
    renamedResults.push(...scanSource(path.relative(ROOT, file), src));
  }
  assert.equal(renamedResults.length, 0, '개명 모사인데 후보가 남아 있다 — 추출기가 이름 문자열에 안 물려 있다(테스트 전제 붕괴)');
  assert.throws(
    () => checkCompliance(renamedResults),
    /검사 대상 0건/,
    '후보 0건인데도 조용히 통과했다(장식) — 0건은 통과가 아니라 실패여야 한다'
  );
});

// ── 판별력 — 정상 호출부(tickerLookupService.js 의 명시적 null)를 오탐하지 않는다 ──

test('⚠️ 오탐 없음: tickerLookupService.js 의 명시적 null fallback(+3번째 extraOptions)은 정상으로 본다', () => {
  const file = path.join(SERVER_DIR, 'tickerLookupService.js');
  const src = fs.readFileSync(file, 'utf8');
  const results = scanSource('server/tickerLookupService.js', src);
  assert.ok(results.length >= 1, 'tickerLookupService.js 에서 호출부를 못 찾았다 — 소스가 바뀌었다');
  const problems = checkCompliance(results);
  assert.equal(problems.length, 0, `명시적 null 인데 오탐이 났다: ${problems.join('\n')}`);
});
