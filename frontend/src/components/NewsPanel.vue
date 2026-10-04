<!--
  뉴스 패널 (2026-10-04 — WorkspaceView 분해로 추출)
  🔴 자체 fetch·자체 상태 — 부모는 종목(symbol·name)만 넘긴다. "늦게 온 응답이 새 선택을
     덮지 않는다"(seq 가드) 는 추출하면서 그대로 가져왔다(라이브에서 실제로 일어났던 축).
-->
<template>
<section class="news">
  <header class="news__head">
    <h3 class="panel__h">
      뉴스
      <small v-if="symbol">{{ name || symbol }}</small>
    </h3>
    <button class="iconbtn" :disabled="!symbol || news.loading" aria-label="뉴스 새로고침" title="뉴스 새로고침" @click="loadNews">
      {{ news.loading ? '…' : '⟳' }}
    </button>
  </header>
  <p v-if="!symbol" class="panel__empty">종목을 고르면 뉴스를 찾습니다.</p>
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
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

const props = defineProps({ symbol: { type: String, default: '' }, name: { type: String, default: '' } });
const news = ref({ loading: false, ok: false, items: [], error: '', when: null });
let newsSeq = 0;

async function loadNews() {
  const sym = props.symbol;
  if (!sym) { news.value = { loading: false, ok: false, items: [], error: '', when: null }; return; }
  const seq = ++newsSeq;
  news.value = { ...news.value, loading: true, error: '' };
  try {
    const q = new URLSearchParams({ symbol: sym, name: props.name || '' });
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

watch(() => props.symbol, loadNews);
onMounted(loadNews);
</script>

<style scoped>
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
</style>
