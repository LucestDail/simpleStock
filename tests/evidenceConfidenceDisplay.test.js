/**
 * 📊 **근거 충실도 표시 — "전부 같으면 접는다"** (2026-10-15 신설)
 *
 * ## 왜 생겼나
 *
 * 10-15 소급 채점에서 **새 코드 7회차 × 7종목 = 42건 전부 HIGH** 였다. 이 값은 서버가
 * *"서술을 채웠나 + 근거를 댔나"* 를 **코드로** 세는 것이라 데이터가 정상이면 전 종목이
 * 같은 등급이 된다 ⇒ **종목 간 비교용이 아니라 이상 탐지용**이다.
 * 그런데 화면은 7칸에 `HIGH` 를 늘어놓아 ①정보량 0 ②종목 간 비교로 **오독**을 불렀다.
 * 사용자 결정: *"전부 같으면 접는다."*
 *
 * ## 무엇을 재는가
 *
 *   ① 전부 같으면 **배지를 그리지 않는다**(= `collapsed`)
 *   ② 갈리면 **갈린 것이 드러난다**(= 안 접고 + 낮은 쪽을 지목)
 *   ③ 🔴 **결손이 섞이면 "전부 같다" 로 접히지 않는다** — *모르는 것*과 *같은 것*은 다르다
 *   ④ 🔴 **배선** — 그 판정이 실제로 템플릿에 닿는가
 *
 * ⚠️ ④가 없으면 *"로직은 맞는데 안 불린다"* 를 **원리상 못 잡는다**(이 저장소가 반복해
 *    밟은 자리). 순수 함수만 재면 `v-if` 를 통째로 지워도 ①~③이 전부 초록이다.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = () => import('../frontend/src/lib/evidenceConfidence.js');

const WORKSPACE = path.join(__dirname, '..', 'frontend/src/views/WorkspaceView.vue');
const SYMBOL = path.join(__dirname, '..', 'frontend/src/views/SymbolView.vue');

const pos = (symbol, confidence) => ({ symbol, confidence });

/* ───────────────────────── ① 전부 같으면 접는다 ───────────────────────── */

test('📊 전 종목이 같은 등급이면 접는다 — 종목별 배지는 안 그려진다', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  // 라이브 실측 모양: 7종목 전부 HIGH
  const s = summarizeEvidenceConfidence([
    pos('QLD', 'HIGH'), pos('O', 'HIGH'), pos('SOXL', 'HIGH'), pos('DIA', 'HIGH'),
    pos('UDOW', 'HIGH'), pos('SOXX', 'HIGH'), pos('RAM', 'HIGH'),
  ]);

  assert.equal(s.collapsed, true, '전부 같으면 접혀야 한다');
  assert.equal(s.grade, 'HIGH');
  assert.deepEqual(s.lowSymbols, [], '전부 HIGH 인데 지목 대상이 있으면 안 된다');
  assert.equal(s.warn, false, 'HIGH 는 경고가 아니다');
  assert.match(s.label, /전 종목/, '한 줄 요약이 있어야 한다');
  assert.match(s.label, /충분/, 'HIGH 는 "충분" 으로 적는다');
});

test('📊 전부 같아도 등급이 낮으면 경고로 말한다 (접는 것과 괜찮은 것은 다르다)', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  const s = summarizeEvidenceConfidence([pos('QLD', 'LOW'), pos('O', 'LOW')]);
  assert.equal(s.collapsed, true);
  assert.equal(s.warn, true, '전 종목 LOW 는 데이터 사고 신호다 — 조용히 접으면 안 된다');
  assert.match(s.label, /부족/);
});

/* ───────────────────────── ② 갈리면 드러난다 ───────────────────────── */

