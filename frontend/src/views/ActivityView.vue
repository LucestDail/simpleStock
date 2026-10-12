<!--
  D-5 활동 로그 (2026-10-03 와이어프레임 준용 · 10-04 사용자 지적으로 전면 손질)
  활동 기록(/api/activity — 분석·알림·동기화)을 한 시간축으로.
  ⚠️ 2026-10-12: 주문 감사 원천은 집행 제거와 함께 사라졌다(옛 이벤트 라벨은 과거 행을 읽으려 남겨 둔다).
  🔴 와이어프레임의 핵심은 "차단·보류도 행이다" — 일어나지 않게 막은 일이 보여야
     사용자가 가드를 신뢰한다.

  🔴 2026-10-04 사용자: "이게 뭐야" — 실화면에서 세 가지가 깨져 있었다:
   ① 같은 사건이 두 줄 — 활동 기록과 주문 감사가 **같은 제안 수명주기를 각자** 적는다
      (활동: "매도 제안 RAM 50주 @ 14.31" / 감사: "RAM 매도 제안 제안").
      ⇒ 활동 쪽이 항상 더 풍부하므로, **활동에 쌍이 있는 감사 행은 접는다**(±3분·같은 종목·
      같은 부류). 감사만 아는 사건(차단·만료·웹 결정)은 그대로 남는다 — 지우는 게 아니라 중복만.
   ② "매도 제안 제안" — 문구 조립이 낱말을 두 번 붙였다.
   ③ 유형 배지가 세로로 꺾이고("차\n단") 시각이 두 줄 — nowrap + 압축 포맷(MM-DD HH:mm).
-->
<template>
  <div class="page">
    <header class="page__head">
      <h1>활동 로그</h1>
      <select v-model="filter" class="input input--sel">
        <option value="">전체</option>
        <option value="propose">제안</option>
        <option value="execute">체결·전송</option>
        <option value="guard">차단·만료</option>
        <option value="analysis">분석·알림</option>
      </select>
      <span style="flex:1"></span>
      <span class="chip">총 <b class="mono-num">{{ merged.length }}</b>건</span>
    </header>

    <!--
      💸 LLM 사용량 (2026-10-12 신설 — D-8)
      사용자가 *"너 계속 LLM 비용 나가잖아"* 라고 했는데 **화면 어디에도 그 숫자가 없었다.**
      집계는 `memory.tokenUsageByMonth` 에 **이미 쌓이고 있었다** — 읽는 곳이 없었을 뿐이다.
      ⚠️ 비용은 **추정**이다. 단가를 모르는 모델이면 금액을 **안 그린다**(0 으로 채우면 "공짜" 로 읽힌다).
    -->
    <section v-if="usage" class="card">
      <h2>LLM 사용량 <small class="mut">{{ usage.model || '모델 미설정' }}</small></h2>
      <div class="ucards">
        <div class="ucard">
          <small>이번 달 호출</small>
          <b class="mono-num">{{ n(usage.current.requestCount) }}</b>
        </div>
        <div class="ucard">
          <small>토큰</small>
          <b class="mono-num">{{ n(usage.current.totalTokens) }}</b>
          <em class="mut mono-num">입력 {{ n(usage.current.promptTokens) }} · 출력 {{ n(usage.current.candidatesTokens) }}</em>
        </div>
        <div class="ucard">
          <small>추정 비용</small>
          <b v-if="usage.current.costUsd != null" class="mono-num">${{ usage.current.costUsd }}</b>
          <b v-else class="mono-num mut">—</b>
          <em v-if="usage.priceNote" class="mut">{{ usage.priceNote }}</em>
        </div>
        <div class="ucard">
          <small>지난 달</small>
          <b class="mono-num">{{ n(usage.previous.requestCount) }}<span class="mut"> 회</span></b>
          <em v-if="usage.previous.costUsd != null" class="mut mono-num">${{ usage.previous.costUsd }}</em>
        </div>
      </div>
      <p v-if="usage.priceSource" class="mut">단가 {{ usage.priceSource }} · 청구액이 아니라 <b>추정</b>입니다.</p>
    </section>

    <p v-if="error" class="banner banner--error">{{ error }}</p>
    <!-- 🔴 표만 자기 영역 안에서 스크롤한다 — 헤더는 sticky 로 붙여 둔다 -->
    <div v-else class="logwrap">
    <table class="tbl">
      <thead><tr><th class="tbl__when">시각</th><th class="tbl__kind">유형</th><th class="tbl__sym">종목</th><th>내용</th></tr></thead>
      <tbody>
        <tr v-for="(r, i) in shown" :key="i">
          <td class="mono-num tbl__when">{{ when(r.at) }}</td>
          <td class="tbl__kind"><span class="tag" :class="`tag--${r.group}`">{{ r.label }}</span></td>
          <td class="mono-num tbl__sym">{{ r.symbol || '—' }}</td>
          <td class="tbl__text" :title="r.text">{{ r.text }}</td>
        </tr>
      </tbody>
    </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

