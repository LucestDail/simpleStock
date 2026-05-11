<script setup>
import { onMounted } from 'vue';
import { usePortfolio } from '../composables/usePortfolio';

const { fetchPortfolio, system, ai, error } = usePortfolio();

onMounted(fetchPortfolio);
</script>

<template>
  <div class="page">
    <div class="container">
      <h1 class="page-title">설정</h1>
      <p class="page-lead">
        SimpleStock은 개인 전용으로 동작하며, 데이터는 서버의 <code>data/portfolio.json</code>에
        저장됩니다.
      </p>

      <p v-if="error" class="banner-error">{{ error }}</p>

      <section class="card">
        <h2 class="card-h">시간대</h2>
        <p class="body">
          서버와 앱 기준 시간대는 <strong>{{ system.timezone }}</strong> 입니다.
          현재 서버 시각은 <code>{{ system.serverTimeLocal || '확인 중' }}</code> 입니다.
        </p>
      </section>

      <section class="card">
        <h2 class="card-h">저장 방식</h2>
        <p class="body">
          현재 데이터는 별도 DB 없이 서버 파일 시스템의 <code>data/portfolio.json</code>에 저장됩니다.
          개인 전용 사용을 전제로 보유 자산 목록, 일별 스냅샷, AI 브리핑 결과만 JSON 형태로 관리합니다.
        </p>
      </section>

      <section class="card">
        <h2 class="card-h">분류 기준</h2>
        <p class="body">
          지금 버전의 비중은 자산군이 아니라 상품 분류 기준입니다. 예금, 적금, 주식, 펀드, 연금의
          5개 버킷으로 단순하게 시작하고, 이후 필요하면 현금성 / 투자 / 연금 같은 상위 자산군을
          추가할 수 있습니다.
        </p>
      </section>

      <section class="card">
        <h2 class="card-h">AI 연계</h2>
        <ul class="meta-list">
          <li><span>Gemini 활성화</span><strong>{{ system.aiConfigured ? '예' : '아니오' }}</strong></li>
          <li><span>모델</span><code>{{ system.geminiModel || '-' }}</code></li>
          <li><span>Thinking level</span><code>{{ system.geminiThinkingLevel || '-' }}</code></li>
          <li><span>스케줄</span><code>{{ system.aiCronExpression || '-' }}</code></li>
          <li><span>방식</span><code>{{ system.aiCronMode || '-' }}</code></li>
        </ul>
        <p class="body body-gap">
          현재는 Gemini API를 사용하며, 키가 설정되면 KST 기준 일 1회 자동 브리핑을 생성합니다.
          마지막 실행 시각은 <code>{{ ai.lastRunAt || '없음' }}</code> 입니다.
        </p>
        <p v-if="ai.lastError" class="warning-text">
          최근 AI 오류: {{ ai.lastError.message }} ({{ ai.lastError.at }})
        </p>
      </section>

      <section class="card">
        <h2 class="card-h">Quant Manager 시스템 프롬프트</h2>
        <pre class="prompt-box">{{ system.quantManagerSystemPrompt }}</pre>
      </section>

      <section class="cta-band">
        <h2 class="cta-title">디자인</h2>
        <p class="cta-body">
          Coinbase 마케팅 서피스 톤을 참고했습니다. 단일 액션 컬러 #0052ff, Inter / JetBrains Mono
          조합, 에디토리얼 여백과 필·카드 라디우스를 사용합니다.
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
</style>