test('📊 등급이 갈리면 접지 않고 낮은 쪽을 지목한다', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  const s = summarizeEvidenceConfidence([
    pos('QLD', 'HIGH'), pos('O', 'HIGH'), pos('SOXL', 'LOW'),
  ]);

  assert.equal(s.collapsed, false, '갈렸는데 접으면 그 사실이 사라진다');
  assert.deepEqual(s.lowSymbols, ['SOXL'], '낮은 쪽이 지목돼야 한다');
  assert.equal(s.warn, true);
  assert.match(s.label, /SOXL/, '요약 줄이 어느 종목인지 이름을 대야 한다');
  assert.ok(!/QLD/.test(s.label), 'HIGH 인 종목까지 지목하면 지목이 뜻을 잃는다');
});

test('📊 MEDIUM 도 지목 대상이다 — "가장 낮은 것" 이 아니라 "만점이 아닌 것"', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  // LOW 가 없어도 MEDIUM 은 결손 신호다
  const s = summarizeEvidenceConfidence([pos('QLD', 'HIGH'), pos('O', 'MEDIUM')]);
  assert.equal(s.collapsed, false);
  assert.deepEqual(s.lowSymbols, ['O']);
  assert.match(s.label, /보통/);
});

/* ───────────────────────── ③ 결손은 "같다" 가 아니다 ───────────────────────── */

test('🔴 confidence 결손이 섞이면 "전부 같다" 로 접히지 않는다 (모르는 것 ≠ 같은 것)', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  for (const missing of [undefined, null, '', '   ']) {
    const s = summarizeEvidenceConfidence([
      pos('QLD', 'HIGH'), pos('O', 'HIGH'), pos('SOXL', missing),
    ]);
    const shown = JSON.stringify(missing);
    assert.equal(s.collapsed, false, `confidence=${shown} 가 섞였는데 접혔다`);
    assert.deepEqual(s.unknownSymbols, ['SOXL'], `confidence=${shown} 를 결손으로 못 봤다`);
    assert.match(s.label, /확인 못 함/, `confidence=${shown} 를 "확인 못 함" 으로 드러내야 한다`);
    assert.match(s.label, /SOXL/);
  }
});

test('🔴 전부 결손이면 접지 않는다 — "전 종목 확인 못 함" 을 "전 종목 같음" 으로 읽으면 안 된다', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  const s = summarizeEvidenceConfidence([pos('QLD', ''), pos('O', null)]);
  assert.equal(s.collapsed, false);
  assert.deepEqual(s.unknownSymbols, ['QLD', 'O']);
  assert.match(s.label, /확인 못 함/);
});

/* ───────────────────────── 경계 ───────────────────────── */

test('📊 종목이 1개면 접지 않는다 — 접을 중복도, 비교 대상도 없다', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  const s = summarizeEvidenceConfidence([pos('QLD', 'HIGH')]);
  assert.equal(s.collapsed, false, '1종목에 "전 종목 충분" 은 어색하고 중복도 없다');
  assert.equal(s.label, null, '말할 것이 없으면 요약 줄을 그리지 않는다');
  // 배지는 그대로 보인다 ⇒ 종목 상세 화면과 같은 규칙("비교 대상이 없으면 그대로")
});

test('📊 1종목이라도 등급이 낮으면 지목한다', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  const s = summarizeEvidenceConfidence([pos('QLD', 'LOW')]);
  assert.equal(s.collapsed, false);
  assert.deepEqual(s.lowSymbols, ['QLD']);
  assert.match(s.label, /QLD/);
});

test('📊 목록이 비었거나 배열이 아니면 null — 화면이 죽지 않는다', async () => {
  const { summarizeEvidenceConfidence } = await lib();

  for (const v of [[], null, undefined, 'nope', 42, {}]) {
    assert.equal(summarizeEvidenceConfidence(v), null, `${JSON.stringify(v)} 에서 null 이 아니다`);
  }
});

