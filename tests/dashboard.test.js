const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// 🔴 테스트 파일은 **병렬로** 돈다 — 설정을 공유하면 서로의 값을 덮어쓴다(경합은 초록불도 만든다)
process.env.SETTINGS_FILE = require('node:path').join(require('node:os').tmpdir(), `ss-set-dashboard-${process.pid}.json`);

/**
 * 대시보드 집계 (2026-09-21)
 *
 * 🔴 이 설계의 핵심은 **부분 실패를 전체 성공/실패로 뭉개지 않는 것**이다.
 *   - 조각 하나가 실패해도 나머지는 그려야 한다(전부 502 로 만들면 멀쩡한 것까지 사라진다)
 *   - 그렇다고 조용히 빈 값으로 만들면 화면은 "데이터가 없네" 로 보이고 **원인을 영영 모른다**
 *   ⇒ 조각마다 성패를 싣고 상위에 실패 개수를 낸다.
 */

process.env.TOSS_CLIENT_ID = 'test-id';
process.env.TOSS_CLIENT_SECRET = 'test-secret';

const dashboard = require('../server/dashboardService');
const portfolio = require('../server/tossPortfolio');

const realFetch = global.fetch;
let routes = new Map();

function res(status, body, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: new Map(Object.entries(headers)),
    json: async () => body, text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  routes = new Map();
  global.fetch = async (url) => {
    const u = String(url);
    for (const [frag, fn] of routes) if (u.includes(frag)) return fn(u);
    throw new Error(`등록되지 않은 호출: ${u}`);
  };
  portfolio._resetForTest();
});
afterEach(() => { global.fetch = realFetch; });

const ok = () => res(200, { access_token: 'AT', token_type: 'Bearer', expires_in: 86399 });

function baseRoutes() {
  routes.set('/oauth2/token', ok);
  routes.set('/api/v1/accounts', () => res(200, { result: [{ accountNo: 'x', accountSeq: 1, accountType: 'BROKERAGE' }] }));
  routes.set('/api/v1/holdings', () => res(200, { result: {
    totalPurchaseAmount: { krw: '0', usd: '100' },
    marketValue: { amount: { krw: '0', usd: '110' } },
    profitLoss: { amount: { krw: '0', usd: '10' }, rate: '0.1' },
    dailyProfitLoss: { amount: { krw: '0', usd: '5' }, rate: '0.05' },
    items: [{ symbol: 'QLD', name: 'QLD', marketCountry: 'US', currency: 'USD', quantity: '1',
      lastPrice: '110', averagePurchasePrice: '100',
      marketValue: { purchaseAmount: '100', amount: '110' },
      profitLoss: { amount: '10', rate: '0.1' },
      dailyProfitLoss: { amount: '5', rate: '0.045' } }] } }));
  routes.set('/api/v1/stocks?', () => res(200, { result: [{ symbol: 'QLD', name: 'QLD', market: 'US', currency: 'USD', status: 'LISTED' }] }));
  routes.set('/api/v1/rankings', () => res(200, { result: { rankedAt: 'now', rankings: [{ rank: 1, symbol: 'A', price: {}, tradingVolume: '1' }] } }));
  routes.set('/api/v1/stocks/', () => res(200, { result: [] })); // warnings
}

test('한 번에 모아 준다 (화면이 조각마다 요청하면 한도를 태운다)', async () => {
  baseRoutes();
  const d = await dashboard.build({ watchSymbols: ['005930'], momentumPct: 3 });
  assert.ok(d.portfolio, '보유가 없다');
  assert.equal(d.failedCount, 0, `실패 조각 ${JSON.stringify(d.parts)}`);
  // ⚠️ 2026-09-21: 키가 `국가:종류` 로 바뀌었다(미국장을 주로 보므로 국가를 나눈다)
  const keys = Object.keys(d.rankings);
  assert.ok(keys.length, '랭킹이 없다');
  assert.ok(keys.every((k) => k.includes(':')), `키가 국가:종류 가 아니다 — ${keys}`);
  // 🔴 종목명이 붙어야 한다 — 코드만 뜨면 사용자가 무슨 종목인지 모른다
  const first = Object.values(d.rankings)[0].rows[0];
  assert.ok('name' in first, '랭킹에 종목명이 안 붙었다');
  assert.ok('stockInfo' in d);
});