const acts = ref([]);
const audit = ref([]);
const error = ref('');
const usage = ref(null);
const n = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('ko-KR') : '—');
const filter = ref('');

/** 활동 kind · 감사 event → 한 벌의 부류. 필터와 중복 접기가 같은 지도를 쓴다(두 벌이면 갈라진다) */
const GROUP = {
  proposal: 'propose', proposed: 'propose',
  approval: 'decide', approved: 'decide', rejection: 'decide', rejected: 'decide', canceled: 'decide',
  execution: 'execute', executed: 'execute', auto_executed: 'execute',
  blocked: 'guard', expired: 'guard', auto_skipped: 'guard',
  analysis: 'analysis', alert: 'analysis',
};
/* ⚠️ auto_* 두 종은 자율 운용(10-04)이 새로 적는 이벤트 — 매핑이 없어 영문 원문이
   화면에 그대로 노출됐다(2026-10-06 스샷 실측) */
const AUDIT_LABEL = { proposed: '제안', approved: '승인', rejected: '거절', canceled: '취소', executed: '체결', blocked: '차단', expired: '만료', auto_skipped: '자동 보류', auto_executed: '자동 집행' };
const ACT_LABEL = { proposal: '제안', approval: '승인', rejection: '거절', execution: '전송', analysis: '분석', alert: '알림' };

const merged = computed(() => {
  const a = acts.value.map((x) => ({
    at: x.at, src: 'act', group: GROUP[x.kind] || 'analysis',
    label: ACT_LABEL[x.kind] || '기록', symbol: x.symbol || null, text: x.title || x.text || '',
  }));
  const b = audit.value.map((x) => {
    const side = x.side === 'BUY' ? '매수' : x.side === 'SELL' ? '매도' : '';
    // ② "매도 제안 제안" 금지 — 동사 하나만: "매도 제안" · "매도 거절" · "매도 제안 차단"
    //    자동 보류는 **왜 보류됐는지**(reason)가 본문이다 — 있으면 그것을 보여준다
    const text = x.event === 'blocked' ? `${side} 제안 차단 (가드·정지)`.trim()
      : x.event === 'auto_skipped' && x.reason ? String(x.reason)
      : `${side} ${AUDIT_LABEL[x.event] || x.event}`.trim();
    return {
      at: x.at, src: 'audit', group: GROUP[x.event] || 'guard',
      label: AUDIT_LABEL[x.event] || x.event, symbol: x.symbol || null, text,
    };
  });
  // ① 중복 접기 — 활동에 같은 (부류·종목·±3분) 쌍이 있는 감사 행만 접는다.
  //   차단·만료는 활동이 원래 안 적으므로 자연히 전부 살아남는다.
  const kept = b.filter((r) => !a.some((x) =>
    x.group === r.group && x.symbol === r.symbol
    && Math.abs(Date.parse(x.at) - Date.parse(r.at)) < 3 * 60_000));
  return [...a, ...kept].sort((x, y) => String(y.at).localeCompare(String(x.at)));
});
const shown = computed(() => (filter.value ? merged.value.filter((r) => r.group === filter.value) : merged.value).slice(0, 200));