test('📊 서버가 모르는 등급을 주면 지어내지 않고 원값을 보여준다', async () => {
  const { summarizeEvidenceConfidence, confidenceWord } = await lib();

  // 전부 같은 미지 값 → 접되 라벨은 원값
  const same = summarizeEvidenceConfidence([pos('QLD', 'PARTIAL'), pos('O', 'PARTIAL')]);
  assert.equal(same.collapsed, true);
  assert.match(same.label, /PARTIAL/, '모르는 등급을 한국어로 지어내면 안 된다');

  // ⚠️ 순위를 매길 수 없으니 **지목하지 않는다**(추측하지 않는다). 대신 접히지도 않는다
  const mixed = summarizeEvidenceConfidence([pos('QLD', 'HIGH'), pos('O', 'PARTIAL')]);
  assert.equal(mixed.collapsed, false);
  assert.deepEqual(mixed.lowSymbols, []);

  assert.equal(confidenceWord('high'), '충분', '대소문자는 정규화한다');
  assert.equal(confidenceWord(''), '확인 못 함', '빈 값은 빈칸이 아니라 "확인 못 함"');
});

/* ───────────────────────── ④ 배선 — 판정이 템플릿에 닿는가 ───────────────────────── */

test('🔴 배선: WorkspaceView 가 접기 판정을 실제로 쓴다 (순수 함수만 재면 못 잡는다)', () => {
  const src = fs.readFileSync(WORKSPACE, 'utf8');

  assert.match(src, /from '\.\.\/lib\/evidenceConfidence'/,
    '판정 모듈을 import 하지 않았다 — 화면이 자기 규칙을 따로 들면 갈린다');
  assert.match(src, /summarizeEvidenceConfidence\(\s*report\.value\?\.positions\s*\)/,
    '보고서의 positions 로 요약을 만들어야 한다');

  // 배지 span 이 collapsed 로 가려지는가
  const badge = src.match(/<span[^>]*class="pos__conf"[\s\S]{0,200}?>/);
  assert.ok(badge, 'pos__conf 배지를 찾지 못했다 — 선택자가 바뀌었으면 이 자를 고쳐라');
  assert.match(badge[0], /v-if="!evidenceConf\?\.collapsed"/,
    '🔴 배지가 collapsed 로 가려지지 않는다 — 전부 같아도 7칸이 그대로 뜬다');

  // 요약 줄이 있는가
  assert.match(src, /v-if="evidenceConf\?\.label"/,
    '요약 줄이 label 로 조건부 렌더되지 않는다');
  assert.match(src, /class="conf-sum"/, '요약 줄 마크업이 없다');

  // 낮은 쪽 강조
  assert.match(src, /pos__conf--low/, '낮은 쪽을 강조하는 클래스가 배선되지 않았다');
  assert.match(src, /confLow\(/, 'confLow 판정이 템플릿에서 안 불린다');
});

test('🔴 CSS: .pos__conf--low 가 .pos__conf 뒤에 있다 (특이성이 같아 순서가 승패를 가른다)', () => {
  const src = fs.readFileSync(WORKSPACE, 'utf8');
  const base = src.indexOf('.pos__conf {');
  const low = src.indexOf('.pos__conf--low {');
  assert.ok(base > 0 && low > 0, '두 규칙이 다 있어야 한다');
  assert.ok(low > base,
    '🔴 .pos__conf--low 가 .pos__conf 앞에 있으면 color 가 되묻혀 강조가 조용히 사라진다');
});

test('📄 tooltip 설명이 보존돼 있다 (요약 줄과 배지가 같은 문구를 쓴다)', () => {
  const src = fs.readFileSync(WORKSPACE, 'utf8');
  assert.match(src, /const CONF_TITLE = '근거 충실도 —/, '설명 문구가 사라졌다');
  const uses = src.match(/:title="CONF_TITLE"/g) || [];
  assert.equal(uses.length, 2, '요약 줄과 배지 둘 다 같은 설명을 달아야 한다');
});

test('📄 종목 상세(SymbolView)는 바꾸지 않는다 — 한 종목만 보는 화면은 비교 대상이 없다', () => {
  const src = fs.readFileSync(SYMBOL, 'utf8');
  assert.match(src, /근거 충실도 \{\{ agentView\.confidence \}\}/,
    'SymbolView 의 근거 충실도 표시가 사라졌다 — 여기는 접는 대상이 아니다');
  assert.ok(!/evidenceConfidence/.test(src),
    'SymbolView 에 접기 로직이 들어가면 안 된다(비교 대상이 없다)');
});