test('🔴 조각 하나가 실패해도 나머지는 살아 있다', async () => {
  baseRoutes();
  routes.set('/api/v1/stocks?', () => res(500, { error: 'boom' }));
  const d = await dashboard.build({ momentumPct: 3 });
  assert.ok(d.portfolio, '종목정보가 죽었다고 보유까지 사라졌다');
  assert.equal(d.parts.stockInfo.ok, false);
  assert.equal(d.parts.holdings.ok, true);
});

test('🔴 랭킹 **종류 하나**가 실패해도 나머지 랭킹은 남는다 (2026-09-21 라이브 결함)', async () => {
  /*
   * 잘못된 종류 하나(내가 지어낸 `tradingVolume`) 때문에 **랭킹이 통째로 비었다.**
   * 화면에 랭킹이 아예 안 떴고, 원인은 종류 하나였다.
   * ⇒ 부분 실패 원칙을 **한 겹 더** 안으로 적용한다.
   */
  baseRoutes();
  let n = 0;
  routes.set('/api/v1/rankings', () => {
    n += 1;
    return n === 1 ? res(400, { error: 'bad type' }) : res(200, { result: { rankedAt: 'now', rankings: [{ rank: 1, symbol: 'A' }] } });
  });
  const d = await dashboard.build({ rankingTypes: ['TOP_GAINERS', 'TOP_LOSERS'], rankingCountries: ['US'] });
  const keys = Object.keys(d.rankings);
  assert.equal(keys.length, 2, '실패한 종류가 목록에서 사라졌다 — 화면이 왜 없는지 모른다');
  const failed = Object.values(d.rankings).find((r) => r.error);
  assert.ok(failed, '실패한 종류에 이유가 안 남았다');
  assert.ok(Object.values(d.rankings).some((r) => r.rows.length), '멀쩡한 종류까지 비었다');
  assert.equal(d.parts.rankings.ok, true, '종류 하나 때문에 랭킹 조각 전체가 실패로 찍혔다');
});

test('🔴 실패를 **조용히 빈 값으로** 만들지 않는다 (화면이 "없음" 과 "못 받음" 을 구분한다)', async () => {
  baseRoutes();
  routes.set('/api/v1/stocks?', () => res(500, { error: 'boom' }));
  const d = await dashboard.build({});
  assert.equal(d.failedCount, 1, '실패를 세지 않았다');
  assert.ok(d.parts.stockInfo.error, '실패 이유가 없다 — 원인을 영영 모른다');
  assert.ok(d.parts.stockInfo.kind, 'kind 가 없다 — ip-denied 인지 429 인지 화면이 못 가른다');
});

test('보유가 통째로 실패해도 대시보드는 응답한다', async () => {
  baseRoutes();
  routes.set('/api/v1/holdings', () => res(403, { error: 'denied' }));
  const d = await dashboard.build({});
  assert.equal(d.portfolio, null);
  assert.equal(d.parts.holdings.ok, false);
  assert.equal(d.parts.holdings.kind, 'ip-denied', 'IP 거부가 화면에 그대로 전달돼야 고칠 수 있다');
  assert.deepEqual(d.momentum, []);
});

test('★ 자의 판별력 — 모두 성공일 때 failedCount 가 0 이다(항상 0 인 자가 아니다)', async () => {
  baseRoutes();
  const okRun = await dashboard.build({});
  assert.equal(okRun.failedCount, 0);
  routes.set('/api/v1/stocks?', () => res(500, {}));
  routes.set('/api/v1/stocks/', () => res(500, {})); // warnings
  const badRun = await dashboard.build({});
  assert.equal(badRun.failedCount, 2, '두 조각이 실패했는데 세지 못했다');
});

test('모멘텀 임계값이 실제로 걸린다', async () => {
  baseRoutes();
  const loose = await dashboard.build({ momentumPct: 1 });   // 4.5% > 1%
  assert.equal(loose.momentum.length, 1);
  const strict = await dashboard.build({ momentumPct: 10 }); // 4.5% < 10%
  assert.equal(strict.momentum.length, 0);
});

