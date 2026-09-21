const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 감시 표시 저장 (2026-09-22)
 *
 * ## 🔴 왜 있나 — **200 과 로그가 거짓말했다**
 *
 * `setWatch` 가 `t.watch = true` 를 넣고 **HTTP 200 + `watchlist.ticker.watch on:true`** 를 냈는데
 * 파일에는 **안 남았다.** 원인은 저장 정규화(`normalizeWatchlistTicker`)가 **필드를 추리는 것**이었다 —
 * 목록에 없는 `watch` 를 조용히 버렸다.
 *
 * ★ **새 필드를 추가할 때 쓰는 쪽만 고치면 안 된다** — 정규화가 **저장 계약의 정본**이다.
 * ★ 사용자가 배지를 눌러도 아무 일이 안 일어나는데 **밖에서는 완벽히 정상으로 보였다.**
 */

/**
 * 🔴 **실제 데이터를 건드리지 않는다.** 첫 판에 env 이름을 `SIMPLESTOCK_DATA_FILE` 로 **지어내서**
 *    `dataStore` 가 무시했고, 테스트가 **로컬 `data/watchlist.json` 에 그룹 5개를 만들었다.**
 *    ⚠️ 그리고 그 오염 때문에 **회차마다 결과가 달랐다**(1번이 통과했다 실패했다).
 *    ★ *"env 를 넣었으니 격리됐다"* 고 믿지 말고 **그 이름을 코드가 읽는지** 확인할 것.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-wf-'));
process.env.SIMPLESTOCK_DATA_DIR = DATA_DIR;

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/dataStore|watchlistService|marketDataService|realtimeService/.test(k)) delete require.cache[k];
  }
  return require('../server/watchlistService');
}

beforeEach(() => {
  for (const f of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, f), { force: true });
});

test('🔴 감시 표시가 **파일에 남는다** (정규화가 버리지 않는다)', async () => {
  const w = fresh();
  await w.createGroup('테스트');
  let st = w.getWatchlistState();
  const gid = st.groups[0].id;
  await w.addTicker(gid, { symbol: 'NVDA', name: 'NVIDIA', market: 'US', currency: 'USD' });

  await w.setWatch(gid, 'NVDA', true);

  // 🔴 **되읽어서** 확인한다 — 메모리만 보면 이 결함을 못 잡는다
  for (const k of Object.keys(require.cache)) if (/dataStore|watchlistService/.test(k)) delete require.cache[k];
  const w2 = require('../server/watchlistService');
  const t = w2.getWatchlistState().groups[0].tickers.find((x) => x.symbol === 'NVDA');
  assert.equal(t.watch, true, '🔴 저장 계약이 watch 를 버렸다 — 배지를 눌러도 아무 일이 안 일어난다');
  assert.deepEqual(w2.getWatchedSymbols(), ['NVDA']);
});

test('🔴 저장이 안 되면 **던진다** (200 이 거짓말하지 않게)', async () => {
  // 먼저 정상 경로로 종목을 하나 만든다
  const w0 = fresh();
  await w0.createGroup('T');
  const gid = w0.getWatchlistState().groups[0].id;
  await w0.addTicker(gid, { symbol: 'AMD', name: 'AMD', market: 'US', currency: 'USD' });

  /**
   * 저장 계약이 필드를 **버리는** 상황을 재현한다(원래 결함 그대로).
   * ⚠️ **스텁은 `require` 전에 꽂는다** — `const { mutateStore } = require(...)` 는 값을 캡처하므로
   *    나중에 바꿔도 안 먹는다. 오늘 이 함정을 네 번 적어 놓고 이 파일에서 또 밟았다.
   */
  for (const k of Object.keys(require.cache)) {
    if (/dataStore|watchlistService/.test(k)) delete require.cache[k];
  }
  const dsPath = require.resolve('../server/dataStore');
  const realDs = require(dsPath);
  require.cache[dsPath] = {
    id: dsPath, filename: dsPath, loaded: true,
    exports: {
      ...realDs,
      // 쓰기를 삼킨다 — 예전 정규화가 `watch` 를 버리던 것과 같은 결과
      mutateStore: async (fn) => { await fn(realDs.loadStore()); },
    },
  };
  const w = require('../server/watchlistService');
  await assert.rejects(() => w.setWatch(gid, 'AMD', true), /저장되지 않/,
    '🔴 저장이 안 됐는데 성공으로 돌려준다 — 200 과 로그가 거짓말한다');

  for (const k of Object.keys(require.cache)) {
    if (/dataStore|watchlistService/.test(k)) delete require.cache[k];
  }
});

test('끄는 것도 남는다 (켰다 끄면 꺼진 채로)', async () => {
  const w = fresh();
  await w.createGroup('T');
  const gid = w.getWatchlistState().groups[0].id;
  await w.addTicker(gid, { symbol: 'TSLA', name: 'Tesla', market: 'US', currency: 'USD' });
  await w.setWatch(gid, 'TSLA', true);
  await w.setWatch(gid, 'TSLA', false);
  assert.deepEqual(w.getWatchedSymbols(), [], '🔴 껐는데 감시 대상에 남는다');
});

test('기본은 **꺼짐**이다 (프리셋 대량 추가가 전부 켜지면 안 된다)', async () => {
  const w = fresh();
  await w.createGroup('T');
  const gid = w.getWatchlistState().groups[0].id;
  await w.addTicker(gid, { symbol: 'META', name: 'Meta', market: 'US', currency: 'USD' });
  assert.equal(w.getWatchlistState().groups[0].tickers[0].watch, false);
  assert.deepEqual(w.getWatchedSymbols(), []);
});

test('같은 종목이 여러 그룹에 있어도 **한 번만** 센다', async () => {
  const w = fresh();
  await w.createGroup('반도체'); await w.createGroup('AI');
  const [g1, g2] = w.getWatchlistState().groups.map((g) => g.id);
  await w.addTicker(g1, { symbol: 'NVDA', name: 'N', market: 'US', currency: 'USD' });
  await w.addTicker(g2, { symbol: 'NVDA', name: 'N', market: 'US', currency: 'USD' });
  await w.setWatch(g1, 'NVDA', true);
  await w.setWatch(g2, 'NVDA', true);
  assert.deepEqual(w.getWatchedSymbols(), ['NVDA'], '🔴 중복으로 세면 감시 대상 수가 부풀려진다');
});

/**
 * 🔴 **이 실패 모드 자체를 잠근다** — 저장 계약이 필드를 추리므로,
 * 앞으로 누가 티커에 새 필드를 넣을 때 **여기서 걸려야** 한다.
 */
test('🔴 저장 계약(normalizeWatchlistTicker)이 감시 표시를 보존한다', () => {
  for (const k of Object.keys(require.cache)) if (/dataStore/.test(k)) delete require.cache[k];
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'dataStore.js'), 'utf8');
  const fn = /function normalizeWatchlistTicker\([\s\S]*?\n\}/.exec(src)?.[0];
  assert.ok(fn, '정규화 함수를 못 찾았다 — 자가 헛돈다');
  assert.match(fn, /watch:/, '🔴 정규화가 watch 를 안 담는다 — 저장할 때 조용히 사라진다');
  // 판별력: 이 함수가 **실제로 추리는지** 확인(안 추리면 이 자는 의미가 없다)
  assert.ok(!/\.\.\.item/.test(fn), '이 함수가 필드를 펼치도록 바뀌었다면 이 자의 전제가 달라졌다');
});
