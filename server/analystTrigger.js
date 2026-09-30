/**
 * 분석을 **언제** 돌릴지 정한다 (2026-09-21 사용자 지시)
 *
 * 사용자: *"제안이 너무 빈번한데 **모멘텀 발생 시점에만** 제안이 발생해야 해.
 * **장마감 + 모멘텀 발생시점에만** 작동해야 LLM 토큰 비용을 아낄 수 있을 거 같은데."*
 *
 * ## 실측 — 빈도의 범인은 크론이 아니라 **화면 진입**이었다
 *
 * ```
 * 분석 24회 / 2시간 40분   (활동 기록 기준)   · 1회당 LLM 3~4회 · 88초
 * ANALYST_AUTO_CRON        하루 2회 — 문제 아님
 * WorkspaceView 진입 자동실행 ← 대부분이 여기서 나왔다
 * ```
 *
 * ## 🔴 고정 %는 **잘못된 자다** (6개월 실측)
 *
 * | 자 | QLD | RAM | SPY | NVDA |
 * |---|---|---|---|---|
 * | 고정 3% | 6.4 | **15.4** | **0.0** | 4.8 |
 * | **2σ**  | 1.4 | 1.0 | 1.8 | 1.6 |
 *
 * (월 환산 횟수) 고정 %는 종목마다 **30배** 차이가 난다 — 그건 "이상 움직임" 이 아니라
 * **그 종목의 변동성**을 재는 것이다. RAM 은 2배 레버리지라 3% 가 평상시고(61일 중 46일),
 * SPY 는 단 하루도 안 넘는다. **2σ 는 종목이 달라도 월 1~2회로 고르다** —
 * *"이 종목치고 이상한가"* 를 재기 때문이다.
 * ★ *"자를 만들면 자의 판별력을 재라"* 의 이 프로젝트 판본이다.
 *
 * ## 🔴 보유만 보면 **매도 뒤 재진입을 영영 못 본다** (사용자 지적)
 *
 * *"매도한다고 판정한 경우 다음날이나 다음 매수 시점의 부분매수 진입 시점 같은 게
 * 애매할 거 같은데, 보유종목만 판정해버리면."* — 맞다. 팔면 포트폴리오에서 사라지고
 * 그 순간 **감시 대상에서도 빠진다.** 되살 자리를 판단할 기회가 없어진다.
 *
 * ⇒ 감시 대상(universe)을 셋으로 둔다:
 * ```
 * 보유 중            들고 있을 것인가
 * 최근 보유했다 사라짐  **되살 자리인가**(기본 20일 추적)
 * 목표·손절 지정      사용자가 지켜보겠다고 표시한 것
 * ```
 * ⚠️ 관심목록 전체(테마 10개 × 10종목)를 넣지 않는다 — 감시는 싸도 **분석은 비싸다.**
 * ⚠️ 사라진 것을 감지하는 기준은 **보유 목록의 변화**다. 주문 체결 기록이 아니다 —
 *    사용자가 토스 앱에서 직접 팔 수도 있고, 지금 우리 실행 경로는 no-op 이다.
 *
 * ## 이 모듈은 **순수**하다
 *
 * LLM·네트워크·파일을 모르게 짰다. 입력(시세·세션·직전 상태) → 출력(돌릴까·왜·다음 상태).
 * 그래야 *"장마감에 도는가"* 를 **장 마감을 기다리지 않고** 검증할 수 있다.
 * ⚠️ `./time` 의 `kstDay` 는 `Intl` 포맷팅만 하는 순수 함수라 이 규율을 안 어긴다.
 */

const { kstDay } = require('./time');

/** 기본 문턱 — `이 종목치고` 얼마나 이상해야 부를 것인가 */
const DEFAULT_Z = Number(process.env.ANALYST_MOMENTUM_Z) || 2;
/** 모멘텀 최소 절대 등락 % — z 만으로는 초저변동 자산(단기채 등)의 노이즈가 발동한다 */
const MIN_MOVE_PCT = Math.max(0, Number(process.env.ANALYST_MOMENTUM_MIN_PCT ?? 1.5));
/**
 * 🔴 **되돌아오는 기준은 더 낮게 둔다**(히스테리시스).
 * 문턱 하나로 켜고 끄면 z 가 1.99↔2.01 을 오갈 때마다 **매번 새 사건**이 된다 —
 * 오늘 텔레그램에서 겪은 진동과 같은 모양이다.
 */
