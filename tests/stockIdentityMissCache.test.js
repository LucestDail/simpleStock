/**
 * 정체 조회 실패 캐시 (2026-10-02 라이브 실사고)
 *
 * 증상: 브리핑 웹 검색이 QLD·RAM 을 통째로 건너뛴다(`mcp.bare_ticker_skipped`).
 * 원인: `getStockInfo` 가 한 번 그 심볼을 안 주면 **성공과 같은 6시간** 캐시돼,
 *       그 사이 `officialName` 이 없고 → `buildQuery` 가 티커로 떨어진다.
 * 가드: 실패는 짧게 캐시하고(곧 다시 묻는다), **못 받았다는 사실을 로그로 남긴다**.
 *
 * ⚠️ 여기서 재는 것은 "정식명이 채워진다" 가 아니라 **"다시 물어보러 간다"** 다 —
 *    외부가 내내 안 주면 채워질 수 없고, 그건 이 코드가 고칠 수 있는 축이 아니다.
 */
const test = require('node:test');
const assert = require('node:assert');

const IDENTITY = require.resolve('../server/stockIdentity');
const TOSS = require.resolve('../server/tossClient');
const LOGGER = require.resolve('../server/logger');

/** 토스·로거를 갈아끼운 채 모듈을 새로 읽는다(캐시가 모듈 전역이라 매번 새로 받아야 한다) */
function load({ responses }) {
  for (const m of [IDENTITY, TOSS, LOGGER]) delete require.cache[m];
  const calls = [];
  const warns = [];
  require.cache[TOSS] = {
    id: TOSS, filename: TOSS, loaded: true,
    exports: {
      async getStockInfo(symbols) {
        calls.push([...symbols]);
        const turn = Math.min(calls.length - 1, responses.length - 1);
        return new Map(Object.entries(responses[turn] || {}));
      },
    },
  };
  require.cache[LOGGER] = {
    id: LOGGER, filename: LOGGER, loaded: true,
    exports: { logWarn: (e, d) => warns.push({ event: e, ...d }), logInfo() {}, logError() {} },
  };
  return { mod: require(IDENTITY), calls, warns };
}

test('응답에 심볼이 없으면 — 조용히 넘기지 않는다', async () => {
  const { mod, warns } = load({ responses: [{}] });
  await mod.enrich([{ symbol: 'QLD', name: 'QLD' }]);
  const miss = warns.find((w) => w.event === 'identity.missing');
  assert.ok(miss, '못 받은 심볼이 있는데 로그가 0건이다 — 그게 이 사고를 숨겼다');
  assert.deepStrictEqual(miss.symbols, ['QLD']);
});

test('실패는 6시간이 아니라 짧게 캐시된다 — 곧 다시 묻는다', async () => {
  // 1회차: 못 받음 → 2회차(시간 경과 없음): 캐시에 걸려 **안 묻는다**
  const { mod, calls } = load({ responses: [{}, { QLD: { englishName: 'ProShares Ultra QQQ' } }] });
  await mod.enrich([{ symbol: 'QLD', name: 'QLD' }]);
  await mod.enrich([{ symbol: 'QLD', name: 'QLD' }]);
  assert.strictEqual(calls.length, 1, '짧은 캐시도 캐시다 — 매 틱 두드리면 호출이 샌다');

  // 🔴 핵심: **실패 유효기간이 성공과 같으면 안 된다.** 상수로 직접 못박는다 —
  //    시간을 돌릴 수 없으니(모듈 전역 Map) 여기서는 상수 관계로 잠근다.
  assert.ok(mod.MISS_CACHE_MS < mod.CACHE_MS / 6,
    `실패 캐시(${mod.MISS_CACHE_MS}ms)가 성공 캐시(${mod.CACHE_MS}ms)에 비해 길다 — `
    + '한 번 빗나가면 그 시간 내내 웹 검색이 죽는다');
});

test('정식명을 받으면 officialName 이 붙는다 (자가 재려던 것을 실제로 잰다)', async () => {
  const { mod } = load({ responses: [{ QLD: { englishName: 'ProShares Ultra QQQ', securityType: 'ETF', leverageFactor: 2 } }] });
  const [it] = await mod.enrich([{ symbol: 'QLD', name: 'QLD' }]);
  assert.strictEqual(it.officialName, 'ProShares Ultra QQQ');
  assert.strictEqual(it.leverageFactor, 2);
});

test('🔴 이 사고의 재현 — 정식명이 없으면 질의가 맨 티커로 떨어진다', () => {
  delete require.cache[require.resolve('../server/mcpClient')];
  const mcp = require('../server/mcpClient');
  // 정체가 붙은 주제는 정식명으로 나간다
  assert.strictEqual(
    mcp.buildQuery({ symbol: 'QLD', name: 'QLD', officialName: 'ProShares Ultra QQQ' }),
    'ProShares Ultra QQQ');
  // 정체가 비면 티커로 떨어지고 → 건너뜀 대상이 된다
  assert.strictEqual(mcp.buildQuery({ symbol: 'QLD', name: 'QLD' }), 'QLD');
  assert.strictEqual(mcp.isBareTickerQuery({ symbol: 'QLD', name: 'QLD' }, 'QLD'), true);
  // ⚠️ 오탐 축 — 심볼이 없는 자유 질의는 건드리지 않는다
  assert.strictEqual(mcp.isBareTickerQuery({ symbol: '', name: 'NVDA 어때?' }, 'NVDA 어때?'), false);
});
