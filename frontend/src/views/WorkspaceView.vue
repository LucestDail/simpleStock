<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import PriceChart from '../components/PriceChart.vue';
import PipelineStrip from '../components/PipelineStrip.vue';
import NewsPanel from '../components/NewsPanel.vue';
import RankingsPanel from '../components/RankingsPanel.vue';
import { useTheme } from '../composables/useTheme';
import { useWatchlist } from '../composables/useWatchlist';
import { useUi } from '../composables/useUi';
import { formatMarketClock } from '../lib/marketClock';
import { heatmapStyleFromChangePct, formatChangePct } from '../lib/heatmapColor';
import { readSse } from '../lib/sse';
import { apiFetch, apiStreamUrl, readApiError } from '../lib/apiClient';

const {
  groups,
  fx,
  sessions,
  loading,
  error,
  load,
  createGroup,
  renameGroup,
  deleteGroup,
  removeTicker,
  applyState,
} = useWatchlist();
const { notify, confirmAction } = useUi();

const { theme, toggle: toggleTheme } = useTheme();
const clock = ref(formatMarketClock());
const newGroupName = ref('');
const tickerInputs = ref({}); // groupId -> { query, market }
const busy = ref(false);


let clockTimer = null;
/** 🔴 `n초 전` 이 멈춰 있으면 그것도 거짓이다 — 1초마다 올린다 */
let freshTimer = null;
let regimeTimer = null;
let pollTimer = null;
let reportTimer = null;
let es = null;


function sessionLabel(state) {
  if (state === 'open' || state === 'active' || state === 'regular') return '개장';
  if (state === 'pre' || state === 'premarket') return '장전';
  if (state === 'post' || state === 'postmarket') return '장후';
  return '휴장';
}

