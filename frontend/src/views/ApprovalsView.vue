<!--
  승인 대기 (2026-10-04 전면 재구축 — 사용자 지시)

  "승인 대기 메뉴는 AI 애널리스트 보고의 사용자 허가 관련 내용이 나와야 한다.
   지금까지의 보고·매수/매도 제안 보고서를 취합해 이력 관리. 좌측 그리드, 선택하면 우측 상세."

  구성:
  ① 결정 영역(항상 위) — 지금 사람 손이 필요한 것들:
     PENDING 제안(OrderTicket 모달로 검토·승인·거절) · 승인됨 전송 대기 큐(실행/취소) ·
     거래소에 걸린 예약(조건부) 주문(취소).
  ② 좌우 분할 — 좌: 보고서 이력 그리드(/api/analyst/history) / 우: 선택한 보고서 상세
     + 그 보고서가 만든 제안들의 **현재** 상태(상태는 orders 가 정본 — 서버가 덧입혀 준다).

  🔴 실행 버튼 이름은 모드에서 유도하고 실거래 실행만 한 번 더 묻는다 —
     tests/liveModeUi.test.js 가 이 파일을 검사한다(대시보드에서 이사 온 계약).
-->
<template>
  <div class="page">
    <header class="page__head">
      <h1>승인 대기</h1>
      <span class="chip">대기 <b class="mono-num">{{ pending.length }}</b></span>
      <span class="chip">승인됨·전송대기 <b class="mono-num">{{ approved.length }}</b></span>
      <span style="flex:1"></span>
      <button v-if="pending.length" class="btn btn--sm" @click="rejectAll">모두 거절</button>
    </header>

    <!-- 🔴 실거래 모드는 버튼을 누르기 전에 보여야 한다 — 켜진 줄 모르고 쓰면 돈이 나간다 -->
    <p v-if="ordersMode === 'live'" class="ordmode">🔴 실거래 모드 — 실행 버튼은 실제 주문을 보냅니다</p>
    <p v-if="error" class="banner banner--error">{{ error }}</p>

    <!-- ── ① 대기 중 결정 — 사람 손이 필요한 것만 모아 맨 위에 ──────────── -->
    <section class="sect">
      <h2 class="sect__h">대기 중 결정</h2>
      <p v-if="!pending.length" class="panel__empty">승인 대기 중인 제안이 없습니다.</p>
      <div v-else class="list">
        <article v-for="pp in pending" :key="pp.id" class="rowcard" @click="picked = pp">
          <b :class="pp.side === 'BUY' ? 'up' : 'down'">{{ pp.side === 'BUY' ? '매수' : '매도' }}</b>
          <span class="rowcard__sym">{{ pp.symbol }}</span>
          <span class="mono-num">{{ pp.quantity }}주 @ {{ money(pp) }}</span>
          <span class="rowcard__why">{{ pp.reason }}</span>
          <!-- 마감까지 남은 시간 — 지나면 자동 만료라 알려야 한다 -->
          <span class="rowcard__ttl mono-num">{{ ttl(pp) }}</span>
          <button class="btn btn--xs btn--primary" @click.stop="picked = pp">검토</button>
        </article>
      </div>

      <template v-if="approved.length">
        <h2 class="sect__h">승인됨 · 전송 대기</h2>
        <!-- ⚠️ 승인 ≠ 전송 — 여기서 한 번 더 누르는 것이 실제 전송(OrderTicket 과 같은 원칙) -->
        <div class="list">
          <article v-for="p in approved" :key="p.id" class="rowcard">
            <b :class="p.side === 'BUY' ? 'up' : 'down'">{{ p.side === 'BUY' ? '매수' : '매도' }}</b>
            <span class="rowcard__sym">{{ p.symbol }}</span>
            <span class="mono-num">{{ p.quantity }}주 @ {{ money(p) }}</span>
            <span class="rowcard__why">{{ p.reason }}</span>
            <button class="btn btn--xs btn--primary" @click="decide(p, 'execute')">{{ ordersMode === 'live' ? '🔴 실주문 전송' : '실행(모의)' }}</button>
            <button class="btn btn--xs" @click="decide(p, 'reject')">취소</button>
          </article>
        </div>
      </template>

      <template v-if="conditionalOrders.length || conditionalError">
        <h2 class="sect__h">예약(조건부) 주문 <small class="sect__sub">거래소가 감시가 도달을 지켜보는 중</small></h2>
        <p v-if="conditionalError" class="panel__err">⚠️ {{ conditionalError }}</p>
        <div class="list">
          <article v-for="o in conditionalOrders" :key="o.conditionalOrderId || o.id" class="rowcard">
            <b :class="(o.first?.orderSide || o.orderSide) === 'BUY' ? 'up' : 'down'">
              예약 {{ (o.first?.orderSide || o.orderSide) === 'BUY' ? '매수' : '매도' }}
            </b>
            <span class="rowcard__sym">{{ o.symbol }}</span>
            <span class="rowcard__info">감시가 <b class="mono-num">{{ o.first?.triggerPrice ?? '—' }}</b></span>
            <span class="rowcard__info">주문가 <b class="mono-num">{{ o.first?.orderPrice ?? '시장가' }}</b></span>
            <span class="rowcard__info"><b class="mono-num">{{ o.quantity }}</b>주</span>
            <span class="rowcard__info">만료 <b class="mono-num">{{ o.expireDate ?? '—' }}</b></span>
            <span class="rowcard__why">{{ o.status || 'OPEN' }}</span>
            <button class="btn btn--xs btn--danger" @click="cancelConditional(o)">취소</button>
          </article>
        </div>
      </template>
    </section>

    <!-- ── ② 보고서 이력 — 좌: 그리드 / 우: 선택 상세 ───────────────────── -->
    <section class="sect split">
      <div class="hist">
        <h2 class="sect__h">AI 애널리스트 보고 이력</h2>
        <p v-if="histError" class="panel__err">{{ histError }}</p>
        <!-- 이력 저장은 2026-10-04 신설 — 그 전 보고서는 남아 있지 않다 -->
        <p v-else-if="histLoaded && !hist.length" class="panel__empty">아직 이력이 없습니다. 다음 분석부터 쌓입니다.</p>
        <div v-else class="hgrid">
          <article v-for="h in hist" :key="h.id || h.at" class="hrow" :class="{ 'hrow--on': (h.id || h.at) === selId }" @click="pick(h)">
            <div class="hrow__top">
              <span class="hrow__when mono-num">{{ when(h.at) }}</span>
              <!-- 이력 체계(10-04) 이전 분석은 활동 기록의 한 줄 요약만 남아 있다 — 지어내지 않고 표시 -->
              <span v-if="h.kind === 'summary'" class="hrow__sum">요약만</span>
              <span v-else class="hrow__trig">{{ h.trigger || '—' }}</span>
            </div>
            <p class="hrow__mv">{{ h.marketView || '(시황 요약 없음)' }}</p>
            <!-- 어느 회차가 예산 판단을 냈는지 **목록에서** 보여야 한다 — 하나씩 열어 보면 아무도 안 본다 -->
            <div v-if="h.proposals?.length || budgetOf(h)" class="hrow__chips">
              <span v-if="budgetOf(h)" class="pchip pchip--budget"
                :class="`pchip--b-${budgetOf(h).action.toLowerCase()}`">
                예산 {{ BUDGET_SHORT[budgetOf(h).action] }}
              </span>
              <span v-for="pr in h.proposals" :key="pr.id || pr.symbol" class="pchip"
                :class="pr.side === 'BUY' ? 'pchip--buy' : 'pchip--sell'">
                {{ pr.side === 'BUY' ? '매수' : '매도' }} {{ pr.symbol }}
              </span>
            </div>
          </article>
        </div>
      </div>

      <div class="detail">
        <h2 class="sect__h">보고서 상세</h2>
        <p v-if="detailError" class="panel__err">{{ detailError }}</p>
        <p v-else-if="!sel" class="panel__empty">왼쪽 이력에서 보고서를 선택하세요.</p>
        <!-- ⚠️ dryRun 점검 회차도 summaryOnly 로 온다 — "10-04 전" 단정은 점검 회차에서 거짓말이 된다(2026-10-06) -->
        <p v-if="sel?.summaryOnly" class="banner banner--empty">
          이 회차는 전문이 보존되지 않았습니다 — <b>한 줄 요약만</b> 남아 있습니다(10-04 이전 회차 또는 점검 실행).
        </p>
        <template v-else>
          <p class="detail__meta">
            <span class="mono-num">{{ when(sel.at) }}</span>
            <span class="chip">{{ trigLabel(sel.trigger) }}</span>
          </p>

          <template v-if="sel.report?.marketView">
            <h3 class="detail__h">시황</h3>
            <p class="detail__txt">{{ sel.report.marketView }}</p>
          </template>

          <template v-if="sel.report?.momentumRead">
            <h3 class="detail__h">모멘텀 읽기</h3>
            <p class="detail__txt">{{ sel.report.momentumRead }}</p>
          </template>

          <!--
            🔴 **AI 예산 판단** (2026-10-06) — 자율 1단 + AI 전용 예산이 가동 중인데 매매가 0건일 때,
               *"안 산 날도 왜 안 샀는지"* 를 회차마다 읽을 수 있어야 한다. 침묵은 "고장" 과 구분되지 않는다.
            ⚠️ 없으면 **아무것도 그리지 않는다** — 빈 껍데기·"없음" 플레이스홀더는 *판단이 실렸는지* 를 흐린다.
               (그 "없음" 을 알려야 하는 자리는 대시보드 쪽 경고 한 줄이다. 여기는 보고서 열람이다.)
          -->
          <template v-if="selBudget">
            <h3 class="detail__h">AI 예산 판단</h3>
            <div class="bdec">
              <span class="bdec__badge" :class="`bdec__badge--${selBudget.action.toLowerCase()}`">
                {{ BUDGET_LABEL[selBudget.action] }}
              </span>
              <span v-if="selBudget.symbol" class="bdec__sym">{{ selBudget.symbol }}</span>
              <p v-if="selBudget.reason" class="bdec__why">{{ selBudget.reason }}</p>
            </div>
          </template>

          <template v-if="sel.report?.positions?.length">
            <h3 class="detail__h">종목 판단</h3>
            <article v-for="ps in sel.report.positions" :key="ps.symbol" class="pos">
              <header class="pos__head">
                <b>{{ ps.symbol }}</b>
                <span class="pos__stance" :class="`pos__stance--${String(ps.stance || '').toLowerCase()}`">{{ ps.stance }}</span>
                <span class="pos__conf">{{ ps.confidence }}</span>
              </header>
              <p class="pos__why">{{ ps.rationale }}</p>
              <p v-if="ps.scenarioUp" class="pos__sc"><b class="up">상승 시</b> {{ ps.scenarioUp }}</p>
              <p v-if="ps.scenarioDown" class="pos__sc"><b class="down">하락 시</b> {{ ps.scenarioDown }}</p>
            </article>
          </template>

          <template v-if="sel.report?.dataGaps?.length">
            <h3 class="detail__h">데이터 공백</h3>
            <!-- 🔴 모델이 "못 본 것" 을 숨기지 않는다 — 빈칸은 "문제 없음" 으로 읽힌다 -->
            <ul class="gaps">
              <li v-for="(g, i) in sel.report.dataGaps" :key="i">{{ g }}</li>
            </ul>
          </template>

          <h3 class="detail__h">이 보고서가 만든 제안</h3>
          <p v-if="!sel.proposals?.length" class="panel__empty">이 보고서에서 만들어진 제안이 없습니다.</p>
          <div v-else class="list">
            <article v-for="pr in sel.proposals" :key="pr.id" class="dprop">
              <b :class="pr.side === 'BUY' ? 'up' : 'down'">{{ pr.side === 'BUY' ? '매수' : '매도' }}</b>
              <span class="rowcard__sym">{{ pr.symbol }}</span>
              <span class="mono-num">{{ pr.quantity }}주 @ {{ money(pr) }}</span>
              <span class="dprop__status" :class="`dprop__status--${String(pr.status || 'gone').toLowerCase()}`">
                {{ statusLabel(pr.status) }}
              </span>
              <span v-if="pr.decidedAt" class="dprop__when mono-num">{{ when(pr.decidedAt) }}</span>
              <!-- PENDING 이면 여기서도 바로 결정할 수 있다 — 위 결정 영역과 같은 경로 -->
              <span v-if="pr.status === 'PENDING'" class="dprop__btns">
                <button class="btn btn--xs btn--primary" @click="decide(pr, 'approve')">승인</button>
                <button class="btn btn--xs" @click="decide(pr, 'reject')">거절</button>
              </span>
            </article>
          </div>
        </template>
      </div>
    </section>

    <!-- 검토 모달 = 기존 OrderTicket 재사용(사전점검·체결 후 포트폴리오·근거) -->
    <OrderTicket v-if="picked" :proposal="picked" :fetch-precheck="fetchPrecheck"
      @close="picked = null" @approve="decide($event, 'approve')" @reject="decide($event, 'reject')" @trim="trim" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiFetch } from '../lib/apiClient';
