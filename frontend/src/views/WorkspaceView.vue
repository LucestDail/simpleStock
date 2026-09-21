<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import PriceChart from '../components/PriceChart.vue';
import SettingsPanel from '../components/SettingsPanel.vue';
import { useWatchlist } from '../composables/useWatchlist';
import { useUi } from '../composables/useUi';
import { formatMarketClock } from '../lib/marketClock';
import { heatmapStyleFromChangePct, formatChangePct } from '../lib/heatmapColor';
import { readSse } from '../lib/sse';
import { renderMarkdown } from '../lib/markdown';
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
  addTicker,
  removeTicker,
  applyState,
} = useWatchlist();
const { notify, confirmAction } = useUi();

const clock = ref(formatMarketClock());
const newGroupName = ref('');
const tickerInputs = ref({}); // groupId -> { query, market }
const busy = ref(false);
const refreshing = ref(false);


let clockTimer = null;
let pollTimer = null;
let es = null;

const totalTickers = computed(() =>
  groups.value.reduce((sum, g) => sum + (g.tickers?.length || 0), 0)
);

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

function ensureInput(groupId) {
  if (!tickerInputs.value[groupId]) tickerInputs.value[groupId] = { query: '', market: '' };
  return tickerInputs.value[groupId];
}

async function onAddGroup() {
  const name = newGroupName.value.trim();
  if (!name) return;
  busy.value = true;
  try {
    await createGroup(name);
    newGroupName.value = '';
    notify({ message: `'${name}' 그룹을 추가했습니다.`, tone: 'success' });
  } catch (e) {
    notify({ message: e.message || '그룹 추가 실패', tone: 'error' });
  } finally {
    busy.value = false;
  }
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

async function onAddTicker(group) {
  const input = ensureInput(group.id);
  const query = String(input.query || '').trim();
  if (!query) return;
  busy.value = true;
  try {
    // 심볼처럼 보이면 symbol, 아니면 종목명(query)로 전송.
    const looksLikeSymbol = /^[A-Za-z0-9.\-]{1,12}$/.test(query);
    const payload = looksLikeSymbol
      ? { symbol: query, market: input.market || undefined }
      : { query, market: input.market || undefined };
    const r = await addTicker(group.id, payload);
    input.query = '';
    if (r && r.added === false) {
      notify({ message: '이미 그룹에 있는 종목입니다.', tone: 'info' });
    } else {
      const sym = r?.ticker?.symbol || query;
      notify({ message: `${sym} 추가됨. 시세를 불러오는 중…`, tone: 'success' });
    }
  } catch (e) {
    notify({ message: e.message || '종목 추가 실패', tone: 'error' });
  } finally {
    busy.value = false;
  }
}

async function onRemoveTicker(group, ticker) {
  try {
    await removeTicker(group.id, ticker.symbol);
  } catch (e) {
    notify({ message: e.message || '종목 삭제 실패', tone: 'error' });
  }
}

async function onRefreshMarket() {
  refreshing.value = true;
  try {
    await apiFetch('/api/market/refresh', { method: 'POST' });
    await load();
    notify({ message: '시세를 갱신했습니다.', tone: 'success' });
  } catch (e) {
    notify({ message: e.message || '시세 갱신 실패', tone: 'error' });
  } finally {
    refreshing.value = false;
  }
}

/**
 * 대시보드 (2026-09-21) — 화면이 필요한 것을 `/api/dashboard` 한 번으로 받는다.
 * 조각마다 요청하면 토스 한도를 태운다.
 * ⚠️ 조각별 성패(`parts`)를 그대로 받아 **"없음" 과 "못 받음" 을 구분해 보여준다.**
 */
const report = ref(null);
const proposals = ref([]);
/** 'live' | 'dry-run' — 서버가 말하는 **실제** 모드. 화면이 지어내지 않는다 */
const ordersMode = ref('dry-run');
const analystLoading = ref(false);
/**
 * 🔴 사용자: *"내부 분석시 **분석 상태 표시**"*
 *    분석은 20~30초 걸린다(도구·LLM). 버튼만 "분석 중…" 이면 멈춘 것처럼 보인다.
 *    ⚠️ 서버가 단계를 스트리밍하지 않으므로 **여기서 예상 단계를 돌린다** —
 *       그래서 진짜 진행률이 아니라 **무엇을 하는 중인지**만 알린다(척하지 않는다).
 */
const analystStage = ref('');
let stageTimer = null;
const ANALYST_STAGES = ['보유·시세 수집', '일봉 분석', '웹 검색', '모델 판단', '제안 정리'];

function startStages() {
  let i = 0;
  analystStage.value = ANALYST_STAGES[0];
  stageTimer = setInterval(() => {
    i = Math.min(i + 1, ANALYST_STAGES.length - 1);
    analystStage.value = ANALYST_STAGES[i];
  }, 6000);
}
function stopStages() {
  if (stageTimer) clearInterval(stageTimer);
  stageTimer = null;
  analystStage.value = '';
}

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
  try {
    return new Date(at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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
const chatInput = ref('');
const chatBusy = ref(false);
const chatError = ref('');
const messages = ref([]);
const chatBox = ref(null);

/**
 * 바닥으로 따라간다. ⚠️ 다만 **사용자가 위를 읽고 있으면 끌어내리지 않는다** —
 * 조각이 올 때마다 강제로 내리면 지난 말을 읽을 수가 없다(반대 방향의 같은 불편).
 * ⇒ 이미 바닥 근처일 때만 따라간다. 아니면 "새 답" 표시만 띄운다.
 */
const NEAR_BOTTOM_PX = 80;
const stuckToBottom = ref(true);
const hasUnseen = ref(false);

function onChatScroll() {
  const el = chatBox.value;
  if (!el) return;
  stuckToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  if (stuckToBottom.value) hasUnseen.value = false;
}

function scrollChat({ force = false } = {}) {
  requestAnimationFrame(() => {
    const el = chatBox.value;
    if (!el) return;
    if (force || stuckToBottom.value) {
      el.scrollTop = el.scrollHeight;
      hasUnseen.value = false;
    } else {
      hasUnseen.value = true;
    }
  });
}

/** 🔴 사용자: *"대화 초기화는 가능한건가?"* — 서버 이력까지 지운다(화면만 비우면 되살아난다) */
const clearing = ref(false);
async function clearChat() {
  if (clearing.value) return;
  clearing.value = true;
  try {
    const res = await apiFetch('/api/analyst/chat/history', { method: 'DELETE' });
    if (!res.ok) throw new Error(`초기화 실패 (${res.status})`);
    messages.value = [];
    chatError.value = '';
    hasUnseen.value = false;
    stuckToBottom.value = true;
  } catch (e) {
    chatError.value = e.message || '초기화 실패';
  } finally {
    clearing.value = false;
  }
}

async function loadChatHistory() {
  try {
    const res = await apiFetch('/api/analyst/chat/history?limit=40');
    if (!res.ok) return;
    const b = await res.json();
    messages.value = (b.items || []).map((m) => ({
      role: m.role, text: m.text, at: m.at, thinking: '', tools: [], done: true,
    }));
    scrollChat();
  } catch { /* 이력이 없어도 대화는 시작할 수 있다 */ }
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || chatBusy.value) return;
  chatInput.value = '';
  chatError.value = '';
  chatBusy.value = true;

  messages.value.push({ role: 'user', text, at: new Date().toISOString(), done: true });
  // 답이 들어올 빈 말풍선을 **먼저** 만든다 — 조각이 이어붙을 자리다
  const reply = { role: 'assistant', text: '', thinking: '', tools: [], recall: 0, done: false, at: null };
  messages.value.push(reply);
  // 내가 방금 보냈으면 바닥으로 간다(읽던 중이었어도 이건 내 행동이다)
  stuckToBottom.value = true;
  scrollChat({ force: true });

  try {
    // 화면이 지금 무엇을 보고 있는지 한 줄로 — 모델이 "그 종목" 을 알아들을 수 있게
    const contextNote = selected.value.symbol
      ? `사용자가 보고 있는 종목: ${selected.value.name || ''}(${selected.value.symbol})`
      : '';
    const res = await apiFetch('/api/analyst/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, contextNote }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || `대화에 실패했습니다 (${res.status})`);
    }
    await readSse(res, (event, data) => {
      if (event === 'text_delta') reply.text += data.text || '';
      else if (event === 'thinking_delta') reply.thinking += data.text || '';
      else if (event === 'tool_call') reply.tools.push({ id: data.id, name: data.name, args: data.args, state: 'running' });
      else if (event === 'tool_result') {
        // 🔴 채팅이 제안을 등록하면 **상단 HITL 목록**에 바로 뜨게 한다
        //    (사용자 지시: "상단 HITL 에 토픽으로 등록"). 새로고침을 사람이 하게 두지 않는다.
        if (data.name === 'propose_order' && data.ok) loadProposals();
        const t = reply.tools.find((x) => x.id === data.id);
        // ⚠️ 실패를 조용히 성공으로 만들지 않는다 — 화면에 그대로 남긴다
        if (t) { t.state = data.ok ? 'ok' : 'fail'; t.detail = data.ok ? data.preview : data.error; }
      } else if (event === 'recall') reply.recall = data.count || 0;
      else if (event === 'notice') reply.notice = data.text;
      else if (event === 'error') chatError.value = data.message || '대화 오류';
      else if (event === 'done') { reply.done = true; reply.at = new Date().toISOString(); }
      scrollChat();
    });
  } catch (e) {
    chatError.value = e.message || '대화 오류';
  } finally {
    reply.done = true;
    chatBusy.value = false;
    scrollChat();
  }
}

/**
 * 선택한 종목 뉴스(레이아웃 지시: 본문 좌열 상단).
 * ⚠️ 종목을 바꿀 때마다 부른다 — **자동 새로고침 타이머에는 안 붙인다**(밖으로 나가는 호출이다).
 */
const news = ref({ loading: false, ok: false, items: [], error: '', when: null });
let newsSeq = 0;

async function loadNews() {
  const sym = selected.value.symbol;
  if (!sym) { news.value = { loading: false, ok: false, items: [], error: '', when: null }; return; }
  const seq = ++newsSeq;
  news.value = { ...news.value, loading: true, error: '' };
  try {
    const q = new URLSearchParams({ symbol: sym, name: selected.value.name || '' });
    const res = await apiFetch(`/api/news?${q}`);
    const b = await res.json().catch(() => ({}));
    // 🔴 늦게 온 응답이 새 선택을 덮어쓰지 않게 한다(종목을 빨리 바꾸면 실제로 일어난다)
    if (seq !== newsSeq) return;
    news.value = {
      loading: false,
      ok: Boolean(b.ok),
      items: b.items || [],
      error: b.ok ? '' : (b.error || `뉴스를 불러오지 못했습니다 (${res.status})`),
      when: new Date().toISOString(),
    };
  } catch (e) {
    if (seq !== newsSeq) return;
    news.value = { loading: false, ok: false, items: [], error: e.message || '뉴스 오류', when: null };
  }
}

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
async function onToggleWatch(group, t) {
  try {
    const res = await apiFetch(
      `/api/watchlist/groups/${encodeURIComponent(group.id)}/tickers/${encodeURIComponent(t.symbol)}/watch`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !t.watch }) }
    );
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '감시 설정 실패');
    t.watch = !t.watch;
  } catch (e) {
    // ⚠️ 형제 핸들러와 같은 통보 경로를 쓴다 — 새 상태를 만들면 표시되는 자리가 갈린다
    notify({ message: e.message || '감시 설정 실패', tone: 'error' });
  }
}

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

