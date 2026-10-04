<!--
  랭킹 패널 (2026-10-04 — WorkspaceView 분해로 추출)
  부모가 쥐는 것 = 데이터(rankings·부분 실패 문구)와 "종목 선택" 의 결과(pick emit).
  검색(lookup)은 **이 패널의 일**이라 자체 보유 — 랭킹에 없는 종목도 코드·이름으로 찾는다.
-->
<template>
  <div class="signals">


      <!--
        🔴 2026-09-21 사용자: *"타이틀이랑 하단 정보가 안 맞는데. 차라리 그냥 정형화된
           테이블로 라도 하지"* ⇒ 목록을 **표**로 바꿨다.
        ★ 목록형은 **어느 제목에 속한 줄인지**가 들여쓰기로만 표현돼서, 그룹이 4개로
          늘어나자 제목과 내용이 어긋나 보였다. 표는 **열이 뜻을 고정**한다.
        ⚠️ 그룹을 한 번에 다 펼치지 않고 **탭으로 하나씩** 본다 — 네 덩어리를 세로로
           쌓으면 어느 것이 어느 제목 밑인지 다시 헷갈린다.
      -->
      <div class="panel">
        <h3 class="panel__h">랭킹</h3>
        <p v-if="error" class="panel__err">{{ error }}</p>
        <template v-else>
          <div v-if="rankKeys.length" class="rank__tabs">
            <button
              v-for="k in rankKeys" :key="k"
              class="rank__tab" :class="{ 'rank__tab--on': k === rankTab }"
              @click="rankTab = k"
            >{{ rankLabel(k) }}</button>
          </div>
          <p v-if="!rankKeys.length" class="panel__empty">랭킹을 불러오지 못했습니다.</p>
          <template v-else-if="activeRank">
            <!-- 🔴 이 종류만 실패했으면 그렇게 말한다("없음" 과 다르다) -->
            <p v-if="activeRank.error" class="rank__err">{{ activeRank.error }}</p>
            <p v-else-if="!activeRank.rows?.length" class="panel__empty">해당 종목 없음</p>
            <div v-else class="rtable__scroll">
            <table class="rtable">
              <thead>
                <tr><th class="rtable__n">#</th><th>종목</th><th class="rtable__r">등락률</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in visibleRankRows" :key="row.symbol">
                  <td class="rtable__n mono-num">{{ row.rank }}</td>
                  <td>
                    <!-- ⚠️ 이름이 없으면 코드를 보여준다(빈칸보다 낫다) -->
                    <button class="linkish" :title="row.symbol" @click="$emit('pick', row.symbol, row.name || row.symbol)">
                      {{ row.name || row.symbol }}
                    </button>
                    <!-- 🔴 이름이 붙었을 때만 코드를 따로 보여준다(같은 값을 두 번 쓰지 않는다) -->
                    <small v-if="row.name" class="rtable__sym mono-num">{{ row.symbol }}</small>
                  </td>
                  <td class="rtable__r mono-num" :class="signClass(row.changePct)">{{ pct(row.changePct) }}</td>
                </tr>
              </tbody>
            </table>
            </div>
          </template>
        </template>

        <!--
          🔴 사용자: *"검색은 최하단에 붙여줘."*
          ★ 검색은 **결과를 본 뒤에** 쓰는 것이라 목록 아래가 맞다 —
            위에 있으면 매번 랭킹을 한 칸 밀어낸다.
        -->

        <!--
          🔴 사용자: *"티커/한국 주식 검색창 제공 · 클릭시 좌측 차트 반응"*
          ⚠️ 이건 **거르는 칸이 아니라 찾는 칸**이다 — 랭킹에 없는 종목도
             코드를 넣으면 차트를 띄울 수 있어야 검색창의 뜻이 산다.
        -->
        <form class="rank__find" @submit.prevent="findSymbol">
          <input v-model="rankQuery" class="input input--xs" placeholder="종목명·티커 (예: 삼성전자)" />
          <button class="iconbtn" type="submit" :disabled="!rankQuery.trim() || findBusy" aria-label="조회" title="조회">
            {{ findBusy ? '…' : '🔍' }}
          </button>
        </form>
        <p v-if="findError" class="panel__err">{{ findError }}</p>
      </div>
    </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { apiFetch } from '../lib/apiClient';

const props = defineProps({
  rankings: { type: Object, default: () => ({}) },
  error: { type: String, default: '' },
});
const emit = defineEmits(['pick']);

const RANK_LABEL = {
  TOP_GAINERS: '급등', TOP_LOSERS: '급락',
  MARKET_TRADING_AMOUNT: '거래대금', MARKET_TRADING_VOLUME: '거래량',
  TOSS_SECURITIES_TRADING_AMOUNT: '토스 거래대금', TOSS_SECURITIES_TRADING_VOLUME: '토스 거래량',
};
function rankLabel(key) {
  const [country, type] = String(key).split(':');
  return `${country === 'US' ? '미국' : '한국'} ${RANK_LABEL[type] || type}`;
}

