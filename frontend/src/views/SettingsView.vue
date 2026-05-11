<script setup>
import { computed, onMounted, reactive } from 'vue';
import { usePortfolio } from '../composables/usePortfolio';
import { useProfile } from '../composables/useProfile';
import { useUi } from '../composables/useUi';

const { fetchPortfolio, system, manager, error: systemError } = usePortfolio();
const { profile, fetchProfile, saveProfile, loading: profileLoading, error: profileError } = useProfile();
const { notify } = useUi();

const form = reactive({
  displayName: '',
  investorType: '',
  investmentGoal: '',
  riskTolerance: '',
  timeHorizon: '',
  liquidityNeeds: '',
  responseStyle: '',
  focusAreas: '',
  notes: '',
});

const combinedError = computed(() => systemError.value || profileError.value || '');

function syncForm() {
  Object.assign(form, profile.value.userProfile || {});
}

onMounted(async () => {
  await Promise.all([fetchPortfolio(), fetchProfile()]);
  syncForm();
});

async function submit() {
  try {
    await saveProfile({ ...form });
    notify({ tone: 'success', message: '사용자 성향 프로필을 저장했습니다.' });
  } catch (e) {
    notify({ tone: 'error', message: e.message || '프로필 저장에 실패했습니다.' });
  }
}
</script>

<template>
  <div class="page">
    <div class="container">
      <h1 class="page-title">설정</h1>
      <p class="page-lead">
        SimpleStock은 포트폴리오, 채팅, 기억, 프로필을 각각 JSON 파일로 저장하고, LangGraph 기반
        supervisor가 매 턴마다 필요한 specialist를 동적으로 조합합니다.
      </p>

      <p v-if="combinedError" class="banner-error">{{ combinedError }}</p>

      <section class="card">
        <h2 class="card-h">시간대 / 저장 위치</h2>
        <ul class="meta-list">
          <li><span>앱 시간대</span><strong>{{ system.timezone }}</strong></li>
          <li><span>현재 서버 시각</span><code>{{ system.serverTimeLocal || '확인 중' }}</code></li>
          <li><span>portfolio</span><code>{{ system.dataFiles?.portfolio || '-' }}</code></li>
          <li><span>chat</span><code>{{ system.dataFiles?.chat || '-' }}</code></li>
          <li><span>memory</span><code>{{ system.dataFiles?.memory || '-' }}</code></li>
          <li><span>profile</span><code>{{ system.dataFiles?.profile || '-' }}</code></li>
        </ul>
      </section>

      <section class="card">
        <h2 class="card-h">사용자 성향 프로필</h2>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field">
            <span class="label">이름</span>
            <input v-model="form.displayName" class="input" type="text" maxlength="80" />
          </label>
          <label class="field">
            <span class="label">투자자 유형</span>
            <input v-model="form.investorType" class="input" type="text" placeholder="예: 배당 중심 장기 투자자" />
          </label>
          <label class="field">
            <span class="label">투자 목표</span>
            <input v-model="form.investmentGoal" class="input" type="text" placeholder="예: 현금흐름 확대, 자산 보전" />
          </label>
          <label class="field">
            <span class="label">리스크 허용도</span>
            <input v-model="form.riskTolerance" class="input" type="text" placeholder="예: 중간, 보수적" />
          </label>
          <label class="field">
            <span class="label">투자 시간축</span>
            <input v-model="form.timeHorizon" class="input" type="text" placeholder="예: 10년 이상" />
          </label>
          <label class="field">
            <span class="label">유동성 필요</span>
            <input v-model="form.liquidityNeeds" class="input" type="text" placeholder="예: 비상금 별도 유지 필요" />
          </label>
          <label class="field">
            <span class="label">응답 스타일</span>
            <input v-model="form.responseStyle" class="input" type="text" placeholder="예: 짧고 실행 가능한 답변 선호" />
          </label>
          <label class="field">
            <span class="label">관심 자산</span>
            <input v-model="form.focusAreas" class="input" type="text" placeholder="예: 미국 ETF, 현금성 자산" />
          </label>
          <label class="field full">
            <span class="label">메모</span>
            <textarea v-model="form.notes" class="textarea" rows="5" />
          </label>
          <div class="actions">
            <button type="submit" class="btn-primary" :disabled="profileLoading">저장</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2 class="card-h">AI 추론 프로필</h2>
        <p class="body" v-if="profile.aiProfile?.summary">{{ profile.aiProfile.summary }}</p>
        <p class="body" v-else>아직 추론된 프로필 요약이 없습니다.</p>
        <div class="chip-row">
          <span v-for="item in profile.aiProfile?.inferredTraits || []" :key="item" class="chip">
            {{ item }}
          </span>
        </div>
        <div class="split-grid">
          <article class="subcard">
            <h3 class="subcard-h">선호</h3>
            <ul class="list">
              <li v-for="item in profile.aiProfile?.preferences || []" :key="item">{{ item }}</li>
            </ul>
          </article>
          <article class="subcard">
            <h3 class="subcard-h">우려</h3>
            <ul class="list">
              <li v-for="item in profile.aiProfile?.concerns || []" :key="item">{{ item }}</li>
            </ul>
          </article>
        </div>
      </section>

      <section class="card">
        <h2 class="card-h">AI 오케스트레이션</h2>
        <ul class="meta-list">
          <li><span>Gemini 활성화</span><strong>{{ system.aiConfigured ? '예' : '아니오' }}</strong></li>
          <li><span>모델</span><code>{{ system.ai?.model || '-' }}</code></li>
          <li><span>Thinking level</span><code>{{ system.ai?.thinkingLevel || '-' }}</code></li>
          <li><span>일일 cron</span><code>{{ system.ai?.dailyCron || '-' }}</code></li>
          <li><span>최근 매니저 브리핑</span><code>{{ manager.latestReport?.createdAt || '없음' }}</code></li>
        </ul>
        <pre class="prompt-box">{{ system.orchestrationNotes }}</pre>
      </section>

      <section class="cta-band">
        <h2 class="cta-title">디자인 / 구조</h2>
        <p class="cta-body">
          Coinbase 계열의 차분한 카드·여백 톤을 유지하면서, 채팅과 자산 관리가 한 앱 안에서 자연스럽게
          이어지도록 재구성했습니다.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-xl) var(--space-base) var(--space-section);
}