const CLEAR_RATIO = 0.7;
/** 팔고 나서 며칠이나 되살 자리를 봐 줄 것인가 */
const REENTRY_DAYS = Math.max(1, Number(process.env.ANALYST_REENTRY_DAYS) || 20);
/**
 * 모멘텀을 **모으는 창**. 관심종목까지 감시하면 같은 날 여러 종목이 다른 틱에 걸린다 —
 * 분석 1회가 어차피 전부를 함께 보므로 **묶는 편이 싸고 읽기도 낫다.**
 * ⚠️ 장마감은 이 창을 무시한다(늦으면 의미가 준다).
 */
const COOLDOWN_MS = Math.max(0, Number(process.env.ANALYST_COOLDOWN_MS) ?? 0) || 30 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 표본의 평균·표준편차. ⚠️ 표본이 적으면 **판정하지 않는다**(null) —
 * 3일치로 낸 σ 는 "이 종목치고" 를 말해 주지 못한다.
 */
function stats(changes, min = 10) {
  const xs = (changes || []).map(Number).filter(Number.isFinite);
  if (xs.length < min) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  const sd = Math.sqrt(variance);
  // σ 가 0 이면 나눌 수 없다(가격이 안 움직인 종목)
  return sd > 0 ? { mean, sd, n: xs.length } : null;
}

/**
 * 오늘 움직임이 **이 종목치고** 몇 σ 인가.
 * @returns {number|null} 판정 불가면 null — **0 이 아니다**(0 은 "평범하다" 는 판정이다)
 */
function zScore(dailyChangePct, history) {
  const s = stats(history);
  if (s == null || !Number.isFinite(Number(dailyChangePct))) return null;
  return Math.abs(Number(dailyChangePct) - s.mean) / s.sd;
}

/**
 * 감시 대상을 갱신한다 — 보유가 사라지면 **되살 후보로 남긴다.**
 * @param {object} prev 직전 상태의 `universe`
 * @param {string[]} held 지금 보유 중인 심볼
 * @param {string[]} targeted 목표·손절을 지정한 심볼
 * @param {number} now
 */
function trackUniverse(prev, held, targeted, now, watched = []) {
  const heldSet = new Set((held || []).map((s) => String(s).toUpperCase()));
  const targetSet = new Set((targeted || []).map((s) => String(s).toUpperCase()));
  const next = {};

  for (const sym of heldSet) next[sym] = { role: 'held', since: prev?.[sym]?.since ?? now };

  // 🔴 직전엔 있었는데 지금 없다 = 판 것이다 ⇒ **되살 자리를 봐 줄 대상**으로 남긴다
  for (const [sym, v] of Object.entries(prev || {})) {
    if (heldSet.has(sym)) continue;
    const exitedAt = v.role === 'held' ? now : v.exitedAt;
    /**
     * 기한이 지나면 잊는다 — 영원히 들고 있으면 감시 대상이 계속 자란다.
     * ⚠️ 경계는 **`>=`** 다: `REENTRY_DAYS=20` 이면 **매도 20일째에 빠진다**(21일째가 아니라).
     *    `>` 로 두면 "20일 추적" 이라 적어 놓고 21일을 추적한다 — 문서와 코드가 어긋난다.
     */
    if (exitedAt != null && now - exitedAt >= REENTRY_DAYS * DAY_MS) continue;
    next[sym] = { role: 'reentry', exitedAt: exitedAt ?? now, since: v.since };
  }

  // 사용자가 목표·손절을 찍은 것은 보유가 아니어도 본다
  for (const sym of targetSet) if (!next[sym]) next[sym] = { role: 'targeted', since: now };

  /**
   * 🔴 **한 번도 안 산 종목** (2026-09-21 사용자 지적: *"감시 대상 기준을 내가 한번도 안샀으면
   * 어떻게 하려고?"*). 보유·매도·지정만 보면 **사려고 보고 있는 종목은 영원히 감시 밖**이다 —
   * 정작 진입 시점을 알아야 하는 건 그쪽이다.
   *
   * ⇒ **관심종목(watchlist)** 을 넣는다. 그게 사용자가 *"안 샀지만 보고 있다"* 고 직접 표시한 목록이다.
   * ⚠️ 처음엔 비용 때문에 뺐는데 **두 비용을 뭉뚱그린 판단이었다**:
   *    감시(시세·z 계산)는 싸고 **분석(LLM)만 비싸다.** 실측으로 갈렸다 —
   *    41종목을 다 감시해도 분석은 **월 ~17회**(z=2)다.
   */
  for (const sym of (watched || []).map((x) => String(x).toUpperCase())) {
    if (!next[sym]) next[sym] = { role: 'watch', since: now };
  }

  return next;
}