function formatPrice(ticker) {
  const q = ticker.quote;
  if (!q || q.price == null) return '시세 대기';
  const cur = q.currency || ticker.currency;
  // ⚠️ maximumFractionDigits 만 주면 $176.2 처럼 자릿수가 들쭉날쭉해 세로로 안 맞는다.
  //    금액은 **줄이 맞아야** 비교가 된다 — minimum 을 함께 준다.
  if (cur === 'USD')
    return `$${Number(q.price).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  if (cur === 'KRW') return `₩${Number(q.price).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}`;
  return `${Number(q.price).toLocaleString()} ${cur || ''}`.trim();
}

function marketBadge(ticker) {
  const m = String(ticker.market || '').toUpperCase();
  if (m === 'US') return '🇺🇸 US';
  if (m === 'ETF') return '📊 ETF';
  return '🇰🇷 KR';
}



async function onRenameGroup(group) {
  const next = window.prompt('그룹 이름 변경', group.name);
  if (next == null) return;
  const name = next.trim();
  if (!name || name === group.name) return;
  try {
    await renameGroup(group.id, name);
    notify({ message: '그룹 이름을 변경했습니다.', tone: 'success' });
  } catch (e) {
    notify({ message: e.message || '이름 변경 실패', tone: 'error' });
  }
}

async function onDeleteGroup(group) {
  const ok = await confirmAction({
    title: '그룹 삭제',
    message: `'${group.name}' 그룹과 포함된 ${group.tickers?.length || 0}개 종목을 삭제할까요?`,
    confirmLabel: '삭제',
    tone: 'danger',
  });
  if (!ok) return;
  try {
    await deleteGroup(group.id);
    notify({ message: '그룹을 삭제했습니다.', tone: 'success' });
  } catch (e) {
    notify({ message: e.message || '그룹 삭제 실패', tone: 'error' });
  }
}




/**
 * 대시보드 (2026-09-21) — 화면이 필요한 것을 `/api/dashboard` 한 번으로 받는다.
 * 조각마다 요청하면 토스 한도를 태운다.
 * ⚠️ 조각별 성패(`parts`)를 그대로 받아 **"없음" 과 "못 받음" 을 구분해 보여준다.**
 */
const report = ref(null);
/**
 * 🔭 제안 성과 (2026-10-03 — 자율 트레이딩 재개편).
 *    자율의 전제 = 승인율이 **보이고 올라가는 것**. 생애 제안의 71% 가 거절인 상태에서
 *    자율은 성립하지 않는다 — 그 수치를 사용자와 에이전트가 **같이 본다.**
 */
const orderStats = ref(null);
/** 거절률 — 분모는 **결정이 난 것**(승인+거절)만. PENDING 을 분모에 넣으면 비율이 왜곡된다 */
const rejectRate = computed(() => {
  const st = orderStats.value; if (!st) return 0;
  const decided = (st.approved || 0) + (st.executed || 0) + (st.rejected || 0);
  return decided ? Math.round((st.rejected / decided) * 100) : 0;
});
async function loadOrderStats() {
  try {
    const res = await apiFetch('/api/orders/stats');
    const b = await res.json();
    orderStats.value = b?.ok ? b : null;   // ⚠️ 못 읽었으면 null — 0 으로 그리면 "제안이 없었다" 가 된다
  } catch { orderStats.value = null; }
}
const proposals = ref([]);

/** 'live' | 'dry-run' — 서버가 말하는 **실제** 모드. 화면이 지어내지 않는다 */
const ordersMode = ref('dry-run');
/**
 * 🔴 사용자: *"내부 분석시 **분석 상태 표시**"*
 *    분석은 20~30초 걸린다(도구·LLM). 버튼만 "분석 중…" 이면 멈춘 것처럼 보인다.
 *    ⚠️ 서버가 단계를 스트리밍하지 않으므로 **여기서 예상 단계를 돌린다** —
 *       그래서 진짜 진행률이 아니라 **무엇을 하는 중인지**만 알린다(척하지 않는다).
 */

/**
 * 활동 타임라인 (2026-09-21 사용자: *"자동 텔레그램 알림과 애널리스트의 모든 분석 기록들이
 * **시간순**으로 나와야 하는데"*).
 * ⚠️ 종전에는 분석 결과가 **화면 메모리에만** 있어 새로고침하면 사라졌고,
 *    알림은 로그 파일에만 있어 사람이 못 봤다. 서버가 한 시간축으로 모은다.
 */
const activity = ref([]);
let activityTimer = null;

/**
 * 🔴 사용자: *"화면 진입하면 내 종목 첫번째 클릭해."*
 * ⚠️ **사용자가 이미 고른 게 있으면 덮지 않는다** — 자동 선택이 사람의 선택을 이기면 안 된다.
 *    (보유를 늦게 받아 오므로 그 사이에 사용자가 다른 종목을 눌렀을 수 있다.)
 */
function autoPickFirstHolding() {
  if (selected.value.symbol) return;
  const first = portfolio.value?.items?.[0];
  if (first?.symbol) pickSymbol(first.symbol, first.name);
}

async function loadActivity() {
  try {
    const res = await apiFetch('/api/activity?limit=60');
    if (res.ok) activity.value = (await res.json()).items || [];
  } catch { /* 타임라인이 없어도 화면은 돈다 */ }
}

const ACT_ICON = { analysis: '🧭', alert: '📈', proposal: '🟡', approval: '✅', rejection: '✖️', order: '📦' };
function actTime(at) {
  // "10. 2. 오전 06:33" 이 좁은 열에서 두 줄로 꺾였다(2026-10-04 실화면) — 압축 24h
  try {
    const d = new Date(at); const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return at; }
}

const analystError = ref('');
/**
 * my-computer MCP 웹검색 연계 상태.
 * 🔴 **"안 붙었다" 와 "붙었는데 결과가 없다" 는 다르다** — 상태를 보여주지 않으면
 *    둘 다 "뉴스 없음" 으로 똑같이 보인다(오늘 하루 종일 본 그 실패 모드).
 */
/**
 * 헤더 시세 테이프 (2026-09-21 사용자 지시).
 * ⚠️ 60초마다만 받는다 — 서버가 무인증 Yahoo 를 29회 치므로 아껴 쓴다.
 */
const tape = ref({ items: [], failed: 0, stale: false });
let tapeTimer = null;

async function loadTape() {
  try {
    const res = await apiFetch('/api/tape');
    if (res.ok) tape.value = await res.json();
  } catch { /* 테이프가 없어도 화면은 돈다 */ }
}

function tapeNum(i) {
  const n = Number(i.price);
  if (!Number.isFinite(n)) return '-';
  const body = n.toLocaleString('ko-KR', { minimumFractionDigits: i.digits, maximumFractionDigits: i.digits });
  return `${i.prefix || ''}${body}${i.suffix || ''}`;
}

const mcpState = ref(null);

/**
 * 애널리스트 채팅 (2026-09-21 레이아웃 지시: 본문 우열).
 *
 * 🔴 사용자: *"스트리밍 형태로 출력되어야 함. **REST 형태로 안 나오게 주의**"*
 *    ⇒ 조각이 오는 즉시 마지막 말풍선에 이어붙인다. 다 받고 한 번에 넣지 않는다.
 * 🔴 `thinking_delta`·`tool_call`·`tool_result` 를 **따로** 보여준다 —
 *    사고 과정과 답이 섞이면 무엇이 근거인지 알 수 없다.
 */

/**
 * 선택한 종목 뉴스(레이아웃 지시: 본문 좌열 상단).
 * ⚠️ 종목을 바꿀 때마다 부른다 — **자동 새로고침 타이머에는 안 붙인다**(밖으로 나가는 호출이다).
 */

async function loadMcpStatus() {
  try {
    const res = await apiFetch('/api/mcp/status');
    if (res.ok) mcpState.value = await res.json();
  } catch {
    mcpState.value = null;
  }
}

/** 시황 → 모멘텀 → 매매 제안. 🔴 제안은 **승인해야** 진행된다 */
/** 마지막 분석을 불러온다 — **실행하지 않는다**(LLM 비용 0) */
/**
 * 🔴 감시 표시 토글 — **이것만** 모멘텀 분석을 부른다.
 * ⚠️ 실패를 조용히 넘기지 않는다 — 별이 켜진 줄 알았는데 안 켜졌으면 알림이 안 온다.
 */

async function loadLastReport() {
  try {
    const res = await apiFetch('/api/analyst/last');
    if (!res.ok) return;
    const body = await res.json();
    if (body?.report) report.value = body.report;
  } catch {
    // ⚠️ 못 불러와도 화면은 뜬다 — "아직 분석 전" 안내가 그 자리를 채운다
  }
}


/** 시장 국면(코드 판정) — 데몬이 5분마다 갱신한다. 화면은 읽기만 */
const regime = ref(null);
const regimeScenarios = ref([]);
const TREND_KO = { up: '상승', side: '횡보', down: '하락' };
const regimeLabel = computed(() => {
  const s = regime.value;
  if (!s) return '';
  const parts = [];
  if (s.us?.trend) parts.push(`US ${TREND_KO[s.us.trend]}`);
  if (s.kr?.trend) parts.push(`KR ${TREND_KO[s.kr.trend]}`);
  if (s.vix?.value != null) parts.push(`VIX ${s.vix.value}`);
  if (s.kr?.shock || s.us?.shock) parts.push('🔴급락');
  return parts.join(' · ') || '판정 대기';
});

async function loadRegime() {
  try {
    const res = await apiFetch('/api/regime');
    if (res.ok) {
      const body = await res.json();
      regime.value = body.state;
      regimeScenarios.value = body.scenarios || [];
    }
  } catch { /* 국면 칩은 곁가지 — 실패해도 화면은 산다 */ }
}

/** 거래소에 걸린 예약(조건부) 주문 — 제안과 별개로, **이미 등록돼 감시 중**인 것들 */
const conditionalOrders = ref([]);
const conditionalError = ref('');

async function loadConditionals() {
  try {
    const res = await apiFetch('/api/orders/conditional');
    if (res.ok) {
      const body = await res.json();
      conditionalOrders.value = body.items || [];
      conditionalError.value = '';
    } else {
      const body = await res.json().catch(() => ({}));
      // ⚠️ 실패를 빈 목록으로 그리지 않는다 — "예약 없음" 과 "못 읽음" 은 다르다
      conditionalError.value = body.error || `조회 실패(${res.status})`;
    }
  } catch (e) {
    conditionalError.value = e?.message || '조회 실패';
  }
}


async function loadProposals() {
  try {
    const res = await apiFetch('/api/orders/proposals');
    if (res.ok) {
      const body = await res.json();
      proposals.value = body.proposals || [];
      /**
       * 🔴 **실거래인지 화면이 알아야 한다** (2026-09-22).
       *    종전 버튼 이름이 `실행(모의)` 로 **박혀** 있었다 — 스위치를 켜는 순간
       *    그 이름이 **거짓**이 되고, 사용자는 *"모의니까"* 하고 누른다.
       *    ★ 오늘 밤 세 번 본 *"이름이 사실과 다른 것"* 의 가장 비싼 판본이 될 뻔했다.
       */
      ordersMode.value = body.status?.effective || 'dry-run';
    }
  } catch {
    // 조용히 넘기지 않는다 — 실패하면 목록이 비는데, 그건 "제안 없음" 과 다르다
    analystError.value = '제안 목록을 불러오지 못했습니다.';
  }
}

const STATUS_LABEL = {
  PENDING: '승인 대기', APPROVED: '승인됨', REJECTED: '거절',
  DRY_RUN: '모의 실행됨', EXPIRED: '만료', BLOCKED: '차단',
};
function statusLabel(p) {
  return p.expired && p.status === 'PENDING' ? '만료' : STATUS_LABEL[p.status] || p.status;
}


const dash = ref(null);
const dashError = ref('');
const selected = ref({ symbol: '', name: '' });
let dashTimer = null;

async function loadDashboard() {
  try {
    const res = await apiFetch('/api/dashboard');
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      dash.value = null;
      dashError.value = b.error || `대시보드를 불러오지 못했습니다 (${res.status})`;
      return;
    }
    dash.value = await res.json();
    dashError.value = '';
    // 아직 고른 종목이 없으면 보유 첫 종목을 기본으로
    if (!selected.value.symbol) {
      const first = dash.value?.portfolio?.items?.[0];
      if (first) selected.value = { symbol: first.symbol, name: first.name };
    }
  } catch (e) {
    dash.value = null;
    dashError.value = e.message || '대시보드 오류';
  }
}

function pickSymbol(symbol, name) {
  selected.value = { symbol, name: name || symbol };
  // 종목을 고르면 뉴스 패널의 watch 가 따라간다 (NewsPanel 로 분해 — 2026-10-04)
}


/**
 * 랭킹 탭. 🔴 **키가 사라져도 빈 화면이 되지 않게** 현재 탭을 항상 유효한 값으로 맞춘다
 *    (설정에서 국가·종류를 빼면 고르던 탭이 없어진다).
 */
/**
 * 관심 테마 페이징 (2026-09-21 사용자 지시).
 * ⚠️ 한 쪽에 몇 개를 넣을지는 **열 폭에 달렸다** — 상수로 박으면 좁은 화면에서 잘린다.
 *    지금 열이 좁으므로(전체의 15%) 한 쪽에 하나가 맞다. 넓어지면 여기만 고친다.
 */
const GROUPS_PER_PAGE = 1;
const groupPage = ref(0);
const groupPages = computed(() => Math.max(1, Math.ceil(groups.value.length / GROUPS_PER_PAGE)));
const pagedGroups = computed(() =>
  groups.value.slice(groupPage.value * GROUPS_PER_PAGE, (groupPage.value + 1) * GROUPS_PER_PAGE)
);
// 🔴 테마를 지우면 현재 쪽이 범위를 벗어난다 — 그러면 **빈 화면**이 된다
watch(groupPages, (n) => { if (groupPage.value >= n) groupPage.value = Math.max(0, n - 1); });






function partError(name) {
  const p = dash.value?.parts?.[name];
  return p && p.ok === false ? p : null;
}

function restartDashTimer() {
  if (dashTimer) clearInterval(dashTimer);
  const sec = Number(dash.value?.settings?.refreshSec) || 60;
  dashTimer = setInterval(loadDashboard, Math.max(15, sec) * 1000);
}

/**
 * 현금(매수 가능) 표시. 🔴 **`null` 은 0 이 아니라 "못 받았다"** — 빈칸이면 사용자가 0 으로 읽으므로
 * "확인 못 함" 을 글자로 쓴다(서버 프롬프트와 같은 규율).
 */
function cashCell(cash) {
  if (!cash) return '확인 못 함';
  const part = (v, unit) => (v == null ? null : (unit === '₩'
    ? `₩${Number(v.amount ?? v.raw ?? 0).toLocaleString('ko-KR')}`
    : `$${Number(v.amount ?? v.raw ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`));
  const parts = [part(cash.krw, '₩'), part(cash.usd, '$')].filter(Boolean);
  const failed = (cash.failed || []).length ? ` (${cash.failed.join('·')} 확인 못 함)` : '';
  return (parts.join(' · ') || '확인 못 함') + failed;
}

const portfolio = ref(null);
const portfolioError = ref('');
const portfolioLoading = ref(false);

/**
 * 🔴 **레버리지 노출 등급** (2026-10-02). 숫자만 주면 사용자가 "90.7% 가 높은 건가" 를
 *    매번 판단해야 한다. 와이어프레임이 `[%] 높음` 으로 **등급까지** 보여주는 이유다.
 * ⚠️ 경계는 국면 매뉴얼(`leverage_concentration`: leveragePct >= 50)과 **같은 수**로 맞춘다 —
 *    화면이 "보통" 이라는데 브리핑이 "쏠림" 이라고 하면 둘 중 하나를 안 믿게 된다.
 */
/**
 * 🔴 **모듈 상태 규칙** (2026-10-02 — 와이어프레임 "모듈 상태 규칙" 표)
 * ```
 * 정상  마지막 동기화 < 갱신주기 × 2   "n초 전" 회색
 * 지연  갱신주기 × 2 초과              주황 칩 "지연 · 마지막 hh:mm" + 값 유지
 * 로딩  최초 로드                      ⚠️ "불러오는 중…" **고착 금지** · 10s 타임아웃 → 오류
 * ```
 * 종전엔 동기화 시각이 **화면에 아예 없었다** — 테이블 수량과 대화 수량이 어긋나도
 * (실측: 테이블 RAM 300주 vs 대화 400주) **언제 읽은 값인지** 알 방법이 없었다.
 */
const PORTFOLIO_PERIOD_MS = 30_000;
const nowTick = ref(Date.now());
const portfolioAgeSec = computed(() => {
  const at = Date.parse(portfolio.value?.asOf || '');
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((nowTick.value - at) / 1000));
});
const portfolioFreshness = computed(() => {
  if (portfolioError.value) return 'error';
  if (portfolioLoading.value && !portfolio.value) return 'loading';
  const age = portfolioAgeSec.value;
  if (age == null) return 'unknown';
  return age * 1000 > PORTFOLIO_PERIOD_MS * 2 ? 'stale' : 'fresh';
});
const portfolioFreshLabel = computed(() => {
  const age = portfolioAgeSec.value;
  switch (portfolioFreshness.value) {
    case 'loading': return '불러오는 중…';
    case 'error': return '동기화 실패';
    case 'unknown': return '동기화 시각 모름';
    case 'stale': return `지연 · ${age}초 전`;
    default: return `${age}초 전`;
  }
});

/** 🔴 **단일 종목 최대 비중** — 레버리지와 다른 축의 쏠림이다(와이어프레임 "리스크 칩") */
const topWeight = computed(() => {
  const h = portfolio.value?.weights?.holdings;
  return Array.isArray(h) && h.length ? h[0] : null;
});
const topWeightTone = computed(() => {
  const p = Number(topWeight.value?.pct);
  if (!Number.isFinite(p)) return '';
  return p >= 50 ? 'alloc__flag--danger' : p >= 35 ? 'alloc__flag--warn' : 'alloc__flag--ok';
});

/**
 * 🔴 **장 세션을 말로 쓴다** (2026-10-02 — 와이어프레임 상단 바 `● KR 정규장 12:24`).
 *    종전엔 `KST 12:24` + 색 점뿐이라 **점 색을 외워야** 열렸는지 알 수 있었다.
 * ⚠️ 모르는 상태를 "마감" 으로 적지 않는다 — 결손과 마감은 다르다.
 */
const SESSION_KO = { open: '정규장', regular: '정규장', pre: '프리장', after: '애프터', closed: '마감' };
function sessionWord(key) {
  const st = sessions.value?.[key]?.state;
  return st ? (SESSION_KO[st] || st) : '확인 중';
}
/** 🔴 상단에서 **승인 대기 건수**를 바로 본다 — 와이어프레임의 `매매 제안 ❷` */
const pendingCount = computed(() => proposals.value.filter((p) => p.status === 'PENDING').length);

/**
 * 🔴 **`AI 대화` 상단 버튼은 뺐다** (2026-10-02 — 사용자: *"상단에 AI 대화는 또 뭐야"*).
 *
 * 와이어프레임을 **렌더해서 상단바를 실제로 읽어 보니** 거기엔 그런 버튼이 없다
 * (로고 · 국면 칩 · 지수 티커 · 지표 편집 · 시계 · 아이콘 버튼 둘이 전부다).
 * 채팅은 **우측 컬럼 안 인라인**으로 있고, 그건 이 앱이 이미 그렇게 하고 있다.
 * ⇒ 버튼은 *"스크롤해서 데려다 주는"* 일만 했으므로 **추가 가치가 0**이었고,
 *   상단바에서 자리만 차지하며 "이건 뭐지" 를 만들었다.
 *
 * ★ 내가 이 버튼을 넣으며 적은 주석이 **"아직 레이어가 아니다"** 였다 —
 *   미완이라고 적어 두는 것과, 미완을 화면에 내보내는 것은 다른 일이다.
 */
/**
 * 🔴 **승인 대기 제안은 모달로 띄운다** (2026-10-02 사용자 지시).
 *
 * 종전엔 대화 로그 안 카드였고, 거기에 **거절된 제안까지 쌓여** 사용자가 *"뭐냐 이건?"*
 * 이라고 했다(화면의 3건이 전부 `REJECTED`, 그중 하나는 **내가 만든 검증용 제안**).
 * ⇒ **결정을 요구하는 것은 흐름을 막아야 하고, 지난 것은 보일 이유가 없다.**
 */
const pendingProposals = computed(() => proposals.value.filter((p) => p.status === 'PENDING'));
/**
 * 🔔 매수/매도 **푸시** (2026-10-04 재편 — 대시보드는 보기 전용, 제안이 오면 알리기만 한다).
 *    승인·거절·전송은 "승인 대기" 메뉴가 전담한다 — 모달·버튼은 전부 그쪽으로 걷어냈다.
 */
watch(() => pendingProposals.value.map((p) => p.id).join(','), (now, before) => {
  const fresh = now.split(',').filter(Boolean).filter((id) => !String(before || '').includes(id));
  if (fresh.length) {
    notify({ message: `새 매매 제안 ${fresh.length}건 — 승인 대기 메뉴에서 확인하세요`, tone: 'info' });
  }
});

/**
 * ⚠️ **사용자가 닫은 것은 다시 안 띄운다** — 안 그러면 닫아도 계속 떠서
 *    *"꺼지지 않는 창"* 이 된다. 같은 제안 id 를 기억한다.
 * ⚠️ 그래도 **사라지지는 않는다** — 상단 `매매 제안 N` 배지가 남아 언제든 다시 열 수 있다.
 */

/*
 * 승인됨·전송 대기 큐는 2026-10-04 재편으로 **승인 대기 메뉴**로 이사했다 — 대시보드는
 * 조작하지 않는다. "승인 ≠ 전송, 전송은 목록에서 한 번 더" 계약과 liveModeUi 가드도 그쪽이 잠근다.
 */
/**
 * 종목의 **현재가** — 보유면 포트폴리오, 아니면 관심종목 시세에서 찾는다.
 * ⚠️ 못 찾으면 `null` 을 돌려 **아무것도 안 그린다** — 0 을 그리면 "가격이 0" 으로 읽힌다.
 */
function priceOf(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const held = (portfolio.value?.items || []).find((h) => String(h.symbol).toUpperCase() === sym);
  const px = Number(held?.lastPrice);
  if (px > 0) return px;
  for (const g of groups.value || []) {
    const hit = (g.items || []).find((i) => String(i.symbol).toUpperCase() === sym);
    const v = Number(hit?.lastPrice ?? hit?.price);
    if (v > 0) return v;
  }
  return null;
}

/**
 * 🔴 **새 제안이 생기면 자동으로 연다** — HITL 은 사람이 **봐야** 성립한다.
 *    폰 알림은 가지만 화면을 보고 있는 사람에겐 아무 일도 안 일어나던 자리다.
 */
const leverageTone = computed(() => {
  // 🔴 2026-10-04 흰 화면의 범인 — 재편 수술 때 leveragePct computed 가 지워진 걸 모르고
  //    참조가 남았다. 렌더 예외 한 줄이 서브트리를 지운다(9-21 사고 가족) — 원천에서 직접 읽는다.
  const p = Number(portfolio.value?.weights?.leveragePct);
  if (!Number.isFinite(p)) return '';
  return p >= 50 ? 'alloc__flag--danger' : p >= 25 ? 'alloc__flag--warn' : 'alloc__flag--ok';
});

/** 내 실제 보유 — 토스에서 **매번 읽는다**(저장하지 않는다) */
async function loadPortfolio() {
  portfolioLoading.value = true;
  /**
   * 🔴 **10초 타임아웃** (2026-10-02 — 와이어프레임 상태 규칙: *"스켈레톤 … 고착 금지,
   *    10s 타임아웃 → 오류"*). 종전엔 응답이 안 오면 `불러오는 중…` 이 **영원히** 남았고,
   *    사용자는 그걸 **정상 대기**로 읽었다. 침묵이 고장을 정상처럼 보이게 하는 그 자리다.
   */
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), 10_000);
  try {
    const res = await apiFetch('/api/portfolio', ctl ? { signal: ctl.signal } : undefined);
    if (res.ok) {
      portfolio.value = await res.json();
      // 🔴 진입 시 첫 보유 종목을 고른다(사용자 지시). 이미 고른 게 있으면 안 덮는다
      autoPickFirstHolding();
      portfolioError.value = '';
      return;
    }
    // 🔴 조용히 비우지 않는다 — 특히 ip-denied 는 화면에서 바로 알아야 고친다
    const body = await res.json().catch(() => ({}));
    portfolio.value = null;
    portfolioError.value = body.error || `보유 현황을 불러오지 못했습니다 (${res.status})`;
  } catch (e) {
    portfolio.value = null;
    portfolioError.value = e.name === 'AbortError'
      ? '보유 현황이 10초 안에 오지 않았습니다 — 다시 시도해 주세요.'
      : (e.message || '보유 현황을 불러오지 못했습니다.');
  } finally {
    clearTimeout(timer);
    portfolioLoading.value = false;
  }
}

/**
 * 🔴 환산은 **서버가 끝냈다**(2026-09-21). 프론트는 받은 값을 그리기만 한다 —
 *    소비자가 화면 하나가 아니라서(텔레그램·API 직접조회) 표시 로직을 뒤로 내렸다.
 *  - `converted:true` 면 계산값이므로 `≈` 를 붙인다
 *  - `krw:null` 이면 **환율을 모른다**는 뜻이다. 0 으로 보여주지 않는다("0원" 으로 읽힌다)
 */
/**
 * 🔴 **표시 통화 토글** (2026-10-02 — 와이어프레임 내 자산 우측 `₩ | $`).
 *    달러 자산을 들고 있으면 **원화 환산은 환율 효과가 섞인다.** 종전엔 원화로만 보여서
 *    "달러로는 얼마인가" 를 볼 방법이 없었다.
 * ⚠️ 환율을 못 읽어 `usd` 가 없으면 **원화로 떨어진다** — 빈칸을 보여주지 않는다.
 */
/**
 * 🔴 **금액과 일관된 손익률을 보여준다** (2026-10-02).
 *    증권사 `profitRate` 가 자기 금액과 어긋난다(실측: 금액 +₩527,619 인데 −6.53%).
 *    백엔드가 `profitRateDerived`(금액에서 유도)를 이미 주고 있는데 화면이 안 썼다.
 * ⚠️ 증권사 값을 **지우지 않는다** — 실현손익 포함 같은 **다른 의미**일 수 있다(10-01 판단).
 *    다르다는 사실만 `*` 와 툴팁으로 남긴다.
 */
const profitRateDiffers = computed(() => {
  const a = Number(portfolio.value?.summary?.profitRate);
  const b = Number(portfolio.value?.summary?.profitRateDerived);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 0.5;
});
const profitRateShown = computed(() => {
  const s2 = portfolio.value?.summary;
  return profitRateDiffers.value && Number.isFinite(Number(s2?.profitRateDerived))
    ? s2.profitRateDerived : s2?.profitRate;
});
const profitRateNote = computed(() => (profitRateDiffers.value
  ? `금액에서 계산한 값입니다. 증권사 보고값은 ${pct(portfolio.value?.summary?.profitRate)} 로 다릅니다.`
  : ''));

const displayCcy = ref('KRW');
/**
 * 손실 구간 보유 — 리스크 체크에 **그 종목만** 올린다.
 * ⚠️ 전부 올리면 수익 종목까지 섞여 "리스크" 라는 말이 흐려진다.
 */
const lossHoldings = computed(() => (portfolio.value?.items || []).filter((h) => Number(h.profitRate) < -10));

/** 종목별 비중 — **계산은 서버 한 곳**(portfolioWeights)에서 온다(두 벌이면 갈라진다) */
function weightOf(sym) {
  const h = portfolio.value?.weights?.holdings?.find((x) => x.symbol === String(sym).toUpperCase());
  return h ? `${h.pct}%` : '—';
}
function krwCell(p) {
  if (!p) return '—';
  if (displayCcy.value === 'USD' && p.usd != null) return money(p.usd, 'USD');
  if (p.krw == null) return p.usd != null ? money(p.usd, 'USD') : '—';
  return `${p.converted ? '≈' : ''}${money(p.krw, 'KRW')}`;
}

function money(v, cur) {
  if (v == null) return '—';
  return cur === 'USD'
    ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `₩${Math.round(Number(v)).toLocaleString('ko-KR')}`;
}
function pct(v) {
  if (v == null) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/**
 * 종목 계층 평가를 판단 옆에 붙인다 — 사용자: *"상세하게 점수 계층화 처리 후 판정이 가능하도록."*
 * ⚠️ 평가에 실패한 종목은 **펼치지 않는다** — 빈 상세를 보여주면 "평가했는데 내용이 없다" 로 읽힌다.
 *    그 사실은 아래 `dataGaps` 가 따로 말한다.
 */
function rated(symbol) {
  const r = report.value?.ratings?.[symbol];
  return r && !r.error ? r : null;
}
/**
 * 목록을 사람이 읽는 한 줄로 — **배열이 아니어도 죽지 않는다.**
 * 🔴 `unverified` 가 문자열로 와서 `.join()` 이 터졌고 **패널 전체가 사라졌다**(2026-09-21).
 *    서버가 정규화하지만 화면도 스스로 지킨다 — 방어는 한 겹이면 다음 필드에서 또 뚫린다.
 */
function listText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean).join(' / ');
  return String(v).trim();
}

/** 점수 색 — ⚠️ `null`(미채점)은 **나쁜 점수가 아니다.** 빨갛게 칠하면 "0점" 으로 읽힌다 */
function scoreTone(score) {
  if (score == null) return 'rt__s--na';
  const n = Number(score);
  if (n >= 8.5) return 'rt__s--hi';
  if (n <= 5) return 'rt__s--lo';
  return 'rt__s--mid';
}
function signClass(v) {
  if (v == null) return 'flat';
  return Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : 'flat';
}



function openStream() {
  try {
    es = new EventSource(apiStreamUrl('/api/stream'));
    es.addEventListener('watchlist.updated', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.watchlist) applyState(data.watchlist);
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      /* 폴링이 백업 — 조용히 무시 */
    };
  } catch {
    /* EventSource 미지원 무시 */
  }
}

onMounted(async () => {
  loadOrderStats();
  loadMcpStatus();
  loadTape();
  tapeTimer = setInterval(loadTape, 60000);
  loadActivity();
  activityTimer = setInterval(loadActivity, 30000);
  /**
   * 🔴 사용자: *"매매 분석은 바로 실행 시작해."*
   * ⚠️ **한 번만** 돈다(주기 실행 아님) — 매 렌더마다 돌면 LLM 비용이 계속 는다.
   *    주기 실행은 서버 `ANALYST_AUTO_CRON` 이 담당한다.
   * ⚠️ 보유를 먼저 받아야 분석할 것이 있다 — 그래서 조금 늦춘다.
   */
  /**
   * 🔴 **화면 진입 자동 실행을 껐다** (2026-09-21 사용자 지시)
   *
   * *"제안이 너무 빈번한데 … 장마감 + 모멘텀 발생시점에만 작동해야 LLM 토큰 비용을 아낄 수 있을 거 같은데."*
   * 실측: 분석 **24회 / 2시간 40분** — 대부분이 여기서 나왔다(1회당 LLM 3~4회 · 88초).
   *
   * ⚠️ 대신 **마지막 분석을 불러온다.** 안 그러면 사건이 날 때까지 빈 화면이라
   *    *"안 돌린 것"* 과 *"고장난 것"* 이 구분되지 않는다.
   * ⚠️ 낮에 주신 *"매매 분석은 바로 실행 시작해"* 를 되돌리는 것이라 **승인받고** 바꿨다.
   */
  loadLastReport();
  await load();
  await loadPortfolio();
  await loadDashboard();
  await loadProposals();
  await loadConditionals();
  await loadRegime();
  regimeTimer = setInterval(loadRegime, 5 * 60 * 1000);
  restartDashTimer();
  clockTimer = setInterval(() => {
  freshTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
    clock.value = formatMarketClock();
  }, 1000);
  pollTimer = setInterval(() => {
    load();
    loadPortfolio();
  }, 20000); // 시세 신선도 유지
  // 🔔 2026-10-04 재편: 보고서·제안·예약도 자동 갱신 — 수동 새로고침 버튼은 걷어냈다.
  //    분석 트리거(장 시점·모멘텀·이벤트)는 서버가 돌리고, 화면은 결과를 따라간다.
  reportTimer = setInterval(() => {
    loadLastReport();
    loadProposals();
    loadConditionals();
    loadOrderStats();
  }, 60000);
  openStream();
});

onUnmounted(() => {
  if (tapeTimer) clearInterval(tapeTimer);
  if (regimeTimer) clearInterval(regimeTimer);
  if (activityTimer) clearInterval(activityTimer);
  if (clockTimer) clearInterval(clockTimer);
  if (freshTimer) clearInterval(freshTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (reportTimer) clearInterval(reportTimer);
  if (dashTimer) clearInterval(dashTimer);
  if (es) es.close();
});
</script>
<template>
  <div class="tracker">
    <!-- ── 상단 ───────────────────────────────────────── -->
    <header class="topbar">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <div class="brand__text">
          <h1 class="brand__name">종합 주식·ETF 트래커</h1>
          <span class="brand__sub">한국 · 미국 관심종목 추적</span>
        </div>
      </div>


      <!--
        🔴 2026-09-21 사용자: *"한국시간 | 미국시간 | 테이프 ~~~ | 환율 보여주고
           **여기 보여주는 애들은 테이프에서 빼**"*
        ★ 흐르는 값은 **지나가면 못 본다.** 늘 봐야 하는 시간·환율은 **고정 칸**이고,
          훑어보는 지수들만 흐른다. 앞판은 시간까지 흘려보내서 시계 구실을 못 했다.
      -->
      <!--
        🔴 **장 상태를 말로** 쓴다 (와이어프레임 `● KR 정규장 12:24` / `● US 마감 23:24 ET`).
           종전엔 `KST 12:24` + 색 점뿐이라 **점 색을 외워야** 열렸는지 알 수 있었다.
      -->
      <div class="clockchip">
        <span class="dot" :class="`dot--${sessions?.kr?.state || 'closed'}`" aria-hidden="true"></span>
        <span class="clockchip__zone">KR {{ sessionWord('kr') }}</span>
        <span class="clockchip__time mono-num">{{ clock.kst.time }}</span>
      </div>
      <div class="clockchip">
        <span class="dot" :class="`dot--${sessions?.us?.state || 'closed'}`" aria-hidden="true"></span>
        <span class="clockchip__zone">US {{ sessionWord('us') }}</span>
        <span class="clockchip__time mono-num">{{ clock.us.time }}</span>
        <span class="clockchip__zone">ET</span>
      </div>

      <!-- 시장 국면 (코드 판정) — 데몬이 5분마다 갱신, 전이는 폰 알림 -->
      <div v-if="regime" class="clockchip" :title="regimeScenarios.map(s => s.name).join(' · ') || '발동 매뉴얼 없음'">
        <span class="clockchip__zone">국면</span>
        <span class="clockchip__time">{{ regimeLabel }}</span>
      </div>

      <div class="tape" :class="{ 'tape--stale': tape.stale }">
        <div class="tape__track">
          <span
            v-for="(i, n) in [...tape.items, ...tape.items]"
            :key="`${n}-${i.symbol}`"
            class="tape__item"
            :aria-hidden="n >= tape.items.length ? 'true' : undefined"
          >
            <b class="tape__label">{{ i.label }}</b>
            <span class="mono-num">{{ tapeNum(i) }}</span>
            <span v-if="i.changePct !== null" class="mono-num" :class="signClass(i.changePct)">{{ pct(i.changePct) }}</span>
            <span v-else class="tape__unknown">등락 모름</span>
          </span>
        </div>
        <span v-if="tape.failed" class="tape__fail">{{ tape.failed }}</span>
      </div>

      <!-- 고정 칸: 환율은 **흐르지 않는다** -->
      <div v-for="f in tape.fixed" :key="f.symbol" class="clockchip">
        <span class="clockchip__zone">{{ f.label }}</span>
        <span class="clockchip__time mono-num">{{ tapeNum(f) }}</span>
        <span v-if="f.changePct !== null" class="mono-num" :class="signClass(f.changePct)">{{ pct(f.changePct) }}</span>
      </div>

      <div class="topbar__meta">
        <!-- 🔴 **토스 동기화 상태를 상단에도** — 와이어프레임 `토스 동기화 6초 전` -->
        <span class="clockchip" :class="`clockchip--${portfolioFreshness}`" title="토스 계좌 마지막 동기화">
          <span class="clockchip__zone">토스 동기화</span>
          <span class="clockchip__time">{{ portfolioFreshLabel }}</span>
        </span>
        <!--
          🔴 **승인 대기 건수를 상단에서 본다** (와이어프레임 `매매 제안 ❷`).
             종전엔 우측 패널을 스크롤해야만 알 수 있었다.
          ⚠️ 0건이면 **버튼 자체를 안 그린다** — `매매 제안 0` 은 매번 뜨는 소음이다.
        -->
                <!-- 🔴 테마 토글 — 와이어프레임 상단 우측 ☀ (종전엔 다크 고정이었다) -->
        <button
          class="btn btn--icon"
          :aria-label="theme === 'light' ? '어두운 테마로' : '밝은 테마로'"
          :title="theme === 'light' ? '어두운 테마로' : '밝은 테마로'"
          @click="toggleTheme"
        >{{ theme === 'light' ? '☾' : '☀' }}</button>
      </div>
    </header>

    <p v-if="error" class="banner banner--error">{{ error }}</p>

    <!--
      ── 상단 2열 (2026-09-21 사용자 레이아웃 지시) ─────────────
         좌 = ETF 추가·관리(좌우 스크롤) · 우 = 내 자산
      🔴 자산을 본문에서 위로 올렸다. 본문 좌열은 **선택 종목**(뉴스·차트) 전용이 된다.
    -->

    <!--
      ── 보드: **3열 × 3행** (2026-09-21 가이드 — 빨간 선을 픽셀로 재서 확정) ──────
        측정값: 세로 분할 x=711·905 가 **전 구간 관통**(3열: 700·194·424 ≈ 53:15:32)
                가로 분할 y=221 은 **전 열 공통**, y=352 는 **좌열에만**
      ┌ 내 자산 ─────────┬ 관심(소형) ┬ 매매분석·시황·텔레그램·HITL ┐  행1
      ├ 뉴스 ────────────┤           │                            │  행2
      ├ 차트 ────────────┤ 랭킹 **만** │ 애널리스트 채팅              │  행3
      🔴 중·우열은 행2~3 을 **세로 병합**한다(좌열만 뉴스/차트로 갈린다).
      🔴 중열은 "랭킹 **정보만** 표출" 이다 — 모멘텀·경고는 여기서 뺀다.
    -->
    <div class="deck">
      <!-- ── 내 자산 (토스 실계좌) ───────────────────────────── -->
      <section class="assets">
        <header class="assets__head">
          <div class="assets__title">
            <span class="assets__badge">TOSS</span>
            <h2>내 자산</h2>
            <span v-if="portfolio?.items?.length" class="group__count mono-num">{{ portfolio.items.length }}</span>
          </div>
          <!--
            🔴 **동기화 상태를 항상 보여준다** (와이어프레임 ① "토스 동기화 · n초 전").
               종전엔 시각이 **화면에 아예 없어서**, 테이블 수량과 대화 수량이 어긋나도
               (실측: RAM 300주 vs 400주) 언제 읽은 값인지 알 방법이 없었다.
          -->
          <span class="assets__sync" :class="`assets__sync--${portfolioFreshness}`">
            TOSS 동기화 · {{ portfolioFreshLabel }}
          </span>
          <!-- 🔴 와이어프레임 `₩ | $` — 달러 자산은 원화 환산에 **환율 효과가 섞인다** -->
          <div class="ccy" role="group" aria-label="표시 통화">
            <button class="ccy__b" :class="{ 'ccy__b--on': displayCcy === 'KRW' }" @click="displayCcy = 'KRW'">₩</button>
            <button class="ccy__b" :class="{ 'ccy__b--on': displayCcy === 'USD' }" @click="displayCcy = 'USD'">$</button>
          </div>
          <span v-if="portfolio?.summary?.fx" class="assets__note">
            ≈ USD/KRW {{ Number(portfolio.summary.fx.rate).toLocaleString('ko-KR') }} 환산
          </span>
        </header>

        <p v-if="portfolioError" class="banner banner--error">{{ portfolioError }}</p>
        <p v-else-if="!portfolio" class="banner banner--empty">토스 연동을 설정하면 실제 보유가 표시됩니다.</p>

        <template v-else>
          <!--
            🔴 **박스 5개 → 와이어프레임의 압축 히어로** (2026-10-02 2차).

            좌열이 340px 가 되면서 KPI 박스가 **288px** 를 먹었고, 그 탓에
            `보유 종목` 목록이 **117px(4행 중 2행)** 만 받았다. 와이어프레임의 `내 자산`
            카드는 박스가 없다 — **큰 숫자 하나 + 한 줄 요약 + 비중 바 + 작은 2칸**이다.
            ⇒ 값은 하나도 안 버리고 **배치만** 바꾼다(투자원금·주문가능은 아래 2칸으로).
          -->
          <div class="hero">
            <span class="hero__label">평가금액</span>
            <span class="hero__value mono-num">{{ krwCell(portfolio.summary.value) }}</span>
            <!--
              🔴 **금액과 비율이 서로 다른 말을 하고 있었다** (2026-10-02 실물).
                 금액 `+₩527,619`(이익) 옆에 `−6.53%`(손실)가 **같은 색으로** 붙어 있었다.
                 증권사 `profitRate` 가 자기 금액과 **일관되게 어긋난다**(알려진 괴리).
              ⇒ 금액과 **일관된 쪽**(금액에서 유도한 값)을 보여주고, 다르면 `*` 로 표시한다.
              ⚠️ 증권사 값을 **지우지 않는다** — 의미가 다를 수 있어 툴팁으로 남긴다.
            -->
            <span class="hero__line">
              <span class="mono-num" :class="signClass(portfolio.summary.profit.krw ?? portfolio.summary.profit.usd)">
                {{ krwCell(portfolio.summary.profit) }}
                <small :title="profitRateNote">{{ pct(profitRateShown) }}<template v-if="profitRateDiffers">*</template></small>
              </span>
              <span class="hero__sep">·</span>
              <span class="hero__today">오늘</span>
              <span class="mono-num" :class="signClass(portfolio.summary.dailyProfit.krw ?? portfolio.summary.dailyProfit.usd)">
                {{ krwCell(portfolio.summary.dailyProfit) }}
                <small>{{ pct(portfolio.summary.dailyRate) }}</small>
              </span>
            </span>
          </div>

          <div class="minis">
            <!-- 와이어프레임 라벨: "투자원금" — "매입금액" 보다 무엇인지 분명하다 -->
            <div class="mini">
              <span class="mini__label">투자원금</span>
              <span class="mini__value mono-num">{{ krwCell(portfolio.summary.purchase) }}</span>
            </div>
            <!-- 🔴 2026-09-22 사용자: "웹 화면에 내 잔고 잔액이 안보이는데" —
                 서버는 summary.cash 를 이미 주고 있었다. 화면만 안 그렸다.
                 ⚠️ 라벨은 "주문 가능" — 예수금 총액과 다를 수 있어 정직하게 붙인다 -->
            <div class="mini">
              <span class="mini__label">주문 가능</span>
              <span class="mini__value mono-num">{{ cashCell(portfolio.summary.cash) }}</span>
            </div>
          </div>

          <!--
            🔴 **자산 비중 + 레버리지 노출** (2026-10-02 와이어프레임 대조)
            백엔드는 레버리지 합계 **90.7%** 를 이미 계산해 브리핑 프롬프트에 싣고 있었는데
            **화면엔 한 줄도 안 갔다.** 사용자가 자기 쏠림을 볼 방법이 없었다.
            ⚠️ `weights` 가 없으면 **절을 통째로 안 그린다** — 0% 로 그리면 "레버리지 없음" 으로 읽힌다.
          -->
          <div v-if="portfolio.weights" class="alloc">
            <div class="alloc__bar">
              <span
                v-for="h in portfolio.weights.holdings" :key="h.symbol"
                class="alloc__seg" :class="{ 'alloc__seg--lev': h.leverage > 1 }"
                :style="{ width: h.pct + '%' }"
                :title="`${h.symbol} ${h.pct}%${h.leverage > 1 ? ` (${h.leverage}배)` : ''}`"
              ></span>
              <span
                class="alloc__seg alloc__seg--cash"
                :style="{ width: portfolio.weights.cashPct + '%' }"
                :title="`현금 ${portfolio.weights.cashPct}%`"
              ></span>
            </div>
            <div class="alloc__legend">
              <span v-for="h in portfolio.weights.holdings" :key="h.symbol" class="alloc__item">
                <i class="alloc__dot" :class="{ 'alloc__dot--lev': h.leverage > 1 }"></i>
                {{ h.symbol }}<em v-if="h.leverage > 1">{{ h.leverage }}x</em>
                <b class="mono-num">{{ h.pct }}%</b>
              </span>
              <span class="alloc__item">
                <i class="alloc__dot alloc__dot--cash"></i>현금 <b class="mono-num">{{ portfolio.weights.cashPct }}%</b>
              </span>
            </div>
            <div class="alloc__flags">
              <span class="alloc__flag" :class="leverageTone">
                레버리지 노출 <b class="mono-num">{{ portfolio.weights.leveragePct }}%</b>
                <small>{{ leverageWord }}</small>
              </span>
              <!-- 🔴 레버리지와 **다른 축**의 쏠림 — 1배만 들고도 한 종목에 몰릴 수 있다 -->
              <span v-if="topWeight" class="alloc__flag" :class="topWeightTone">
                단일 최대 <b class="mono-num">{{ topWeight.symbol }} {{ topWeight.pct }}%</b>
              </span>
              <span class="alloc__flag" :class="portfolio.weights.cashPct < 5 ? 'alloc__flag--warn' : 'alloc__flag--ok'">
                현금 <b class="mono-num">{{ portfolio.weights.cashPct }}%</b>
              </span>
              <!-- ⚠️ 분모가 틀렸을 수 있다는 사실을 **숨기지 않는다** -->
              <span v-if="portfolio.weights.krwCashUnconverted > 0" class="alloc__flag alloc__flag--warn">
                ⚠️ 환율 미확인 — 원화 현금이 비중 분모에서 빠졌습니다
              </span>
            </div>
          </div>

          <!-- 모멘텀: 판단하지 않고 **고르기만** 한다 -->
          <div v-if="portfolio.momentum?.length" class="momentum">
            <span class="momentum__label">오늘 크게 움직임</span>
            <span v-for="m in portfolio.momentum" :key="m.symbol" class="momentum__chip" :class="signClass(m.dailyRate)">
              {{ m.name }} <b class="mono-num">{{ pct(m.dailyRate) }}</b>
            </span>
          </div>

          <!-- 🔴 **표만** 스크롤한다 — 요약은 위에 남는다 -->
          <!--
            🔴 **8열 표 → 2줄 행으로 바꿨다** (2026-10-02 2차 — 와이어프레임 수용).

            와이어프레임의 좌열은 **340px** 이고 `보유 종목` 카드는 한 종목당 **두 줄**이다
            (`{sym}{tag} … {pl}` / `{meta} … 오늘 {today}`). 종전 8열 표는 **681px** 라
            그 열에 넣으면 **절반 넘게 잘린다**(실측 681 vs 보이는 313).
            ⚠️ **열을 지운 게 아니라 접은 것**이다 — 수량·평단·현재가·비중은 둘째 줄
               `meta` 로 전부 살아 있다. 값을 버리면 "화면이 좁아서 못 본다" 가 된다.
          -->
          <ul class="holdings__scroll holds">
            <li
              v-for="h in portfolio.items"
              :key="h.symbol"
              class="hold"
              :class="{ 'hold--on': selected.symbol === h.symbol }"
              @click="pickSymbol(h.symbol, h.name)"
            >
              <span class="hold__name">
                {{ h.name }}
                <!-- 🔴 레버리지는 판단의 전제 — 사용자도 "RAM" 만 보면 무엇인지 모른다 -->
                <span v-if="Number(h.leverageFactor) >= 2" class="hold__lev">{{ h.leverageFactor }}x</span>
              </span>
              <span class="hold__val mono-num">{{ money(h.marketValue, h.currency) }}</span>
              <span class="hold__meta" :title="h.officialName || ''">
                {{ h.market }} · {{ h.symbol }} · <span class="mono-num">{{ h.quantity }}</span>주 ·
                평단 <span class="mono-num">{{ money(h.avgPrice, h.currency) }}</span>
                <!-- D-7 종목 상세 — 행 클릭(차트 선택)과 겹치지 않게 .stop -->
                <RouterLink class="hold__detail" :to="`/symbol/${h.symbol}`" @click.stop>상세 →</RouterLink>
              </span>
              <span class="hold__pl mono-num" :class="signClass(h.profit)">
                {{ money(h.profit, h.currency) }} <small>{{ pct(h.profitRate) }}</small>
                <small class="hold__today" :class="signClass(h.dailyRate)">오늘 {{ pct(h.dailyRate) }}</small>
              </span>
            </li>
            <!--
              🔴 **현금 행** (와이어프레임 내 자산 맨 아래).
                 종전엔 현금이 KPI 한 칸에만 있어 **보유와 같은 축으로 비교할 수 없었다** —
                 "현금이 몇 %인가" 를 보려면 머리로 계산해야 했다.
            -->
            <li v-if="portfolio.weights" class="hold hold--cash">
              <span class="hold__name">현금</span>
              <span class="hold__val mono-num">{{ cashCell(portfolio.summary.cash) }}</span>
              <span class="hold__meta">주문 가능 잔고</span>
              <span class="hold__pl mono-num">비중 {{ portfolio.weights.cashPct }}%</span>
            </li>
          </ul>
        </template>
      </section>
    <section class="strip">
      <div v-if="!groups.length" class="strip__empty">
        관심 테마가 없습니다 — 편집은 포트폴리오·리스크에서.
      </div>
      <!--
        🔴 사용자: *"페이징 처리해서 … 스크롤 처리하지말고 페이징 처리해서 보여줘"*
        ★ 가로 스크롤은 **몇 개가 더 있는지 안 보인다.** 페이지 번호는 그걸 말해 준다.
        ⚠️ 카드가 한 페이지 분량 이하면 **쪽 번호를 숨긴다** — 1/1 은 아무 정보가 아니다.
      -->
      <article v-for="group in pagedGroups" :key="group.id" class="wcard">
        <!--
          🔴 사용자: *"카테고리 명 있고 **우상단에 페이징 버튼/페이지** 붙여."*
          ★ 쪽 이동을 카드 **밖** 아래에 두니 어느 카드의 쪽인지 멀었다 — 제목 옆이 맞다.
        -->
        <header class="wcard__head">
          <span class="wcard__name">{{ group.name }}</span>
          <span class="wcard__count mono-num">{{ group.tickers.length }}</span>
          <nav v-if="groupPages > 1" class="pager">
            <button class="iconbtn" :disabled="groupPage === 0" aria-label="이전 테마" @click="groupPage -= 1">‹</button>
            <span class="pager__at mono-num">{{ groupPage + 1 }}/{{ groupPages }}</span>
            <button class="iconbtn" :disabled="groupPage >= groupPages - 1" aria-label="다음 테마" @click="groupPage += 1">›</button>
          </nav>
        </header>
        <ul class="wcard__list">
          <li
            v-for="t in group.tickers"
            :key="t.symbol + t.market"
            class="wrow"
            :class="{ 'wrow--on': selected.symbol === t.symbol, 'wrow--watch': t.watch }"
            @click="pickSymbol(t.symbol, t.name)"
          >
            <span class="wrow__name">{{ t.name }}</span>
            <span class="wrow__price mono-num">{{ formatPrice(t) }}</span>
            <span
              v-if="t.quote && t.quote.changePct != null"
              class="wrow__chg mono-num"
              :style="heatmapStyleFromChangePct(t.quote.changePct)"
            >{{ formatChangePct(t.quote.changePct) }}</span>
            <!--
              🔴 **감시 표시** (2026-09-22 사용자: *"내가 클릭하면 테두리로 치고 음영으로 감시중 이라고 해"*)
              켠 종목만 분석을 깨운다. 관심종목은 테마 프리셋으로 대량 추가된 것이라
              **전부 감시하면 내 기본값이 분석 빈도와 비용을 정한다** ⇒ **기본 꺼짐**.
              ⚠️ 행 전체 클릭은 **차트 선택**이라 그대로 두고, 표시는 전용 버튼으로 받는다.
            -->
            <!-- 감시중 표시 — 보기 전용(편집은 포트폴리오·리스크에서. 2026-10-04 재편: 대시보드는 조작하지 않는다) -->
            <span v-if="t.watch" class="wrow__w wrow__w--on">감시중</span>
          </li>
          <li v-if="!group.tickers.length" class="wrow wrow--empty">비어 있음</li>
        </ul>
      </article>
    </section>

        <NewsPanel :symbol="selected.symbol" :name="selected.name" />
      <!-- 행3·1열 : 차트 -->
      <div class="cell cell--chart">
        <!-- 🔭 의사결정 파이프라인 (2026-10-03 자율 트레이딩 재개편) — 차트 위 스트립.
             수집→게이트→판단→가드→제안 을 숫자 다섯으로. 단계 클릭 = 상세(탈락 사유 등) -->
        <PipelineStrip
          :pipeline="report?.pipeline || null"
          :at="report?.at || null"
          :trigger="report?.trigger?.why || null"
          :proposal-count="report ? (report.proposals?.length ?? 0) : null"
          :pending-count="pendingProposals.length"
        />
        <!-- ── 조각 실패를 숨기지 않는다 ─────────────────────── -->
        <p v-if="dashError" class="banner banner--error">{{ dashError }}</p>
        <p v-else-if="dash && dash.failedCount" class="banner banner--warn">
          일부 데이터를 못 받았습니다 ({{ dash.failedCount }}건) —
          <template v-for="(p, k) in dash.parts" :key="k">
            <span v-if="p.ok === false">{{ k }}: {{ p.error }} ({{ p.kind }}) </span>
          </template>
        </p>
        <!-- ── 차트 + 호가 ────────────────────────────────────── -->
        <PriceChart :symbol="selected.symbol" :name="selected.name" />
      </div>

      <!-- 행2~3·2열 : 🔴 **랭킹만**(가이드: "랭킹 정보만 표출") -->
      <aside class="layout__signals">
        <RankingsPanel :rankings="dash?.rankings || {}" :error="partError('rankings')?.error || ''" @pick="pickSymbol" />
      </aside>
        <!-- ── 애널리스트와 채팅 (레이아웃 지시: 우열) ─────────── -->
        <section class="chat">
          <!--
            🔴 **매매 분석 패널을 없애고 대화 하나로 합쳤다** (2026-10-02 3차 — 사용자:
               *"매매 분석도 자연어로 하고 대화도 자연어인데 이거를 왜 뜯는거야.
                 기능 전면적으로 재편해."*).

            맞는 지적이었다. 서버는 **처음부터 한 몸**이다 — 같은 모델이 같은 도구
            (`propose_order`·`get_portfolio`·`web_search`)를 쓰고, 둘 다 자연어다.
            화면만 `매매 분석`/`애널리스트와 대화` 두 카드로 **뜯어 놓고 있었다** ⇒
            대화에서 시킨 일의 결과를 다른 카드에서 찾아야 했다.

            ⇒ 이제 **하나의 흐름**이다:
               머리말(분석 시각·웹검색·리스크) → 분석 보고서 → 대화 → 매매 제안(HITL) → 입력
            ⚠️ `분석 실행` 은 **사람이 부르는 또 하나의 발화**다 — 버튼을 없애지 않은 이유는
               정기 회차 밖에서 즉시 돌리고 싶을 때가 있어서다(자연어로도 된다).
          -->
          <header class="chat__head">
            <div class="chat__title">
              <span class="chat__badge">AI</span>
              <h3 class="panel__h">애널리스트</h3>
            </div>
            <!-- 🔴 2026-10-04 재편: 분석 실행 버튼 제거 — 분석은 장 시점·모멘텀·이벤트·퀀트
                 트리거(서버 크론·국면 데몬)가 돌린다. 화면은 결과를 자동으로 받아 그릴 뿐이다. -->
            <span class="chat__auto">자동 갱신 · 분석은 장 시점·모멘텀 트리거로 실행</span>
          </header>

          <!--
            🔴 **상시 지표는 스크롤 밖에 고정한다** (2026-10-02).
               합치고 나서 실제로 띄워 보니 `리스크 체크`·분석 메타가 **대화 로그 안**으로
               들어가 자동 스크롤에 묻혔다 — 레버리지 노출·현금 비중은 **매 순간 보여야 하는**
               값이라 묻히면 "없어진" 것과 같다.
            ⚠️ 반대로 **분석 산문·종목 판단은 로그 안**에 있어야 한다 — 그건 "그때 한 말" 이고
               대화와 같은 시간축에 놓여야 되묻기가 자연스럽다.
          -->
          <p v-if="mcpState && mcpState.effective !== 'live'" class="analyst__warn">
            웹 검색 미연결 — {{ mcpState.reason === 'url_or_token_missing' ? '주소·토큰 없음' : '꺼짐' }}
          </p>

          <!-- 🔴 무엇을 하는 중인지 알린다 — 20~30초 동안 아무 표시가 없으면 멈춘 줄 안다 -->
          <p v-if="analystError" class="banner banner--error">{{ analystError }}</p>
          <p v-else-if="!report" class="banner banner--empty">
            아직 분석 기록이 없습니다 — <b>장 시점·모멘텀 트리거</b>가 돌면 여기 나타납니다.
            (수동 실행은 운용 규칙 설정에서)
          </p>


          <div class="chat__log">
            <!--
              🔴 **분석 결과는 대화의 첫 발언이다** — 따로 뜯어 둔 카드가 아니다.
                 아래 메시지들과 **같은 스크롤 안**에 있어서, 분석을 보고 바로 되묻고
                 그 자리에서 제안을 승인하는 한 흐름이 된다.
            -->

          <!--
            🔴 사용자: *"웹 검색은 당연히 해야하는거니까 저 체크 표시랑 웹 검색 저거 빼"*
            ⇒ 선택지를 없애고 **항상 켠다.** 다만 **붙었는지**는 여전히 보여야 한다 —
              안 보이면 "검색이 안 돈 것" 과 "검색했는데 별 게 없던 것" 이 똑같아진다.
          -->
            <template v-if="report">
            <!-- 🔄 2026-10-04 2차: 사용자 "제안 성과·리스크 체크를 한 화면으로 합치라" —
                 고정부/스크롤부 분리를 없애고 보고서가 **한 흐름**이 됐다. 메타 → 시황 →
                 성과·리스크(한 표) → 종목 판단 → 못 본 것 → 예약 순서. -->
            <div class="meta">
              <span v-if="report.at" class="meta__chip">
                {{ new Date(report.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}
                <template v-if="report.trigger?.why"> · {{ report.trigger.why }}</template>
              </span>
              <span v-if="report.web" class="meta__chip" :class="{ 'meta__chip--warn': !report.web.ok }">
                <template v-if="report.web.ok">웹 검색 {{ report.web.hits }}건</template>
                <template v-else>웹 검색 미반영</template>
              </span>
              <span v-if="portfolio?.asOf" class="meta__chip">잔고 {{ new Date(portfolio.asOf).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) }}</span>
            </div>
            <p v-if="report.web && !report.web.ok" class="analyst__src">웹 검색 미반영 — {{ report.web.error }}</p>

            <p class="analyst__view">{{ report.marketView }}</p>
            <p class="analyst__mom">{{ report.momentumRead }}</p>

            <!-- 📊 성과 + 리스크 — 따로 두 카드였던 것을 한 표로(2026-10-04 사용자 지시) -->
            <div v-if="orderStats || portfolio?.weights" class="risk">
              <h3 class="panel__h">성과·리스크 <small>생애 감사 · 서버 계산</small></h3>
              <dl class="risk__grid">
                <template v-if="orderStats">
                  <div><dt>제안</dt><dd class="mono-num">{{ orderStats.proposed }}건</dd></div>
                  <div><dt>승인</dt><dd class="mono-num">{{ orderStats.approved + orderStats.executed }}건</dd></div>
                  <div><dt>거절</dt><dd class="mono-num" :class="{ down: rejectRate >= 50 }">{{ orderStats.rejected }}건 · {{ rejectRate }}%</dd></div>
                  <div><dt>실주문</dt><dd class="mono-num">{{ orderStats.executed }}건</dd></div>
                </template>
                <template v-if="portfolio?.weights">
                  <div><dt>레버리지 노출</dt><dd class="mono-num" :class="leverageTone">{{ portfolio.weights.leveragePct }}%</dd></div>
                  <div v-if="topWeight"><dt>단일 최대</dt><dd class="mono-num" :class="topWeightTone">{{ topWeight.pct }}% {{ topWeight.symbol }}</dd></div>
                  <div><dt>현금 비중</dt><dd class="mono-num">{{ portfolio.weights.cashPct }}%</dd></div>
                  <div v-for="h in lossHoldings" :key="h.symbol"><dt>{{ h.symbol }} 평단비</dt><dd class="mono-num down">{{ pct(h.profitRate) }}</dd></div>
                </template>
              </dl>
            </div>

            <!-- 🔴 제안 — 승인해야만 진행된다. 실행은 아직 no-op 이다 -->
            <!--
              🔴 **매매 제안·예약 주문은 아래 「애널리스트와 대화」 안으로 옮겼다** (2026-10-02).
                 사용자: *"이럴거면 그냥 매매분석이랑 애널리스트와 대화를 합쳐. HITL 이랑 주식에
                 대해서 자연어로 문의, 답변, 자연어 기반의 매수/매도가 진행되어야 하는데 이게 뭐야."*
                 맞는 지적이었다 — 서버는 이미 `propose_order`·`propose_conditional_order` 를 쥐고
                 있어서 **자연어로 "QLD 10주 팔아줘" 하면 제안이 생긴다.** 그런데 화면이 그 제안을
                 **다른 카드**에 띄워서, 대화에서 시킨 일의 결과를 다른 데서 찾아야 했다.
              ⇒ 제안은 **대화가 끝나는 자리**에 둔다. 승인·거절도 거기서 한다.
            -->

            <div v-if="report.rejected?.length" class="props">
              <h3 class="panel__h">버려진 제안</h3>
              <!-- 🔴 조용히 버리지 않는다 — 왜 안 만들어졌는지 보여준다 -->
              <p v-for="(r, i) in report.rejected" :key="i" class="prop__rej">
                {{ r.symbol }} {{ r.side }} — {{ r.error }}
              </p>
            </div>

            <!-- 🔴 실거래 모드는 **버튼을 누르기 전에** 보여야 한다 -->
            <p v-if="ordersMode === 'live'" class="ordmode">
              🔴 <b>실거래 모드</b> — 승인한 제안을 실행하면 <b>실제 주문</b>이 나갑니다.
            </p>
            <div v-if="report.positions?.length" class="props">
              <h3 class="panel__h">종목 판단</h3>
              <article v-for="ps in report.positions" :key="ps.symbol" class="pos">
                <header>
                  <b>{{ ps.symbol }}</b>
                  <span class="pos__stance" :class="`pos--${ps.stance.toLowerCase()}`">{{ ps.stance }}</span>
                  <span class="pos__conf">{{ ps.confidence }}</span>
                  <!--
                    🔴 손익비는 **코드가 계산**한 값이다(모델이 아니라).
                    ⚠️ 계산이 안 된 이유가 있으면 그걸 보여준다 — 빈칸은 "위험 없음" 으로 읽힌다.
                  -->
                  <span v-if="ps.trade?.rr" class="pos__rr">R/R {{ ps.trade.rr }}</span>
                  <span v-else-if="ps.trade?.error || ps.trade?.rrNote" class="pos__rrbad">
                    {{ ps.trade.error || ps.trade.rrNote }}
                  </span>
                </header>
                <p>{{ ps.rationale }}</p>

                <!--
                  🔴 **현재가가 없으면 레벨을 판정할 수 없다** (2026-10-02 사용자 지적).
                     카드에 `진입 29.59 · 손절 28.2 · 목표 31.5` 만 있고 **현재가가 없어서**
                     그게 추격매수인지 지정가 대기인지, 목표가 이미 지났는지를 알 수 없었다.
                     ⇒ 맨 앞에 현재가를 둔다 — 나머지 숫자는 전부 이것과의 관계로 읽힌다.
                -->
                <dl v-if="ps.entry || ps.stop || ps.target" class="pos__lv">
                  <div v-if="priceOf(ps.symbol)" class="pos__lv--now">
                    <dt>현재</dt><dd class="mono-num">{{ priceOf(ps.symbol) }}</dd>
                  </div>
                  <!--
                    🔴 **숫자만 있고 맥락이 없어서 "뭔 말도 안 되는 수치" 로 보였다** (2026-10-02).
                       `진입 29.59` 가 현재가 28.44 보다 높은 건지 낮은 건지 화면에 안 적혔다.
                       `+4%` 면 추격매수, `-5%` 면 지정가 대기 — **전혀 다른 제안**인데
                       숫자만 보면 구분이 안 된다. ⇒ 괴리를 **진입 옆에** 붙인다.
                  -->
                  <div v-if="ps.entry">
                    <dt>진입</dt>
                    <dd class="mono-num">
                      {{ ps.entry }}
                      <!-- ⚠️ 코드가 현재가로 메운 자리라는 표시 — 모델이 정한 값과 구분된다 -->
                      <small v-if="ps._entryFromPrice" class="pos__auto" title="모델이 진입가를 비워 현재가로 채웠습니다">자동</small>
                      <small v-if="ps.trade?.entryGapPct != null"
                             :class="ps.trade.entryGapPct > 0 ? 'down' : 'up'"
                             :title="ps.trade.entryGapPct > 0 ? '현재가보다 높다 — 추격매수' : '현재가보다 낮다 — 지정가 대기'">
                        {{ ps.trade.entryGapPct > 0 ? '+' : '' }}{{ ps.trade.entryGapPct }}%
                      </small>
                    </dd>
                  </div>
                  <div v-if="ps.stop"><dt>손절</dt><dd class="mono-num">{{ ps.stop }}</dd></div>
                  <div v-if="ps.target"><dt>목표</dt><dd class="mono-num">{{ ps.target }}</dd></div>
                  <div v-if="ps.trade?.sizedQuantity != null">
                    <dt>수량</dt><dd class="mono-num">{{ ps.trade.sizedQuantity }}주</dd>
                  </div>
                </dl>
                <p v-if="ps.trade?.sizeNote" class="pos__rrbad">{{ ps.trade.sizeNote }}</p>
                <!--
                  🔴 **이미 달성된 목표를 조용히 두지 않는다** — QLD 목표 97 이 현재가 97.6
                     아래였는데 화면은 그냥 `목표 97` 만 보여줬다. 손익비(rr)는 코드가
                     이미 `null` 로 만들지만, **왜 비었는지**를 적지 않으면 사용자는
                     "계산이 안 됐나" 로 읽는다.
                -->
                <p v-if="ps.trade?.levelNote" class="pos__rrbad">🔴 {{ ps.trade.levelNote }}</p>
                <p v-if="ps.scenarioUp" class="pos__sc pos__sc--up">▲ {{ ps.scenarioUp }}</p>
                <p v-if="ps.scenarioDown" class="pos__sc pos__sc--dn">▼ {{ ps.scenarioDown }}</p>

                <ul><li v-for="(e, i) in ps.evidence" :key="i">{{ e }}</li></ul>
                <p class="pos__risk">⚠ {{ ps.risk }}</p>

                <!--
                  🔴 **점수 계층** — 사용자: *"상세하게 점수 계층화 처리 후 판정이 가능하도록."*
                  ⚠️ `총점 없음` 과 `0점` 은 **다르다.** ETF 는 기업 채점 대상이 아니라 점수가 없고,
                     항목이 덜 채워져도 총점을 만들지 않는다 — 둘 다 이유를 적어서 보여준다.
                -->
                <details v-if="rated(ps.symbol)" class="rt">
                  <summary>
                    <template v-if="rated(ps.symbol).total != null">
                      기업 평가 <b class="mono-num">{{ rated(ps.symbol).total }}</b>/100
                      · <b>{{ rated(ps.symbol).opinion }}</b>
                    </template>
                    <template v-else-if="rated(ps.symbol).isFund">
                      {{ rated(ps.symbol).typeWhy }} — 기업 점수 없음
                    </template>
                    <template v-else>기업 평가 미완 — 점수 없음</template>
                    <span class="rt__conf">확신도 {{ rated(ps.symbol).confidence }}</span>
                  </summary>

                  <p v-if="rated(ps.symbol).scoreNotApplicable" class="rt__na">
                    {{ rated(ps.symbol).scoreNotApplicable }}
                  </p>
                  <p v-for="(n, i) in rated(ps.symbol).notes || []" :key="`n${i}`" class="rt__warn">{{ n }}</p>
                  <p v-if="rated(ps.symbol).holdIt" class="rt__hold">
                    보유 적합성 <b>{{ rated(ps.symbol).holdIt }}</b>
                    <span v-if="rated(ps.symbol).holdWhy"> — {{ rated(ps.symbol).holdWhy }}</span>
                  </p>

                  <table v-if="rated(ps.symbol).items?.length" class="rt__t">
                    <tbody>
                      <tr v-for="it in rated(ps.symbol).items" :key="it.name">
                        <th>{{ it.name }}</th>
                        <td class="mono-num rt__s" :class="scoreTone(it.score)">
                          {{ it.score == null ? '미채점' : it.score }}
                        </td>
                        <td class="rt__c">{{ it.comment }}</td>
                      </tr>
                    </tbody>
                  </table>

                  <!--
                    🔴 **서술이 들어오는 자리를 안 그리고 있었다** (2026-09-21 발견).
                    라이브에서 `interpretation` 에 411~655자가 3/3 회차 다 도착하는데
                    화면은 `oneLiner`·`weaknesses` 만 그려서 **사용자는 빈 칸을 봤다.**
                    ★ "수집해 놓고 안 쓰는" 패턴 — 이 저장소에서 아홉 번째이고 이번엔 내가 했다.
                    ⚠️ 모델이 한 덩어리로 주면 `interpretation` 에만 들어온다(그게 정상 동작이다) —
                       그래서 **이 칸이 실제로는 주된 출력**이다.
                  -->
                  <p v-if="rated(ps.symbol).oneLiner" class="rt__one">{{ rated(ps.symbol).oneLiner }}</p>
                  <p v-if="rated(ps.symbol).strengths" class="rt__st">강점 · {{ rated(ps.symbol).strengths }}</p>
                  <p v-if="rated(ps.symbol).weaknesses" class="rt__wk">약점 · {{ rated(ps.symbol).weaknesses }}</p>
                  <p v-if="rated(ps.symbol).interpretation" class="rt__int">{{ rated(ps.symbol).interpretation }}</p>
                  <!-- 🔴 "비었다" 와 "안 물어봤다" 를 구분해 보여준다 — 부실한 평가로 오해하면 안 된다 -->
                  <p v-if="rated(ps.symbol).proseSkipped" class="rt__why">{{ rated(ps.symbol).proseSkipped }}</p>
                  <p v-if="rated(ps.symbol).confidenceWhy" class="rt__why">{{ rated(ps.symbol).confidenceWhy }}</p>
                  <!--
                    🔴 **서버가 무슨 모양을 주든 화면이 죽으면 안 된다** (2026-09-21).
                    `unverified` 가 배열이 아니라 **문자열**로 와서 `.join()` 이 터졌고,
                    Vue 가 서브트리를 통째로 버려 **매매 분석 패널 전체가 사라졌다**(제목까지).
                    서버에서 `asList()` 로 정규화했지만, **다음 필드가 또 그럴 수 있으니**
                    화면도 스스로 지킨다 — 한 겹만 고치면 같은 사고가 다른 필드에서 난다.
                  -->
                  <p v-if="listText(rated(ps.symbol).unverified)" class="rt__why">
                    확인 못 함 · {{ listText(rated(ps.symbol).unverified) }}
                  </p>
                </details>
              </article>
            </div>

            <!-- ⚠️ 무엇을 못 봤는지 밝힌다 — 안 밝히면 "다 보고 판단했다" 로 읽힌다 -->
            <div v-if="report.dataGaps?.length" class="gaps">
              <h3 class="panel__h">이 분석이 못 본 것</h3>
              <ul><li v-for="(g, i) in report.dataGaps" :key="i">{{ g }}</li></ul>
            </div>
          </template>

          <!-- 활동 기록은 활동 로그 메뉴가 전담(2026-10-04 — 패널 중복이 난잡의 축이었다) -->
            <!-- 거래소에 걸려 감시 중인 예약(조건부) 주문 — 제안과 다른 층이다 -->
            <div v-if="conditionalOrders.length || conditionalError" class="props">
              <h3 class="panel__h">예약 주문 <small>거래소가 감시가 도달을 지켜보는 중</small></h3>
              <p v-if="conditionalError" class="prop__rej">⚠️ {{ conditionalError }}</p>
              <article v-for="o in conditionalOrders" :key="o.conditionalOrderId || o.id" class="prop">
                <header class="prop__head">
                  <span class="prop__side">예약 {{ (o.first?.orderSide || o.orderSide) === 'BUY' ? '매수' : '매도' }}</span>
                  <span class="prop__sym">{{ o.symbol }}</span>
                  <span class="prop__status">{{ o.status || 'OPEN' }}</span>
                </header>
                <dl class="prop__grid">
                  <div><dt>감시가</dt><dd class="mono-num">{{ o.first?.triggerPrice ?? '—' }}</dd></div>
                  <div><dt>주문가</dt><dd class="mono-num">{{ o.first?.orderPrice ?? '시장가' }}</dd></div>
                  <div><dt>수량</dt><dd class="mono-num">{{ o.quantity }}</dd></div>
                  <div><dt>만료</dt><dd class="mono-num">{{ o.expireDate ?? '—' }}</dd></div>
                </dl>
                <!-- 취소는 승인 대기 메뉴에서 — 대시보드는 조작하지 않는다(2026-10-04 재편) -->
              </article>
            </div>
          </div>
        </section>
    </div>

  </div>

    <!-- 🔴 주문 티켓 · 사전 점검 (와이어프레임 ⑨) -->
</template>

<style scoped>
/**
 * 2026-09-21 전면 개정.
 *
 * 🔴 직전 판의 실제 결함(사용자 지적 + 스크린샷 확인):
 *   1. 주 버튼이 배경과 구분 안 됨          → btn--primary 에 실제 색을 준다
 *   2. 카드 배경이 페이지 배경과 같은 색     → surface 사다리를 쓴다
 *   3. 카드 안 `지수`셀렉트+`추가`가 잘림     → addticker 를 grid 로 (넘치면 줄바꿈)
 *   4. 카드가 좁아 오른쪽 절반이 빔          → 넓으면 보드+브리핑 2열
 *   5. 라이트 테마 잔재(#eef0f4 등)          → 전부 토큰으로
 *
 * ⚠️ 하드코딩 색을 다시 넣지 말 것. 필요하면 styles/tokens.css 에 토큰을 추가한다.
 */
/**
 * 🔴 데스크탑 전용 — **페이지가 스크롤되지 않는다**(2026-09-21 사용자 지시).
 *    화면 높이에 맞추고, 넘치는 것은 **각 패널 안에서** 스크롤한다.
 *    ⚠️ 그래서 모든 스크롤 컨테이너에 `min-height: 0` 이 필요하다 —
 *       grid/flex 자식은 기본 min-height:auto 라 **내용이 밀어내고 페이지가 늘어난다.**
 */
.tracker {
  height: 100vh;
  overflow: hidden;
  padding: var(--space-sm) var(--space-base) var(--space-base);
  background: var(--color-canvas);
  color: var(--color-ink);
  /*
    🔴 **grid 행을 세어 두지 않는다.** 종전에는 `grid-template-rows: auto auto minmax(0,1fr)`
       였는데, 시세 테이프를 한 줄 추가하자 행이 밀려 **`.top` 이 1fr 을 가져가고**
       상단이 화면 절반을 먹었다(좌측 관심 테마가 470px 로 늘어났다).
       조건부 오류 배너까지 있어서 **자식 수가 그때그때 달라진다** — 세는 방식 자체가 약하다.
    ⇒ flex 열로 바꾸고 **남는 높이는 본문(.layout)이 가져간다**고 한 곳에만 적는다.
       이제 위에 무엇을 더 넣어도 안 밀린다.
  */
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

/* ── 상단 ─────────────────────────────────────────── */
.topbar {
  display: flex;
  flex-wrap: nowrap;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: var(--space-xs) var(--space-base);
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-base);
  min-width: 0;
}
/* 브랜드 마크 — 이 앱의 유일한 그라디언트다(인디고→바이올렛: 시세와 AI 를 한 몸으로) */
.brand__mark {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--rounded-md);
  background: linear-gradient(140deg, var(--color-primary), var(--color-ai));
}
.brand__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.brand__name {
  margin: 0;
  font-size: var(--text-base);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--color-ink);
  white-space: nowrap;
}
.brand__sub { display: none; } /* 헤더를 낮춘다 — 부제는 공간값이 없다 */

.clocks {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.clockchip {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-base);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-hairline-soft);
  border-radius: var(--rounded-pill);
}
.clockchip__zone {
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--color-faint);
}
.clockchip__time {
  font-size: var(--text-md);
  color: var(--color-ink);
}
.clockchip__state {
  font-size: var(--text-xs);
  color: var(--color-muted);
}
/* 개장 여부는 배지가 아니라 점으로 — 배지가 많으면 색이 시세와 경쟁한다 */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-faint);
  flex: none;
}
.dot--open,
.dot--active,
.dot--regular {
  background: var(--color-open);
  box-shadow: 0 0 0 3px var(--color-open-soft);
}

.topbar__meta {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}
.metric {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.2;
}
.metric__label {
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  color: var(--color-faint);
}
.metric__value {
  font-size: var(--text-md);
  color: var(--color-body);
}

/* ── 시세 테이프 ─────────────────────────────────── */
/*
  🔴 헤더 **안**에 들어간다(가이드: 빨간 박스가 헤더 행 자체를 감쌌다).
  ⚠️ `flex: 1` + `min-width: 0` 이 **둘 다** 있어야 한다 — min-width 가 없으면
     flex 항목이 내용 폭만큼 버텨서 헤더가 **세 줄로 접힌다**(실제로 그랬다).
*/
.tape {
  flex: 1; min-width: 0;
  position: relative; overflow: hidden; white-space: nowrap;
  border-left: 1px solid var(--color-hairline);
  border-right: 1px solid var(--color-hairline);
  padding: 2px var(--space-sm); font-size: var(--text-xs);
}
/* 값이 낡았으면 눈에 보이게 — 조용히 옛날 값을 보여주지 않는다 */
.tape--stale { opacity: 0.55; }
.tape__track {
  display: inline-flex; gap: var(--space-lg); align-items: baseline;
  /* 🔴 사용자 지시가 **좌→우**다. 뒤집으려면 `reverse` 한 단어만 지우면 된다. */
  animation: tape-flow 90s linear infinite reverse;
  will-change: transform;
}
/* 마우스를 올리면 멈춘다 — 흐르는 글자는 읽으려는 순간 지나간다 */
.tape:hover .tape__track { animation-play-state: paused; }
@keyframes tape-flow {
  from { transform: translateX(0); }
  /* 두 벌 중 한 벌만큼 밀면 원위치라 이음매가 안 보인다 */
  to { transform: translateX(-50%); }
}
/* ⚠️ 움직임에 어지러움을 느끼는 사용자를 위해 멈춘다(접근성) */
@media (prefers-reduced-motion: reduce) {
  .tape__track { animation: none; }
  .tape { overflow-x: auto; }
}
.tape__item { display: inline-flex; align-items: baseline; gap: 6px; }
.tape__label { color: var(--color-muted); font-weight: 600; }
.tape__unknown { color: var(--color-faint); font-size: var(--text-2xs); }
.tape__fail {
  position: absolute; right: 0; top: 0; bottom: 0; display: flex; align-items: center;
  padding: 0 var(--space-sm); background: var(--color-surface-sunken);
  color: var(--color-down); font-size: var(--text-2xs);
}

/* ── 레이아웃 ─────────────────────────────────────── */
/* 데스크탑 3열 — 자산·차트 / 신호 / 브리핑. 각 열은 **자기 안에서** 스크롤한다 */
/*
  ── 보드: 3열 × 3행 (2026-09-21 가이드 — **빨간 선을 픽셀로 재서** 정한 비율) ──────
     측정: 세로 분할 x=711·905 가 전 구간 관통 → 3열 700 : 194 : 424 ≈ **53 : 15 : 32**
           가로 분할 y=221 은 전 열 공통 · y=352 는 **좌열에만** → 행 183 : 131 : 278
     ┌ 내 자산 ────────┬ 관심(소형) ┬ 매매분석·시황·HITL ┐ 행1
     ├ 뉴스 ───────────┤           │                    │ 행2
     ├ 차트 ───────────┤ 랭킹만     │ 애널리스트 채팅      │ 행3
  🔴 중·우열은 행2~3 을 **세로 병합**한다 — 좌열만 뉴스/차트로 갈린다.
  ⚠️ 앞판은 상단을 2열로 두고 열 폭을 두 그리드로 나눠 **세로선이 안 맞았다.**
     그리드 **하나**로 묶어야 맞출 수 있다.
*/
/*
  🔴 클래스 이름을 `.board` 로 지었다가 **이미 있던 규칙에 졌다**
     (기존 「보드」 절의 `.board { grid-template-columns: repeat(auto-fill, minmax(320px,1fr)) }`
      가 파일 **뒤쪽**에 있어 내 것을 덮었다 — 열이 5개로 깨졌다).
     ⚠️ 이 주석을 쓰다 `*` `/` 를 그대로 넣어 **CSS 주석이 조기 종료**돼 빌드가 깨졌다 —
        주석 안에서는 그 두 글자를 붙여 쓰지 않는다.
  ⚠️ 증상이 "그리드가 안 먹는다" 라 **CSS 가 안 들어간 줄** 알았다. 실제로는 들어갔고
     **같은 이름이 하나 더** 있었다 ⇒ 새 구획에는 **쓰이지 않는 이름**을 쓴다.
  ★ DOM 을 직접 조회해 `grid-template-columns` 가 5트랙인 것을 보고서야 갈렸다 —
    소스만 보면 3트랙이라 영원히 못 찾는다.
*/
.deck {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-sm);
  overflow-y: auto;
}
@media (min-width: 1180px) {
  /**
   * 🔴 **4열로 간다** (2026-10-02 3차 — 사용자 지시 두 건을 한 번에 푼다).
   *
   * ① *"뉴스 정보랑 랭킹 정보도 합쳐서 세로로 잘라서 사용해. 랭킹 정보는 y 축이 길어야 하는데
   *    저러면 아무것도 안보이잖아."* — 종전엔 뉴스와 랭킹이 가운데 열에 **가로로 쌓여**
   *    각각 **179px** 뿐이었다(실측). 랭킹은 순위 목록이라 **세로가 길어야 쓸모가 있다.**
   * ② *"매매분석이랑 애널리스트와 대화를 합쳐"* — 우열을 **한 덩어리**로 읽히게 한다.
   *
   * ```
   *      열1 340     열2 1fr        열3 1fr       열4 400
   *  행1  내 자산      ← 종목 차트 (2열을 걸친다) →   애널리스트(요약·판단)
   *  행2  관심종목      ↑              ↑            대화 + 매매 제안(HITL)
   *  행3  관심종목     뉴스           랭킹              ↑
   * ```
   * ⇒ 뉴스·랭킹이 **좌우로 갈라져** 각각 행3 전체 높이를 쓴다(179 → 약 400px).
   * ⚠️ 차트는 2·3열을 **걸쳐야** 한다 — 안 그러면 주인공이 반으로 줄어든다.
   */
  .deck {
    grid-template-columns: minmax(0, 340px) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 400px);
    grid-template-rows: minmax(0, 30fr) minmax(0, 26fr) minmax(0, 44fr);
    overflow: hidden;
  }
  /**
   * 좌열 — 내가 가진 것.
   * 🔴 **자산은 2행을 써야 한다** (2026-10-02 — 같은 실패 모드를 **두 번** 밟았다).
   *    1행(≈246px)만 주면 히어로+비중바가 다 먹고 `.holdings__scroll` 이
   *    `flex:1; min-height:0` 이라 **조용히 높이 0** 이 된다 — 오류도 경고도 없이
   *    **보유 목록이 화면에서 사라진다.** 4행→3행으로 바꾸면서 그대로 재발했다.
   *    ★ 행 수를 바꿀 때마다 이 칸을 다시 재야 한다. 자동으로 따라오지 않는다.
   */
  .deck > .assets { grid-column: 1; grid-row: 1 / span 2; }
  .deck > .strip { grid-column: 1; grid-row: 3; }
  /* 가운데 — 종목. 차트가 두 열을 걸쳐 가장 큰 칸을 쓴다 */
  .deck > .cell--chart { grid-column: 2 / span 2; grid-row: 1 / span 2; }
  .deck > .news { grid-column: 2; grid-row: 3; }
  .deck > .layout__signals { grid-column: 3; grid-row: 3; }
  /**
   * 우열 — **패널 하나다** (2026-10-02 3차).
   * 종전엔 `매매 분석` 과 `애널리스트와 대화` 를 두 칸에 나눠 두고 테두리만 붙여 놨는데,
   * 사용자가 *"이거를 왜 뜯는거야"* 라고 한 게 정확했다 — **붙여 놓은 두 개**는
   * 여전히 두 개다. 섹션 자체를 합쳤으므로 칸도 하나다.
   */
  .deck > .chat { grid-column: 4; grid-row: 1 / span 3; }
}
/* 칸을 넘기지 않는다 — 내용은 **각 카드 안에서** 스크롤한다 */
.deck > * { min-width: 0; min-height: 0; }
.cell--chart { display: flex; flex-direction: column; gap: var(--space-sm); min-height: 0; }
@media (max-width: 1400px) {
  .layout { grid-template-columns: minmax(0, 1fr) 240px 300px; }
}
@media (max-width: 1100px) {
  .layout { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
}

/*
  🔴 2026-09-21 사용자: *"대화하면서 하단으로 고정해야하는데 사용자가 계속 스크롤 내려야해."*
     원인은 **여기**였다. rail 이 `overflow-y: auto` 라 **rail 자체가 스크롤**을 가져갔고,
     그러면 `.chat` 은 내용만큼 늘어나 `.chat__log` 가 **자기 스크롤을 못 만든다.**
     결과: 입력창이 화면 밖으로 밀리고, 새 말이 올 때마다 사람이 내려야 했다.
  ⇒ rail 은 **안 넘친다**(hidden). 남는 높이는 `.chat` 이 갖고, 스크롤은 `.chat__log` 안에서만.
     그러면 입력창은 **항상 바닥에 붙어 있다.**
*/
.layout__rail {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.addgroup {
  display: flex;
  gap: var(--space-sm);
}

/* ── 폼 ───────────────────────────────────────────── */
.input,
.select {
  height: 40px;
  padding: 0 var(--space-base);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  color: var(--color-ink);
  font-size: var(--text-base);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.input:focus,
.select:focus {
  outline: none;
  border-color: var(--color-primary-line);
  box-shadow: var(--ring);
}
.input--sm,
.select { height: 34px; font-size: var(--text-md); }
.select { padding-right: var(--space-sm); }

/* ── 버튼 ─────────────────────────────────────────── */

/* 🔴 주 행동 — 직전 판은 여기에 색이 없어서 버튼이 안 보였다 */

/* AI 가 하는 일은 AI 색으로 — 사람이 누르는 다른 버튼과 구분된다 */



.btn__spin { display: none; }
.btn__spin--on {
  display: block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--color-hairline-strong);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.iconbtn--danger:hover { background: var(--color-danger-soft); color: var(--color-danger); }

/* ── 안내 ─────────────────────────────────────────── */

/* ── 내 자산 ──────────────────────────────────────── */
/*
  🔴 2026-09-21 사용자 지시:
     *"내 자산 현황 (2개 초과할 경우 해당 카드 내부에서 스크롤) · 종목 테이블만 스크롤 되고
       height 고정 · 상단 평가금액/매입금액/평가손익/오늘 상단 고정으로 유지"*
  ⇒ 카드 높이를 못박고 **표만** 스크롤시킨다. 요약(kpis)은 스크롤 밖이라 늘 보인다.
  ⚠️ 카드가 늘어나면 옆 칸(관심 테마)과 높이가 어긋나 상단 전체가 들쭉날쭉해진다.
*/
.assets {
  /* 높이는 **그리드 행**이 정한다 — 여기서 또 박으면 두 곳이 다툰다 */
  min-height: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-left: 2px solid var(--color-primary-line);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
/**
 * 🔴 **좁은 열에서 제목이 세로로 쪼개졌다** (2026-10-02 실측 — `내/자/산`).
 *    `.assets__head` 가 flex 인데 우측 `assets__note`(동기화·환율 안내)가 길어서,
 *    좌측 제목이 **글자 하나 폭까지** 눌렸다. flex 아이템의 기본 `min-width:auto` 가
 *    내용 때문에 안 먹는 상황이라 **명시적으로 줄바꿈을 막고 줄어들지 않게** 한다.
 * ⚠️ 대신 **note 쪽이 줄어들고 넘치면 말줄임** — 둘 다 안 줄면 카드가 가로로 터진다.
 */
.assets__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); flex-wrap: wrap; }
.assets__title { display: flex; align-items: center; gap: var(--space-sm); flex-shrink: 0; }
.assets__title h2 { margin: 0; font-size: var(--text-base); font-weight: 700; color: var(--color-ink); white-space: nowrap; }
.assets__badge {
  font-size: var(--text-2xs); font-weight: 700; letter-spacing: 0.1em;
  padding: 2px 6px; border-radius: var(--rounded-xs);
  background: var(--color-primary-soft); color: var(--color-primary);
}
.assets__note { font-size: var(--text-xs); color: var(--color-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* ── 내 자산 히어로 (2026-10-02 와이어프레임) ─────────────────────────
   큰 숫자 하나가 "지금 얼마인가" 를 말하고, 아래 한 줄이 "얼마 벌었나 / 오늘 어떤가" 를
   말한다. 박스로 쪼개면 다섯 개가 같은 무게가 돼서 **무엇을 먼저 볼지 알 수 없다.** */
.hero { display: flex; flex-direction: column; gap: 1px; }
.hero__label { font-size: var(--text-2xs); letter-spacing: 0.06em; color: var(--color-faint); }
.hero__value {
  font-size: var(--text-3xl); font-weight: 600; color: var(--color-ink);
  line-height: 1.15; letter-spacing: -0.02em;
}
.hero__line {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 5px;
  font-size: var(--text-md); font-weight: 600;
}
.hero__line small { font-size: var(--text-xs); margin-left: 3px; opacity: 0.85; }
.hero__sep { color: var(--color-hairline-strong); }
.hero__today { color: var(--color-muted); font-weight: 500; font-size: var(--text-xs); }

/* 배경 정보 2칸 — 와이어프레임의 `[레버리지 노출][주문 가능]` 자리 */
.minis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-xs); }
.mini {
  display: flex; flex-direction: column; gap: 1px;
  padding: var(--space-xs) var(--space-sm);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md);
  min-width: 0;
}
.mini__label { font-size: var(--text-2xs); letter-spacing: 0.06em; color: var(--color-faint); }
.mini__value {
  font-size: var(--text-xs); font-weight: 600; color: var(--color-body);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── 자산 비중 + 레버리지 노출 (2026-10-02 와이어프레임) ─────────────── */
.alloc { display: flex; flex-direction: column; gap: var(--space-xs); margin-top: var(--space-sm); }
.alloc__bar {
  display: flex; height: 10px; border-radius: 999px; overflow: hidden;
  background: var(--color-surface-2, rgba(255,255,255,.06));
}
.alloc__seg { height: 100%; background: var(--color-accent, #4c8dff); }
/* 🔴 레버리지 구간은 **눈에 띄게** — 사용자가 쏠림을 한눈에 봐야 한다 */
.alloc__seg--lev { background: repeating-linear-gradient(45deg, #e0603a, #e0603a 4px, #b8482a 4px, #b8482a 8px); }
.alloc__seg--cash { background: var(--color-muted, #8b93a7); opacity: .45; }
.alloc__legend { display: flex; flex-wrap: wrap; gap: var(--space-sm); font-size: var(--text-xs); color: var(--color-muted); }
.alloc__item { display: inline-flex; align-items: center; gap: 4px; }
/* ⚠️ `--color-text` 는 **없는 토큰**이었다 — 선언이 조용히 버려졌다(가드가 찾음) */
.alloc__item b { color: var(--color-ink); }
.alloc__item em { font-style: normal; font-size: 10px; opacity: .8; }
.alloc__dot { width: 8px; height: 8px; border-radius: 2px; background: var(--color-accent, #4c8dff); display: inline-block; }
.alloc__dot--lev { background: #e0603a; }
.alloc__dot--cash { background: var(--color-muted, #8b93a7); opacity: .45; }
.alloc__flags { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.alloc__flag {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 8px; border-radius: 999px; font-size: var(--text-xs);
  border: 1px solid var(--color-border, rgba(255,255,255,.12));
}
.alloc__flag small { opacity: .85; }
.alloc__flag--ok { border-color: rgba(70,180,120,.45); color: #5fc48f; }
.alloc__flag--warn { border-color: rgba(230,170,60,.5); color: #e0ad48; }
.alloc__flag--danger { border-color: rgba(224,96,58,.6); color: #ef7a55; background: rgba(224,96,58,.08); }
/* 상단 바 — 와이어프레임 `매매 제안 ❷` (`AI 대화` 는 10-02 에 뺐다 — 위 주석 참조) */
.topbar__pend { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.topbar__pend b { background: rgba(255,255,255,.22); border-radius: 999px; padding: 0 6px; }
/* ₩|$ 토글 — 와이어프레임 내 자산 우측 */
/* 🔴 flex: none — 헤더가 좁아지면 토글이 **눌려 $ 버튼이 잘렸다**(2026-10-04 실화면).
   헤더는 wrap 으로 풀고, 토글·동기화 라벨은 제 폭을 지킨다. */
.ccy { display: inline-flex; flex: none; border: 1px solid var(--color-hairline-strong); border-radius: var(--rounded-md); overflow: hidden; }
.ccy__b { background: none; border: 0; color: var(--color-muted); font-size: var(--text-xs); padding: 2px 8px; cursor: pointer; line-height: 1.4; white-space: nowrap; }
.ccy__b--on { background: var(--color-ink); color: var(--color-surface); }
/* 현금 행 — 보유와 같은 축에 둔다 */
/* 분석 메타 칩 · 리스크 체크 — 와이어프레임 ③ */
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--space-xs); }
.meta__chip {
  font-size: var(--text-2xs); color: var(--color-body);
  background: var(--color-flat-soft); border-radius: var(--rounded-pill); padding: 2px 8px;
}
.meta__chip--warn { color: var(--color-warn); background: var(--color-warn-soft); }
.risk { margin-top: var(--space-sm); }
.risk__grid { display: flex; flex-direction: column; gap: 3px; margin: 4px 0 0; }
.risk__grid > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: var(--text-xs); }
.risk__grid dt { color: var(--color-muted); margin: 0; }
.risk__grid dd { margin: 0; }
.clockchip--stale .clockchip__time { color: var(--color-warn); }
.clockchip--error .clockchip__time { color: var(--color-danger); }

/* 동기화 상태 칩 — 와이어프레임 "모듈 상태 규칙" */
/* ── 보유 종목 — 와이어프레임의 2줄 행 (2026-10-02) ─────────────────────
   좌열이 340px 라 8열 표가 안 들어간다. 한 종목 = **2행 2열**:
     이름[레버리지]   평가금액
     시장·심볼·수량·평단·비중   손익(비율) 오늘
   ⚠️ 두 줄 다 **한 줄 안에서 말줄임** — 넘치면 카드가 가로로 터진다 */
.holdings__scroll { flex: 1; min-height: 0; overflow-y: auto; }
.holds { list-style: none; margin: 0; padding: 0; }
.hold {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 var(--space-sm);
  /* ⚠️ 행 높이가 곧 "몇 종목이 스크롤 없이 보이나" 다 — 실측 69px 에서 조였다 */
  padding: var(--space-xs) var(--space-xs);
  border-bottom: 1px solid var(--color-hairline-soft);
  cursor: pointer;
  font-size: var(--text-md);
  line-height: 1.35;
}
.hold:last-child { border-bottom: none; }
.hold:hover { background: var(--color-surface-hover); }
.hold--on { background: var(--color-primary-soft); }
.hold--cash { cursor: default; }
.hold--cash .hold__name, .hold--cash .hold__pl { color: var(--color-body); }
.hold__name {
  font-weight: 600; color: var(--color-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hold__val { text-align: right; font-weight: 600; color: var(--color-ink); }
.hold__detail { margin-left: 6px; font-size: var(--text-2xs); color: var(--color-primary); text-decoration: none; }
.hold__detail:hover { text-decoration: underline; }
.hold__meta {
  font-size: var(--text-xs); color: var(--color-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hold__pl { text-align: right; font-size: var(--text-xs); font-weight: 600; white-space: nowrap; }
.hold__pl small { opacity: 0.85; margin-left: 3px; }
/* 오늘은 손익 아래 한 칸 더 — 좁은 열에서 옆으로 붙이면 줄이 터진다 */
.hold__today { display: block; margin: 1px 0 0; font-weight: 500; }
.hold__lev {
  margin-left: 4px; padding: 0 4px; border-radius: var(--rounded-xs);
  border: 1px solid var(--color-warn); color: var(--color-warn);
  font-size: var(--text-2xs); font-weight: 700; vertical-align: 1px;
}

/* ── 통합 애널리스트 패널 머리 (2026-10-02) ───────────────────────── */
.sendq { margin: var(--space-xs) var(--space-base) 0; padding: var(--space-sm);
  border: 1px solid var(--color-warn); border-radius: var(--rounded-md); background: var(--color-warn-soft); }
.sendq__row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm);
  margin-top: var(--space-xs); font-size: var(--text-xs); }
.sendq__what { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sendq__act { display: flex; gap: var(--space-xs); flex-shrink: 0; }

/* 🤖 자율성 배지 — "지금 누가 결정하는가" 를 상시 (2026-10-03) */
.automode {
  font-size: var(--text-xs); font-weight: 600; white-space: nowrap;
  padding: 3px 10px; border: 1px solid var(--color-ai-line);
  border-radius: var(--rounded-pill); color: var(--color-ai); background: var(--color-ai-soft);
}
/* 📊 제안 성과 — 리스크 체크와 같은 표 문법 */
.perf { margin: var(--space-xs) var(--space-base) 0; }
.perf .panel__h { margin: 0 0 2px; }

.chat__title { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; }
.chat__badge {
  font-size: var(--text-2xs); font-weight: 700; letter-spacing: 0.1em;
  padding: 2px 6px; border-radius: var(--rounded-xs);
  background: var(--color-ai-soft); color: var(--color-ai);
}
.chat__auto { font-size: var(--text-2xs); color: var(--color-faint); white-space: nowrap; }
.chat__headacts { display: flex; align-items: center; gap: var(--space-xs); flex-shrink: 0; }
/**
 * 🔴 **고정 영역과 스크롤 영역 사이에 선을 긋는다** (2026-10-02 실측).
 *    선이 없으니 스크롤로 **반쯤 잘린 글자**가 리스크 체크 바로 밑에 붙어 보여서
 *    "글자가 겹쳤다" 로 읽혔다. 스크롤 영역은 **어디서 시작하는지 보여야** 한다.
 */
.chat > .meta { margin: 0 var(--space-base); }
.chat > .risk { margin: var(--space-xs) var(--space-base) 0; }
.chat__log {
  border-top: 1px solid var(--color-hairline);
  padding-top: var(--space-sm);
  margin-top: var(--space-sm);
}
/* 보고서 본문과 대화 메시지 사이에도 경계를 둔다 — 같은 스크롤이지만 다른 종류의 글이다 */
.chat__log > .tl { padding-top: var(--space-sm); border-top: 1px solid var(--color-hairline-soft); }

.assets__sync { font-size: var(--text-xs); color: var(--color-muted); white-space: nowrap; flex: none; }
.assets__sync--stale { color: #e0ad48; }
.assets__sync--error { color: #ef7a55; }
.assets__sync--loading { opacity: .7; }

.momentum { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }
.momentum__label { font-size: var(--text-xs); color: var(--color-muted); }
.momentum__chip {
  font-size: var(--text-sm);
  padding: 3px 9px;
  border-radius: var(--rounded-pill);
  background: var(--color-flat-soft);
}
.momentum__chip.up { background: var(--color-up-soft); }
.momentum__chip.down { background: var(--color-down-soft); }

/* 표만 스크롤 · 머리글은 붙어 있는다(스크롤해도 어느 열인지 잃지 않게) */
.holdings__scroll { flex: 1; min-height: 0; overflow-y: auto; }
/* ⚠️ 행을 조여 같은 공간에 **현금 행까지** 들어가게 한다(와이어프레임은 4행이 다 보인다) */
/*
  🔴 2026-09-21 사용자: *"수량 평단, 평가손익 금일 변동치가 각 항목과 위치가 안맞는데"*
     원인은 데이터가 아니라 **CSS 특이도**였다 — `.holdings th`(0,1,1)가 `.ta-r`(0,1,0)를
     이겨서 **헤더만 왼쪽 정렬**되고 데이터는 오른쪽으로 갔다. 표는 이미 <table> 이었고
     열 폭도 맞았는데, **헤더 글자만 반대쪽에 붙어** 다른 열을 가리키는 것처럼 보였다.
  ★ 눈으로는 "데이터가 밀렸다" 로 보이지만 실제로 움직인 건 **헤더**다 —
    증상과 원인이 반대편에 있어서 데이터 정렬을 아무리 고쳐도 안 맞았을 자리.
*/
.ta-r { text-align: right; }

/* ── 관심 테마 스트립 (상단) ───────────────────────── */

/* 🔴 사용자: *"관심 카테고리 / 관심 티커 **소형화** 제공"* — 상단은 자산이 주인공이다 */
/*
  🔴 **페이징으로 바꿨으면 가로 스크롤 전제도 같이 걷어내야 했다** (2026-09-21).
     `overflow-x: auto` + `width: 236px` 를 그대로 둬서, 폭 194px 인 이 열에서
     카드가 넘쳐 **왼쪽이 잘렸다**("국내 주식·ETF" 가 "식·ETF" 로 보였다).
  ★ 한 가지를 바꾸면 **그 전제에 기대던 것**을 같이 훑어야 한다.
  ⇒ 세로로 쌓고 · 카드는 **열 폭을 채우고** · 쪽 번호는 아래.
*/
.strip {
  display: flex;
  flex-direction: column;
  font-size: var(--text-xs);
  gap: var(--space-sm);
  min-height: 0;
  overflow: hidden;
}
.strip__empty {
  font-size: var(--text-sm); color: var(--color-faint);
  padding: var(--space-sm) var(--space-base);
  border: 1px dashed var(--color-hairline); border-radius: var(--rounded-md);
}
.wcard {
  /* 고정 폭이면 좁은 열에서 잘린다 — 열을 채운다 */
  width: 100%;
  min-width: 0;
  flex: 1;
  min-height: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  padding: var(--space-sm);
  display: flex; flex-direction: column; gap: 4px;
}
.wcard__head {
  /* 쪽 이동을 **오른쪽 끝**으로 민다 */
  gap: 6px; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.wcard__name {
  font-size: var(--text-sm); font-weight: 700; color: var(--color-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wcard__count { font-size: var(--text-2xs); color: var(--color-faint); }
/*
  🔴 **`max-height: 92px` 를 뺐다** (2026-09-22 사용자: *"이거때문에 지금 전체 종목이 안보여."*)

  티커가 행 높이를 밀지 않게 하려고 넣은 마법 숫자였는데, **5행쯤에서 목록을 잘랐다.**
  카드가 이미 그리드 행 안에서 높이가 정해지므로 `flex:1 + min-height:0` 만으로 충분하다 —
  넘치면 **카드 안에서 스크롤**하고, 적으면 다 보인다.
  ★ 높이 제약은 **컨테이너가 정하게** 둔다. 자식에 숫자를 박으면 내용이 늘 때 조용히 잘린다.
  ⚠️ `overflow-y: auto` 가 두 번 적혀 있던 것도 정리했다.
*/
.wcard__list {
  flex: 1; min-height: 0; overflow-y: auto;
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 1px;
}
.wrow {
  /* ⚠️ 감시 별 칸을 더했다 — 안 늘리면 별이 이름 칸을 빼앗아 종목명이 잘린다 */
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto 14px;
  align-items: center; gap: 5px;
  padding: 1px 2px; border: 1px solid transparent; border-radius: var(--rounded-xs); cursor: pointer;
}
.wrow:hover { background: var(--color-surface-hover); }
.wrow--on { background: var(--color-primary-soft); }
.wrow--empty { color: var(--color-faint); font-size: var(--text-xs); cursor: default; display: block; }
.wrow__name { font-size: var(--text-xs); color: var(--color-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wrow__price { font-size: var(--text-2xs); color: var(--color-body); }
.wrow__chg { font-size: var(--text-3xs, 9px); padding: 1px 4px; border-radius: var(--rounded-xs); font-weight: 700; }
/*
  감시 배지 — 꺼져 있어도 **보인다**(숨기면 켤 수 있다는 걸 모른다).
  사용자: *"테두리로 치고 음영으로 감시중"* ⇒ 켜지면 행에 테두리+음영, 배지에 글자.
*/
.wrow__w {
  border: 1px solid var(--color-hairline); background: none; color: var(--color-faint);
  cursor: pointer; font-size: var(--text-3xs, 9px); line-height: 1;
  padding: 2px 4px; border-radius: var(--rounded-xs); white-space: nowrap;
}
.wrow__w:hover { border-color: var(--color-primary); color: var(--color-body); }
.wrow__w--on { border-color: var(--color-primary); background: var(--color-primary-soft); color: var(--color-primary); font-weight: 700; }
/* 🔴 행 자체에 **테두리 + 음영** — 목록에서 한눈에 갈린다 */
.wrow--watch {
  border: 1px solid var(--color-primary);
  background: var(--color-primary-soft);
}
/* ⚠️ 차트 선택과 겹칠 때는 선택이 이긴다 — 둘이 같은 색이면 무엇이 선택인지 모른다 */
.wrow--watch.wrow--on { background: var(--color-primary-soft); box-shadow: inset 2px 0 0 var(--color-primary); }
.wrow__rm { border: 0; background: none; color: var(--color-faint); cursor: pointer; font-size: 12px; padding: 0; opacity: 0; }
.wrow:hover .wrow__rm { opacity: 1; }
/*
  🔴 사용자: *"input 을 카드 **최하단**에 두라고 이렇게 중간에 두지 말고."*
  ⚠️ `.wcard__list { flex: 1 }` 만으로는 부족했다 — 목록이 짧으면 flex 가 남는 공간을
     나눠 갖지 않고 **내용 높이로 멈춘다.** `margin-top: auto` 가 확실하다.
*/
.wcard__add {
  margin-top: auto; display: grid; grid-template-columns: minmax(0, 1fr) 28px; gap: 4px; }
.input--xs { height: 26px; font-size: var(--text-xs); padding: 0 6px; }

/*
  🔴 사용자: *"랭킹 하단에 공간이 비는데 다 채워."*
  ⇒ 랭킹 패널이 **남는 높이를 전부 가져가고**, 줄이 많으면 **표 안에서** 스크롤한다.
  ⚠️ 패널이 아니라 **표**가 스크롤해야 한다 — 패널이 스크롤하면 검색창·탭이 위로 밀려 사라진다.
*/
.layout__signals {
  display: flex; flex-direction: column; gap: var(--space-sm);
  min-width: 0; min-height: 0; overflow: hidden;
}
/*
  ⚠️ 마크업이 `aside.layout__signals > div.signals > div.panel` 이라
     `aside > .panel` 은 **아무것도 안 잡는다**(래퍼가 하나 끼어 있다).
     선택자가 빗나가도 **CSS 는 조용하다** — 화면이 안 변하는 것으로만 알 수 있다.
*/

/* ── HTS: 차트 + 사이드 패널 ──────────────────────── */
/* 신호 패널은 가운데 열로 옮겼다 — 차트는 자기 폭을 다 쓴다 */
.hts { display: block; }
.side { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
.panel__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.panel__list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); font-size: var(--text-md); }
.linkish {
  border: 0; background: none; padding: 0; cursor: pointer;
  color: var(--color-ink); font-size: var(--text-md); text-align: left;
}
.linkish:hover { color: var(--color-primary); }
.warnish { color: var(--color-warn); font-size: var(--text-sm); }
.rank { display: flex; flex-direction: column; gap: 4px; }

.ticker__id[role='button'] { cursor: pointer; }

/* ── 보드 ─────────────────────────────────────────── */
.board {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-md);
  align-items: start;
}
.group {
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-width: 0;
}
.group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-hairline-soft);
}
.group__title { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; }
.group__name {
  font-size: var(--text-base);
  font-weight: 700;
  color: var(--color-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group__count {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-muted);
  background: var(--color-flat-soft);
  padding: 1px 7px;
  border-radius: var(--rounded-pill);
}
.group__actions { display: flex; gap: var(--space-xxs); flex: none; }

.tickers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.ticker {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-xs);
  border-radius: var(--rounded-sm);
  transition: background 0.1s ease;
}
.ticker:hover { background: var(--color-surface-hover); }
.ticker--empty {
  list-style: none;
  padding: var(--space-md);
  text-align: center;
  font-size: var(--text-md);
  color: var(--color-faint);
}
.ticker__id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ticker__name {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--color-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ticker__meta { font-size: var(--text-xs); color: var(--color-faint); }
.ticker__quote {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.ticker__price { font-size: var(--text-md); font-weight: 600; color: var(--color-ink); }
.ticker__chg {
  min-width: 62px;
  text-align: center;
  font-size: var(--text-xs);
  font-weight: 700;
  padding: 3px 7px;
  border-radius: var(--rounded-sm);
}
.ticker__rm { flex: none; opacity: 0; }
.ticker:hover .ticker__rm,
.ticker__rm:focus-visible { opacity: 1; }

/* 🔴 종전에는 flex 라 셀렉트·버튼이 카드 폭을 넘어 잘렸다. grid 로 자리를 정해 준다 */
.addticker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 78px 58px;
  gap: var(--space-xs);
  margin-top: var(--space-xs);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--color-hairline-soft);
}
.addticker__query { min-width: 0; }

.analyst__stage { display: flex; align-items: center; gap: 6px; margin: 0; font-size: var(--text-2xs); color: var(--color-ai); }
.analyst__dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--color-ai);
  animation: pulse 1.1s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .analyst__dot { animation: none; } }

/* ── 아이콘 버튼 · 페이저 · 타임라인 · 마크다운 ──────── */
/* 🔴 사용자: 조회·갱신·초기화·새로고침을 **아이콘으로** · 설정 버튼은 **크게** */
.btn--icon {
  width: 38px; height: 38px; padding: 0; font-size: 18px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}

.pager { display: flex; align-items: center; gap: 2px; margin-left: auto; flex: none; }
.pager__at { font-size: var(--text-2xs); color: var(--color-faint); }

.analyst__warn { margin: 0; font-size: var(--text-2xs); color: var(--color-down); }

.tl { margin-top: var(--space-sm); border-top: 1px solid var(--color-hairline-soft); padding-top: var(--space-sm); }
.tl__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.tl__row { display: grid; grid-template-columns: 16px 74px 1fr; gap: 6px; align-items: baseline; font-size: var(--text-2xs); }
.tl__icon { text-align: center; line-height: 1.4; }
.tl__at { color: var(--color-faint); }
.tl__text { color: var(--color-body); overflow-wrap: anywhere; }

/* 마크다운 — 채팅 폭이 좁으므로 여백을 줄이고 표는 **가로 스크롤**시킨다 */
/* 🔴 사용자: *"마크다운 파서 줄바꿈 간격이 너무커 좀 줄여."* — 채팅 폭이 좁아 여백이 크게 느껴진다 */
.md { line-height: 1.45; }
.md :where(p, ul, ol, pre, blockquote, table) { margin: 0 0 3px; }
.md :where(h1, h2, h3, h4) { margin: 5px 0 2px; font-size: var(--text-sm); font-weight: 700; color: var(--color-ink); }
.md ul, .md ol { padding-left: 15px; }
.md li { margin: 0; }
.md li + li { margin-top: 1px; }
/* ⚠️ `marked` 의 `breaks: true` 가 줄바꿈마다 <br> 를 넣는다 — 연속 <br> 은 간격을 두 배로 만든다 */
.md br + br { display: none; }
.md > :last-child { margin-bottom: 0; }
.md code { background: var(--color-surface-sunken); padding: 1px 4px; border-radius: 3px; font-size: 0.92em; }
.md pre { background: var(--color-surface-sunken); padding: 8px; border-radius: var(--rounded-sm); overflow-x: auto; }
.md pre code { background: none; padding: 0; }
.md a { color: var(--color-primary); }
.md blockquote { border-left: 2px solid var(--color-hairline); padding-left: 8px; color: var(--color-muted); }
/* ⚠️ 표가 넓으면 **패널이 아니라 표가** 스크롤해야 한다 — 안 그러면 채팅 폭이 밀린다 */
.md table { display: block; overflow-x: auto; border-collapse: collapse; max-width: 100%; }
.md th, .md td { border: 1px solid var(--color-hairline-soft); padding: 2px 6px; text-align: left; white-space: nowrap; }
.md th { color: var(--color-muted); font-weight: 600; }

/* ── 애널리스트 채팅 ─────────────────────────────── */
.chat {
  display: flex; flex-direction: column; gap: var(--space-sm);
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg); padding: var(--space-base);
  /* 남는 높이를 채팅이 가져간다 — 대화가 주인공인 열이다.
     ⚠️ `min-height` 는 **0** 이어야 한다. 280px 을 주면 내용이 많을 때 그만큼 **밀어내서**
        rail 을 넘치게 만들고, 그러면 위의 문제가 그대로 돌아온다. */
  flex: 1; min-height: 0;
}
.chat__head { display: flex; align-items: center; justify-content: space-between; }
.chat__head .panel__h { margin: 0; }
.chat__tools { font-size: var(--text-2xs); color: var(--color-faint); }
.chat__log {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: var(--space-sm);
}
.msg { font-size: var(--text-xs); line-height: 1.6; }
.msg__text { white-space: pre-wrap; word-break: break-word; }
.msg--user .msg__text {
  background: var(--color-primary-soft); color: var(--color-ink);
  padding: 6px 10px; border-radius: var(--rounded-md); align-self: flex-end;
}
.msg--assistant .msg__text { color: var(--color-body); }
.msg__wait { color: var(--color-faint); font-size: var(--text-2xs); }
.msg__recall { margin: 0 0 4px; font-size: var(--text-2xs); color: var(--color-ai); }
.msg__notice { margin: 4px 0 0; font-size: var(--text-2xs); color: var(--color-warn, #d9a441); }
.msg__think { margin-bottom: 4px; }
.msg__think summary { cursor: pointer; font-size: var(--text-2xs); color: var(--color-faint); }
.msg__think pre {
  margin: 4px 0 0; padding: 6px 8px; white-space: pre-wrap; word-break: break-word;
  background: var(--color-surface-sunken); border-radius: var(--rounded-sm);
  font-size: var(--text-2xs); color: var(--color-muted);
}
.msg__tools { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.tool {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  font-size: var(--text-2xs); padding: 3px 6px;
  background: var(--color-surface-sunken); border-radius: var(--rounded-sm);
  border-left: 2px solid var(--color-hairline);
}
.tool--running { border-left-color: var(--color-ai); }
.tool--ok { border-left-color: var(--color-up); }
/* 🔴 실패를 눈에 띄게 — 조용히 성공처럼 보이면 안 된다 */
.tool--fail { border-left-color: var(--color-down); }
.tool__name { font-weight: 700; color: var(--color-body); }
.tool__args { color: var(--color-faint); }
.tool__state { margin-left: auto; font-weight: 700; }
.tool__detail { flex-basis: 100%; color: var(--color-muted); word-break: break-all; }
.chat__headacts { display: flex; align-items: center; gap: var(--space-xs); }
.chat__jump {
  align-self: center; border: 1px solid var(--color-ai-line); background: var(--color-ai-soft);
  color: var(--color-ai); font-size: var(--text-2xs); padding: 3px 10px;
  border-radius: 999px; cursor: pointer;
}
/* 입력창은 **항상 바닥**이다 — 줄어들지 않게 못박는다 */
.chat__form { display: flex; gap: var(--space-xs); flex: none; }
.chat__form .input { flex: 1; }

/* 뉴스 패널 스타일은 NewsPanel.vue 로 이사(2026-10-04) — `.deck > .news` 배치만 여기 남는다 */


/* ── 매매 분석 ────────────────────────────────────── */
.websearch {
  display: flex; align-items: center; gap: var(--space-xs);
  font-size: var(--text-xs); color: var(--color-body); cursor: pointer;
}
.websearch--off { cursor: not-allowed; color: var(--color-faint); }
.websearch__tag {
  margin-left: auto; padding: 2px 6px; border-radius: var(--rounded-sm);
  background: var(--color-surface-sunken); color: var(--color-faint); font-size: var(--text-2xs);
}
.websearch__tag--on { background: var(--color-ai-soft); color: var(--color-ai); }
.analyst__src { margin: 0; font-size: var(--text-2xs); color: var(--color-faint); }

.analyst {
  /* 행1 칸 안에서만 스크롤한다 — 내용이 길어도 행 높이를 밀지 않는다 */
  min-height: 0;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-left: 2px solid var(--color-ai-line);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: flex; flex-direction: column; gap: var(--space-sm);
}
.analyst__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.analyst__title { display: flex; align-items: center; gap: var(--space-sm); }
.analyst__title h2 { margin: 0; font-size: var(--text-base); font-weight: 700; color: var(--color-ink); }
.analyst__badge {
  font-size: var(--text-2xs); font-weight: 700; letter-spacing: 0.1em;
  padding: 2px 6px; border-radius: var(--rounded-xs);
  background: var(--color-ai-soft); color: var(--color-ai);
}
.analyst__when { margin: 0 0 4px; font-size: var(--text-2xs); color: var(--color-faint); }
.analyst__view { margin: 0; font-size: var(--text-md); line-height: 1.65; color: var(--color-body); }
.analyst__mom {
  margin: 0; padding: var(--space-sm) var(--space-base);
  border-left: 2px solid var(--color-ai-line); background: var(--color-ai-soft);
  border-radius: 0 var(--rounded-sm) var(--rounded-sm) 0;
  font-size: var(--text-md); line-height: 1.6; color: var(--color-body);
}
.props { display: flex; flex-direction: column; gap: var(--space-sm); }
.prop {
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md);
  padding: var(--space-sm); display: flex; flex-direction: column; gap: 6px;
  background: var(--color-surface-sunken);
}
.prop--buy { border-left: 3px solid var(--color-up); }
.prop--sell { border-left: 3px solid var(--color-down); }
.prop__head { display: flex; align-items: center; gap: 8px; font-size: var(--text-md); }
.prop__side { font-weight: 700; color: var(--color-ink); }
.prop__sym { color: var(--color-body); }
.prop__status { margin-left: auto; font-size: var(--text-xs); color: var(--color-muted); }
.prop__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 0; }
.prop__grid dt { font-size: var(--text-2xs); color: var(--color-faint); }
.prop__grid dd { margin: 0; font-size: var(--text-md); font-weight: 600; color: var(--color-ink); }
.prop__why { margin: 0; font-size: var(--text-xs); color: var(--color-muted); line-height: 1.5; }
.prop__act { display: flex; gap: 6px; justify-content: flex-end; }
.ordmode {
  margin: 4px 0; padding: 4px 8px; font-size: var(--text-2xs); font-weight: 700;
  color: var(--color-down); border: 1px solid var(--color-down); border-radius: var(--rounded-xs);
}
.prop__note { margin: 0; font-size: var(--text-xs); color: var(--color-warn); }
.prop__rej { margin: 0; font-size: var(--text-xs); color: var(--color-down); }
.pos { border-top: 1px solid var(--color-hairline-soft); padding-top: var(--space-sm); }
.pos header { display: flex; align-items: center; gap: 8px; font-size: var(--text-md); color: var(--color-ink); }
.pos__stance { font-size: var(--text-2xs); font-weight: 700; padding: 1px 6px; border-radius: var(--rounded-pill); }
.pos--buy { background: var(--color-up-soft); color: var(--color-up); }
.pos--sell { background: var(--color-down-soft); color: var(--color-down); }
.pos--hold { background: var(--color-flat-soft); color: var(--color-muted); }
.pos__conf { margin-left: auto; font-size: var(--text-2xs); color: var(--color-faint); }
.pos p { margin: 4px 0; font-size: var(--text-xs); color: var(--color-body); line-height: 1.5; }
.pos ul, .gaps ul { margin: 2px 0; padding-left: 16px; }
.pos li, .gaps li { font-size: var(--text-xs); color: var(--color-muted); line-height: 1.5; }
.pos__risk { color: var(--color-warn) !important; }

/*
  🔴 **규칙을 안 써서 맨몸으로 나왔다** (2026-09-21, 피어가 배포 후 발견).
     내가 스타일을 넣으려던 앵커가 그 사이 바뀌어 **치환이 조용히 no-op** 됐다.
  ★ `noBorrowedScopedClass` 는 *남의 클래스를 빌려 쓴 것*만 본다 — **아예 규칙이 없는 것**은
    못 잡았다. 그래서 그 가드를 넓혔다(`orphanClass`).
*/
.pos__rr { font-size: var(--text-2xs); color: var(--color-up); font-weight: 700; }
.pos__rrbad { font-size: var(--text-2xs); color: var(--color-down); margin: 2px 0 0; }
.pos__lv { display: flex; flex-wrap: wrap; gap: 8px; margin: 3px 0 0; }
.pos__lv div { display: flex; gap: 3px; align-items: baseline; }
/**
 * 🔴 **현재가는 기준점이라 눈에 먼저 들어와야 한다** (2026-10-02).
 *    나머지 레벨은 전부 이 숫자와의 관계로 읽힌다 — 같은 무게로 늘어놓으면
 *    사용자가 *"29? 28?"* 처럼 기준 없는 숫자로 본다.
 */
.pos__lv--now { padding-right: 8px; border-right: 1px solid var(--color-hairline); }
/* 코드가 메운 값 — 모델이 정한 숫자와 섞이면 안 된다 */
.pos__auto { color: var(--color-muted); font-weight: 500; }
.pos__lv--now dt { color: var(--color-body) !important; }
.pos__lv--now dd { font-weight: 700; color: var(--color-ink); }
.pos__lv dt { font-size: var(--text-2xs); color: var(--color-faint); }
.pos__lv dd { margin: 0; font-size: var(--text-xs); color: var(--color-body); }
.pos__sc { margin: 2px 0 0; font-size: var(--text-2xs); }
.pos__sc--up { color: var(--color-up); }
.pos__sc--dn { color: var(--color-down); }

/* 종목 계층 평가 — 접어 두고, 펼치면 10항목이 다 보인다 */
/* ⚠️ `--color-line` 도 **없는 토큰**이었다 — 구분선이 아예 안 그려지고 있었다 */
.rt { margin: 4px 0 0; border-top: 1px solid var(--color-hairline); padding-top: 4px; }
.rt summary { cursor: pointer; font-size: var(--text-2xs); color: var(--color-body); list-style: none; display: flex; gap: 4px; align-items: baseline; }
.rt summary::-webkit-details-marker { display: none; }
.rt summary::before { content: '▸'; color: var(--color-faint); }
.rt[open] summary::before { content: '▾'; }
.rt__conf { margin-left: auto; color: var(--color-faint); }
.rt__na { margin: 3px 0 0; font-size: var(--text-2xs); color: var(--color-faint); }
.rt__warn { margin: 3px 0 0; font-size: var(--text-2xs); color: var(--color-warn); }
.rt__hold { margin: 3px 0 0; font-size: var(--text-2xs); color: var(--color-body); }
.rt__t { width: 100%; border-collapse: collapse; margin: 4px 0 0; }
.rt__t th { text-align: left; font-weight: 400; font-size: var(--text-2xs); color: var(--color-faint); padding: 1px 4px 1px 0; white-space: nowrap; }
.rt__t td { padding: 1px 0; font-size: var(--text-2xs); vertical-align: baseline; }
.rt__s { text-align: right; padding-right: 6px !important; white-space: nowrap; }
.rt__s--hi { color: var(--color-up); font-weight: 700; }
.rt__s--mid { color: var(--color-body); }
.rt__s--lo { color: var(--color-down); }
/* ⚠️ 미채점은 **나쁜 점수가 아니다** — 회색으로 둔다(빨갛게 칠하면 0점으로 읽힌다) */
.rt__s--na { color: var(--color-faint); }
.rt__c { color: var(--color-faint); }
.rt__one { margin: 4px 0 0; font-size: var(--text-2xs); color: var(--color-body); }
.rt__wk { margin: 2px 0 0; font-size: var(--text-2xs); color: var(--color-warn); }
.rt__st { margin: 2px 0 0; font-size: var(--text-2xs); color: var(--color-up); }
/* 모델이 한 덩어리로 주면 여기로 온다 — 실제로는 이 칸이 주된 출력이다. 줄바꿈을 살린다 */
.rt__int { margin: 4px 0 0; font-size: var(--text-2xs); color: var(--color-body); white-space: pre-wrap; line-height: 1.45; }
.rt__why { margin: 2px 0 0; font-size: var(--text-2xs); color: var(--color-faint); }
.gaps { border-top: 1px solid var(--color-hairline-soft); padding-top: var(--space-sm); }

/* ── 브리핑 (AI 레이어) ──────────────────────────── */
@media (max-width: 640px) {
  .tracker { padding: var(--space-base) var(--space-base) var(--space-xl); }
  .topbar { gap: var(--space-sm); }
  .topbar__meta { width: 100%; justify-content: space-between; }
  .board { grid-template-columns: minmax(0, 1fr); }
  .briefing { max-height: none; }
}
</style>
