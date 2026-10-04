<!--
  D-9 전략 연구소 (2026-10-04 전면 재구축 — 사용자 지시)
  "국면 플레이북 32종 전체를 열람·수정 가능하게, 체크로 모아 조합 백테스트·차트화,
   결과가 좋으면 '운용 규칙 승급' — 이후 애널리스트 매수/매도의 RAG 로."

  ## 구조
  좌측 = 시나리오 목록(체크=조합 선택 · 클릭=상세) / 우측 = 상세·편집
  하단 = 조합 백테스트(세계 4종 × 선택 시나리오만 발동) + 시계열 차트 + 승급

  🔴 수정은 서버가 검증한다(필드 허용목록·쓰기 전 재파싱·백업) — 그 전제로 편집기를 연다.
     종전 "화면 편집기는 다음 단계" 유보는 검증이 생기며 해제됐다(2026-10-04).
-->
<template>
  <div class="page">
    <header class="page__head">
      <h1>전략 연구소</h1>
      <span class="chip">판정 = 제품과 같은 코드 (decideOnContext)</span>
      <span style="flex:1"></span>
      <span class="chip mono-num">시나리오 {{ scenarios.length }}</span>
    </header>
    <p v-if="error" class="banner banner--error">{{ error }}</p>

    <div class="cols">
      <!-- ── 좌: 시나리오 목록 ── -->
      <section class="card card--list">
        <h2>국면 플레이북 <small class="mut">체크 = 백테스트 조합</small></h2>
        <ul class="sl">
          <li
            v-for="sc in scenarios" :key="sc.id"
            class="sl__row" :class="{ 'sl__row--on': selectedId === sc.id }"
            @click="selectedId = sc.id"
          >
            <!-- 체크는 행 클릭(상세)과 분리 — .stop -->
            <input type="checkbox" :checked="checked.has(sc.id)" @click.stop @change="toggle(sc.id)" />
            <div class="sl__body">
              <b>{{ sc.name }}</b>
              <small class="mono-num">{{ sc.id }}</small>
              <small class="sl__match">{{ matchLabel(sc.match) }}</small>
            </div>
          </li>
        </ul>
      </section>

      <!-- ── 우: 상세·편집 ── -->
      <section class="card card--detail">
        <template v-if="selected">
          <h2>{{ selected.name }} <small class="mut mono-num">{{ selected.id }}</small></h2>
          <p class="mut">발동 조건: <span class="mono-num">{{ matchLabel(selected.match) }}</span>
            <span v-if="selected._editedAt" class="chip">{{ when(selected._editedAt) }} 수정됨</span></p>

          <h3 class="panel__h">지침 (steps) <small class="mut">한 줄 = 한 지침 — 애널리스트 프롬프트에 그대로 실린다</small></h3>
          <textarea v-model="editSteps" class="input ed" rows="8" spellcheck="false"></textarea>

          <h3 class="panel__h">도구상자 카테고리</h3>
          <input v-model="editCategories" class="input" placeholder="쉼표로 구분 (예: tech_broad, gold)" />

          <div v-if="selected.modelPortfolio" class="mp">
            <h3 class="panel__h">기준 배분 <small class="mut">정렬 목표 — 현금에서 새로 사라는 지시가 아니다</small></h3>
            <table class="tbl"><tbody>
              <tr v-for="(v, k) in selected.modelPortfolio" :key="k"><td>{{ k }}</td><td class="mono-num">{{ v }}</td></tr>
            </tbody></table>
          </div>

          <div class="ed__act">
            <button class="btn btn--primary btn--sm" :disabled="saving" @click="save">{{ saving ? '저장 중…' : '수정 저장' }}</button>
            <span v-if="saveMsg" class="mut">{{ saveMsg }}</span>
          </div>
          <p class="mut">⚠️ 저장은 라이브 판정(플레이북 정본)을 즉시 바꾼다 — 서버가 구조 검증·백업 후 반영하고,
            변경 전 판이 <span class="mono-num">config/backups/</span> 에 남는다.</p>
        </template>
        <p v-else class="panel__empty">좌측에서 시나리오를 고르면 상세와 편집기가 열립니다.</p>
      </section>
    </div>

    <!-- ── 조합 백테스트 ── -->
    <section class="card">
      <h2>조합 백테스트 <small class="mut">합성 시나리오 75일 · 제품과 같은 판정 경로</small></h2>
      <p class="warn">🔴 실행하면 <b>LLM 을 실제로 태웁니다</b>(수 분 + 토큰). 동시 1개만 돕니다.</p>
      <p class="mut">
        <template v-if="checked.size">발동 허용: <b class="mono-num">{{ [...checked].join(', ') }}</b> — 체크한 시나리오만 매뉴얼로 발동합니다.</template>
        <template v-else>체크 없음 — 플레이북 <b>전체</b>가 평소처럼 발동합니다.</template>
      </p>
      <div class="bt__row">
        <button v-for="(label, key) in LABEL" :key="key" class="btn" :disabled="!!running" @click="runBt(key)">{{ label }}</button>
        <span v-if="running" class="chip">⏳ {{ LABEL[running.scenario] }} 실행 중 — {{ since(running.startedAt) }}</span>
      </div>

      <div v-if="last" class="btres">
        <h3>마지막 결과 — {{ LABEL[last.scenario] || last.scenario }}
          <small class="mut">{{ when(last.finishedAt) }}</small>
          <small v-if="last.onlyScenarios" class="chip">조합: {{ last.onlyScenarios.join(', ') }}</small>
        </h3>
        <table v-if="last.ok" class="tbl">
          <tbody>
            <tr><td>운용 (판정 경로)</td><td class="mono-num" :class="tone(last.final)">$10,000 → ${{ fmt(last.final) }}</td></tr>
            <tr><td>벤치마크 QQQ 보유</td><td class="mono-num">$10,000 → ${{ fmt(last.bench) }}</td></tr>
            <tr><td>초과</td><td class="mono-num" :class="tone(last.final - last.bench)">{{ last.final - last.bench >= 0 ? '+' : '−' }}${{ fmt(Math.abs(last.final - last.bench)) }}</td></tr>
          </tbody>
        </table>
        <p v-else class="banner banner--error">실패: {{ String(last.error || '').slice(0, 300) }}</p>

        <!-- 📈 시계열 차트 — 판정 지점의 자산 vs 벤치 (SVG 직접 — 외부 의존 없음) -->
        <svg v-if="chart" class="btchart" :viewBox="`0 0 ${chart.w} ${chart.h}`" preserveAspectRatio="none" role="img" aria-label="백테스트 자산 추이">
          <polyline :points="chart.bench" fill="none" stroke="var(--color-faint)" stroke-width="1.5" stroke-dasharray="4 3" />
          <polyline :points="chart.value" fill="none" stroke="var(--color-primary)" stroke-width="2" />
        </svg>
        <p v-if="chart" class="mut legend"><span class="lg lg--run"></span> 운용 <span class="lg lg--bench"></span> 벤치(QQQ)</p>

        <details class="raw"><summary>실행 기록 원문 (무엇을 샀는지)</summary><pre>{{ last.tail }}</pre></details>

        <!-- 🏅 승급 — 근거(이 백테스트 결과)가 함께 저장된다. 벤치를 못 이기면 버튼이 잠긴다 -->
        <div class="promote">
          <template v-if="last.ok && last.final > last.bench && checked.size">
            <input v-model="promoteName" class="input" placeholder="전략 이름 (예: 횡보 관망 + 공포 사다리)" />
            <button class="btn btn--primary btn--sm" :disabled="promoting || !promoteName.trim()" @click="promote">
              {{ promoting ? '승급 중…' : '🏅 운용 규칙 승급' }}
            </button>
          </template>
          <p v-else-if="last.ok && checked.size" class="mut">벤치마크를 이기지 못한 조합은 승급할 수 없습니다 — 근거 없는 승급은 장식이다.</p>
          <p v-else-if="last.ok" class="mut">승급하려면 좌측에서 시나리오를 <b>체크해 조합으로</b> 백테스트하세요 — 전체 발동 결과는 조합의 근거가 아닙니다.</p>
        </div>
      </div>
      <p v-else class="panel__empty">아직 실행한 백테스트가 없습니다.</p>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { apiFetch } from '../lib/apiClient';

