/**
 * 정식 종목명 정규화 — **검색 변별력이 0인 낱말만 뺀다** (2026-10-02)
 *
 * ## 왜 필요했나 (실측)
 * 토스 `englishName` 은 법인명과 축약이 섞여 있다. 그대로 검색하면 **같은 운용사의
 * 다른 상품**이 올라온다 — 그리고 그중 일부는 **방향이 반대**다.
 * ```
 * 'PROSHARES TRUST PSHS ULTRA QQQ'  → 5건 중 적중 1 · 오염 4
 *                                     (TQQQ · QID · ProShares UltraPro **Short** QQQ)
 * 'PROSHARES ULTRA QQQ'             → 5건 중 적중 1 · 오염 **0**
 * ```
 * 🔴 **얻는 것은 "적중 상승" 이 아니라 "오염 제거"** 다. QLD·RAM 같은 소형 레버리지 ETF 는
 *    자체 뉴스가 원래 드물어서(1/5) 적중은 안 오른다. 그런데 **반대 방향 상품 기사가
 *    매매 판단 프롬프트에 실리는 것**은 없느니만 못하다.
 *
 * ## ⚠️ 내 첫 규칙이 한 종목을 망가뜨렸다 — 측정이 잡았다
 * 처음엔 `DAILY`·`TARGET` 도 뺐다. 그랬더니
 * `'ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF'`(적중 1) →
 * `'ROUNDHILL T-REX 2X LONG DRAM ETF'`(적중 **0**) 로 **나빠졌다.**
 * 그 둘은 **상품 구조**(일일 리밸런싱·목표)를 나타내는 고유 수식어이지 법인 수식어가 아니다.
 * ⇒ 원칙을 **법인형 + 중복 축약**으로 좁혔다. **한 종목에 맞춘 게 아니라 원칙을 고친 것이다.**
 *
 * ## 🔴 방향·배수는 절대 빼지 않는다
 * `LONG`·`SHORT`·`ULTRA`·`ULTRAPRO`·`2X`·`T-REX` 를 빼면 **반대 상품과 구분이 사라진다.**
 * 그건 오염을 줄이려다 **더 나쁜 오염**을 만드는 것이다.
 *
 * ## 양방향 실측 (`tests/officialName.test.js` 가 잠근다)
 * ```
 * 바뀌어야   PROSHARES TRUST PSHS ULTRA QQQ → PROSHARES ULTRA QQQ   (오염 4→0)
 * 안 바뀌어야 ROUNDHILL T-REX 2X LONG DRAM DAILY TARGET ETF         (건드리면 적중 1→0)
 *            Realty Income                                          (이미 5/5 정확)
 *            PROSHARES ULTRAPRO SHORT QQQ                           (방향이 이름에 있다)
 * ```
 */

/** 검색에서 변별력이 0인 법인·조직 수식어. ⚠️ 상품 구조·방향 낱말은 **여기 넣지 않는다** */
const DROP = new Set([
  'TRUST', 'INC', 'CORP', 'CORPORATION', 'PLC', 'LTD', 'LIMITED', 'LP', 'LLC',
  'COMPANY', 'CO', 'FUND', 'FUNDS', 'INVESTMENTS', 'INVESTMENT', 'THE',
]);

/**
 * 직전 토큰의 **자음 축약**인가 — `PSHS` ⊂ `PROSHARES`.
 * 토스 이름에 `<법인명> <법인명축약>` 이 연달아 오는 모양이 흔하다.
 * ⚠️ 3글자 미만은 보지 않는다 — `S&P` 의 `P` 같은 조각이 걸린다.
 */
function isAbbrevOf(short, long) {
  const a = String(short || '').toUpperCase();
  const b = String(long || '').toUpperCase();
  if (a.length < 3 || a.length >= b.length) return false;
  let i = 0;
  for (const ch of b) if (ch === a[i]) i += 1;
  return i === a.length;
}

function normalizeOfficialName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const out = [];
  for (const tok of raw.split(/\s+/)) {
    const T = tok.toUpperCase().replace(/[.,]+$/, '');
    if (DROP.has(T)) continue;
    if (out.length && isAbbrevOf(T, out[out.length - 1])) continue;
    out.push(tok);
  }
  // ⚠️ 전부 지워졌으면 **원본을 쓴다** — 빈 질의가 나가면 검색이 통째로 무의미해진다
  return out.join(' ') || raw;
}

module.exports = { normalizeOfficialName, isAbbrevOf, DROP };
