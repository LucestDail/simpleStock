/**
 * LLM 사용량·비용 추정 (2026-10-12 신설)
 *
 * ## 🔴 새로 만든 것이 아니라 **이미 모으던 것을 꺼낸 것**이다
 *
 * `settingsService.recordTokenUsage` 가 매 호출마다 `memory.tokenUsageByMonth` 에
 * 월별 토큰을 쌓고 있었다. **그런데 그 숫자를 읽는 화면이 한 곳도 없었다** —
 * 사용자가 *"너 계속 LLM 비용 나가잖아"* 라고 했을 때 화면에서 보여줄 수가 없었다.
 * 이 저장소가 열한 번 밟은 *"수집해 놓고 안 쓰는"* 자리다.
 *
 * ⚠️ **비용은 추정이다.** 게이트웨이도 OpenRouter 도 청구액을 돌려주지 않는다.
 *    단가는 2026-10-06 실측 공시가이고, **모델이 바뀌면 틀린다** — 그래서 응답에
 *    `estimated: true` 와 단가 출처를 함께 싣는다. 숨기면 추정이 사실로 읽힌다.
 */
const { loadStore } = require('./dataStore');
const { getEffectiveAiConfig } = require('./settingsService');

/**
 * 100만 토큰당 USD — 2026-10-06 실측 공시가.
 * ⚠️ 모르는 모델이면 **추정하지 않는다**(0 으로 채우면 "공짜" 로 읽힌다).
 */
const PRICES = {
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'qwen3-max': { in: 0.78, out: 3.9 },
  'sonnet-5': { in: 2.0, out: 10.0 },
  'deepseek-v4-flash': { in: 0.14, out: 0.28 },
};

function priceFor(model) {
  const key = String(model || '').toLowerCase();
  for (const [name, p] of Object.entries(PRICES)) {
    if (key.includes(name)) return { ...p, matched: name };
  }
  return null;
}

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

/** 이번 달 사용량 + 비용 추정. 지난 달도 함께 준다(추세를 보려면 분모가 둘 필요하다) */
function monthly() {
  const store = loadStore();
  const byMonth = store?.memory?.tokenUsageByMonth || {};
  const now = monthKey();
  const prevDate = new Date();
  prevDate.setMonth(prevDate.getMonth() - 1);
  const prev = monthKey(prevDate);

  const model = (() => {
    try { return getEffectiveAiConfig()?.model || null; } catch { return null; }
  })();
  const price = priceFor(model);

  const shape = (key) => {
    const u = byMonth[key];
    if (!u) return { month: key, requestCount: 0, promptTokens: 0, candidatesTokens: 0, totalTokens: 0, costUsd: null };
    const inTok = Number(u.promptTokens) || 0;
    const outTok = Number(u.candidatesTokens) || 0;
    return {
      month: key,
      requestCount: Number(u.requestCount) || 0,
      promptTokens: inTok,
      candidatesTokens: outTok,
      totalTokens: Number(u.totalTokens) || inTok + outTok,
      // 🔴 단가를 모르면 **null** — 0 으로 채우면 "공짜" 로 읽힌다
      costUsd: price ? Math.round(((inTok / 1e6) * price.in + (outTok / 1e6) * price.out) * 10000) / 10000 : null,
    };
  };

  return {
    model,
    estimated: true,
    priceSource: price
      ? `${price.matched} · 입력 $${price.in}/1M · 출력 $${price.out}/1M (2026-10-06 공시가)`
      : null,
    priceNote: price ? null : `단가를 모르는 모델입니다(${model || '모델 미설정'}) — 비용을 추정하지 않습니다.`,
    current: shape(now),
    previous: shape(prev),
  };
}

module.exports = { monthly, priceFor, PRICES };
