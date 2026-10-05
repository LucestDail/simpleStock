<!--
  D-9 전략 연구소 (2026-10-05 전면 재설계)
  "전략이 카드로 쭉 보이고 → 클릭하면 상세 모달 → 체크로 조합해 백테스트 →
   시계열 차트와 수익률 비교가 즉시 크게" — 종전 좌/우 2단은 목록·상세·결과가
   한 화면에서 서로를 밀어내 "보기가 너무 불편"했다 ⇒ 카드 그리드 + 모달로 분리.

  구조: 카드 그리드(체크=조합·클릭=모달) → 조합 백테스트 카드(세계 4종·경과·히어로 수치·차트) → 승급 목록
  🔴 수정은 서버가 검증한다(필드 허용목록·쓰기 전 재파싱·백업) — 그 전제로 모달 편집기를 연다.
-->
<template>
  <div class="page">
    <header class="page__head">
      <h1>전략 연구소</h1>
      <span class="chip">판정 = 제품과 같은 코드 decideOnContext</span>
      <span v-if="regimeLabel" class="chip">국면 {{ regimeLabel }}</span>
      <span class="page__sp"></span>
      <span class="chip mono-num">시나리오 {{ scenarios.length }}</span>
    </header>
    <p v-if="error" class="banner banner--error">{{ error }}</p>
    <p class="mut">플레이북 정본은 서버 config — 저장 시 서버가 검증·백업 후 라이브 판정에 즉시 반영한다.
      카드 체크 = 백테스트 조합 · 카드 클릭 = 상세/편집.</p>

    <!-- ── 시나리오 카드 그리드 ── -->
    <div class="grid">
      <article
        v-for="sc in scenarios" :key="sc.id"
        class="sc" :class="{ 'sc--on': checked.has(sc.id) }"
        @click="openModal(sc.id)"
      >
        <div class="sc__top">
          <!-- 체크는 카드 클릭(모달)과 분리 — .stop 이 없으면 체크할 때마다 모달이 뜬다 -->
          <input class="sc__pick" type="checkbox" :checked="checked.has(sc.id)" @click.stop @change="toggle(sc.id)" />
          <b class="sc__name">{{ sc.name }}</b>
        </div>
        <small class="sc__id mono-num">{{ sc.id }}</small>
        <p class="sc__match">{{ matchLabel(sc.match) }}</p>
        <div v-if="(sc.categories || []).length" class="sc__chips">
          <span v-for="c in sc.categories.slice(0, 4)" :key="c" class="sc__chip">{{ c }}</span>
          <span v-if="sc.categories.length > 4" class="sc__chip">+{{ sc.categories.length - 4 }}</span>
        </div>
      </article>
    </div>
    <p v-if="!scenarios.length && !error" class="panel__empty">플레이북을 불러오는 중입니다…</p>

    <!-- ── 조합 백테스트 (그리드 아래 고정 카드) ── -->
    <section class="card">
      <h2>조합 백테스트 <small class="mut">합성 시나리오 75일 · 제품과 같은 판정 경로</small></h2>
      <p class="warn">🔴 실행하면 <b>LLM 을 실제로 태웁니다</b>(수 분 + 토큰). 동시 1개만 돕니다.</p>
      <p class="mut">
        <template v-if="checked.size">발동 허용: <b class="mono-num">{{ [...checked].join(', ') }}</b> — 체크한 시나리오만 매뉴얼로 발동합니다.</template>
        <template v-else>체크 없음 — 플레이북 <b>전체</b>가 평소처럼 발동합니다.</template>
      </p>
      <div class="bt__row">
        <button v-for="(label, key) in LABEL" :key="key" class="btn" :disabled="!!running" @click="runBt(key)">{{ label }}</button>
        <span v-if="running" class="chip">⏳ {{ LABEL[running.scenario] || running.scenario }} 실행 중 — {{ since(running.startedAt) }} 경과</span>
      </div>

      <div v-if="last" class="btres">
        <h3>마지막 결과 — {{ LABEL[last.scenario] || last.scenario }}
          <small class="mut">{{ when(last.finishedAt) }}</small>
          <small v-if="last.onlyScenarios" class="chip">조합: {{ last.onlyScenarios.join(', ') }}</small>
        </h3>

        <!-- 수익률 비교 히어로 — 결과가 끝나자마자 숫자부터 크게 -->
        <div v-if="last.ok" class="hero">
          <div class="hero__cell">
            <span class="hero__lbl">운용 (판정 경로)</span>
            <b class="hero__num mono-num" :class="pct(last.final) >= 0 ? 'up' : 'down'">{{ fmtPct(pct(last.final)) }}%</b>
            <small class="mut mono-num">$10,000 → ${{ fmt(last.final) }}</small>
          </div>
          <div class="hero__cell">
            <span class="hero__lbl">벤치마크 QQQ 보유</span>
            <b class="hero__num mono-num" :class="pct(last.bench) >= 0 ? 'up' : 'down'">{{ fmtPct(pct(last.bench)) }}%</b>
            <small class="mut mono-num">$10,000 → ${{ fmt(last.bench) }}</small>
          </div>
          <div class="hero__cell hero__cell--ex" :class="excess >= 0 ? 'up' : 'down'">
            <span class="hero__lbl">초과</span>
            <b class="hero__num mono-num">{{ fmtPct(excess) }}%p</b>
            <small class="mut mono-num">{{ excess >= 0 ? '벤치를 이겼다' : '벤치에 뒤졌다' }}</small>
          </div>
        </div>
        <p v-else class="banner banner--error">실패: {{ String(last.error || '').slice(0, 300) }}</p>

        <!-- 📈 시계열 — 판정 지점의 자산 vs 벤치 (SVG 직접, 외부 의존 없음) -->
        <svg v-if="chart" class="btchart" :viewBox="`0 0 ${chart.w} ${chart.h}`" preserveAspectRatio="none" role="img" aria-label="백테스트 자산 추이">
          <polyline :points="chart.bench" fill="none" stroke="var(--color-faint)" stroke-width="1.5" stroke-dasharray="4 3" />
          <polyline :points="chart.value" fill="none" stroke="var(--color-primary)" stroke-width="2" />
        </svg>
        <p v-if="chart" class="legend mut"><span class="lg lg--run"></span> 운용 <span class="lg lg--bench"></span> 벤치(QQQ)</p>

        <details class="raw"><summary>실행 기록 원문 (무엇을 샀는지)</summary><pre>{{ last.tail }}</pre></details>

        <!-- 🏅 승급 — 근거(이 백테스트)가 함께 저장된다. 벤치를 못 이기면 잠근다 -->
        <div class="promote">
          <template v-if="last.ok && last.final > last.bench && checked.size">
            <input v-model="promoteName" class="input" placeholder="전략 이름 (예: 횡보 관망 + 공포 사다리)" />
            <button class="btn btn--primary btn--sm" :disabled="promoting || !promoteName.trim()" @click="promote">
              {{ promoting ? '승급 중…' : '🏅 운용 규칙 승급' }}
            </button>
          </template>
          <p v-else-if="last.ok && checked.size" class="mut">벤치마크를 이기지 못한 조합은 승급할 수 없습니다 — 근거 없는 승급은 장식이다.</p>
          <p v-else-if="last.ok" class="mut">승급하려면 카드를 <b>체크해 조합으로</b> 백테스트하세요 — 전체 발동 결과는 조합의 근거가 아닙니다.</p>
        </div>
      </div>
      <p v-else-if="!running" class="panel__empty">아직 실행한 백테스트가 없습니다.</p>
    </section>

    <!-- ── 승급된 전략 ── -->
    <section class="card">
      <h2>승급된 전략 <small class="mut">활성이면 애널리스트 매수/매도 판단의 참고 축(RAG)으로 실린다</small></h2>
      <table v-if="promoted.length" class="tbl">
        <thead><tr><th>이름</th><th>시나리오 조합</th><th>백테스트 근거</th><th>승급일</th><th>RAG</th></tr></thead>
        <tbody>
          <tr v-for="p in promoted" :key="p.id">
            <td><b>{{ p.name }}</b><small v-if="p.note" class="mut"> — {{ p.note }}</small></td>
            <td class="mono-num">{{ p.scenarioIds.join(', ') }}</td>
            <td class="mono-num">{{ p.backtest ? `${p.backtest.scenario}: $${fmt(p.backtest.final)} vs 벤치 $${fmt(p.backtest.bench)}` : '—' }}</td>
            <td class="mono-num">{{ when(p.at) }}</td>
            <td><button class="btn btn--xs" :class="p.active ? 'btn--primary' : ''" @click="setActive(p)">{{ p.active ? '활성' : '꺼짐' }}</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="panel__empty">아직 승급된 전략이 없습니다 — 조합 백테스트가 벤치를 이기면 여기로 올립니다.</p>
    </section>

    <!-- ── 상세 모달 ──
         🔴 .page 직계 자식이어야 한다 — 아래 scoped CSS 의 `.page > .mdl` 전폭 예외가
            이 위치를 전제한다(깊이 묻으면 예외 선택자가 안 맞아 스크림이 또 좁아진다). -->
    <div v-if="modal" class="mdl">
      <div class="mdl__scrim" @click="closeModal"></div>
      <div class="mdl__box" role="dialog" aria-modal="true">
        <header class="mdl__head">
          <h2>{{ modal.name }} <small class="mut mono-num">{{ modal.id }}</small></h2>
          <span class="page__sp"></span>
          <span v-if="modal._editedAt" class="chip">{{ when(modal._editedAt) }} 수정됨</span>
          <button class="iconbtn" aria-label="닫기" @click="closeModal">✕</button>
        </header>
        <p class="mut">발동 조건: <span class="mono-num">{{ matchLabel(modal.match) }}</span></p>

        <h3 class="panel__h">지침 (steps) <small>한 줄 = 한 지침 — 애널리스트 프롬프트에 그대로 실린다</small></h3>
        <textarea v-model="editSteps" class="input ed" rows="9" spellcheck="false"></textarea>

        <h3 class="panel__h">도구상자 카테고리</h3>
        <input v-model="editCategories" class="input" placeholder="쉼표로 구분 (예: tech_broad, gold)" />

        <div v-if="modal.modelPortfolio" class="mp">
          <h3 class="panel__h">기준 배분 <small>정렬 목표 — 현금에서 새로 사라는 지시가 아니다</small></h3>
          <table class="tbl"><tbody>
            <tr v-for="(v, k) in modal.modelPortfolio" :key="k"><td>{{ k }}</td><td class="mono-num">{{ v }}</td></tr>
          </tbody></table>
        </div>

        <div class="mdl__act">
          <button class="btn btn--primary btn--sm" :disabled="saving" @click="save">{{ saving ? '저장 중…' : '수정 저장' }}</button>
          <button class="btn btn--sm" @click="closeModal">닫기</button>
          <span v-if="saveMsg" class="mut">{{ saveMsg }}</span>
        </div>
        <p class="mut">⚠️ 저장은 라이브 판정을 즉시 바꾼다 — 변경 전 판은 서버 백업에 남는다.</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