test('🔴 설정이 비었으면 **기본값**이 적용된다 (Number(null)===0 함정)', async () => {
  /*
   * 처음 판에서 `Number.isFinite(Number(null))` 이 **true** 라(Number(null)===0)
   * null 이 하한으로 클램프됐다 — momentumPct 3 → **0.1**, refreshSec 60 → **15**.
   * ★ 숫자가 그럴듯해서 코드만 봐선 안 보였다. **화면에 "|0.1%| 이상" 이 떠서** 알았다.
   */
  const settings = require('../server/settingsService');
  await settings.updateSettings({ dashboard: { momentumPct: null, refreshSec: null } });
  const d = settings.getDashboardSettings();
  assert.equal(d.momentumPct, 3, `기본값이 아니라 ${d.momentumPct} 다`);
  assert.equal(d.refreshSec, 60, `기본값이 아니라 ${d.refreshSec} 다`);
  assert.ok(d.usingDefault.includes('momentumPct'), '기본값을 썼는데 그 사실을 안 알린다');

  // ★ 자의 판별력 — 진짜 값은 그대로 두고, 범위 밖만 되돌린다
  await settings.updateSettings({ dashboard: { momentumPct: 7, refreshSec: 30 } });
  const set = settings.getDashboardSettings();
  assert.equal(set.momentumPct, 7);
  assert.equal(set.refreshSec, 30);
  assert.ok(!set.usingDefault.includes('momentumPct'));

  await settings.updateSettings({ dashboard: { momentumPct: 999, refreshSec: 1 } });
  const clamped = settings.getDashboardSettings();
  assert.equal(clamped.momentumPct, 50, '상한을 넘겼는데 안 잘렸다');
  assert.equal(clamped.refreshSec, 15, '하한 아래인데 안 올렸다');

  await settings.updateSettings({ dashboard: { momentumPct: null, refreshSec: null } }); // 원복
});

test('🔴 설정이 **실제로 쓰인다** (만들어 놓고 안 쓰면 설정이 아니다)', () => {
  /*
   * 오늘 아침 `upsertHolding` 이 **실행부 없이** 존재했던 것과 같은 축이다.
   * 설정을 만들고 소비처에 안 꽂으면 화면에서 저장은 되는데 **아무 일도 안 일어난다.**
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const mgr = fs.readFileSync(path.join(__dirname, '..', 'server/managerService.js'), 'utf8');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.ok(/getDashboardSettings\(\)/.test(mgr), '브리핑이 대시보드 설정을 안 읽는다');
  assert.ok(/briefingPrompt/.test(mgr), 'briefingPrompt 가 브리핑에 안 쓰인다 — 저장만 되고 끝난다');
  assert.ok(/momentumPct/.test(srv), 'momentumPct 가 대시보드 라우트에 안 쓰인다');
  assert.ok(/settings: getDashboardSettings\(\)/.test(srv), '화면이 실효 설정을 못 받는다(갱신 주기가 안 따라온다)');
});

test('🔴 보유가 있으면 프롬프트가 그것을 **금지하지 않는다**', () => {
  /*
   * v3 에서 개인 자산을 걷어냈을 때 *"개인 자산 정보는 없습니다 · 보유/수익률 표현은
   * 절대 쓰지 마세요"* 라고 적었다. 이제 토스 실계좌가 들어오는데 그 문장이 남아 있으면
   * 모델이 **자산을 보고도 못 본 척**한다 — 아침의 죽은 지시서와 **거울상**이다.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'server/managerService.js'), 'utf8');
  /*
   * ⚠️ **주석을 먼저 지운다.** 첫 판에서 이 테스트가 실패했는데 제품이 아니라 **내 주석** 때문이었다
   *    — 위 설명에 같은 문장을 인용해 뒀고 indexOf 가 그걸 먼저 잡았다.
   *    *"판정은 언급이 아니라 구조로"* 를 이 테스트 자신이 어겼다.
   */
  const mgr = raw
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n');
  assert.ok(/hasHoldings/.test(mgr), '보유 유무에 따라 프롬프트가 갈리지 않는다');
  // 금지 문장은 **보유가 없을 때만** 나가야 한다 — 삼항 안에 들어 있는지 본다
  const i = mgr.indexOf('절대 쓰지 마세요');
  assert.ok(i > 0, '금지 문장을 못 찾았다 — 가드가 대상을 잃었다(통과 아님)');
  const around = mgr.slice(Math.max(0, i - 400), i);
  assert.ok(/hasHoldings\s*\n?\s*\?/.test(around), '금지 문장이 보유 유무와 무관하게 항상 나간다');
});