async function runAnalyst() {
  analystLoading.value = true;
  analystError.value = '';
  startStages();
  try {
    const res = await apiFetch('/api/analyst/run', { method: 'POST' });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || `분석 실패 (${res.status})`);
    }
    report.value = await res.json();
    await loadProposals();
    await loadActivity();
  } catch (e) {
    analystError.value = e.message || '분석 실패';
  } finally {
    analystLoading.value = false;
    stopStages();
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

async function decide(p, action) {
  /**
   * 🔴 **실거래 실행은 한 번 더 묻는다** (2026-09-22).
   *    지금은 클릭 한 번이면 주문이 나간다. 되돌릴 수 없는 행위에 확인이 없으면
   *    오터치가 곧 체결이다. ⚠️ 승인·거절은 되돌릴 수 있으니 안 묻는다 — **실행만** 묻는다.
   */
  const live = ordersMode.value === 'live';
  if (action === 'execute' && live) {
    const amount = (Number(p.quantity) * Number(p.price)).toLocaleString('ko-KR');
    const ok = window.confirm(
      `🔴 실제 주문을 냅니다 (모의 아님)\n\n`
      + `${p.side === 'BUY' ? '매수' : '매도'} ${p.symbol} ${p.quantity}주 · 지정가 ${p.price}\n`
      + `평가금액 약 ${amount}\n\n진행할까요?`
    );
    if (!ok) return;
  }

  try {
    const res = await apiFetch(`/api/orders/proposals/${encodeURIComponent(p.id)}/${action}`, { method: 'POST' });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) {
      notify({ message: b.error || '처리 실패', tone: 'error' });
      return;
    }
    if (action === 'execute') {
      // ⚠️ 서버가 말한 것을 **그대로** 옮긴다 — 화면이 모드를 추측해 문구를 지어내지 않는다
      notify({
        message: b.proposal?.result?.note || (live ? '전송했습니다.' : '모의 실행했습니다(실제 주문 아님).'),
        tone: live ? 'warn' : 'info',
      });
    }
    await loadProposals();
  } catch (e) {
    notify({ message: e.message || '처리 실패', tone: 'error' });
  }
}