import OrderTicket from '../components/OrderTicket.vue';

// ── 제안(결정 영역) ───────────────────────────────────────────────
const rows = ref([]);
const error = ref('');
const picked = ref(null);
const ordersMode = ref('dry-run');

// 🔴 만료된 PENDING 은 결정 대상이 아니다 — "00:00 · 검토" 로 남아 사용자를 헷갈리게 했다
//    (2026-10-05 실화면). 서버 list() 가 expired 를 동봉한다 — 그걸 믿는다.
const pending = computed(() => rows.value.filter((p) => p.status === 'PENDING' && !p.expired));
const approved = computed(() => rows.value.filter((p) => p.status === 'APPROVED'));

async function loadProposals() {
  try {
    const r = await apiFetch('/api/orders/proposals');
    const body = await r.json();
    rows.value = Array.isArray(body) ? body : (body.proposals || []);
    // 🔴 모드는 서버가 말한 것을 쓴다 — 화면이 추측하면 스위치를 켠 날 이름이 거짓이 된다
    ordersMode.value = body.status?.effective || 'dry-run';
    error.value = '';
  } catch (e) { error.value = `제안 목록을 못 읽었습니다: ${e.message}`; }
}

async function fetchPrecheck(p) {
  // ⚠️ OrderTicket 은 id 를 넘긴다 — 객체·id 어느 쪽이 와도 받는다(호출 규약이 두 벌이었다)
  const id = p?.id ?? p;
  const r = await apiFetch(`/api/orders/proposals/${id}/precheck`);
  return r.json();
}

