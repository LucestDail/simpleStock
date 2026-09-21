const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 🔴 **버튼 이름이 사실을 말한다** (2026-09-22)
 *
 * ## 왜 있나
 * 실행 버튼이 `실행(모의)` 로 **박혀** 있었다. 지금은 사실이지만
 * **`ORDERS_ENABLED`/`ORDERS_LIVE` 를 켜는 순간 그 이름이 거짓**이 된다 —
 * 사용자는 *"모의니까"* 하고 누르고 **실제 주문이 나간다.**
 *
 * ★ 오늘 밤 *"이름이 사실과 다른 것"* 을 세 번 봤다(`QUIET_OFF` 가 조용시간을 안 껐다 ·
 *   "없는 데이터" 목록에 있는 데이터를 적었다 · 이것). 이번 건은 **돈이 나간다.**
 */

const VIEW = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'views', 'WorkspaceView.vue'), 'utf8');
const tpl = /<template>([\s\S]*)<\/template>/.exec(VIEW)?.[1] || '';
const script = VIEW.slice(VIEW.indexOf('<script'), VIEW.indexOf('</script>'));

test('🔴 실행 버튼 이름이 **하드코딩돼 있지 않다**', () => {
  const btn = /<button[^>]*decide\(p, 'execute'\)[\s\S]{0,400}?<\/button>/.exec(tpl)?.[0];
  assert.ok(btn, '🔴 실행 버튼을 못 찾았다 — 자가 헛돈다');
  assert.ok(/ordersMode/.test(btn), '🔴 버튼이 모드를 안 본다 — 켜는 순간 이름이 거짓이 된다');
  assert.ok(/실주문/.test(btn), '🔴 실거래일 때 쓸 이름이 없다');
});

test('🔴 모드는 **서버가 말한 것**을 쓴다 (화면이 추측하지 않는다)', () => {
  assert.match(script, /ordersMode\.value\s*=\s*body\.status\?\.effective/,
    '🔴 화면이 모드를 지어내면 서버와 어긋난다');
});

/** 🔴 되돌릴 수 없는 행위에 확인이 없으면 오터치가 곧 체결이다 */
test('🔴 실거래 실행은 한 번 더 묻는다', () => {
  const fn = /async function decide\([\s\S]*?\n\}/.exec(script)?.[0] || '';
  assert.ok(fn, 'decide 를 못 찾았다');
  assert.match(fn, /confirm\(/, '🔴 확인 없이 실주문이 나간다');
  // ⚠️ **실행에만** 확인을 건다 — 승인·거절은 되돌릴 수 있다(매번 물으면 사람이 끈다)
  assert.match(fn, /action === 'execute' && live/, '🔴 승인·거절까지 물으면 확인이 무의미해진다');
});

test('🔴 실거래 모드는 **버튼을 누르기 전에** 보인다', () => {
  assert.match(tpl, /ordmode/, '🔴 모드 배지가 없다 — 켜져 있는지 모르고 쓴다');
  const badge = /<p v-if="ordersMode === 'live'"[\s\S]{0,200}?<\/p>/.exec(tpl)?.[0] || '';
  assert.match(badge, /실제 주문/, '🔴 배지가 무슨 뜻인지 말하지 않는다');
});

/**
 * 🔴 **자기검증** — 이 자가 진짜로 하드코딩을 잡는가.
 * 안 잡으면 다음 사람이 `실행(모의)` 로 되돌려도 초록불이다.
 */
test('🔴 자기검증: 옛 하드코딩 모양이면 걸린다', () => {
  const OLD = `<button class="btn btn--sm btn--soft" @click="decide(p, 'execute')">실행(모의)</button>`;
  const fake = tpl.replace(/<button[^>]*decide\(p, 'execute'\)[\s\S]{0,400}?<\/button>/, OLD);
  const btn = /<button[^>]*decide\(p, 'execute'\)[\s\S]{0,400}?<\/button>/.exec(fake)?.[0];
  assert.ok(btn && !/ordersMode/.test(btn), '🔴 변이를 만들지 못했다 — 이 자는 아무것도 안 지킨다');
});

/** ⚠️ 서버가 두 스위치를 **둘 다** 봐야 한다 — 하나만 켜고 실거래가 되면 안 된다 */
test('⚠️ 서버는 두 스위치가 모두 켜져야 live 로 본다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'orderService.js'), 'utf8');
  assert.match(src, /ORDERS_ENABLED && ORDERS_LIVE \? 'live' : 'dry-run'/,
    '🔴 한쪽만으로 live 가 되면 실수로 켜진다');
});