const scenarios = ref([]);
const promoted = ref([]);
const error = ref('');
const checked = ref(new Set());

// ── 상세 모달 ──
const modalId = ref('');
const modal = computed(() => scenarios.value.find((s) => s.id === modalId.value) || null);

/** 편집 버퍼 — 모달을 열 때마다 원본에서 채운다(남의 시나리오 편집분이 넘어오지 않게) */
const editSteps = ref('');
const editCategories = ref('');
function openModal(id) {
  const sc = scenarios.value.find((s) => s.id === id);
  if (!sc) return;
  modalId.value = id;
  editSteps.value = (sc.steps || []).join('\n');
  editCategories.value = (sc.categories || []).join(', ');
  saveMsg.value = '';
}
function closeModal() { modalId.value = ''; }
function onKey(e) { if (e.key === 'Escape') closeModal(); }

const saving = ref(false);
const saveMsg = ref('');
async function save() {
  if (!modal.value) return;
  saving.value = true; saveMsg.value = '';
  try {
    const body = {
      steps: editSteps.value.split('\n').map((x) => x.trim()).filter(Boolean),
      categories: editCategories.value.split(',').map((x) => x.trim()).filter(Boolean),
    };
    const r = await apiFetch(`/api/strategy/playbook/${encodeURIComponent(modal.value.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const b = await r.json();
    if (!r.ok || !b.ok) throw new Error(b.error || `저장 실패 (${r.status})`);
    saveMsg.value = '저장됨 — 라이브 판정에 즉시 반영';
    await load();
  } catch (e) { saveMsg.value = `실패: ${e.message}`; }
  finally { saving.value = false; }
}

function toggle(id) {
  const s = new Set(checked.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  checked.value = s;
}

/** match 조건을 사람이 읽는 한 줄로 — JSON 을 그대로 들이밀지 않는다 */
function matchLabel(m) {
  if (!m) return '(없음)';
  return Object.entries(m).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

// ── 국면 한 줄 — 어느 카드가 지금 발동권인지 가늠하는 배경 정보(실패해도 화면은 산다) ──
const regime = ref(null);
const TREND_KO = { up: '상승', side: '횡보', down: '하락' };
const regimeLabel = computed(() => {
  const s = regime.value;
  if (!s) return '';
  const parts = [];
  if (s.us?.trend) parts.push(`US ${TREND_KO[s.us.trend] || s.us.trend}`);
  if (s.kr?.trend) parts.push(`KR ${TREND_KO[s.kr.trend] || s.kr.trend}`);
  if (s.vix?.value != null) parts.push(`VIX ${s.vix.value}`);
  if (s.kr?.shock || s.us?.shock) parts.push('🔴급락');
  return parts.join(' · ');
});
async function loadRegime() {
  try {
    const r = await apiFetch('/api/regime');
    if (r.ok) regime.value = (await r.json()).state;
  } catch { /* 국면 칩은 곁가지 */ }
}

// ── 백테스트 ──
const LABEL = { vshape: 'V자 반등', bull: '지속 상승', bear: '지속 하락', chop: '횡보' };
const running = ref(null);
const last = ref(null);
const promoting = ref(false);
const promoteName = ref('');

async function loadStatus() {
  try {
    const r = await apiFetch('/api/backtest/status'); const b = await r.json();
    running.value = b.running || null;
    last.value = b.last || null;
  } catch { /* 폴링 다음 회차가 잡는다 */ }
}
async function runBt(key) {
  try {
    const r = await apiFetch('/api/backtest/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: key, onlyScenarios: [...checked.value] }),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || (r.status === 409 ? '이미 실행 중입니다' : `실행 실패 (${r.status})`));
    error.value = '';
    await loadStatus();
  } catch (e) { error.value = e.message; }
}
async function promote() {
  promoting.value = true;
  try {
    const r = await apiFetch('/api/strategy/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: promoteName.value.trim(), scenarioIds: [...checked.value], backtest: last.value }),
    });
    const b = await r.json();
    if (!r.ok || !b.ok) throw new Error(b.error || '승급 실패');
    promoteName.value = '';
    await load();
  } catch (e) { error.value = e.message; }
  finally { promoting.value = false; }
}
async function setActive(p) {
  try {
    await apiFetch(`/api/strategy/promoted/${encodeURIComponent(p.id)}/active`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !p.active }),
    });
    await load();
  } catch (e) { error.value = e.message; }
}

/** 차트 좌표 — 운용과 벤치를 같은 축으로(비교가 목적이라 정규화하지 않고 달러 그대로) */
const chart = computed(() => {
  const s = last.value?.series;
  if (!Array.isArray(s) || s.length < 2) return null;
  const w = 960; const h = 220; const pad = 8;
  const all = s.flatMap((p) => [p.value, p.bench]).filter((x) => Number.isFinite(x));
  const lo = Math.min(...all); const hi = Math.max(...all);
  const x = (i) => pad + (i / (s.length - 1)) * (w - pad * 2);
  const y = (v) => hi === lo ? h / 2 : pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);
  return {
    w, h,
    value: s.map((p, i) => `${x(i)},${y(p.value)}`).join(' '),
    bench: s.map((p, i) => `${x(i)},${y(p.bench)}`).join(' '),
  };
});

/** 시작 자본 $10,000 기준 수익률 % — 히어로의 큰 숫자는 달러가 아니라 이것이다 */
const pct = (v) => (Number.isFinite(v) ? (v / 10000 - 1) * 100 : NaN);
const excess = computed(() => (last.value?.ok ? pct(last.value.final) - pct(last.value.bench) : 0));
const fmtPct = (n) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}` : '—');
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const when = (at) => {
  if (!at) return '';
  const d = new Date(at); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const since = (at) => `${Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000))}분`;

async function load() {
  try {
    const r = await apiFetch('/api/strategy/playbook'); const b = await r.json();
    if (!b.ok) throw new Error(b.error || '플레이북을 못 읽었습니다');
    scenarios.value = b.scenarios || [];
    promoted.value = b.promoted || [];
  } catch (e) { error.value = e.message; }
  await loadStatus();
}

let timer = null;
onMounted(() => {
  load(); loadRegime();
  timer = setInterval(loadStatus, 15_000);
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => { clearInterval(timer); window.removeEventListener('keydown', onKey); });
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
/* 초광폭(1700px+)에서 콘텐츠가 끝까지 퍼지면 황량하다 — 스크롤 컨테이너는 전폭을
   유지하되(스크롤바가 오른쪽 끝) 콘텐츠만 1440 에서 멈추고 중앙 정렬한다. */
.page > * { width: 100%; max-width: 1440px; margin-inline: auto; }
/* 🔴 모달 스크림 전폭 예외 — 위 상한이 fixed 요소까지 좁혀 "화면 일부만 어두워지는"
   실사고가 났다. 반드시 상한 선언보다 뒤에 있어야 이긴다(순서가 곧 안전장치다). */
.page > .mdl { width: 100vw; max-width: none; margin: 0; }

.page__head { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.page__sp { flex: 1; }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.mut { font-size: var(--text-xs); color: var(--color-muted); margin: 0; }
.warn { margin: 0 0 6px; font-size: var(--text-sm); color: var(--color-warn); }

/* ── 카드 그리드 ── */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--space-sm); }
.sc {
  background: var(--color-surface); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg); padding: var(--space-base);
  display: flex; flex-direction: column; gap: 4px; cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.sc:hover { background: var(--color-surface-hover); border-color: var(--color-hairline-strong); }
/* 체크된 카드 — 조합에 들어 있다는 것이 한눈에 보여야 한다 */
.sc--on { border-color: var(--color-primary); background: var(--color-primary-soft); }
.sc__top { display: flex; align-items: flex-start; gap: var(--space-sm); }
.sc__pick { margin: 3px 0 0; accent-color: var(--color-primary); width: 15px; height: 15px; flex: none; cursor: pointer; }
.sc__name { font-size: var(--text-md); color: var(--color-ink); line-height: 1.35; }
.sc__id { font-size: var(--text-2xs); color: var(--color-faint); }
.sc__match {
  margin: 0; font-size: var(--text-xs); color: var(--color-muted);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.sc__chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: auto; padding-top: 4px; }
.sc__chip {
  font-size: var(--text-2xs); color: var(--color-body);
  border: 1px solid var(--color-hairline-soft); border-radius: var(--rounded-pill);
  padding: 1px 8px; background: var(--color-surface-sunken);
}

/* ── 공용 카드 섹션 ── */
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 8px; font-size: var(--text-md); color: var(--color-ink); }
.card h3 { margin: 10px 0 4px; }

.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }

/* ── 백테스트 ── */
.bt__row { display: flex; gap: var(--space-xs); align-items: center; flex-wrap: wrap; margin: 6px 0; }
.btres { display: flex; flex-direction: column; gap: var(--space-sm); }
.btres h3 { display: flex; align-items: center; gap: var(--space-sm); font-size: var(--text-sm); margin: 4px 0 0; flex-wrap: wrap; }

/* 수익률 히어로 — 표보다 숫자가 먼저 읽혀야 "바로 비교" 가 된다 */
.hero { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: var(--space-sm); }
.hero__cell {
  background: var(--color-surface-sunken); border: 1px solid var(--color-hairline-soft);
  border-radius: var(--rounded-md); padding: var(--space-base);
  display: flex; flex-direction: column; gap: 2px;
}
.hero__cell--ex { border-color: var(--color-primary-line); }
.hero__lbl { font-size: var(--text-xs); color: var(--color-muted); }
.hero__num { font-size: var(--text-3xl); line-height: 1.15; }

.btchart { width: 100%; height: 220px; border: 1px solid var(--color-hairline-soft); border-radius: var(--rounded-xs); background: var(--color-surface-sunken); }
.legend { display: flex; align-items: center; gap: 6px; }
.lg { display: inline-block; width: 18px; height: 3px; border-radius: 2px; }
.lg--run { background: var(--color-primary); }
.lg--bench { background: var(--color-faint); }
.raw { font-size: var(--text-xs); }
.raw pre { max-height: 300px; overflow: auto; background: var(--color-surface-sunken); padding: var(--space-sm); border-radius: var(--rounded-xs); white-space: pre-wrap; }
.promote { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
.promote .input { max-width: 320px; }

/* ── 상세 모달 ── */
.mdl { position: fixed; inset: 0; z-index: 95; display: flex; align-items: center; justify-content: center; padding: var(--space-lg); }
/* 스크림을 별도 층으로 — 색은 실재 토큰만 쓰기로 했으므로 canvas 토큰 + opacity 로 만든다 */
.mdl__scrim { position: absolute; inset: 0; background: var(--color-canvas); opacity: 0.72; }
.mdl__box {
  position: relative; z-index: 1;
  width: min(760px, 100%); max-height: 84vh; overflow-y: auto;
  background: var(--color-surface-raised); border: 1px solid var(--color-hairline-strong);
  border-radius: var(--rounded-lg); padding: var(--space-md);
  box-shadow: var(--shadow-pop);
  display: flex; flex-direction: column; gap: var(--space-sm);
}
.mdl__head { display: flex; align-items: center; gap: var(--space-sm); }
.mdl__head h2 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.mdl__act { display: flex; align-items: center; gap: var(--space-sm); margin-top: 4px; }
.mp { margin-top: 2px; }
.ed { width: 100%; font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5; resize: vertical; }
</style>