async function decide(p, action) {
  // 🔴 되돌릴 수 없는 것(실거래 실행)만 한 번 더 묻는다 — 승인·거절은 되돌릴 수 있어서
  //    매번 물으면 사람이 확인 자체를 끈다
  const live = ordersMode.value === 'live';
  if (action === 'execute' && live) {
    const sideKo = p.side === 'BUY' ? '매수' : '매도';
    if (!window.confirm(`🔴 실거래 모드입니다 — ${p.symbol} ${sideKo} ${p.quantity}주 실제 주문을 전송할까요?`)) return;
  }
  picked.value = null;
  try {
    await apiFetch(`/api/orders/proposals/${p.id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'approvals-page' }),
    });
  } catch (e) { error.value = `처리에 실패했습니다: ${e.message}`; }
  await loadProposals();
  // 상세의 제안 상태도 orders 를 덧입혀 오므로 같이 새로고침해야 화면이 사실을 말한다
  if (selId.value) await pick(selId.value);
}

async function trim({ proposal, quantity }) {
  await apiFetch(`/api/orders/proposals/${proposal.id}/reject`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: `수량 조정 ${quantity}주로 재제안 요청` }),
  });
  picked.value = null;
  await loadProposals();
}

async function rejectAll() {
  // 자율 트레이딩에서 사람이 피곤하면 승인 대신 방치가 일어난다 — 방치보다 일괄 거절이 낫다
  for (const p of pending.value) {
    await apiFetch(`/api/orders/proposals/${p.id}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '일괄 거절' }),
    });
  }
  await loadProposals();
}

