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
 */

/** 기본 문턱 — `이 종목치고` 얼마나 이상해야 부를 것인가 */
const DEFAULT_Z = Number(process.env.ANALYST_MOMENTUM_Z) || 2;
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
 * 돌릴 것인가.
 *
 * @param {object} input
 * @param {number} input.now
 * @param {Array}  input.sessions `[{key,label,state}]` — 지금 장 상태
 * @param {Array}  input.symbols  `[{symbol, dailyChangePct, history}]` 감시 대상의 시세
 * @param {object} input.state    직전 상태(영속화된 것)
 * @param {number} [input.z]      모멘텀 문턱(σ)
 * @returns {{run:boolean, reasons:Array, state:object}}
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

  // ① 장마감 — **상태 전이**일 때만. 닫혀 있는 내내 부르면 안 된다
  for (const s of sessions) {
    const key = String(s?.key || '');
    if (!key) continue;
    const cur = String(s.state || '');
    const was = st.sessions[key];
    st.sessions[key] = cur;
    // 🔴 첫 실행은 기준선일 뿐 "바뀐 것" 이 아니다(alertService.ruleSessions 와 같은 규율)
    if (!was || was === cur) continue;
    if (cur === 'closed') reasons.push({ kind: 'close', key, label: s.label || key });
    /**
     * 🔴 **개장 브리핑** (2026-09-22 사용자 지시 — 하루 6회 정기 브리핑).
     *    `open` 은 **정규장(데이장)** 시작이다. 프리마켓은 `open` 이 아니라 `pre` 라
     *    17:00 KST 프리 시작에는 안 뜬다 — 사용자가 짚은 *"데이장/프리장"* 구분이 이것이다.
     */
    else if (cur === 'open') reasons.push({ kind: 'open', key, label: s.label || key });
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
    if (zv >= z) {
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

  if (!all.length) return { run: false, reasons: [], state: { ...st, pending: [] } };
  /**
   * ⚠️ **`st.lastRunAt` 이 0 이면 falsy 다** — `&& st.lastRunAt` 으로 쓰면 그 회차만 쿨다운이 풀린다.
   *    테스트가 `now: 0` 으로 재다 잡았다. 실제 타임스탬프에서는 **영영 안 드러났을** 자리고,
   *    오늘 하루 종일 본 *"0 을 '없음' 으로 읽는다"* 와 같은 모양이다.
   */
  if (!hasClose && st.lastRunAt != null && since < cooldownMs) {
    // 아직 이르다 — 쌓아 두고 다음에 함께
    return { run: false, reasons: [], deferred: all.length, state: { ...st, pending: all } };
  }
  return { run: true, reasons: all, state: { ...st, pending: [], lastRunAt: now } };
}

/** 사람이 읽는 한 줄 — 활동 기록·로그에 그대로 쓴다 */
/** 브리핑 종류 이름 — 로그·텔레그램·프롬프트가 같은 낱말을 쓰게 한 곳에 둔다 */
const KIND_LABEL = { open: '개장', mid: '장중', close: '마감' };

function describe(reasons) {
  return (reasons || []).map((r) => (KIND_LABEL[r.kind]
    ? `${r.label} ${KIND_LABEL[r.kind]}`
    : `${r.symbol} 모멘텀 ${r.z}σ (${r.changePct > 0 ? '+' : ''}${r.changePct}%)`)).join(' · ');
}

module.exports = { decide, trackUniverse, zScore, stats, describe, KIND_LABEL, DEFAULT_Z, REENTRY_DAYS, CLEAR_RATIO, COOLDOWN_MS };
