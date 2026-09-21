const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// 🔴 테스트 파일은 **병렬로** 돈다 — 설정을 공유하면 서로의 값을 덮어쓴다(경합은 초록불도 만든다)
process.env.SETTINGS_FILE = require('node:path').join(require('node:os').tmpdir(), `ss-set-analystDryRun-${process.pid}.json`);
const os = require('node:os');
const path = require('node:path');

/**
 * 점검용 실행(`dryRun`) 과 **판단 누락 되묻기** (2026-09-21)
 *
 * ## 왜 있나
 *
 * pm2 가 배포 검증을 하다 **사용자 폰으로 알림 3건**을 보냈다:
 * > *"검증이 곧 발송이다. … 안 그러면 나는 이 경로를 앞으로 검증할 수 없다."*
 *
 * ★ **검증할 수 없는 경로는 결국 검증 안 된 채로 배포된다.** 오늘 아침 내가 `force` 로
 *   사용자 폰에 12건을 보낸 것과 **같은 자리**다 — 그때는 숫자(`r.ok`↔`r.sent`)가 틀렸고
 *   이번엔 **부작용**이 문제다.
 *
 * ## 🔴 이 테스트가 지키는 것
 *
 * 1. `dryRun` 이면 **아무것도 안 나간다**(텔레그램·제안 둘 다)
 * 2. `dryRun` 이 **다음 진짜 발송을 삼키지 않는다** — digest 를 건드리면 안 된다
 * 3. 기본값은 **여전히 발송**이다 — 사용자 지시 *"판단하면 바로 쏴"* 를 바꾸지 않는다
 */

process.env.ANALYST_CHAT_FILE = path.join(os.tmpdir(), `ssdry-chat-${process.pid}.jsonl`);
process.env.ACTIVITY_FILE = path.join(os.tmpdir(), `ssdry-act-${process.pid}.jsonl`);
process.env.TELEGRAM_BOT_TOKEN = 'T';
process.env.TELEGRAM_CHAT_ID = '999';
process.env.TELEGRAM_SEND_ENABLED = 'true';

const realFetch = global.fetch;
let sent = [];
let proposed = [];
let replies = [];

/**
 * ⚠️ **스텁은 require 전에 꽂는다** — `const {fn} = require()` 는 값을 캡처하므로
 *    나중에 바꿔도 안 먹는다(이 저장소에서 네 번 밟았다).
 */
function fresh(generate) {
  for (const k of Object.keys(require.cache)) {
    if (/analystService|aiService|telegramService|orderService|activityLog|mcpClient|tossClient|settingsService|stockRating|tickerTapeService/.test(k)) {
      delete require.cache[k];
    }
  }
  const aiPath = require.resolve('../server/aiService');
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: {
      // 🔴 **생성기를 인자로 받는다** — `fresh()` 뒤에 바꿔 끼우면 안 먹는다(캡처된 뒤다).
      //    실제로 이 테스트를 쓰면서 그 함정에 빠졌다: 모델 호출 수가 `0` 으로 나와
      //    "되묻지 않았다" 로 보였는데 사실은 **내 스텁이 안 꽂힌 것**이었다.
      generateStructuredOutput: generate || (async () => replies.shift() ?? replies.at(-1)),
      getAiSettings: () => ({}),
    },
  };
  /** ⚠️ 테이프·토스는 **네트워크를 탄다** — 테스트에서 실제로 부르면 느리고 결과가 흔들린다 */
  const tapePath = require.resolve('../server/tickerTapeService');
  const realTape = require(tapePath);
  require.cache[tapePath] = {
    id: tapePath, filename: tapePath, loaded: true,
    exports: { ...realTape, getTape: async () => ({ items: [], fixed: [], failed: [] }) },
  };
  const tossPath2 = require.resolve('../server/tossClient');
  const realToss2 = require(tossPath2);
  require.cache[tossPath2] = {
    id: tossPath2, filename: tossPath2, loaded: true,
    exports: {
      ...realToss2,
      getCommissions: async () => [],
      getInvestorTrading: async () => [],
      getCandles: async () => ({ rows: [] }),
    },
  };
  const mcpPath = require.resolve('../server/mcpClient');
  const realMcp = require(mcpPath);
  require.cache[mcpPath] = {
    id: mcpPath, filename: mcpPath, loaded: true,
    exports: { ...realMcp, searchMarketNews: async () => ({ ok: false, error: '꺼짐', kind: 'disabled', results: [] }) },
  };
  const ordPath = require.resolve('../server/orderService');
  const realOrd = require(ordPath);
  require.cache[ordPath] = {
    id: ordPath, filename: ordPath, loaded: true,
    exports: {
      ...realOrd,
      /**
       * ⚠️ **계좌 검증이 새로 생겼다**(2026-09-22) — 제안은 이제 현금·판매가능수량을
       *    통과해야 만들어진다. 스텁하지 않으면 토스가 미설정이라 `unknown` 으로 **막히고**,
       *    그러면 이 테스트가 *"기본값인데 제안을 안 만들었다"* 로 보인다.
       *    ★ 실패 메시지가 제품 결함처럼 읽히는 자리라 여기 적어 둔다.
       */
      checkAccountLimits: async () => ({ ok: true, available: '99999' }),
      propose: (o) => { proposed.push(o); return { ok: true, proposal: { id: 'p1', ...o } }; },
    },
  };
  return require('../server/analystService');
}