/**
 * 세션 dedup 표시가 **오늘치인지** 잰다. 판정은 **KST 날짜 하나로만** 한다.
 *
 * 🔴 **2026-09-30: UTC 폴백을 걷어냈다 — 그 폴백이 프리장을 격일로 죽이고 있었다.**
 *
 * 09-28 에 UTC→KST 전환을 하며 *"배포 직후 옛 값이 남아 있는 순간의 중복 발화"* 를 막으려
 * `|| stored === new Date(atMs).toISOString().slice(0,10)` 를 **한 번만 쓸 안전장치**로 뒀다
 * (주석에도 *"영구 호환 코드가 아니다"* 라고 적혀 있었다). 그런데 **KST 00:00~08:59 는 UTC 로
 * 전날**이라, 그 대역 회차에서는 **어제 저장한 KST 날짜 == 오늘 회차의 UTC 날짜**가 되어
 * 폴백이 **항상 매칭**한다 ⇒ *"오늘 이미 보냈다"* 로 오판하고 **조용히 건너뛴다.**
 * ```
 * 09-28 08:00  수정 전 저장 → "2026-09-27"(UTC)
 * 09-29 08:03  stored ≠ UTC"09-28" ≠ KST"09-29" → 발화 ✅  저장 → "2026-09-29"
 * 09-30 08:00  UTC"2026-09-29" == stored        → **건너뜀** 🔴  (라이브 실측과 일치)
 * ```
 * ⇒ **어제 뜨면 오늘 안 뜬다.** 실측 3일이 전부 이 메커니즘으로 설명된다.
 *
 * ★ **고친 사람이 남긴 안전장치가 새 결함이 됐다** — 전환용 임시 코드에 **만료가 없었다.**
 * ⚠️ 제거 전제는 실측으로 확인했다: 라이브 상태 파일의 `lastPreopenDay` 는 KST 형식 하나뿐이고
 *    **옛 UTC 형식 잔재가 없다**(`lastCloseDay` 는 비어 있다). 코드 추론이 아니라 파일을 열어 봤다.
 * ⚠️ 제거의 위험 방향도 안전하다 — 매칭이 깨져도 **한 번 더 도는 것**이고, 제안은 HITL 이라
 *    실주문으로 가지 않는다.
 * ⚠️ **알려진 유계 위험 — 백업 복원**(2026-09-30, pm2 지적): 일일 백업에서 09-28 **이전** 상태
 *    파일을 되돌리면 옛 UTC 형식 값이 **돌아온다**. 그때는 폴백이 없으므로 그날 회차가
 *    **한 번 더 발화**할 수 있다(중복 알림 1회 · HITL 이라 실주문 아님).
 *    ⇒ 막지 않는다. **"모르는 위험" 을 "아는 위험" 으로 바꿔 두는 것**이 목적이다 —
 *      복원한 사람이 중복 알림을 보고 당황하지 않도록.
 * ★ 같은 파일의 `mid` 는 **날짜 문자열이 아니라 `String(reg.start)` epoch 마크**를 써서
 *    이 함정을 처음부터 피했다(*"날짜 문자열보다 안전하다"* 는 그 주석이 답을 적어 두고 있었다).
 */
function sameDayMark(stored, atMs) {
  if (stored == null) return false;
  return stored === kstDay(atMs);
}