const nowTick = ref(Date.now());
setInterval(() => { nowTick.value = Date.now(); }, 1000);
function ttl(p) {
  const exp = Date.parse(p.expiresAt || 0);
  if (!exp) return '';
  const s = Math.max(0, Math.round((exp - nowTick.value) / 1000));
  return `만료 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── 예약(조건부) 주문 — 이미 거래소에 등록돼 감시 중인 것들(제안과 다른 층) ──
const conditionalOrders = ref([]);
const conditionalError = ref('');

async function loadConditionals() {
  try {
    const r = await apiFetch('/api/orders/conditional');
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      conditionalOrders.value = body.items || [];
      conditionalError.value = '';
    } else {
      // ⚠️ 실패를 빈 목록으로 그리지 않는다 — "예약 없음" 과 "못 읽음" 은 다르다
      conditionalError.value = body.error || `조회 실패(${r.status})`;
    }
  } catch (e) { conditionalError.value = e?.message || '조회 실패'; }
}

async function cancelConditional(o) {
  const id = o.conditionalOrderId || o.id;
  try {
    await apiFetch(`/api/orders/conditional/${id}/cancel`, { method: 'POST' });
  } catch (e) { conditionalError.value = `취소에 실패했습니다: ${e.message}`; }
  await loadConditionals();
}

// ── 보고서 이력(좌 그리드 / 우 상세) ─────────────────────────────
const hist = ref([]);
const histError = ref('');
const histLoaded = ref(false);
const selId = ref('');
const sel = ref(null);
const detailError = ref('');

async function loadHistory() {
  try {
    const r = await apiFetch('/api/analyst/history?limit=100');
    const b = await r.json();
    hist.value = b.ok ? (b.items || []) : [];
    histError.value = b.ok ? '' : (b.error || '이력을 못 읽었습니다');
    // 첫 진입이면 최신 보고서를 자동 선택 — 빈 오른쪽은 "고장" 으로 읽힌다
    if (!selId.value && hist.value.length) await pick(hist.value[0]);
  } catch (e) { histError.value = `이력을 못 읽었습니다: ${e.message}`; }
  histLoaded.value = true;
}

async function pick(h) {
  // 문자열(id)로도, 행 객체로도 부를 수 있게 — 요약 행은 id 가 없다
  const row = typeof h === 'string' ? (hist.value.find((x) => x.id === h) || { id: h }) : h;
  selId.value = row.id || row.at;
  if (row.kind === 'summary') {
    // 전문이 없는 과거 회차 — 요약을 그대로 보여주고 그 사실을 말한다(빈 화면은 고장으로 읽힌다)
    sel.value = {
      ok: true, id: null, at: row.at, trigger: row.trigger,
      summaryOnly: true,
      report: { marketView: row.marketView, momentumRead: '', dataGaps: [], positions: [] },
      proposals: [],
    };
    detailError.value = '';
    return;
  }
  const id = row.id;
  try {
    const r = await apiFetch(`/api/analyst/history/${id}`);
    const b = await r.json();
    if (b.ok) { sel.value = b; detailError.value = ''; }
    else { sel.value = null; detailError.value = b.error || '보고서를 못 읽었습니다'; }
  } catch (e) { sel.value = null; detailError.value = `보고서를 못 읽었습니다: ${e.message}`; }
}

// ── 표시 도우미 ──────────────────────────────────────────────────
/** 한 줄에 들어가는 압축 포맷(MM-DD HH:mm) — 활동 로그와 같은 모양 */
function when(at) {
  if (!at) return '';
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 상세의 trigger 는 원본 그대로 온다(객체 또는 문자열) — 목록은 서버가 평탄화해 준다 */
function trigLabel(t) {
  if (!t) return '—';
  if (typeof t === 'string') return t;
  return t.why || t.kind || '—';
}

/** 통화기호 — 제안엔 통화 정보가 없어 심볼 모양으로 가른다(6자리 숫자 = KR) */
function money(p) {
  if (p?.price == null) return '시장가';
  const sign = /^\d{6}$/.test(String(p.symbol || '')) ? '₩' : '$';
  return `${sign}${Number(p.price).toLocaleString('ko-KR')}`;
}

/**
 * 🔴 **AI 예산 판단** — 서버 계약은 `report.budgetDecision` = `null` 또는
 *    `{ action: 'ENTER'|'HOLD'|'EXIT'|'WAIT', reason: string, symbol: string|null }`.
 *
 * ⚠️ **모양을 검사하고 나서 그린다.** 09-21 에 모델이 배열 스키마를 문자열로 줘서
 *    `.join()` 이 터지고 **Vue 가 서브트리를 통째로 버려** 패널 제목까지 사라진 전례가 있다
 *    (API 는 내내 200 이었다). 여기도 `action.toLowerCase()` 가 같은 모양이라,
 *    **받는 자리에서** enum 을 확인하고 아니면 `null` 로 떨군다.
 * ⚠️ 없는 필드를 추정하지 않는다 — 계약의 세 키만 읽는다(10-04 에 사이드바가 없는 필드를
 *    추정해 **실거래를 '모의' 로** 표시한 사고가 있었다).
 */
const BUDGET_LABEL = {
  ENTER: '진입 제안', HOLD: 'AI 보유 유지', EXIT: 'AI 보유 정리', WAIT: '대기 (미진입)',
};
/** 목록용 압축 표기 — 한 줄에 제안 칩들과 나란히 선다 */
const BUDGET_SHORT = { ENTER: '진입', HOLD: '유지', EXIT: '정리', WAIT: '대기' };

/** 계약에 맞는 것만 통과시킨다. 어긋나면 null = 아무것도 그리지 않는다 */
function normBudget(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (!Object.prototype.hasOwnProperty.call(BUDGET_LABEL, d.action)) return null;
  return {
    action: d.action,
    reason: typeof d.reason === 'string' ? d.reason : '',
    symbol: typeof d.symbol === 'string' && d.symbol ? d.symbol : null,
  };
}

/**
 * 이력 **목록** 행에서 꺼낸다.
 * ⚠️ 목록(`/api/analyst/history`)은 서버가 메타만 **재조립**해 주는 응답이라
 *    `marketView` 처럼 평탄화될 수도 있고 `report` 째로 올 수도 있다 — 두 자리를 다 본다.
 *    어느 쪽에도 없으면 칩을 안 그린다(조용한 것이 거짓말보다 낫다).
 */
const budgetOf = (h) => normBudget(h?.budgetDecision ?? h?.report?.budgetDecision);

/** 선택한 보고서 상세 — 여기는 전문이 오므로 `report.budgetDecision` 이 정본 */
const selBudget = computed(() => (sel.value?.summaryOnly ? null : normBudget(sel.value?.report?.budgetDecision)));

const STATUS_LABEL = {
  PENDING: '승인 대기', APPROVED: '승인됨', REJECTED: '거절', EXECUTED: '전송됨',
  DRY_RUN: '모의 실행됨', EXPIRED: '만료', BLOCKED: '차단',
};
// status=null 은 "orders 목록에서 밀려난 옛 제안" — 없는 것과 모르는 것을 구분해 적는다
const statusLabel = (s) => (s ? (STATUS_LABEL[s] || s) : '기록 없음');

let timer = null;
onMounted(() => {
  loadProposals(); loadConditionals(); loadHistory();
  timer = setInterval(() => { loadProposals(); loadConditionals(); loadHistory(); }, 15_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
/* 페이지 뼈대 — ActivityView 와 같은 패턴 */
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
/* 🔴 2026-10-06 사용자(세 번째 지적): "max-width 주지 말라고" — 콘텐츠 폭 상한(1440px)을
   전면 제거, 화면 전폭을 쓴다. 길어지는 목록은 max-height 내부 스크롤로 자른다(아래 .hgrid).
   ⚠️ 종전의 `.page > .ticket__scrim` 전폭 예외도 함께 제거 — 상한이 사라져 충돌 자체가
   없어졌고, OrderTicket 자체 규칙(fixed·inset:0·width:100vw·max-width:none)이 전폭을 보장한다. */

.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }

/* 🔴 실거래 배지 — 버튼보다 먼저 눈에 들어와야 한다 */
.ordmode { margin: 0; padding: 6px 12px; border: 1px solid var(--color-down); border-radius: var(--rounded-md); background: var(--color-down-soft); color: var(--color-down); font-size: var(--text-sm); font-weight: 600; }

.sect { display: flex; flex-direction: column; gap: var(--space-xs); }
.sect__h { margin: var(--space-xs) 0 0; font-size: var(--text-sm); color: var(--color-ink); font-weight: 700; }
.sect__sub { font-size: var(--text-2xs); color: var(--color-faint); font-weight: 400; }

/* 결정 영역의 한 줄 카드 */
.list { display: flex; flex-direction: column; gap: var(--space-xs); }
.rowcard {
  display: flex; align-items: center; gap: var(--space-sm);
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base);
  cursor: pointer; font-size: var(--text-sm);
}
.rowcard:hover { background: var(--color-surface-hover); }
.rowcard__sym { font-weight: 700; color: var(--color-ink); }
.rowcard__why { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted); font-size: var(--text-xs); }
.rowcard__ttl { color: var(--color-warn); font-size: var(--text-xs); white-space: nowrap; margin-left: auto; }
.rowcard > .btn { flex: none; white-space: nowrap; }
.rowcard__info { color: var(--color-body); font-size: var(--text-xs); white-space: nowrap; }

/* ② 좌우 분할 — 좌 이력 그리드 / 우 상세 */
.split { display: grid; grid-template-columns: minmax(300px, 36%) 1fr; gap: var(--space-base); align-items: start; }
.hist { display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
/* 이력이 길어도 화면 절반에서 자른다(내부 스크롤) — 아래 내용이 위로 끌려 올라온다 */
.hgrid { display: flex; flex-direction: column; gap: var(--space-xs); max-height: 50vh; overflow-y: auto; }
.hrow {
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base);
  cursor: pointer; display: flex; flex-direction: column; gap: 4px;
}
.hrow:hover { background: var(--color-surface-hover); }
.hrow--on { border-color: var(--color-primary-line); background: var(--color-primary-soft); }
.hrow__top { display: flex; align-items: baseline; gap: var(--space-sm); }
.hrow__when { color: var(--color-ink); font-size: var(--text-xs); white-space: nowrap; }
.hrow__sum { font-size: var(--text-2xs); color: var(--color-faint); border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 0 6px; }
.hrow__trig { color: var(--color-faint); font-size: var(--text-2xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hrow__mv {
  margin: 0; color: var(--color-body); font-size: var(--text-xs);
  /* 요약은 2줄에서 자른다 — 전문은 우측 상세가 보여준다 */
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.hrow__chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pchip { font-size: var(--text-2xs); border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 1px 8px; white-space: nowrap; }
.pchip--buy { color: var(--color-up); border-color: var(--color-up); }
.pchip--sell { color: var(--color-down); border-color: var(--color-down); }
/* 예산 판단 칩 — 제안 칩과 **한 줄에서 구분**돼야 한다(옅은 배경으로 갈랐다) */
.pchip--budget { font-weight: 600; }
.pchip--b-enter { color: var(--color-up); border-color: var(--color-up); background: var(--color-up-soft); }
.pchip--b-exit { color: var(--color-down); border-color: var(--color-down); background: var(--color-down-soft); }
.pchip--b-wait { color: var(--color-warn); border-color: var(--color-warn); background: var(--color-warn-soft); }
.pchip--b-hold { color: var(--color-flat); border-color: var(--color-flat); background: var(--color-flat-soft); }

/* 우측 상세 */
.detail {
  display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0;
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md); padding: var(--space-base);
}
.detail__meta { margin: 0; display: flex; align-items: center; gap: var(--space-sm); color: var(--color-ink); font-size: var(--text-sm); }
.detail__h { margin: var(--space-xs) 0 0; font-size: var(--text-xs); color: var(--color-faint); font-weight: 600; }
.detail__txt { margin: 0; color: var(--color-body); font-size: var(--text-sm); line-height: 1.6; }

/* 종목 판단 카드 */
.pos { border: 1px solid var(--color-hairline-soft); border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; gap: 4px; }
.pos__head { display: flex; align-items: baseline; gap: var(--space-sm); color: var(--color-ink); }
.pos__stance { font-size: var(--text-2xs); border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 1px 8px; color: var(--color-body); }
.pos__stance--buy { color: var(--color-up); border-color: var(--color-up); }
.pos__stance--sell { color: var(--color-down); border-color: var(--color-down); }
.pos__stance--hold { color: var(--color-flat); border-color: var(--color-flat); }
.pos__conf { color: var(--color-faint); font-size: var(--text-2xs); }
.pos__why { margin: 0; color: var(--color-body); font-size: var(--text-sm); line-height: 1.55; }
.pos__sc { margin: 0; color: var(--color-muted); font-size: var(--text-xs); }

/* AI 예산 판단 블록 — 배지 + 대상 종목 + 이유. 색은 전부 토큰(라이트/다크 둘 다 따라온다) */
.bdec {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--space-sm);
  border: 1px solid var(--color-hairline-soft); border-radius: var(--rounded-md);
  padding: var(--space-sm) var(--space-base);
}
.bdec__badge {
  font-size: var(--text-2xs); font-weight: 700; white-space: nowrap;
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px;
  color: var(--color-body);
}
.bdec__badge--enter { color: var(--color-up); border-color: var(--color-up); background: var(--color-up-soft); }
.bdec__badge--exit { color: var(--color-down); border-color: var(--color-down); background: var(--color-down-soft); }
.bdec__badge--wait { color: var(--color-warn); border-color: var(--color-warn); background: var(--color-warn-soft); }
.bdec__badge--hold { color: var(--color-flat); border-color: var(--color-flat); background: var(--color-flat-soft); }
.bdec__sym { font-weight: 700; color: var(--color-ink); font-size: var(--text-sm); }
.bdec__why { margin: 0; flex: 1 1 100%; min-width: 0; color: var(--color-body); font-size: var(--text-sm); line-height: 1.55; }

.gaps { margin: 0; padding-left: 18px; color: var(--color-warn); font-size: var(--text-xs); display: flex; flex-direction: column; gap: 2px; }

/* 보고서가 만든 제안 + 현재 상태 */
.dprop { display: flex; align-items: center; gap: var(--space-sm); border: 1px solid var(--color-hairline-soft); border-radius: var(--rounded-md); padding: var(--space-xs) var(--space-base); font-size: var(--text-sm); }
.dprop__status { font-size: var(--text-2xs); border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 1px 8px; color: var(--color-body); white-space: nowrap; }
.dprop__status--pending { color: var(--color-warn); border-color: var(--color-warn); }
.dprop__status--approved, .dprop__status--executed, .dprop__status--dry_run { color: var(--color-open); border-color: var(--color-open); }
.dprop__status--rejected, .dprop__status--expired, .dprop__status--blocked { color: var(--color-down); border-color: var(--color-down); }
.dprop__when { color: var(--color-faint); font-size: var(--text-2xs); }
.dprop__btns { display: inline-flex; gap: 4px; margin-left: auto; }
</style>
