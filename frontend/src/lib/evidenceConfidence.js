/**
 * 📊 **근거 충실도 표시 규칙** (2026-10-15 신설 — 사용자 결정 *"전부 같으면 접는다"*)
 *
 * ## 왜 접는가
 *
 * 서버(`analystService.evidenceConfidence`)가 **코드로** 세는 값이다 —
 * *"추세·상대강도·변동성 서술을 채웠는가 + 근거를 몇 개 인용했는가"*.
 * 데이터가 정상이면 전 종목이 **같은 등급**으로 나온다(10-15 소급 채점:
 * 새 코드 7회차 × 7종목 = **42건 전부 HIGH**).
 *
 * ⇒ 이 값은 **종목 간 비교용이 아니라 이상 탐지용**이다. 변별은 캔들 결손·시세
 *   미수신 같은 **데이터 사고가 난 날에만** 일어난다. 그런데 7칸에 `HIGH` 가 늘
 *   같은 값으로 떠 있으면 ①정보량이 0 이고 ②사용자가 **종목 간 비교로 오독**한다.
 *
 * ★ 🔴 **등급 값 자체는 여기서 만들지 않는다.** 서버가 준 것을 읽기만 한다 —
 *   정본은 `evidenceConfidence` 하나다. 여기서 재계산하면 그 순간 정본이 둘이 된다.
 *
 * ## 접는 조건은 셋을 **모두** 만족할 때만이다
 *
 *   ① 등급이 전부 같다
 *   ② 🔴 **결손이 하나도 없다** — *모르는 것*과 *같은 것*은 다르다. 빈 `confidence`
 *      가 섞였는데 "전 종목 충분" 이라 적으면, 못 잰 것이 **통과로 보인다**
 *      (이 저장소가 반복해 적은 *"검사 안 한 것을 통과로 보여주지 않는다"*).
 *   ③ 종목이 **2개 이상**이다 — 1개면 "전부 같다" 가 자명해서 접을 **중복이 없고**,
 *      *"전 종목"* 이라는 말 자체가 거짓에 가깝다. 비교 대상이 없으면 오독 위험도 없다
 *      (종목 상세 화면이 배지를 그대로 보여주는 것과 같은 이유).
 *
 * ## 안 접을 때는 **왜 안 접었는지**를 말한다
 *
 * 그냥 배지만 되돌리면 사용자는 *"오늘은 왜 다르지"* 를 7칸에서 찾아야 한다.
 * ⇒ 낮은 쪽(= `HIGH` 가 아닌 것)과 확인 못 한 것을 **한 줄로 먼저 지목**한다.
 */

/** 서버 enum. ⚠️ 순서가 곧 등급 순위다(낮음 → 높음) */
export const CONF_ORDER = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * 화면 표기. ⚠️ `LOW` 를 *"낮음"* 이 아니라 **"부족"** 으로 적는다 —
 * 이 값은 *"판단에 자신이 없다"* 가 아니라 **"근거 데이터가 덜 들어왔다"** 이고,
 * "낮음" 은 종목의 질이 낮다는 뜻으로 읽힌다(그건 기업 평가 쪽 `확신도` 의 몫이다).
 */
const KO = { LOW: '부족', MEDIUM: '보통', HIGH: '충분' };

/** 사람이 읽는 등급 — 서버가 모르는 값을 주면 **지어내지 않고 원값 그대로** 보여준다 */
export function confidenceWord(grade) {
  const g = String(grade ?? '').trim().toUpperCase();
  return KO[g] || g || '확인 못 함';
}

/**
 * 보유 종목 판단 목록 → 근거 충실도 요약.
 *
 * @param {Array<{symbol?: string, confidence?: string}>} positions
 * @returns {null | {
 *   collapsed: boolean,      // true 면 종목별 배지를 그리지 않는다
 *   grade: string|null,      // 전부 같을 때의 그 등급
 *   lowSymbols: string[],    // HIGH 가 아닌 종목 (눈에 띄게 할 대상)
 *   unknownSymbols: string[],// confidence 가 비었거나 없는 종목
 *   warn: boolean,           // 경고 색을 입힐지
 *   label: string|null,      // 한 줄 요약. null 이면 **줄 자체를 그리지 않는다**
 * }}
 */
export function summarizeEvidenceConfidence(positions) {
  const list = Array.isArray(positions) ? positions : [];
  if (!list.length) return null;

  const rows = list.map((p) => ({
    symbol: String(p?.symbol ?? '').trim() || '—',
    grade: String(p?.confidence ?? '').trim().toUpperCase(),
  }));

  const unknownSymbols = rows.filter((r) => !r.grade).map((r) => r.symbol);
  const graded = rows.filter((r) => r.grade);
  const distinct = [...new Set(graded.map((r) => r.grade))];

  // ① 전부 같다 ② 결손 0 ③ 2종목 이상 — 셋을 다 만족해야 접는다
  if (unknownSymbols.length === 0 && distinct.length === 1 && rows.length >= 2) {
    const grade = distinct[0];
    return {
      collapsed: true,
      grade,
      lowSymbols: [],
      unknownSymbols: [],
      warn: grade !== 'HIGH',
      label: `근거 충실도 — 전 종목 ${confidenceWord(grade)}`,
    };
  }

  /**
   * 안 접는다. 지목 대상 = **`HIGH` 가 아닌 것**.
   * ⚠️ *"가장 낮은 것"* 이 아니라 *"만점이 아닌 것"* 으로 잡는다 — 전부 MEDIUM 인
   *    (그러나 결손이 섞여 안 접힌) 경우에 **아무도 지목되지 않는 구멍**이 생긴다.
   * ⚠️ enum 밖 값은 **순위를 매길 수 없으므로 지목하지 않는다**(추측하지 않는다).
   *    대신 접히지도 않으니 배지로 원값이 그대로 보인다.
   */
  const lowSymbols = graded
    .filter((r) => CONF_ORDER.includes(r.grade) && r.grade !== 'HIGH')
    .map((r) => r.symbol);

  const parts = graded
    .filter((r) => lowSymbols.includes(r.symbol))
    .map((r) => `${r.symbol} ${confidenceWord(r.grade)}`);
  if (unknownSymbols.length) parts.push(`${unknownSymbols.join(' · ')} 확인 못 함`);

  return {
    collapsed: false,
    grade: null,
    lowSymbols,
    unknownSymbols,
    warn: parts.length > 0,
    // 🔴 말할 것이 없으면 **줄을 그리지 않는다** — 빈 요약은 소음이다
    label: parts.length ? `근거 충실도 ⚠ ${parts.join(' · ')}` : null,
  };
}
