<!--
  🔭 의사결정 파이프라인 (2026-10-03 — 자율 트레이딩 재개편)

  사용자 최종 목표: *"지능형으로 최적의 포트폴리오를 구성하여 매수/매도 제안,
  나중에는 알아서 트레이딩."* 자율로 가는 길은 **투명성**이다 — 사용자가
  "왜 이 제안인가" 를 단계별 수치로 추적할 수 있어야 승인율이 올라가고,
  승인율이 올라가야 자율 모드가 성립한다.

  수집 → 퀀트 게이트 → LLM 판단 → 검증 가드 → 제안   (5단계, 각각 숫자 하나)

  ⚠️ **0 이 두 종류다** — "통과 0(수치가 그렇게 말함)" 과 "데이터 없음(검사 못 함)" 을
     한 색으로 그리면 *검사 안 한 것이 통과처럼* 보인다. null 은 '—' 로 그린다.
-->
<template>
  <section v-if="pipeline" class="pstrip">
    <header class="pstrip__head">
      <h3 class="panel__h">🔭 의사결정 파이프라인</h3>
      <span class="pstrip__when mono-num" v-if="at">{{ new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</span>
      <span v-if="trigger" class="pstrip__why">{{ trigger }}</span>
    </header>
    <div class="pstrip__row">
      <button class="stage" :class="{ 'stage--on': open === 'collect' }" @click="toggle('collect')">
        <small>① 수집</small>
        <b class="mono-num">{{ num(pipeline.collected?.candidates) }}</b>
        <small>도구상자 · 보유 {{ num(pipeline.collected?.holdings) }} · 웹 {{ num(pipeline.collected?.webSearch) }}</small>
      </button>
      <button class="stage" :class="{ 'stage--on': open === 'gate' }" @click="toggle('gate')">
        <small>② 퀀트 게이트</small>
        <b class="mono-num">{{ num(pipeline.gate?.passed?.length) }}</b>
        <small :class="{ warn: droppedCount > 0 }">탈락 {{ droppedCount }}</small>
      </button>
      <button class="stage" :class="{ 'stage--on': open === 'judge' }" @click="toggle('judge')">
        <small>③ LLM 판단</small>
        <b class="mono-num">{{ num(pipeline.judged?.positions) }}</b>
        <small :class="{ warn: (pipeline.judged?.codeFilled || 0) > 0 }">코드채움 {{ num(pipeline.judged?.codeFilled) }}</small>
      </button>
      <button class="stage" :class="{ 'stage--on': open === 'guard' }" @click="toggle('guard')">
        <small>④ 검증 가드</small>
        <b class="mono-num" :class="{ warn: guardCount > 0 }">{{ guardCount }}</b>
        <small>{{ guardCount ? '발동 — 교정됨' : '발동 없음' }}</small>
      </button>
      <button class="stage" :class="{ 'stage--on': open === 'propose' }" @click="toggle('propose')">
        <small>⑤ 제안</small>
        <b class="mono-num">{{ num(proposalCount) }}</b>
        <small>HITL 대기 {{ num(pendingCount) }}</small>
      </button>
    </div>

    <!-- 단계 상세 — 클릭한 것만. 전부 펼치면 소음이다 -->
    <div v-if="open === 'gate' && pipeline.gate" class="pstrip__detail">
      <p v-if="pipeline.gate.passed?.length">
        통과(모멘텀순):
        <template v-for="(p, i) in pipeline.gate.passed" :key="p.symbol">
          <b>{{ p.symbol }}</b><small class="mono-num"> {{ p.momentum >= 0 ? '+' : '' }}{{ p.momentum }}%</small><template v-if="i < pipeline.gate.passed.length - 1"> · </template>
        </template>
      </p>
      <p v-if="pipeline.gate.dropped?.length" class="pstrip__drop">
        탈락: <span v-for="d in pipeline.gate.dropped" :key="d.symbol">{{ d.symbol }} <small>({{ d.why }})</small>&ensp;</span>
      </p>
      <p v-if="pipeline.gate.overflow" class="pstrip__drop">⚠️ 통과했지만 상한에 잘린 것 {{ pipeline.gate.overflow }}종</p>
    </div>
    <div v-if="open === 'guard'" class="pstrip__detail">
      <p>가격 지어내기 교체 <b class="mono-num">{{ num(pipeline.guards?.priceOutliers) }}</b> ·
         주제 이탈 <b class="mono-num">{{ num(pipeline.guards?.subjectDrift) }}</b> ·
         진입 자동채움 <b class="mono-num">{{ num(pipeline.guards?.entryFilled) }}</b></p>
      <p class="pstrip__mut">가드는 값을 지우지 않고 **사실로 교정**한다 — 발동은 결함이 아니라 잡힌 것이다.</p>
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  pipeline: { type: Object, default: null },
  at: { type: String, default: null },
  trigger: { type: String, default: null },
  proposalCount: { type: Number, default: null },
  pendingCount: { type: Number, default: null },
});

const open = ref(null);
function toggle(k) { open.value = open.value === k ? null : k; }

/** ⚠️ null 과 0 을 가른다 — '—' 는 "못 쟀다" 이지 0 이 아니다 */
const num = (v) => (v == null ? '—' : v);
const droppedCount = computed(() => props.pipeline?.gate?.dropped?.length ?? 0);
const guardCount = computed(() => {
  const g = props.pipeline?.guards || {};
  return (g.priceOutliers || 0) + (g.subjectDrift || 0) + (g.entryFilled || 0);
});
</script>

<style scoped>
.pstrip { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-lg); padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; gap: var(--space-xs); min-height: 0; overflow-y: auto; }
.pstrip__head { display: flex; align-items: baseline; gap: var(--space-sm); }
.pstrip__head .panel__h { margin: 0; font-size: var(--text-md); font-weight: 700; color: var(--color-ink); }
.pstrip__when, .pstrip__why { font-size: var(--text-xs); color: var(--color-muted); }
.pstrip__row { display: flex; }
.stage {
  flex: 1; min-width: 0; text-align: left; cursor: pointer;
  background: var(--color-surface); color: inherit; font: inherit;
  border: 1px solid var(--color-hairline); border-left: none;
  padding: var(--space-xs) var(--space-sm);
  display: flex; flex-direction: column; gap: 1px;
}
.stage:first-child { border-left: 1px solid var(--color-hairline); border-radius: var(--rounded-md) 0 0 var(--rounded-md); }
.stage:last-child { border-radius: 0 var(--rounded-md) var(--rounded-md) 0; }
.stage:hover { background: var(--color-surface-hover); }
.stage--on { background: var(--color-primary-soft); }
.stage small { font-size: var(--text-2xs); color: var(--color-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stage b { font-size: var(--text-lg); color: var(--color-ink); }
.stage .warn, .pstrip b.warn { color: var(--color-warn); }
.pstrip__detail { border-top: 1px solid var(--color-hairline-soft); padding-top: var(--space-xs); font-size: var(--text-xs); }
.pstrip__detail p { margin: 0 0 2px; }
.pstrip__drop { color: var(--color-warn); }
.pstrip__mut { color: var(--color-muted); }
</style>