.container {
  max-width: var(--content-max);
  margin: 0 auto;
}

.page-title {
  margin: 0 0 var(--space-xs);
  font-size: 32px;
  font-weight: 400;
  letter-spacing: -0.02em;
  color: var(--color-ink);
}

.page-lead {
  margin: 0 0 var(--space-xl);
  color: var(--color-muted);
  max-width: 60ch;
}

.banner-error {
  padding: var(--space-sm) var(--space-base);
  background: #fff5f5;
  color: var(--color-semantic-down);
  border-radius: var(--rounded-md);
  margin-bottom: var(--space-lg);
}

.page-lead code,
.card code {
  font-family: var(--font-mono);
  font-size: 14px;
  background: var(--color-surface-soft);
  padding: 2px 6px;
  border-radius: var(--rounded-xs);
}

.card {
  background: var(--color-canvas);
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
  margin-bottom: var(--space-xl);
}

.card-h {
  margin: 0 0 var(--space-base);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-ink);
}

.body {
  margin: 0;
  color: var(--color-body);
  line-height: 1.6;
}

.body-gap {
  margin-top: var(--space-base);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-lg);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.field.full,
.actions {
  grid-column: 1 / -1;
}

.label {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-ink);
}

.input,
.textarea {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md);
  padding: 14px var(--space-base);
  font: inherit;
  color: var(--color-ink);
  background: var(--color-canvas);
}

.input {
  height: 48px;
}

.textarea {
  resize: vertical;
}

.input:focus,
.textarea:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(0, 82, 255, 0.08);
}

.btn-primary {
  height: 44px;
  padding: 0 var(--space-md);
  border: none;
  border-radius: var(--rounded-pill);
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary:disabled {
  background: var(--color-primary-disabled);
  cursor: not-allowed;
}

.meta-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: var(--space-sm);
}

.meta-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-base);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-hairline);
  color: var(--color-body);
}

.meta-list li strong {
  color: var(--color-ink);
}

.warning-text {
  margin: var(--space-base) 0 0;
  color: var(--color-semantic-down);
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-top: var(--space-base);
}

.chip {
  padding: 8px 12px;
  border-radius: var(--rounded-pill);
  background: var(--color-surface-soft);
  color: var(--color-body-strong);
  font-size: 13px;
  font-weight: 600;
}

.split-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-lg);
  margin-top: var(--space-lg);
}

.subcard {
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  padding: var(--space-lg);
}

.subcard-h {
  margin: 0 0 var(--space-sm);
  font-size: 16px;
  font-weight: 600;
  color: var(--color-ink);
}

.list {
  margin: 0;
  padding-left: 18px;
  color: var(--color-body);
}

.prompt-box {
  margin: 0;
  padding: var(--space-lg);
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
  color: var(--color-body-strong);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.cta-band {
  background: var(--color-surface-dark);
  color: var(--color-on-dark);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
}

.cta-title {
  margin: 0 0 var(--space-sm);
  font-size: 24px;
  font-weight: 400;
  letter-spacing: -0.02em;
}

.cta-body {
  margin: 0;
  color: var(--color-on-dark-soft);
  line-height: 1.6;
}

@media (max-width: 720px) {
  .form-grid,
  .split-grid {
    grid-template-columns: 1fr;
  }
}
</style>