const DASH = { portfolio: { items: [], summary: null }, momentum: [], warnings: {}, rankings: {} };

const REPORT = (marketView) => ({
  marketView,
  momentumRead: '',
  dataGaps: [],
  positions: [],
  proposals: [{ symbol: 'QLD', side: 'SELL', quantity: 10, price: 91, reason: 'x' }],
});

beforeEach(() => {
  sent = [];
  proposed = [];
  replies = [];
  global.fetch = async (url, init) => {
    /**
     * 🔴 **텔레그램 호출만 센다.** 종전엔 `fetch` 를 **전부** 발송으로 셌는데,
     *    분석이 시세(테이프)를 받기 시작하자 그게 발송으로 잡혀
     *    *"점검인데 사용자 폰으로 갔다"* 라는 **거짓 빨간불**이 났다.
     * ★ 자가 무엇에 민감한지 안 물으면, 제품이 커질 때 자가 먼저 거짓말한다.
     */
    const u = String(url || '');
    if (!/api\.telegram\.org/.test(u)) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    sent.push(JSON.parse(init?.body || '{}'));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
});
afterEach(() => { global.fetch = realFetch; });

test('🔴 `dryRun` 이면 텔레그램도 제안도 **나가지 않는다**', async () => {
  replies = [REPORT('점검용 시황')];
  const analyst = fresh();
  const r = await analyst.analyze(DASH, { dryRun: true });
  await new Promise((x) => setTimeout(x, 30));

  assert.equal(sent.length, 0, '🔴 점검인데 사용자 폰으로 갔다');
  assert.equal(proposed.length, 0, '🔴 점검인데 매매 제안이 만들어졌다 — 승인 버튼이 곧 간다');
  assert.equal(r.marketView, '점검용 시황', '분석 결과 자체는 돌아와야 검증이 된다');
});

/** 🔴 판별력 — 같은 지문이 `dryRun` 없이는 **반드시** 나가야 한다. 안 그러면 위 테스트는 공허하다 */
test('🔴 자기검증: 같은 지문이 기본값에서는 발송된다', async () => {
  replies = [REPORT('평소 시황')];
  const analyst = fresh();
  await analyst.analyze(DASH);
  await new Promise((x) => setTimeout(x, 30));

  assert.equal(sent.length, 1, '🔴 기본값인데 안 보냈다 — "판단하면 바로 쏴" 를 깼다');
  assert.equal(proposed.length, 1, '🔴 기본값인데 제안을 안 만들었다');
});

/**
 * 🔴 **점검이 다음 진짜 발송을 삼키면 안 된다.**
 * `lastSentDigest` 를 점검이 채워 버리면, 사용자는 **점검 때문에** 알림을 못 받는다 —
 * 그 편이 알림이 한 번 더 가는 것보다 나쁘다(조용히 사라지므로 아무도 모른다).
 */
test('🔴 점검 뒤에도 같은 내용의 진짜 발송은 나간다 (digest 를 건드리지 않는다)', async () => {
  const analyst = fresh();
  replies = [REPORT('같은 시황'), REPORT('같은 시황')];

  await analyst.analyze(DASH, { dryRun: true });
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(sent.length, 0);

  await analyst.analyze(DASH);
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(sent.length, 1, '🔴 점검이 다음 진짜 발송을 삼켰다');
});

/**
 * 판단 누락 되묻기 — 보유가 있는데 `positions` 가 비면 **한 번** 다시 묻는다.
 * ⚠️ 보유가 없으면 되묻지 않는다(되물을 대상이 없다).
 */
const HELD = {
  portfolio: {
    items: [
      { symbol: 'QLD', name: 'QLD', quantity: 99, currency: 'USD' },
      { symbol: 'RAM', name: 'RAM', quantity: 442, currency: 'USD' },
    ],
    summary: null,
  },
  momentum: [], warnings: {}, rankings: {},
};

const POS = (symbol) => ({ symbol, stance: 'HOLD', confidence: 'MEDIUM', rationale: 'r', evidence: [], risk: 'k' });

test('🔴 보유가 있는데 판단이 비면 한 번 되묻는다 (라이브: 3회 중 0·1·0건)', async () => {
  // 라이브 실측 모양 — 서술형 한 덩어리만 주고 종목 배열이 없다
  replies = [
    { conclusion: 'QLD는 보유 유지, RAM은 관망이 낫습니다.' },
    { marketView: '재요청 시황', momentumRead: '', dataGaps: [], positions: [POS('QLD'), POS('RAM')], proposals: [] },
  ];
  const analyst = fresh();
  const r = await analyst.analyze(HELD, { dryRun: true });

  assert.equal(r.positions.length, 2, '🔴 되묻지 않았거나 결과를 안 썼다');
  assert.deepEqual(r.positions.map((p) => p.symbol).sort(), ['QLD', 'RAM']);
});

/** 첫 답에 서술형만 와도 **시황은 살린다** — `conclusion` 은 라이브에서 실제로 온 키다 */
test('`conclusion` 만 온 응답도 시황으로 읽는다', async () => {
  replies = [{ conclusion: 'QLD는 보유 유지, RAM은 관망이 낫습니다.' }];
  const analyst = fresh();
  const r = await analyst.analyze(DASH, { dryRun: true });
  assert.match(r.marketView, /QLD는 보유 유지/);
});

/** 🔴 되물어서 **더 나빠지면** 안 쓴다 — 견고성 조치가 회귀를 만들면 안 된다 */
test('🔴 되물은 결과가 더 적으면 첫 답을 지킨다', async () => {
  replies = [
    { marketView: '첫 시황', momentumRead: '', dataGaps: [], positions: [POS('QLD')], proposals: [] },
    { marketView: '', momentumRead: '', dataGaps: [], positions: [], proposals: [] },
  ];
  const analyst = fresh();
  const r = await analyst.analyze(HELD, { dryRun: true });
  assert.equal(r.positions.length, 1, '🔴 빈 재요청으로 덮어썼다');
  assert.equal(r.marketView, '첫 시황');
});

/** ⚠️ **한 번만** 되묻는다 — 무한히 되물으면 분석 한 번이 예산을 다 태운다 */
test('⚠️ 되묻기는 한 번뿐이다 (두 번 다 비어도 3회차는 없다)', async () => {
  let calls = 0;
  const analyst = fresh(async () => {
    calls += 1;
    return { marketView: '비었음', momentumRead: '', dataGaps: [], positions: [], proposals: [] };
  });
  await analyst.analyze(HELD, { dryRun: true });
  assert.equal(calls, 2, `🔴 모델을 ${calls}번 불렀다 — 되묻기가 한 번을 넘었다`);
});

/** 보유가 전부 판단되면 되묻지 않는다 — 멀쩡한 경로에 비용을 더하지 않는다 */
test('판단이 다 있으면 되묻지 않는다', async () => {
  let calls = 0;
  const analyst = fresh(async () => {
    calls += 1;
    return { marketView: 'ok', momentumRead: '', dataGaps: [], positions: [POS('QLD'), POS('RAM')], proposals: [] };
  });
  await analyst.analyze(HELD, { dryRun: true });
  assert.equal(calls, 1, '🔴 다 채워졌는데 또 물었다');
});