const rankTab = ref('');
const rankKeys = computed(() => Object.keys(props.rankings || {}));
const activeRank = computed(() => {
  const keys = rankKeys.value;
  if (!keys.length) return null;
  const key = keys.includes(rankTab.value) ? rankTab.value : keys[0];
  return props.rankings[key];
});

/** 검색어가 있으면 목록도 같이 좁힌다(찾는 중에 눈이 편하게) */
const visibleRankRows = computed(() => {
  const rows = activeRank.value?.rows || [];
  const q = rankQuery.value.trim().toLowerCase();
  if (!q) return rows.slice(0, 30);
  return rows
    .filter((r) => r.symbol?.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q))
    .slice(0, 30);
});

const rankQuery = ref('');
const findBusy = ref(false);
const findError = ref('');

/**
 * 종목 검색 — ①목록 안에서 먼저 찾고 ②없으면 서버 `/api/lookup`(코드 → 이름 순).
 * 🔴 사용자: *"삼성전자 검색하면 안뜨는데 **이름으로도** 검색할수 있게"* — 한글을 티커로
 *    보내면 당연히 없다. 조용히 실패하지 않는다(앞판은 엉뚱한 코드로 "빈 차트" 를 열었다).
 */
async function findSymbol() {
  const q = rankQuery.value.trim();
  if (!q || findBusy.value) return;
  findError.value = '';
  const hit = (activeRank.value?.rows || []).find(
    (r) => r.symbol?.toLowerCase() === q.toLowerCase() || (r.name || '').includes(q)
  );
  if (hit) { emit('pick', hit.symbol, hit.name || hit.symbol); rankQuery.value = ''; return; }
  findBusy.value = true;
  try {
    const res = await apiFetch(`/api/lookup?q=${encodeURIComponent(q)}`);
    const b = await res.json().catch(() => ({}));
    if (!res.ok || !b.ok) throw new Error(b.error || `'${q}' 를 찾지 못했습니다.`);
    emit('pick', b.symbol, b.name || b.symbol);
    rankQuery.value = '';
  } catch (e) {
    findError.value = e.message;
  } finally {
    findBusy.value = false;
  }
}

function pct(v) {
  if (v == null) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function signClass(v) {
  if (v == null) return 'flat';
  return Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : 'flat';
}
</script>

<style scoped>
/* 레이아웃 글루 — 부모 aside 안에서 세로로 꽉 찬다 (WorkspaceView 에서 이사) */
.signals { display: flex; flex-direction: column; gap: var(--space-sm); flex: 1; min-height: 0; }
.signals > .panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rtable__scroll { flex: 1; min-height: 0; overflow-y: auto; }

.linkish {
  border: 0; background: none; padding: 0; cursor: pointer;
  color: var(--color-ink); font-size: var(--text-md); text-align: left;
}

.linkish:hover { color: var(--color-primary); }

.rank { display: flex; flex-direction: column; gap: 4px; }

.rank__type { font-size: var(--text-2xs); color: var(--color-faint); letter-spacing: 0.06em; }

.rank__list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }

.rank__list li { font-size: var(--text-sm); }

.rank__err { margin: 0; font-size: var(--text-xs); color: var(--color-down); }

/* ── 랭킹 표 ──────────────────────────────────────── */
.rank__find { display: flex; gap: 4px; margin-bottom: var(--space-xs); }

.rank__find .input { flex: 1; min-width: 0; }

.rank__tabs { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: var(--space-xs); }

.rank__tab {
  border: 0; background: var(--color-surface-sunken); color: var(--color-muted);
  font-size: var(--text-2xs); font-weight: 600; padding: 3px 8px;
  border-radius: var(--rounded-sm); cursor: pointer;
}

.rank__tab--on { background: var(--color-primary-soft); color: var(--color-primary); }

.rtable { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }

.rtable th {
  text-align: left; font-weight: 600; color: var(--color-faint);
  font-size: var(--text-2xs); padding: 2px 4px; border-bottom: 1px solid var(--color-hairline);
}

.rtable td { padding: 3px 4px; border-bottom: 1px solid var(--color-hairline-soft); }

.rtable tr:last-child td { border-bottom: 0; }

/* ⚠️ 위와 **같은 함정**을 내가 이 표에도 넣었다(`.rtable th` 가 유틸 클래스를 이긴다).
      한 곳 고칠 때 저장소를 훑으라는 규칙의 CSS 판본 — 아래는 th·td 를 함께 짚는다. */
.rtable th.rtable__n, .rtable td.rtable__n { width: 1.6rem; color: var(--color-faint); text-align: right; }

.rtable th.rtable__r, .rtable td.rtable__r { text-align: right; white-space: nowrap; }

.rtable__sym { display: block; color: var(--color-faint); font-size: var(--text-2xs); }
</style>