/**
 * 돌릴 것인가.
 *
 * @param {object} input
 * @param {number} input.now
 * @param {Array}  input.sessions `[{key,label,state}]` — 지금 장 상태
 * @param {Array}  input.symbols  `[{symbol, dailyChangePct, history}]` 감시 대상의 시세
 * @param {object} input.state    직전 상태(영속화된 것)
 * @param {number} [input.z]      모멘텀 문턱(σ)
 * @returns {{run:boolean, reasons:Array, skipped:Array, state:object}}
 */
function decide({ now: nowIn, sessions = [], symbols = [], state = {}, z = DEFAULT_Z, cooldownMs = COOLDOWN_MS } = {}) {
  /**
   * 🔴 **호출자는 `Date` 를 넘긴다**(`alertService.tick` 의 `const now = new Date()`).
   *    그런데 이 함수는 숫자로 계산한다 ⇒ `lastRunAt: now` 가 **Date 로 저장**되고,
   *    JSON 으로 직렬화되면서 **ISO 문자열**이 된다. 다음 회차에
   *    `now - "2026-09-22T03:24:15.088Z"` = **NaN** ⇒ `NaN < cooldownMs` 가 **false** 라
   *    **쿨다운이 통째로 무효**였고, `pending` 이월 경로는 **죽은 코드**였다.
   *
   * ★ **내 테스트는 `now` 에 숫자를 넘겨서 이걸 못 봤다** — 자가 *실제 호출 모양*을 안 쟀다.
   *   순수 함수라 믿고 편한 타입으로 불렀고, 그게 프로덕션과 달랐다.
   *   2026-09-22 서비스 모니터링에서 `경과: NaN분` 을 보고 잡았다.
   * ⚠️ 상태에 남는 값도 **숫자로 못박는다** — 안 그러면 같은 일이 다시 난다.
   */
  const now = nowIn instanceof Date ? nowIn.getTime() : Number(nowIn);
  const st = { ...(state || {}) };
  // 옛 회차가 남긴 문자열/Date 를 숫자로 되돌린다(재기동해도 쿨다운이 살아나게)
  if (st.lastRunAt != null && typeof st.lastRunAt !== 'number') {
    const parsed = Date.parse(st.lastRunAt);
    st.lastRunAt = Number.isFinite(parsed) ? parsed : null;
  }
  st.sessions = { ...(st.sessions || {}) };
  st.momentum = { ...(st.momentum || {}) };
  const reasons = [];
  /**
   * 🔴 **건너뛴 이유를 담는다** (2026-09-30) — 이 함수는 순수라 로거를 안 쓴다.
   *    호출자가 **하루 1회만** 로그한다. 09-30 프리장 미발화를 로그로 못 찾은 것이 계기다.
   */
  const skipped = [];

  // ① 장마감 — **상태 전이**일 때만. 닫혀 있는 내내 부르면 안 된다
  for (const s of sessions) {
    const key = String(s?.key || '');
    if (!key) continue;
    const cur = String(s.state || '');
    const was = st.sessions[key];
    st.sessions[key] = cur;
    /**
     * 🔴 마감은 **놓쳐도 보낸다** (2026-09-25 — 실측: 09-24 15:30 KRX 마감이 배포 재기동에
     *    삼켜져 트리거 0건, 마감 브리핑이 통째로 소실됐다. 전이 감지는 재기동을 못 넘는다).
     *    중간(mid)과 다르다 — "장 끝난 뒤 중간보고" 는 거짓이지만 **마감 요약은 사후에도 유효**하다.
     *    같은 날 중복은 ①여기 lastCloseDay ②발송단 briefKey 지문, 두 겹이 막는다.
     */
    st.lastCloseDay = { ...(st.lastCloseDay || {}) };
    const regEnd = Number(s?.regular?.end);
    if (cur === 'closed' && Number.isFinite(regEnd) && now >= regEnd) {
      // 🔴 **KST 날짜다 — UTC 가 아니다** (2026-09-28). `sameDayMark` 가 옛 UTC 형식 저장값도
      //    함께 인정해 배포 직후 한 번은 중복 발화하지 않는다(파일 머리 주석 참조).
      if (!sameDayMark(st.lastCloseDay[key], regEnd)) {
        st.lastCloseDay[key] = kstDay(regEnd);
        reasons.push({ kind: 'close', key, label: s.label || key });
        st.sessions[key] = cur;
        continue; // 전이 검사와 중복 발화 방지
      }
    }
    // 🔴 첫 실행은 기준선일 뿐 "바뀐 것" 이 아니다(alertService.ruleSessions 와 같은 규율)
    if (!was || was === cur) continue;
    if (cur === 'closed') {
      // 전이 close — 위 캘린더 경로가 이미 오늘치를 보냈으면 중복 금지(KST 날짜, sameDayMark 참조)
      if (Number.isFinite(regEnd) && sameDayMark(st.lastCloseDay[key], regEnd)) continue;
      if (Number.isFinite(regEnd)) st.lastCloseDay[key] = kstDay(regEnd);
      reasons.push({ kind: 'close', key, label: s.label || key });
    }
    /**
     * 🔴 **개장 브리핑** (2026-09-22 사용자 지시 — 하루 6회 정기 브리핑).
     *    `open` 은 **정규장(데이장)** 시작이다. 프리마켓은 `open` 이 아니라 `pre` 라
     *    17:00 KST 프리 시작에는 안 뜬다 — 사용자가 짚은 *"데이장/프리장"* 구분이 이것이다.
     */
    else if (cur === 'open') reasons.push({ kind: 'open', key, label: s.label || key });
  }

  /**
   * 🔴 **프리장 개장 브리핑** (2026-09-27 사용자 지시 — 월요일 실전).
   *
   * 정규장 개장(09:00 KST) 전, 프리마켓 창(KR 08:00~09:00)에 들어서면 하루 한 번.
   * 밤사이 미국장 결과를 국내장이 열리기 전에 받기 위함이다(지금은 정규장 개장부터라
   * 못 받는다).
   *
   * ⚠️ **KR 만** — 사용자가 "한국장 프리장" 만 요청했다. US 프리(17:00 KST)까지 켜면
   *    LLM 회차가 하루 1번 더 는다(비용은 사용자 관심사). **US 도 켜려면** 아래
   *    `key !== 'kr'` 조건만 지우면 된다 — `preSpan` 은 이미 양쪽 시장에 실려 오므로
   *    나머지 로직은 그대로 동작한다.
   * ⚠️ **재기동으로 놓쳐도 보낸다**(마감과 같은 취급, `mid` 과 같은 패턴 — 전이가 아니라
   *    "오늘 이 창에 들어섰는가+ 아직 안 보냈는가" 로만 판정한다). 08:00~09:00 사이에
   *    재시작돼도 프리장 브리핑은 살아야 한다. 정규장이 시작되면(`now >= reg.start`)
   *    더 이상 "프리장" 이 아니므로 보내지 않는다.
   */
  st.lastPreopenDay = { ...(st.lastPreopenDay || {}) };
  for (const s of sessions) {
    const key = String(s?.key || '');
    if (key !== 'kr') continue; // ⚠️ KR 만 — 위 주석 참조
    const pre = s?.preSpan;
    const reg = s?.regular;
    /**
     * 🔴 **탈락 사유를 밖으로 내보낸다** (2026-09-30).
     *
     * 09-30 08:00 프리장이 안 떴는데 **로그에 아무 흔적이 없어** 원인을 손계산으로 찾아야 했다
     * (`sameDayMark` 의 UTC 폴백이 범인이었다). 이 블록의 `continue` 는 전부 **조용했다.**
     * ⚠️ 이 파일은 **순수 함수**라 로거를 들이지 않는다 — `skipped` 에 실어 보내고
     *    **호출자(`alertService.tick`)가 하루 1회만** 로그한다(매 tick 짖으면 소음이고,
     *    소음이 되면 침묵과 같아진다).
     * ⚠️ `now < pre.start`(아직 창 전)는 **정상**이라 싣지 않는다 — 실으면 매일 새벽 내내
     *    "건너뜀" 이 쌓여 진짜 신호가 묻힌다.
     */
    if (!pre || !Number.isFinite(pre.start) || !reg || !Number.isFinite(reg.start)) {
      skipped.push({ kind: 'preopen', key, why: 'no_span', hasPre: Boolean(pre), hasReg: Boolean(reg) });
      continue;
    }
    // 🔴 KST 날짜다 — UTC 가 아니다(2026-09-28 라이브 실측). ⚠️09-30: UTC 폴백 제거됨(sameDayMark 주석)
    /**
     * ⚠️ **여기는 일부러 싣지 않는다** (2026-09-30, pm2 반박으로 되돌린 자리).
     *
     * 처음엔 `why:'already_sent'` 를 실었는데 **그건 정상 동작이다** — 프리장이 정상 발화하면
     * `stored` 가 오늘로 찍히고, 그 뒤 모든 틱이 이 분기로 온다 ⇒ **매일 warn 1건**이 쌓여
     * `warn 0` 기준선이 무너진다. 내가 바로 아래 *"소음이 되면 침묵과 같아진다"* 라고
     * 적어 놓고 소음을 만들었다.
     *
     * 🔴 그리고 *"`stored` 가 오늘이 아닐 때만 싣자"* 는 **죽은 가드**였다(pm2가 잡았다):
     *    폴백을 지운 뒤 `sameDayMark` ≡ `stored === kstDay(atMs)` 이므로 **이 분기 안에서는
     *    정의상 `stored === 오늘`** 이다 — 그 조건은 **절대 참이 될 수 없다.**
     *    로그가 0 인 것을 *"이상 없음"* 으로 읽게 만드는, **없는 안전망을 있다고 적는** 실패다.
     *
     * ★ 재발(누가 UTC 폴백을 되살리는 것)은 **런타임이 아니라 소스에서** 일어나고,
     *   그 층의 탐지기는 이미 있다 — `tests/preopenDayBoundary.test.js`(변이 검증까지 했다).
     *   **"구조적으로 불가능하게 만들었다" 와 "런타임에 재발을 탐지한다" 는 동시에 못 가진다.**
     * ⚠️ 다음 사람이 *"탈락 사유를 안 남기네"* 하며 친절하게 되넣지 않도록 이 주석을 남긴다.
     */
    if (sameDayMark(st.lastPreopenDay[key], pre.start)) continue;
    if (now < pre.start) continue; // 아직 창 전 — 정상이라 싣지 않는다
    if (now >= reg.start) { // 정규장이 이미 시작됐다 — 더는 "프리장" 이 아니다(재기동이 늦었다)
      skipped.push({ kind: 'preopen', key, why: 'regular_started' });
      continue;
    }
    st.lastPreopenDay[key] = kstDay(pre.start);
    reasons.push({ kind: 'preopen', key, label: s.label || key });
  }

  /**
   * 🔴 **중간 브리핑** — 정규장 **중간 지점**에서 하루 한 번.
   *
   * ⚠️ 고정 시각을 쓰지 않는다. `regular{start,end}` 에서 유도하므로
   *    **서머타임·조기폐장·공휴일이 자동으로 따라온다**(오늘 `ss-obs` 05:10 이 겨울에 어긋나던 그 함정의 반대편).
   * ⚠️ **장이 끝난 뒤에는 안 보낸다** — 재기동이 늦어 중간 지점을 지나쳐 버렸으면
   *    "중간 보고" 가 장 끝난 뒤 나가는 꼴이 된다. 그럴 땐 **표시만 남기고 건너뛴다**(다음 날 정상 동작).
   */
  st.mid = { ...(st.mid || {}) };
  for (const s of sessions) {
    const key = String(s?.key || '');
    const reg = s?.regular;
    if (!key || !reg || !Number.isFinite(reg.start) || !Number.isFinite(reg.end)) continue;
    const midAt = reg.start + (reg.end - reg.start) / 2;
    const mark = String(reg.start); // 세션마다 고유 — 날짜 문자열보다 안전하다(자정을 넘는 장)
    if (st.mid[key] === mark) continue;
    if (now < midAt) continue;
    st.mid[key] = mark;
    if (now >= reg.end) continue; // 지나쳐 버렸다 — 표시만 남기고 보내지 않는다
    reasons.push({ kind: 'mid', key, label: s.label || key });
  }

  // ② 모멘텀 — **통과하는 순간** 한 번. 넘어 있는 내내가 아니다
  for (const row of symbols) {
    const sym = String(row?.symbol || '').toUpperCase();
    if (!sym) continue;
    const zv = zScore(row.dailyChangePct, row.history);
    const mark = st.momentum[sym];
    if (zv == null) {
      // ⚠️ **판정 불가를 "평범함" 으로 읽지 않는다** — 표시를 지우면 다음에 새 사건이 된다
      continue;
    }
    /**
     * 🔴 절대 변화 하한 (2026-09-27 실전 실증) — SGOV(초단기채, 변동성 ~0.02%)가 **-0.23% 로
     *    3.68σ** 를 넘어 분석을 깨웠다. 초저변동 자산은 티끌도 통계적 이상치다 —
     *    z(그 종목답지 않음) AND 절대 크기(경제적 유의미)를 함께 요구한다.
     */
    if (zv >= z && Math.abs(Number(row.dailyChangePct)) >= MIN_MOVE_PCT) {
      if (!mark) {
        st.momentum[sym] = { at: now, z: Number(zv.toFixed(2)) };
        reasons.push({
          kind: 'momentum', symbol: sym, z: Number(zv.toFixed(2)),
          changePct: Number(row.dailyChangePct), role: row.role || 'held',
        });
      }
    } else if (mark && zv < z * CLEAR_RATIO) {
      // 충분히 내려왔으면 표시를 지운다 — 다음 돌파는 **새 사건**이다
      delete st.momentum[sym];
    }
  }

  // 감시 대상에서 빠진 종목의 표시는 정리한다(상태가 무한히 자라지 않게)
  const alive = new Set(symbols.map((r) => String(r?.symbol || '').toUpperCase()));
  for (const sym of Object.keys(st.momentum)) if (!alive.has(sym)) delete st.momentum[sym];

  /**
   * 🔴 **모아서 한 번에 돌린다** — 관심종목까지 보면 같은 날 여러 종목이 **다른 틱**에 걸린다.
   *    그때마다 분석을 돌리면 하루에 몇 번씩 도는데, 분석 1회는 어차피 **전부를 함께 본다.**
   * ⚠️ 표시(mark)는 이미 찍혔으니 **미룬 이유를 버리면 영영 못 본다** ⇒ 상태에 쌓아 두고
   *    쿨다운이 끝나면 **함께** 넘긴다. *"버려지는 경로는 반드시 남긴다"* 의 이 모듈 판본이다.
   * ⚠️ 장마감은 미루지 않는다 — 마감 요약은 늦으면 의미가 준다.
   */
  const pending = Array.isArray(st.pending) ? st.pending : [];
  const all = [...pending, ...reasons];
  const hasClose = all.some((r) => r.kind === 'close');
  const since = now - (st.lastRunAt || 0);

  if (!all.length) return { run: false, reasons: [], skipped, state: { ...st, pending: [] } };
  /**
   * ⚠️ **`st.lastRunAt` 이 0 이면 falsy 다** — `&& st.lastRunAt` 으로 쓰면 그 회차만 쿨다운이 풀린다.
   *    테스트가 `now: 0` 으로 재다 잡았다. 실제 타임스탬프에서는 **영영 안 드러났을** 자리고,
   *    오늘 하루 종일 본 *"0 을 '없음' 으로 읽는다"* 와 같은 모양이다.
   */
  if (!hasClose && st.lastRunAt != null && since < cooldownMs) {
    // 아직 이르다 — 쌓아 두고 다음에 함께
    return { run: false, reasons: [], skipped, deferred: all.length, state: { ...st, pending: all } };
  }
  return { run: true, reasons: all, skipped, state: { ...st, pending: [], lastRunAt: now } };
}

/** 사람이 읽는 한 줄 — 활동 기록·로그에 그대로 쓴다 */
/** 브리핑 종류 이름 — 로그·텔레그램·프롬프트가 같은 낱말을 쓰게 한 곳에 둔다 */
const KIND_LABEL = { preopen: '프리장 개장', open: '개장', mid: '장중', close: '마감' };

function describe(reasons) {
  return (reasons || []).map((r) => (KIND_LABEL[r.kind]
    ? `${r.label} ${KIND_LABEL[r.kind]}`
    : `${r.symbol} 모멘텀 ${r.z}σ (${r.changePct > 0 ? '+' : ''}${r.changePct}%)`)).join(' · ');
}

module.exports = { decide, trackUniverse, zScore, stats, describe, KIND_LABEL, DEFAULT_Z, REENTRY_DAYS, CLEAR_RATIO, COOLDOWN_MS };
