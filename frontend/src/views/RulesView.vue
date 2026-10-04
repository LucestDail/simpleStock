<!--
  D-1 운용 규칙 설정 (2026-10-03 와이어프레임 준용)
  와이어프레임은 온보딩 위저드지만, 이 계좌는 이미 운용 중이라 **현재 규칙 열람 + 수정** 형태.
  자율 수준 3단은 표시하되 **0단계 고정** — 해금은 사람이, 그 사실을 문장으로 박는다.
  기존 SettingsPanel(브리핑 프롬프트·리스크 % 등)을 재사용한다.
-->
<template>
  <div class="page">
    <header class="page__head"><h1>운용 규칙 설정</h1></header>
    <section class="card">
      <h2>자율 수준</h2>
      <div class="levels">
        <div class="level level--on"><b>제안 + 승인</b><small>승인한 주문만 실행 — 현재 단계</small></div>
        <div class="level level--locked"><b>한도 내 자동</b><small>🔒 해금 조건: 거절률 하락 추세 + 가드 안정. <b>해금도 사람이 합니다</b></small></div>
        <div class="level level--locked"><b>안내 후 자율</b><small>🔒 1단계 실적 후</small></div>
      </div>
    </section>
    <section class="card">
      <h2>한도</h2>
      <table class="tbl">
        <tr><td>종목당 최대 비중</td><td class="mono-num">20%</td><td class="mut">초과 시 추가 매수 차단 (계좌 검증)</td></tr>
        <tr><td>현금 최소 비중</td><td class="mono-num">10%</td><td class="mut">하회하는 매수 제안 경고</td></tr>
        <tr><td>제안 유효시간</td><td class="mono-num">10분</td><td class="mut">응답 없으면 자동 만료 — 옛 시세로 체결되지 않게</td></tr>
        <tr><td>신용·미수</td><td class="mono-num">불가</td><td class="mut">고정 — 설정으로도 못 켠다</td></tr>
      </table>
      <p class="mut">⚠️ 일일 손실 한도·MDD 자동 정지는 아직 <b>수동</b>(상단 비상정지)이다 —
        자동 발동 백엔드가 생기면 여기서 켠다. (없는 안전장치를 있다고 적지 않는다.)</p>
    </section>
    <section class="card">
      <h2>브리핑·분석 설정</h2>
      <!-- 🔴 SettingsPanel 은 모달(v-if="open")이라 그냥 박으면 **빈 카드**가 된다(2026-10-04 실화면).
           대시보드의 ⚙ 과 같은 물건을 같은 방식으로 연다 — 설정 화면이 두 벌이 되지 않게. -->
      <p class="mut">브리핑 프롬프트·리스크 %·표시 통화 등은 운영 설정에서 — 대시보드의 ⚙ 과 같은 창이다.</p>
      <button class="btn" @click="settingsOpen = true">운영 설정 열기</button>
      <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    </section>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import SettingsPanel from '../components/SettingsPanel.vue';

const settingsOpen = ref(false);
</script>

<style scoped>
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 8px; font-size: var(--text-md); color: var(--color-ink); }
.mut { font-size: var(--text-xs); color: var(--color-muted); }
.levels { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-sm); }
.level { border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; gap: 2px; }
.level b { color: var(--color-ink); font-size: var(--text-sm); }
.level small { color: var(--color-muted); font-size: var(--text-xs); }
.level--on { border-color: var(--color-ai-line); background: var(--color-ai-soft); }
.level--locked { opacity: .75; }
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); margin-bottom: 6px; }
.tbl td { padding: 5px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }
</style>