test('🔴 컴포넌트가 **남의 scoped 스타일**에 기대지 않는다', () => {
  /*
   * 2026-09-21: 설정 패널의 입력·버튼이 화면에서 **안 보였다.**
   * `.input`·`.btn`·`.iconbtn` 이 WorkspaceView 의 **scoped** 스타일이라 적용되지 않았다.
   * ⚠️ 입력만 고치고 버튼을 안 훑어서 **두 번** 당했다 — *"한 곳 고치면 전수 훑는다"*.
   * ⇒ 이 가드가 그 전수 훑기를 대신한다.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'frontend/src');
  const wv = fs.readFileSync(path.join(root, 'views/WorkspaceView.vue'), 'utf8');
  const wvStyle = wv.split('<style scoped>')[1] || '';
  const defined = new Set([...wvStyle.matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]));
  assert.ok(defined.size > 20, 'WorkspaceView 스타일을 못 읽었다 — 가드가 대상을 잃었다(통과 아님)');

  const dir = path.join(root, 'components');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.vue'));
  assert.ok(files.length >= 2, `컴포넌트가 ${files.length}개뿐 — 경로가 틀렸을 수 있다`);

  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const tpl = (src.split('<template>')[1] || '').split('</template>')[0];
    const own = new Set([...(src.split('<style scoped>')[1] || '').matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]));
    const used = new Set();
    for (const m of tpl.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
    for (const m of tpl.matchAll(/'([a-z][a-z0-9_-]*)':/g)) used.add(m[1]);
    for (const c of used) if (defined.has(c) && !own.has(c)) offenders.push(`${f}:${c}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `남의 scoped 클래스를 쓴다(화면에서 스타일이 안 먹는다): ${offenders.join(', ')}`
  );
});

test('🔴 지어낸 랭킹 종류를 **보내기 전에** 막는다 (400 은 원인을 안 알려준다)', async () => {
  /*
   * 2026-09-21 라이브: `tradingVolume` 로 불러 토스가 400 을 냈고 랭킹이 통째로 비었다.
   * 그 이름은 **내가 스펙을 잘못 읽고 지어낸 것**이다(내 덤프가 긴 enum 을 잘랐다).
   * ⇒ 클라이언트가 먼저 막고 **무엇이 허용되는지** 메시지에 담는다.
   */
  const toss = require('../server/tossClient');
  await assert.rejects(
    () => toss.getRankings({ type: 'tradingVolume' }),
    (e) => {
      assert.equal(e.kind, 'shape');
      assert.match(e.message, /TOP_GAINERS/, '허용값을 안 알려준다 — 400 과 똑같아진다');
      return true;
    }
  );
  // ⚠️ 급등·급락은 realtime 을 지원하지 않는다(실측 400)
  await assert.rejects(() => toss.getRankings({ type: 'TOP_GAINERS', duration: 'realtime' }), /realtime/);
});

test('🔴 랭킹 등락률도 소수비율이다 — 같은 100배 함정의 재발 자리', async () => {
  /*
   * 피어 실측: `price.changeRate: '1.4416'` = **+144.17%** (2.93/1.2 로 검산).
   * 그대로 쓰면 화면에 "+1.44%" 로 뜬다 — 오후에 보유 손익률에서 고친 그 함정이다.
   * ⚠️ 최상위 `rate` 는 **없다**. 엉뚱한 자리를 보면 "등락률이 안 온다" 로 읽힌다.
   */
  const toss = require('../server/tossClient');
  const realFetch2 = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/oauth2/token')) {
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ access_token: 'A', expires_in: 86399 }) };
    }
    return {
      ok: true, status: 200, headers: new Map(),
      json: async () => ({ result: { rankedAt: 'now', rankings: [
        { rank: 1, symbol: 'GLND', currency: 'USD',
          price: { lastPrice: '2.93', basePrice: '1.2', changeRate: '1.4416' } },
      ] } }),
    };
  };
  const r = await toss.getRankings({ type: 'TOP_GAINERS', country: 'US' });
  global.fetch = realFetch2;
  assert.equal(r.rows[0].changePct, 144.16, `등락률이 ${r.rows[0].changePct} — 144.16 이어야 한다`);
  assert.equal(r.rows[0].lastPrice, 2.93);
});
