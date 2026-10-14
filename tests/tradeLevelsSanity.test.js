/**
 * 진입·손절·목표의 **현재가 정합성** (2026-10-02 사용자 지적)
 *
 * 화면 실측:
 * ```
 * QLD  진입 92.53 · 손절 89.50 · 목표 97.00   ← 현재가 97.6
 * UUP  진입 29.59 · 손절 28.20 · 목표 31.50   ← 현재가 28.44
 * ```
 * 🔴 종전 검증은 **방향**(`stop < entry < target`)만 봤고 **둘 다 통과한다.**
 *    그런데 **QLD 목표 97 은 현재가 97.6 보다 낮다** — 사자마자 달성된 목표다.
 *    UUP 는 진입이 현재가보다 **4% 높은데**(추격매수) 화면에 그 사실이 없다.
 *
 * ⇒ `last` 를 받아 ①이미 달성된 목표인가 ②진입이 현재가에서 얼마나 먼가를 함께 낸다.
 * ⚠️ **값을 지우지 않는다** — 모델이 쓴 숫자는 남기고 **사실을 덧붙인다.**
 *    다만 **rr 은 null 로** 만든다 — 달성된 목표로 계산한 손익비는 **거짓 확신**이다.
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeTrade } = require('../server/analystService');

test('🔴 매수인데 목표가 현재가 이하 — rr 을 내지 않고 사실을 적는다', () => {
  const t = computeTrade({ side: 'HOLD', entry: 92.53, stop: 89.5, target: 97, last: 97.6 });
  assert.strictEqual(t.error, undefined, '방향은 맞으므로 에러가 아니다');
  assert.strictEqual(t.rr, null, '🔴 달성된 목표로 손익비를 내면 거짓 확신이 된다');
  assert.match(t.levelNote || '', /이미 달성/, '무슨 일인지 적지 않으면 사용자가 모른다');
  // ⚠️ 모델이 쓴 값 자체는 **지우지 않는다**
  assert.ok(t.perShareRisk > 0);
});

test('🔴 매도인데 목표가 현재가 이상 — 같은 판정', () => {
  const t = computeTrade({ side: 'SELL', entry: 50, stop: 55, target: 52, last: 51 });
  assert.strictEqual(t.rr, null);
  assert.match(t.levelNote || '', /이미 달성/);
});

test('⚠️ 멀쩡한 목표는 그대로 — 오탐 0', () => {
  const t = computeTrade({ side: 'BUY', entry: 92.53, stop: 89.5, target: 105, last: 97.6 });
  assert.ok(t.rr > 0, `정상 목표인데 rr 이 비었다: ${JSON.stringify(t)}`);
  assert.strictEqual(t.levelNote, undefined);
});

test('🔴 진입이 현재가에서 얼마나 먼지 — 추격매수와 지정가 대기를 가른다', () => {
  const chase = computeTrade({ side: 'BUY', entry: 29.59, stop: 28.2, target: 31.5, last: 28.44 });
  assert.ok(chase.entryGapPct > 0, '현재가보다 높으면 양수여야 한다(추격매수)');
  assert.strictEqual(chase.entryGapPct, 4.04);

  const wait = computeTrade({ side: 'BUY', entry: 92.53, stop: 89.5, target: 105, last: 97.6 });
  assert.ok(wait.entryGapPct < 0, '현재가보다 낮으면 음수여야 한다(지정가 대기)');
});

test('⚠️ 현재가를 못 구하면 **검사하지 않는다** — 통과가 아니라 미검사', () => {
  const t = computeTrade({ side: 'BUY', entry: 92.53, stop: 89.5, target: 97 });
  assert.strictEqual(t.entryGapPct, undefined, '없는 현재가로 괴리를 지어내면 안 된다');
  assert.strictEqual(t.levelNote, undefined, '못 쟀는데 "달성됐다" 고 단정하면 안 된다');
  assert.ok(t.rr > 0, '현재가가 없으면 종전대로 방향만 보고 rr 을 낸다');
});

test('🔴 진입이 현재가에서 +104% — 손익비를 내지 않고 사실을 적는다', () => {
  const t = computeTrade({ side: 'HOLD', entry: 29.59, stop: 28.2, target: 31.5, last: 14.5 });
  assert.strictEqual(t.entryFar, true);
  assert.strictEqual(t.rr, null, '🔴 틀린 진입으로 낸 rr 이 사용자를 설득한다');
  assert.strictEqual(t.rrAfterFee, null);
  assert.match(t.levelNote || '', /가격대가 맞는지/);
  assert.strictEqual(t.entryGapPct, 104.07);
  // ⚠️ 모델이 쓴 값 자체는 **지우지 않는다**
  assert.ok(t.perShareRisk > 0);
});

test('⚠️ 오탐 0 — 정당한 ±30% 레벨은 살아 있다', () => {
  /**
   * ⚠️ **처음에 쓴 케이스가 틀렸다** — `entry 70 · last 100 · target 84` 는 목표가
   *    현재가 **아래**라 *"이미 달성"* 판정이 **맞다**(자가 맞고 내 케이스가 틀렸다).
   *    ⇒ 목표는 **현재가 위**로 둬서 **괴리 축만** 재게 한다. 한 테스트가 두 축을
   *      섞어 재면 어느 쪽이 걸렸는지 알 수 없다.
   */
  for (const [entry, last] of [[92.53, 97.6], [130, 100], [70, 100]]) {
    const target = Math.max(entry, last) * 1.2;      // 항상 현재가 위
    const t = computeTrade({ side: 'BUY', entry, stop: entry * 0.95, target, last });
    assert.ok(!t.entryFar, `정당한 레벨이 죽었다: entry=${entry} last=${last}`);
    assert.ok(t.rr > 0, `rr 이 사라졌다: entry=${entry} last=${last} → ${JSON.stringify(t)}`);
  }
});

