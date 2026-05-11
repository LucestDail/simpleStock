<script setup>
// AI 연계 등 확장 예정
</script>

<template>
  <div class="page">
    <div class="container">
      <h1 class="page-title">설정</h1>
      <p class="page-lead">
        SimpleStock은 개인 전용으로 동작하며, 데이터는 서버의 <code>data/portfolio.json</code>에
        저장됩니다.
      </p>

      <section class="card">
        <h2 class="card-h">저장 방식</h2>
        <p class="body">
          현재 데이터는 별도 DB 없이 서버 파일 시스템의 <code>data/portfolio.json</code>에 저장됩니다.
          개인 전용 사용을 전제로 보유 자산 목록과 일별 스냅샷만 JSON 형태로 관리합니다.
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
        <p class="body">
          자산 해석, 뉴스 요약, 포트폴리오 코멘트 등 AI 기능은 추후 연동 예정입니다. 현재 버전에서는
          입력하신 금액만으로 비중·대시보드·일별 스냅샷을 제공합니다.
        </p>
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

.page-lead code {
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

.card code {
  font-family: var(--font-mono);
  font-size: 14px;
  background: var(--color-surface-soft);
  padding: 2px 6px;
  border-radius: var(--rounded-xs);
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