const scenarios = ref([]);
const promoted = ref([]);
const error = ref('');
const checked = ref(new Set());
const selectedId = ref('');
const selected = computed(() => scenarios.value.find((s) => s.id === selectedId.value) || null);

/** 편집 버퍼 — 선택이 바뀌면 원본에서 다시 채운다(수정 중이던 것을 조용히 버리지 않게 즉시 반영형) */
const editSteps = ref('');
const editCategories = ref('');
watch(selected, (sc) => {
  editSteps.value = (sc?.steps || []).join('\n');
  editCategories.value = (sc?.categories || []).join(', ');
});

const saving = ref(false);
const saveMsg = ref('');
async function save() {
  if (!selected.value) return;
  saving.value = true; saveMsg.value = '';
  try {
    const body = {
      steps: editSteps.value.split('\n').map((x) => x.trim()).filter(Boolean),
      categories: editCategories.value.split(',').map((x) => x.trim()).filter(Boolean),
    };
    const r = await apiFetch(`/api/strategy/playbook/${encodeURIComponent(selected.value.id)}`, {
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
  const w = 640; const h = 160; const pad = 6;
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

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const tone = (n) => (n >= 10000 || n >= 0 ? 'up' : 'down');
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
    if (!selectedId.value && scenarios.value.length) selectedId.value = scenarios.value[0].id;
  } catch (e) { error.value = e.message; }
  await loadStatus();
}

let timer = null;
onMounted(() => { load(); timer = setInterval(loadStatus, 15_000); });
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 8px; font-size: var(--text-md); color: var(--color-ink); }
.card h3 { margin: 10px 0 4px; }
.mut { font-size: var(--text-xs); color: var(--color-muted); }
.warn { margin: 0 0 6px; font-size: var(--text-sm); color: var(--color-warn); }

.cols { display: grid; grid-template-columns: 360px 1fr; gap: var(--space-sm); align-items: start; }
.card--list { max-height: 520px; overflow-y: auto; }
.card--detail { min-width: 0; }
.card--detail > .input { width: 100%; max-width: 480px; }
.sl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.sl__row { display: flex; gap: var(--space-sm); align-items: flex-start; padding: 6px var(--space-sm); border-radius: var(--rounded-md); cursor: pointer; }
.sl__row:hover { background: var(--color-surface-hover); }
.sl__row--on { background: var(--color-primary-soft); }
.sl__body { display: flex; flex-direction: column; min-width: 0; }
.sl__body b { font-size: var(--text-sm); color: var(--color-ink); }
.sl__body small { font-size: var(--text-2xs); color: var(--color-faint); }
.sl__match { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }

.ed { width: 100%; font-family: var(--font-mono, monospace); font-size: var(--text-xs); line-height: 1.5; resize: vertical; }
.ed__act { display: flex; align-items: center; gap: var(--space-sm); margin-top: 6px; }
.mp { margin-top: 6px; }

.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 4px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }

.bt__row { display: flex; gap: var(--space-xs); align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
.btres h3 { display: flex; align-items: center; gap: var(--space-sm); font-size: var(--text-sm); }
.btchart { width: 100%; max-width: 640px; height: 160px; margin-top: 8px; border: 1px solid var(--color-hairline-soft); border-radius: var(--rounded-xs); background: var(--color-surface-sunken, transparent); }
.legend { display: flex; align-items: center; gap: 6px; margin: 4px 0 0; }
.lg { display: inline-block; width: 18px; height: 3px; border-radius: 2px; }
.lg--run { background: var(--color-primary); }
.lg--bench { background: var(--color-faint); }
.raw { margin-top: 8px; font-size: var(--text-xs); }
.raw pre { max-height: 300px; overflow: auto; background: var(--color-surface-sunken, rgba(0,0,0,.04)); padding: var(--space-sm); border-radius: var(--rounded-xs); white-space: pre-wrap; }
.promote { display: flex; align-items: center; gap: var(--space-sm); margin-top: 10px; }
.promote .input { max-width: 320px; }
</style>