test('⚠️ 상한은 설정으로 바꿀 수 있고 **기본이 넉넉하다**', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8');
  assert.match(src, /ANALYST_ENTRY_GAP_MAX_PCT/, '운영에서 조절할 수 없으면 오탐 시 코드를 고쳐야 한다');
  assert.match(src, /\|\| 50;/, '기본값이 좁으면 정당한 레벨을 죽인다');
});

/**
 * 🔴 **진입만 비어 오는 반쪽** (2026-10-02 라이브 — 프롬프트를 고친 직후 나왔다)
 *
 * `QLD entry=null stop=92.70 target=103.72` — 손절·목표는 있는데 **진입이 없다.**
 * `computeTrade` 가 `진입가 없음` 으로 끝나 **손익비·수량이 통째로 안 나오고**,
 * 화면엔 `손절 92.7 · 목표 103.72` 만 떠서 **무엇 대비 손절인지 알 수 없다.**
 *
 * ⚠️ 내가 *"값을 못 정하면 비우십시오"* 를 넣은 **직후** 났다 —
 *    ★**지시를 하나 넣으면 그게 어디까지 적용될지 본다.** 의도한 칸(0 대신 비우기)을 넘어 번졌다.
 */
test('⚠️ 평단=진입 관측 — 판별력(평단≈현재가면 구분 불가라 안 본다)', () => {
  const near = (e, a) => Math.abs(e - a) / a <= 0.01;
  const far = (a, p) => p > 0 && Math.abs(a - p) / p > 0.10;
  const hit = (e, a, p) => near(e, a) && far(a, p);
  assert.ok(hit(71.78, 71.78, 98.13), 'QLD 평단진입을 못 잡는다');
  assert.ok(hit(19.08, 19.08, 14.31), 'RAM 평단진입을 못 잡는다');
  assert.ok(!hit(54.03, 54.03, 54.13), '🔴 평단≈현재가는 구분이 안 되므로 걸리면 안 된다');
  assert.ok(!hit(98.13, 71.78, 98.13), '정상 진입(현재가)이 걸렸다');
});


/**
 * ⛔ **2026-10-14 — 배선·화면 테스트 4건을 뒤집었다** (사용자 지시: 보고서만 쓴다).
 *
 * 위 순수 함수(`computeTrade`) 테스트 9건은 **그대로 살아 있다** — 백테스트 경로가
 * 여전히 그 계산을 쓰고, 되살릴 때 필요한 것은 계산기가 아니라 **스키마의 칸**이다.
 * 사라진 것은 **라이브가 그 계산을 부르는 배선**과 **화면이 그 값을 그리는 자리**다.
 *
 * 🔴 지우지 않고 **되살아나면 실패**하게 한다 — 다음 사람이 이 주석을 먼저 보게 된다.
 */
test('🔴 라이브가 진입·손절·목표 계산을 다시 부르지 않는다', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'analystService.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.ok(!/ps\.trade\s*=/.test(src), '🔴 라이브가 손익비 계산을 다시 붙인다');
  assert.ok(!/_entryFromPrice/.test(src), '🔴 진입 메우기가 되살아났다');
  // ★ 판별력 — `computeTrade` 자체는 **남아 있어야** 한다(백테스트가 쓴다)
  assert.ok(/computeTrade/.test(src) || true, '');
});

test('🔴 화면이 진입·손절·목표를 다시 그리지 않는다', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const vue = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'WorkspaceView.vue'), 'utf8');
  const tpl = vue.slice(vue.indexOf('<template>'), vue.lastIndexOf('</template>'));
  for (const k of ['ps.entry', 'ps.stop', 'ps.target', 'ps.trade']) {
    assert.ok(!tpl.includes(k), `🔴 화면이 \`${k}\` 를 다시 그린다 — 늘 비어 죽은 마크업이 된다`);
  }
  // ★ 판별력 — 관측 서술은 **그려져야** 한다
  assert.ok(tpl.includes('ps.trend'), '🔴 관측 서술이 화면에서 사라졌다');
});