/** 한 줄에 들어가는 압축 포맷 — "10. 4. 오전 12:11" 두 줄 꺾임이 ③의 증상이었다 */
const when = (at) => {
  if (!at) return '';
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

onMounted(async () => {
  try {
    // ⚠️ 2026-10-12 — 주문 감사(`/api/orders/stats`)가 사라졌다. 활동 기록만 읽는다.
    const ra = await apiFetch('/api/activity');
    const ba = await ra.json();
    acts.value = Array.isArray(ba) ? ba : (ba.items || ba.activity || []);
    audit.value = [];
  } catch (e) { error.value = `로그를 못 읽었습니다: ${e.message}`; }
  try {
    const ru = await apiFetch('/api/usage/llm');
    const bu = await ru.json();
    if (bu?.ok) usage.value = bu;
    // ⚠️ 사용량 실패를 **로그 실패로 보고하지 않는다** — 틀린 진단이 사용자를 엉뚱한 곳으로 보낸다.
    //    패널이 안 그려지는 것으로 충분하다(없는 것과 못 받은 것은 패널 유무로 갈린다).
  } catch { /* 사용량은 곁가지 — 활동 로그는 그대로 보여준다 */ }
});
</script>

<style scoped>
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.card h2 { margin: 0; font-size: var(--text-md); color: var(--color-ink); display: flex; gap: var(--space-sm); align-items: baseline; }
.ucards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-sm); }
.ucard { border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm); display: flex; flex-direction: column; gap: 2px; }
.ucard small { color: var(--color-faint); font-size: var(--text-2xs); }
.ucard b { font-size: var(--text-md); color: var(--color-ink); }
.ucard em { font-style: normal; font-size: var(--text-2xs); }
.mut { color: var(--color-muted); font-size: var(--text-xs); }

/* 🔴 2026-10-12 사용자: "활동 로그도 좀 창 크기 줄이고 **카드 내에서 스크롤**되게 해
   전체 스크롤 하게 하지말고." ⇒ 페이지는 스크롤하지 않고(`overflow: hidden`),
   표만 자기 영역 안에서 스크롤한다. 상단 필터·사용량 패널이 항상 보인다. */
.page { flex: 1; min-height: 0; overflow: hidden; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
/* 🔴 2026-10-06 사용자(세 번째 지적): "max-width 주지 말라고" — 콘텐츠 폭 상한(1440px)
   제거, 표가 화면 전폭을 쓴다. 표는 페이지의 유일한 패널이라 내부 스크롤로 자르지 않는다
   (.page 자체가 스크롤 컨테이너 — 아래로 끌어올릴 다른 패널이 없다). */

.page__head { display: flex; align-items: center; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.input--sel { max-width: 140px; height: 32px; border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); background: var(--color-surface); color: var(--color-body); padding: 0 var(--space-sm); }
.chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; font-size: var(--text-xs); color: var(--color-body); }
.logwrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); }
.tbl thead th { position: sticky; top: 0; z-index: 1; background: var(--color-surface-sunken); }
.tbl { width: 100%; border-collapse: collapse; background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); font-size: var(--text-sm); table-layout: fixed; }
.tbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 6px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.tbl td { padding: 5px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); vertical-align: top; }
/* ③ 시각·유형·종목은 꺾이지 않는다 — 내용만 넓게 */
.tbl__when { width: 92px; white-space: nowrap; }
.tbl__kind { width: 64px; }
.tbl__sym { width: 72px; white-space: nowrap; }
.tbl__text {
  color: var(--color-body);
  /* 긴 분석 한 줄 요약은 2줄에서 자른다 — 전문은 title 툴팁 */
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.tag { font-size: var(--text-2xs); border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 1px 8px; white-space: nowrap; display: inline-block; }
.tag--decide { color: var(--color-warn); border-color: var(--color-warn); }
.tag--guard { color: var(--color-down); border-color: var(--color-down); }
.tag--execute, .tag--propose { color: var(--color-open); border-color: var(--color-open); }
</style>