const dash = ref(null);
const dashError = ref('');
const selected = ref({ symbol: '', name: '' });
const settingsOpen = ref(false);
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
  // 종목을 고르면 좌열 뉴스도 따라간다(차트와 같은 대상을 본다)
  loadNews();
}

/** 조각이 실패했으면 그 사실을 화면에 남긴다 */
const RANK_LABEL = {
  TOP_GAINERS: '급등', TOP_LOSERS: '급락',
  MARKET_TRADING_AMOUNT: '거래대금', MARKET_TRADING_VOLUME: '거래량',
  TOSS_SECURITIES_TRADING_AMOUNT: '토스 거래대금', TOSS_SECURITIES_TRADING_VOLUME: '토스 거래량',
};
function rankLabel(key) {
  const [country, type] = String(key).split(':');
  return `${country === 'US' ? '미국' : '한국'} ${RANK_LABEL[type] || type}`;
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

const rankQuery = ref('');

/**
 * 랭킹 검색. **두 가지를 겸한다**:
 *  ① 목록 안에 있으면 그 줄을 골라 차트를 띄운다
 *  ② 없으면 입력값을 **종목 코드로 보고** 그대로 차트를 띄운다
 * ⚠️ ②가 없으면 "랭킹에 없는 종목은 못 본다" 가 되어 검색창의 뜻이 사라진다.
 */
const findBusy = ref(false);
const findError = ref('');

/**
 * 종목 검색. 🔴 사용자: *"삼성전자 검색하면 안뜨는데 **이름으로도** 검색할수 있게"*
 *
 * ⚠️ 앞판은 입력값을 **그대로 종목 코드로** 썼다 — `005930` 은 되고 `삼성전자` 는 안 됐다
 *    (한글을 티커로 보내니 당연히 없다). 그게 "안 뜬다" 의 정체다.
 * ⇒ ①목록 안에서 먼저 찾고 ②없으면 서버 `/api/lookup`(코드 → 이름 순) 에 맡긴다.
 */
async function findSymbol() {
  const q = rankQuery.value.trim();
  if (!q || findBusy.value) return;
  findError.value = '';

  const hit = (activeRank.value?.rows || []).find(
    (r) => r.symbol?.toLowerCase() === q.toLowerCase() || (r.name || '').includes(q)
  );
  if (hit) { pickSymbol(hit.symbol, hit.name || hit.symbol); rankQuery.value = ''; return; }

  findBusy.value = true;
  try {
    const res = await apiFetch(`/api/lookup?q=${encodeURIComponent(q)}`);
    const b = await res.json().catch(() => ({}));
    if (!res.ok || !b.ok) throw new Error(b.error || `'${q}' 를 찾지 못했습니다.`);
    pickSymbol(b.symbol, b.name || b.symbol);
    rankQuery.value = '';
  } catch (e) {
    // 🔴 조용히 실패하지 않는다 — 앞판은 엉뚱한 코드로 차트를 열어 "빈 차트" 로 보였다
    findError.value = e.message;
  } finally {
    findBusy.value = false;
  }
}

const rankTab = ref('');
const rankKeys = computed(() => Object.keys(dash.value?.rankings || {}));
const activeRank = computed(() => {
  const keys = rankKeys.value;
  if (!keys.length) return null;
  const key = keys.includes(rankTab.value) ? rankTab.value : keys[0];
  return dash.value.rankings[key];
});

/** 검색어가 있으면 목록도 같이 좁힌다(찾는 중에 눈이 편하게) */
const visibleRankRows = computed(() => {
  const rows = activeRank.value?.rows || [];
  const q = rankQuery.value.trim().toLowerCase();
  // 🔴 공간이 생겼으니 더 보여준다(사용자: "하단 공간이 비는데 다 채워")
  if (!q) return rows.slice(0, 30);
  return rows
    .filter((r) => r.symbol?.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q))
    .slice(0, 30);
});

function partError(name) {
  const p = dash.value?.parts?.[name];
  return p && p.ok === false ? p : null;
}

function restartDashTimer() {
  if (dashTimer) clearInterval(dashTimer);
  const sec = Number(dash.value?.settings?.refreshSec) || 60;
  dashTimer = setInterval(loadDashboard, Math.max(15, sec) * 1000);
}

const portfolio = ref(null);
const portfolioError = ref('');
const portfolioLoading = ref(false);

/** 내 실제 보유 — 토스에서 **매번 읽는다**(저장하지 않는다) */
async function loadPortfolio() {
  portfolioLoading.value = true;
  try {
    const res = await apiFetch('/api/portfolio');
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
    portfolioError.value = e.message || '보유 현황을 불러오지 못했습니다.';
  } finally {
    portfolioLoading.value = false;
  }
}

/**
 * 🔴 환산은 **서버가 끝냈다**(2026-09-21). 프론트는 받은 값을 그리기만 한다 —
 *    소비자가 화면 하나가 아니라서(텔레그램·API 직접조회) 표시 로직을 뒤로 내렸다.
 *  - `converted:true` 면 계산값이므로 `≈` 를 붙인다
 *  - `krw:null` 이면 **환율을 모른다**는 뜻이다. 0 으로 보여주지 않는다("0원" 으로 읽힌다)
 */
function krwCell(p) {
  if (!p) return '—';
  if (p.krw == null) return p.usd != null ? `$${Number(p.usd).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—';
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
  loadChatHistory();
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
  restartDashTimer();
  clockTimer = setInterval(() => {
    clock.value = formatMarketClock();
  }, 1000);
  pollTimer = setInterval(() => {
    load();
    loadPortfolio();
  }, 20000); // 시세 신선도 유지
  openStream();
});

onUnmounted(() => {
  if (tapeTimer) clearInterval(tapeTimer);
  if (activityTimer) clearInterval(activityTimer);
  if (clockTimer) clearInterval(clockTimer);
  if (pollTimer) clearInterval(pollTimer);
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
      <div class="clockchip">
        <span class="clockchip__zone">KST</span>
        <span class="clockchip__time mono-num">{{ clock.kst.time }}</span>
        <span class="dot" :class="`dot--${sessions?.kr?.state || 'closed'}`" aria-hidden="true"></span>
      </div>
      <div class="clockchip">
        <span class="clockchip__zone">ET</span>
        <span class="clockchip__time mono-num">{{ clock.us.time }}</span>
        <span class="dot" :class="`dot--${sessions?.us?.state || 'closed'}`" aria-hidden="true"></span>
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
        <!-- ⚠️ 환율은 위 고정 칸으로 옮겼다 — 같은 값을 두 번 두지 않는다 -->
        <div class="metric">
          <span class="metric__label">종목</span>
          <span class="metric__value mono-num">{{ totalTickers }}</span>
        </div>
        <!-- 🔴 사용자: *"헤더의 설정 버튼 너무 작은데 좀 크기 키워줘"* -->
        <button class="btn btn--icon" aria-label="운영 설정" title="운영 설정" @click="settingsOpen = true">⚙</button>
        <button class="btn btn--icon" :disabled="refreshing" aria-label="시세 갱신" title="시세 갱신" @click="onRefreshMarket">
          <span v-if="refreshing" class="btn__spin btn__spin--on" aria-hidden="true"></span>
          <template v-else>⟳</template>
        </button>
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
          <span v-if="portfolioLoading" class="assets__note">불러오는 중…</span>
          <span v-else-if="portfolio?.summary?.fx" class="assets__note">
            ≈ USD/KRW {{ Number(portfolio.summary.fx.rate).toLocaleString('ko-KR') }} 환산
          </span>
        </header>

        <p v-if="portfolioError" class="banner banner--error">{{ portfolioError }}</p>
        <p v-else-if="!portfolio" class="banner banner--empty">토스 연동을 설정하면 실제 보유가 표시됩니다.</p>

        <template v-else>
          <div class="kpis">
            <div class="kpi">
              <span class="kpi__label">평가금액</span>
              <span class="kpi__value mono-num">{{ krwCell(portfolio.summary.value) }}</span>
            </div>
            <div class="kpi">
              <span class="kpi__label">매입금액<template v-if="portfolio.summary.purchase.usd"> · USD 보유</template></span>
              <span class="kpi__value kpi__value--sub mono-num">{{ krwCell(portfolio.summary.purchase) }}</span>
            </div>
            <div class="kpi">
              <span class="kpi__label">평가손익</span>
              <span class="kpi__value mono-num" :class="signClass(portfolio.summary.profit.krw ?? portfolio.summary.profit.usd)">
                {{ krwCell(portfolio.summary.profit) }}
                <small>{{ pct(portfolio.summary.profitRate) }}</small>
              </span>
            </div>
            <div class="kpi">
              <span class="kpi__label">오늘</span>
              <span class="kpi__value mono-num" :class="signClass(portfolio.summary.dailyProfit.krw ?? portfolio.summary.dailyProfit.usd)">
                {{ krwCell(portfolio.summary.dailyProfit) }}
                <small>{{ pct(portfolio.summary.dailyRate) }}</small>
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
          <div class="holdings__scroll">
          <table class="holdings">
            <thead>
              <tr>
                <th>종목</th><th class="ta-r">수량</th><th class="ta-r">평단</th>
                <th class="ta-r">현재가</th><th class="ta-r">평가손익</th><th class="ta-r">오늘</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="h in portfolio.items"
                :key="h.symbol"
                class="holdings__row"
                :class="{ 'holdings__row--on': selected.symbol === h.symbol }"
                @click="pickSymbol(h.symbol, h.name)"
              >
                <td>
                  <span class="holdings__name">{{ h.name }}</span>
                  <span class="holdings__meta">{{ h.market }} · {{ h.symbol }}</span>
                </td>
                <td class="ta-r mono-num">{{ h.quantity }}</td>
                <td class="ta-r mono-num">{{ money(h.avgPrice, h.currency) }}</td>
                <td class="ta-r mono-num">{{ money(h.lastPrice, h.currency) }}</td>
                <td class="ta-r mono-num" :class="signClass(h.profit)">
                  {{ money(h.profit, h.currency) }} <small>{{ pct(h.profitRate) }}</small>
                </td>
                <td class="ta-r mono-num" :class="signClass(h.dailyRate)">{{ pct(h.dailyRate) }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </template>
      </section>
    <section class="strip">
      <div v-if="!groups.length" class="strip__empty">
        관심 테마가 없습니다. ⚙ 설정에서 추가하세요.
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
            <button
              class="wrow__w"
              :class="{ 'wrow__w--on': t.watch }"
              :title="t.watch ? '감시 중 — 끄려면 클릭' : '감시 켜기'"
              @click.stop="onToggleWatch(group, t)"
            >{{ t.watch ? '감시중' : '감시' }}</button>
            <button class="wrow__rm" title="삭제" @click.stop="onRemoveTicker(group, t)">×</button>
          </li>
          <li v-if="!group.tickers.length" class="wrow wrow--empty">비어 있음</li>
        </ul>
        <div class="wcard__add">
          <input
            v-model="ensureInput(group.id).query"
            class="input input--xs"
            placeholder="티커/종목명"
            @keyup.enter="onAddTicker(group)"
          />
          <button class="btn btn--xs btn--soft" :disabled="busy" @click="onAddTicker(group)">+</button>
        </div>
      </article>
    </section>
        <section class="analyst">
          <header class="analyst__head">
            <div class="analyst__title">
              <span class="analyst__badge">AI</span>
              <h2>매매 분석</h2>
            </div>
            <button class="btn btn--ai" :disabled="analystLoading" @click="runAnalyst">
              {{ analystLoading ? '분석 중…' : '분석 실행' }}
            </button>
          </header>

          <!--
            🔴 사용자: *"웹 검색은 당연히 해야하는거니까 저 체크 표시랑 웹 검색 저거 빼"*
            ⇒ 선택지를 없애고 **항상 켠다.** 다만 **붙었는지**는 여전히 보여야 한다 —
              안 보이면 "검색이 안 돈 것" 과 "검색했는데 별 게 없던 것" 이 똑같아진다.
          -->
          <p v-if="mcpState && mcpState.effective !== 'live'" class="analyst__warn">
            웹 검색 미연결 — {{ mcpState.reason === 'url_or_token_missing' ? '주소·토큰 없음' : '꺼짐' }}
          </p>

          <!-- 🔴 무엇을 하는 중인지 알린다 — 20~30초 동안 아무 표시가 없으면 멈춘 줄 안다 -->
          <p v-if="analystLoading && analystStage" class="analyst__stage">
            <span class="analyst__dot" aria-hidden="true"></span>{{ analystStage }}…
          </p>
          <p v-if="analystError" class="banner banner--error">{{ analystError }}</p>
          <p v-else-if="!report" class="banner banner--empty">
            아직 분석 기록이 없습니다. <b>장 마감</b>과 <b>모멘텀 발생</b> 시 자동으로 돌고,
            지금 보려면 <b>분석 실행</b>을 누르세요.
          </p>

          <template v-else>
            <!-- ★ 새 기능이 **실제로 돌았다는 증거**를 화면에 둔다 — 0 이면 스스로 알려준다 -->
            <p v-if="report.web" class="analyst__src">
              <template v-if="report.web.ok">웹 검색 {{ report.web.hits }}건 반영 · {{ report.web.tool }}</template>
              <template v-else>웹 검색 미반영 — {{ report.web.error }}</template>
            </p>
            <!-- 🔴 **언제·왜 돌았는지** 보여준다 — 자동 실행으로 바뀌었으니 안 그러면 언제 것인지 모른다 -->
            <p v-if="report.at || report.trigger?.why" class="analyst__when">
              <template v-if="report.at">{{ new Date(report.at).toLocaleString('ko-KR') }}</template>
              <template v-if="report.trigger?.why"> · {{ report.trigger.why }}</template>
            </p>
            <p class="analyst__view">{{ report.marketView }}</p>
            <p class="analyst__mom">{{ report.momentumRead }}</p>

            <!-- 🔴 제안 — 승인해야만 진행된다. 실행은 아직 no-op 이다 -->
            <div v-if="proposals.length" class="props">
              <h3 class="panel__h">매매 제안 <small>승인해야 진행됩니다</small></h3>
              <article v-for="p in proposals" :key="p.id" class="prop" :class="`prop--${p.side.toLowerCase()}`">
                <header class="prop__head">
                  <span class="prop__side">{{ p.side === 'BUY' ? '매수' : '매도' }}</span>
                  <span class="prop__sym">{{ p.symbol }}</span>
                  <span class="prop__status">{{ statusLabel(p) }}</span>
                </header>
                <dl class="prop__grid">
                  <div><dt>수량</dt><dd class="mono-num">{{ p.quantity }}</dd></div>
                  <div><dt>지정가</dt><dd class="mono-num">{{ p.price }}</dd></div>
                  <div><dt>평가금액</dt><dd class="mono-num">{{ (p.quantity * p.price).toLocaleString() }}</dd></div>
                </dl>
                <p class="prop__why">{{ p.reason }}</p>
                <div v-if="p.status === 'PENDING'" class="prop__act">
                  <button class="btn btn--sm" @click="decide(p, 'reject')">거절</button>
                  <button class="btn btn--sm btn--primary" @click="decide(p, 'approve')">승인</button>
                </div>
                <div v-else-if="p.status === 'APPROVED'" class="prop__act">
                  <!--
                    🔴 **버튼 이름이 사실을 말한다.** 종전엔 `실행(모의)` 로 박혀 있어서
                    스위치를 켜는 순간 이름이 거짓이 됐다. 서버가 주는 모드로 갈린다.
                  -->
                  <button
                    class="btn btn--sm"
                    :class="ordersMode === 'live' ? 'btn--danger' : 'btn--soft'"
                    @click="decide(p, 'execute')"
                  >{{ ordersMode === 'live' ? '🔴 실주문 전송' : '실행(모의)' }}</button>
                </div>
                <p v-else-if="p.result" class="prop__note">{{ p.result.note }}</p>
              </article>
            </div>

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

                <dl v-if="ps.entry || ps.stop || ps.target" class="pos__lv">
                  <div v-if="ps.entry"><dt>진입</dt><dd class="mono-num">{{ ps.entry }}</dd></div>
                  <div v-if="ps.stop"><dt>손절</dt><dd class="mono-num">{{ ps.stop }}</dd></div>
                  <div v-if="ps.target"><dt>목표</dt><dd class="mono-num">{{ ps.target }}</dd></div>
                  <div v-if="ps.trade?.sizedQuantity != null">
                    <dt>수량</dt><dd class="mono-num">{{ ps.trade.sizedQuantity }}주</dd>
                  </div>
                </dl>
                <p v-if="ps.trade?.sizeNote" class="pos__rrbad">{{ ps.trade.sizeNote }}</p>
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

          <!-- 🔴 분석·알림·제안·승인을 **한 시간축**으로 (사용자 지시) -->
          <div class="tl">
            <h3 class="panel__h">활동 기록 <small>{{ activity.length }}</small></h3>
            <p v-if="!activity.length" class="panel__empty">아직 기록이 없습니다.</p>
            <ol v-else class="tl__list">
              <li v-for="(a, i) in activity" :key="i" class="tl__row">
                <span class="tl__icon" aria-hidden="true">{{ ACT_ICON[a.kind] || '·' }}</span>
                <time class="tl__at mono-num">{{ actTime(a.at) }}</time>
                <span class="tl__text">{{ a.title }}</span>
              </li>
            </ol>
          </div>
        </section>

        <section class="news">
          <header class="news__head">
            <h3 class="panel__h">
              뉴스
              <small v-if="selected.symbol">{{ selected.name || selected.symbol }}</small>
            </h3>
            <button class="iconbtn" :disabled="!selected.symbol || news.loading" aria-label="뉴스 새로고침" title="뉴스 새로고침" @click="loadNews">
              {{ news.loading ? '…' : '⟳' }}
            </button>
          </header>
          <p v-if="!selected.symbol" class="panel__empty">종목을 고르면 뉴스를 찾습니다.</p>
          <p v-else-if="news.loading" class="panel__empty">검색 중…</p>
          <!-- 🔴 "없다" 와 "못 받았다" 를 구분해 보여준다 -->
          <p v-else-if="news.error" class="panel__err">{{ news.error }}</p>
          <p v-else-if="!news.items.length" class="panel__empty">검색 결과가 없습니다.</p>
          <ul v-else class="news__list">
            <li v-for="n in news.items" :key="n.rank">
              <a v-if="n.url" :href="n.url" target="_blank" rel="noopener" class="news__title">{{ n.title }}</a>
              <span v-else class="news__title">{{ n.title }}</span>
              <!-- ⚠️ 날짜를 반드시 보여준다 — 실측에서 **6개월 지난 기사**가 섞여 왔다 -->
              <time v-if="n.when" class="news__when">{{ n.when }}</time>
            </li>
          </ul>
        </section>
      <!-- 행3·1열 : 차트 -->
      <div class="cell cell--chart">
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
          <div class="signals">


            <!--
              🔴 2026-09-21 사용자: *"타이틀이랑 하단 정보가 안 맞는데. 차라리 그냥 정형화된
                 테이블로 라도 하지"* ⇒ 목록을 **표**로 바꿨다.
              ★ 목록형은 **어느 제목에 속한 줄인지**가 들여쓰기로만 표현돼서, 그룹이 4개로
                늘어나자 제목과 내용이 어긋나 보였다. 표는 **열이 뜻을 고정**한다.
              ⚠️ 그룹을 한 번에 다 펼치지 않고 **탭으로 하나씩** 본다 — 네 덩어리를 세로로
                 쌓으면 어느 것이 어느 제목 밑인지 다시 헷갈린다.
            -->
            <div class="panel">
              <h3 class="panel__h">랭킹</h3>
              <p v-if="partError('rankings')" class="panel__err">{{ partError('rankings').error }}</p>
              <template v-else>
                <div v-if="rankKeys.length" class="rank__tabs">
                  <button
                    v-for="k in rankKeys" :key="k"
                    class="rank__tab" :class="{ 'rank__tab--on': k === rankTab }"
                    @click="rankTab = k"
                  >{{ rankLabel(k) }}</button>
                </div>
                <p v-if="!rankKeys.length" class="panel__empty">랭킹을 불러오지 못했습니다.</p>
                <template v-else-if="activeRank">
                  <!-- 🔴 이 종류만 실패했으면 그렇게 말한다("없음" 과 다르다) -->
                  <p v-if="activeRank.error" class="rank__err">{{ activeRank.error }}</p>
                  <p v-else-if="!activeRank.rows?.length" class="panel__empty">해당 종목 없음</p>
                  <div v-else class="rtable__scroll">
                  <table class="rtable">
                    <thead>
                      <tr><th class="rtable__n">#</th><th>종목</th><th class="rtable__r">등락률</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in visibleRankRows" :key="row.symbol">
                        <td class="rtable__n mono-num">{{ row.rank }}</td>
                        <td>
                          <!-- ⚠️ 이름이 없으면 코드를 보여준다(빈칸보다 낫다) -->
                          <button class="linkish" :title="row.symbol" @click="pickSymbol(row.symbol, row.name || row.symbol)">
                            {{ row.name || row.symbol }}
                          </button>
                          <!-- 🔴 이름이 붙었을 때만 코드를 따로 보여준다(같은 값을 두 번 쓰지 않는다) -->
                          <small v-if="row.name" class="rtable__sym mono-num">{{ row.symbol }}</small>
                        </td>
                        <td class="rtable__r mono-num" :class="signClass(row.changePct)">{{ pct(row.changePct) }}</td>
                      </tr>
                    </tbody>
                  </table>
                  </div>
                </template>
              </template>

              <!--
                🔴 사용자: *"검색은 최하단에 붙여줘."*
                ★ 검색은 **결과를 본 뒤에** 쓰는 것이라 목록 아래가 맞다 —
                  위에 있으면 매번 랭킹을 한 칸 밀어낸다.
              -->

              <!--
                🔴 사용자: *"티커/한국 주식 검색창 제공 · 클릭시 좌측 차트 반응"*
                ⚠️ 이건 **거르는 칸이 아니라 찾는 칸**이다 — 랭킹에 없는 종목도
                   코드를 넣으면 차트를 띄울 수 있어야 검색창의 뜻이 산다.
              -->
              <form class="rank__find" @submit.prevent="findSymbol">
                <input v-model="rankQuery" class="input input--xs" placeholder="종목명·티커 (예: 삼성전자)" />
                <button class="iconbtn" type="submit" :disabled="!rankQuery.trim() || findBusy" aria-label="조회" title="조회">
                  {{ findBusy ? '…' : '🔍' }}
                </button>
              </form>
              <p v-if="findError" class="panel__err">{{ findError }}</p>
            </div>
          </div>
      </aside>
        <!-- ── 애널리스트와 채팅 (레이아웃 지시: 우열) ─────────── -->
        <section class="chat">
          <header class="chat__head">
            <h3 class="panel__h">애널리스트와 대화</h3>
            <div class="chat__headacts">
              <span class="chat__tools">도구 {{ 7 }}개</span>
              <button
                class="iconbtn"
                :disabled="clearing || !messages.length"
                aria-label="대화 초기화"
                title="대화 이력을 지웁니다(서버 기록도 함께)"
                @click="clearChat"
              >{{ clearing ? '…' : '🗑' }}</button>
            </div>
          </header>

          <div ref="chatBox" class="chat__log" @scroll="onChatScroll">
            <p v-if="!messages.length" class="panel__empty">
              보유 종목·시황을 물어보세요. 필요하면 시세·차트·뉴스를 <b>직접 찾아서</b> 답합니다.
            </p>
            <article v-for="(m, i) in messages" :key="i" class="msg" :class="`msg--${m.role}`">
              <!-- 사고 과정: 접어 둔다. 🔴 답과 섞으면 무엇이 근거인지 알 수 없다 -->
              <details v-if="m.thinking" class="msg__think">
                <summary>생각 ({{ m.thinking.length }}자)</summary>
                <pre>{{ m.thinking }}</pre>
              </details>

              <!-- 도구 호출: 무엇을 부르고 무엇을 받았는지 그대로 -->
              <ul v-if="m.tools && m.tools.length" class="msg__tools">
                <li v-for="t in m.tools" :key="t.id" class="tool" :class="`tool--${t.state}`">
                  <span class="tool__name">{{ t.name }}</span>
                  <span class="tool__args mono-num">{{ JSON.stringify(t.args) }}</span>
                  <span class="tool__state">{{ t.state === 'running' ? '…' : t.state === 'ok' ? '✓' : '✕' }}</span>
                  <span v-if="t.detail" class="tool__detail">{{ t.detail }}</span>
                </li>
              </ul>

              <p v-if="m.recall" class="msg__recall">과거 대화 {{ m.recall }}건을 참고했습니다.</p>
              <!--
                🔴 **모델 답만** 마크다운으로 렌더한다. 사용자 발화는 평문 그대로 —
                   내가 쓴 글을 HTML 로 바꿀 이유가 없고, 표면만 넓힌다.
                ⚠️ `v-html` 을 쓰므로 `renderMarkdown` 안에서 **반드시 소독**한다
                   (웹 검색 결과가 답에 섞여 들어온다 = 외부 입력이다).
              -->
              <div
                v-if="m.text && m.role === 'assistant'"
                class="msg__text md"
                v-html="renderMarkdown(m.text)"
              ></div>
              <div v-else-if="m.text" class="msg__text">{{ m.text }}</div>
              <!-- 아직 아무것도 안 온 상태를 빈칸으로 두지 않는다 -->
              <span v-else-if="!m.done" class="msg__wait">생각 중…</span>
              <p v-if="m.notice" class="msg__notice">{{ m.notice }}</p>
            </article>
          </div>

          <!-- 위를 읽는 중에 새 답이 오면 **끌어내리지 않고** 알려만 준다 -->
          <button v-if="hasUnseen" class="chat__jump" @click="scrollChat({ force: true })">
            ↓ 새 답이 있습니다
          </button>

          <p v-if="chatError" class="banner banner--error">{{ chatError }}</p>

          <form class="chat__form" @submit.prevent="sendChat">
            <input
              v-model="chatInput"
              class="input"
              :disabled="chatBusy"
              placeholder="예: QLD 지금 더 사도 될까?"
            />
            <button class="btn btn--ai" type="submit" :disabled="chatBusy || !chatInput.trim()">
              {{ chatBusy ? '…' : '보내기' }}
            </button>
          </form>
        </section>
    </div>

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" @saved="loadDashboard(); restartDashTimer()" />
  </div>
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
  .deck {
    grid-template-columns: minmax(0, 53fr) minmax(0, 15fr) minmax(0, 32fr);
    grid-template-rows: minmax(0, 183fr) minmax(0, 131fr) minmax(0, 278fr);
    overflow: hidden;
  }
  /* 중·우열이 행2~3 을 세로로 먹는다 */
  .deck > .layout__signals { grid-column: 2; grid-row: 2 / span 2; }
  .deck > .chat { grid-column: 3; grid-row: 2 / span 2; }
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
.input { flex: 1; min-width: 0; }
.input::placeholder { color: var(--color-faint); }
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
.btn {
  display: inline-flex;
  /* 헤더가 낮아졌다 */
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  height: 32px;
  padding: 0 var(--space-base);
  border: 1px solid var(--color-hairline-strong);
  border-radius: var(--rounded-md);
  background: var(--color-surface-raised);
  color: var(--color-ink);
  font-size: var(--text-md);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}
.btn:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-hairline-strong); }
.btn:disabled { opacity: 0.42; cursor: not-allowed; }
.btn--sm { height: 34px; padding: 0 var(--space-base); font-size: var(--text-sm); }

/* 🔴 주 행동 — 직전 판은 여기에 색이 없어서 버튼이 안 보였다 */
.btn--primary {
  background: var(--color-primary);
  border-color: transparent;
  color: var(--color-on-primary);
}
.btn--primary:hover:not(:disabled) { background: var(--color-primary-hover); }
.btn--primary:active:not(:disabled) { background: var(--color-primary-active); }

/* AI 가 하는 일은 AI 색으로 — 사람이 누르는 다른 버튼과 구분된다 */
.btn--ai {
  background: var(--color-ai-soft);
  border-color: var(--color-ai-line);
  color: var(--color-ai);
}
.btn--ai:hover:not(:disabled) { background: var(--color-ai-line); color: var(--color-ink); }

.btn--soft {
  background: var(--color-primary-soft);
  border-color: var(--color-primary-line);
  color: var(--color-primary);
}
.btn--soft:hover:not(:disabled) { background: var(--color-primary); color: var(--color-on-primary); }

.btn--ghost { background: transparent; }

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

.iconbtn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--rounded-sm);
  color: var(--color-muted);
  font-size: var(--text-lg);
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.iconbtn:hover { background: var(--color-surface-hover); color: var(--color-ink); }
.iconbtn--danger:hover { background: var(--color-danger-soft); color: var(--color-danger); }

/* ── 안내 ─────────────────────────────────────────── */
.banner {
  margin: 0;
  padding: var(--space-base) var(--space-md);
  border-radius: var(--rounded-md);
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  color: var(--color-body);
  font-size: var(--text-md);
}
.banner--error {
  background: var(--color-danger-soft);
  border-color: transparent;
  color: var(--color-danger);
}
.banner--empty {
  border-style: dashed;
  text-align: center;
  color: var(--color-muted);
}

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
.assets__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.assets__title { display: flex; align-items: center; gap: var(--space-sm); }
.assets__title h2 { margin: 0; font-size: var(--text-base); font-weight: 700; color: var(--color-ink); }
.assets__badge {
  font-size: var(--text-2xs); font-weight: 700; letter-spacing: 0.1em;
  padding: 2px 6px; border-radius: var(--rounded-xs);
  background: var(--color-primary-soft); color: var(--color-primary);
}
.assets__note { font-size: var(--text-xs); color: var(--color-muted); }

.kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-xs);
}
.kpi {
  display: flex; flex-direction: column; gap: 1px;
  padding: var(--space-sm) var(--space-base);
  background: var(--color-surface-sunken);
  border-radius: var(--rounded-md);
}
.kpi__label { font-size: var(--text-2xs); letter-spacing: 0.06em; color: var(--color-faint); }
/* 🔴 사용자: *"내 자산 부분 크기 좀 더 줄여"* — 상단으로 올라가므로 한 줄을 낮춘다 */
.kpi__value { font-size: var(--text-base); font-weight: 700; color: var(--color-ink); }
.kpi__value--sub { font-size: var(--text-sm); color: var(--color-body); font-weight: 600; }
.kpi__value small { font-size: var(--text-sm); font-weight: 600; margin-left: 6px; opacity: 0.85; }
.up { color: var(--color-up); }
.down { color: var(--color-down); }
.flat { color: var(--color-body); }

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
.holdings { width: 100%; border-collapse: collapse; font-size: var(--text-md); }
.holdings thead th { position: sticky; top: 0; z-index: 1; background: var(--color-surface); }
.holdings th {
  text-align: left; font-size: var(--text-2xs); font-weight: 600; letter-spacing: 0.06em;
  color: var(--color-faint); padding: 0 var(--space-sm) var(--space-xs);
  border-bottom: 1px solid var(--color-hairline-soft);
}
.holdings td { padding: 5px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
/*
  🔴 2026-09-21 사용자: *"수량 평단, 평가손익 금일 변동치가 각 항목과 위치가 안맞는데"*
     원인은 데이터가 아니라 **CSS 특이도**였다 — `.holdings th`(0,1,1)가 `.ta-r`(0,1,0)를
     이겨서 **헤더만 왼쪽 정렬**되고 데이터는 오른쪽으로 갔다. 표는 이미 <table> 이었고
     열 폭도 맞았는데, **헤더 글자만 반대쪽에 붙어** 다른 열을 가리키는 것처럼 보였다.
  ★ 눈으로는 "데이터가 밀렸다" 로 보이지만 실제로 움직인 건 **헤더**다 —
    증상과 원인이 반대편에 있어서 데이터 정렬을 아무리 고쳐도 안 맞았을 자리.
*/
.holdings th.ta-r, .holdings td.ta-r { text-align: right; }
.holdings tr:last-child td { border-bottom: none; }
.holdings__name { display: block; font-weight: 600; color: var(--color-ink); }
.holdings__meta { display: block; font-size: var(--text-xs); color: var(--color-faint); }
.holdings small { font-size: var(--text-xs); opacity: 0.85; margin-left: 4px; }
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
.btn--xs { height: 26px; padding: 0; font-size: var(--text-sm); }

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
.layout__signals > .signals { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.signals > .panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rtable__scroll { flex: 1; min-height: 0; overflow-y: auto; }
.signals { display: flex; flex-direction: column; gap: var(--space-sm); }

/* ── HTS: 차트 + 사이드 패널 ──────────────────────── */
/* 신호 패널은 가운데 열로 옮겼다 — 차트는 자기 폭을 다 쓴다 */
.hts { display: block; }
.side { display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
.panel {
  background: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-base);
  display: flex; flex-direction: column; gap: var(--space-sm);
}
.panel__h {
  margin: 0; font-size: var(--text-xs); font-weight: 700;
  letter-spacing: 0.06em; color: var(--color-muted);
  display: flex; align-items: baseline; gap: 6px;
}
.panel__h small { font-weight: 500; color: var(--color-faint); }
.panel__empty { margin: 0; font-size: var(--text-sm); color: var(--color-faint); }
/* 🔴 "없음" 과 "못 받음" 은 다른 색이어야 한다 */
.panel__err { margin: 0; font-size: var(--text-sm); color: var(--color-down); }
.panel__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.panel__list li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); font-size: var(--text-md); }
.linkish {
  border: 0; background: none; padding: 0; cursor: pointer;
  color: var(--color-ink); font-size: var(--text-md); text-align: left;
}
.linkish:hover { color: var(--color-primary); }
.warnish { color: var(--color-warn); font-size: var(--text-sm); }
.rank { display: flex; flex-direction: column; gap: 4px; }
.rank__type { font-size: var(--text-2xs); color: var(--color-faint); letter-spacing: 0.06em; }
.rank__list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
.rank__list li { font-size: var(--text-sm); }
.rank__err { margin: 0; font-size: var(--text-xs); color: var(--color-down); }

.banner--warn {
  background: var(--color-warn-soft);
  border-color: transparent;
  color: var(--color-warn);
}
.holdings__row { cursor: pointer; }
.holdings__row:hover { background: var(--color-surface-hover); }
.holdings__row--on { background: var(--color-primary-soft); }
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
.iconbtn {
  width: 26px; height: 26px; padding: 0; font-size: 13px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm);
  background: var(--color-surface-sunken); color: var(--color-body); cursor: pointer;
}
.iconbtn:hover:not(:disabled) { background: var(--color-surface-hover); }
.iconbtn:disabled { opacity: 0.4; cursor: not-allowed; }

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

/* ── 선택 종목 뉴스 ──────────────────────────────── */
.news {
  /* 행2 칸을 그대로 채운다(가이드에서 뉴스는 독립 행이다) */
  min-height: 0;
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg); padding: var(--space-sm) var(--space-base);
  display: flex; flex-direction: column; gap: var(--space-xs);
  /* 뉴스가 길어도 차트를 밀어내지 않는다 — 차트가 주인공이다 */
  overflow-y: auto;
}
.news__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.news__head .panel__h { margin: 0; }
.news__head small { margin-left: 6px; color: var(--color-faint); font-weight: 500; }
.news__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.news__title { display: block; font-size: var(--text-xs); color: var(--color-body); text-decoration: none; }
a.news__title:hover { color: var(--color-primary); text-decoration: underline; }
.news__when { display: block; font-size: var(--text-2xs); color: var(--color-faint); }

/* ── 랭킹 표 ──────────────────────────────────────── */
.rank__find { display: flex; gap: 4px; margin-bottom: var(--space-xs); }
.rank__find .input { flex: 1; min-width: 0; }
.rank__tabs { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: var(--space-xs); }
.rank__tab {
  border: 0; background: var(--color-surface-sunken); color: var(--color-muted);
  font-size: var(--text-2xs); font-weight: 600; padding: 3px 8px;
  border-radius: var(--rounded-sm); cursor: pointer;
}
.rank__tab--on { background: var(--color-primary-soft); color: var(--color-primary); }
.rtable { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
.rtable th {
  text-align: left; font-weight: 600; color: var(--color-faint);
  font-size: var(--text-2xs); padding: 2px 4px; border-bottom: 1px solid var(--color-hairline);
}
.rtable td { padding: 3px 4px; border-bottom: 1px solid var(--color-hairline-soft); }
.rtable tr:last-child td { border-bottom: 0; }
/* ⚠️ 위와 **같은 함정**을 내가 이 표에도 넣었다(`.rtable th` 가 유틸 클래스를 이긴다).
      한 곳 고칠 때 저장소를 훑으라는 규칙의 CSS 판본 — 아래는 th·td 를 함께 짚는다. */
.rtable th.rtable__n, .rtable td.rtable__n { width: 1.6rem; color: var(--color-faint); text-align: right; }
.rtable th.rtable__r, .rtable td.rtable__r { text-align: right; white-space: nowrap; }
.rtable__sym { display: block; color: var(--color-faint); font-size: var(--text-2xs); }

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
.btn--danger { background: var(--color-down); color: #fff; border-color: var(--color-down); }
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
.pos__lv dt { font-size: var(--text-2xs); color: var(--color-faint); }
.pos__lv dd { margin: 0; font-size: var(--text-xs); color: var(--color-body); }
.pos__sc { margin: 2px 0 0; font-size: var(--text-2xs); }
.pos__sc--up { color: var(--color-up); }
.pos__sc--dn { color: var(--color-down); }

/* 종목 계층 평가 — 접어 두고, 펼치면 10항목이 다 보인다 */
.rt { margin: 4px 0 0; border-top: 1px solid var(--color-line); padding-top: 4px; }
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
