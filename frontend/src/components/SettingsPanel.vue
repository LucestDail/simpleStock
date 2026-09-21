<script setup>
import { ref, watch } from 'vue';
import { apiFetch } from '../lib/apiClient';

/**
 * 운영 설정 (2026-09-21)
 *
 * 사용자: *"모멘텀 체크나 상황/시황판단을 위한 여러가지 옵션 및 설정, 프롬프트 세팅, 주기"*
 *
 * 🔴 **주문 켜기는 여기 없다.** 화면에서 실수로 켜질 수 있어서 서버 환경변수(`ORDERS_ENABLED`)에 뒀다.
 *    여기 있는 것은 전부 **되돌릴 수 있는** 값이다.
 * ⚠️ 서버가 범위를 벗어난 값을 **기본값으로 되돌린다.** 저장 후 서버가 준 값을 다시 그려서
 *    "내가 넣은 값이 안 들어갔다" 를 화면에서 바로 알 수 있게 한다.
 */
const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'saved']);

const form = ref({ momentumPct: 3, refreshSec: 60, rankingTypes: [], briefingPrompt: '', briefingCron: '' });
const usingDefault = ref([]);
const busy = ref(false);
const msg = ref('');
const err = ref('');

const RANKING_LABELS = {
  TOP_GAINERS: '급등',
  TOP_LOSERS: '급락',
  tradingVolume: '거래량',
  tradingAmount: '거래대금',
};

async function load() {
  err.value = '';
  try {
    const res = await apiFetch('/api/system/status');
    if (!res.ok) throw new Error(`설정을 불러오지 못했습니다 (${res.status})`);
    const d = await res.json();
    const s = d?.dashboardSettings || null;
    if (s) {
      form.value = {
        momentumPct: s.momentumPct,
        refreshSec: s.refreshSec,
        rankingTypes: [...(s.rankingTypes || [])],
        briefingPrompt: s.briefingPrompt || '',
        briefingCron: s.briefingCron || '',
      };
      usingDefault.value = s.usingDefault || [];
    }
  } catch (e) {
    err.value = e.message;
  }
}

async function save() {
  busy.value = true;
  msg.value = '';
  err.value = '';
  try {
    const res = await apiFetch('/api/system/settings', {
      method: 'PUT',
      body: JSON.stringify({ dashboard: { ...form.value } }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || `저장 실패 (${res.status})`);
    }
    // 🔴 서버가 정규화한 값을 **다시 읽어 그린다** — 잘린 값을 모른 채 쓰지 않게
    await load();
    msg.value = '저장했습니다. 서버가 정규화한 값을 다시 표시합니다.';
    emit('saved');
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

function toggleRanking(t) {
  const i = form.value.rankingTypes.indexOf(t);
  if (i >= 0) form.value.rankingTypes.splice(i, 1);
  else form.value.rankingTypes.push(t);
}

watch(() => props.open, (v) => { if (v) load(); }, { immediate: true });
</script>

<template>
  <div v-if="open" class="sp__backdrop" @click.self="emit('close')">
    <aside class="sp" role="dialog" aria-label="운영 설정">
      <header class="sp__head">
        <h2>운영 설정</h2>
        <button class="iconbtn" aria-label="닫기" @click="emit('close')">×</button>
      </header>

      <p v-if="err" class="sp__err">{{ err }}</p>
      <p v-if="msg" class="sp__ok">{{ msg }}</p>

      <label class="sp__row">
        <span class="sp__label">
          모멘텀 임계값 (%)
          <em v-if="usingDefault.includes('momentumPct')">기본값</em>
        </span>
        <input v-model.number="form.momentumPct" class="input input--sm" type="number" step="0.1" min="0.1" max="50" />
        <small>당일 등락이 이 값을 넘으면 모멘텀 후보로 고릅니다. 낮출수록 후보가 늘어납니다.</small>
      </label>

      <label class="sp__row">
        <span class="sp__label">
          자동 갱신 주기 (초)
          <em v-if="usingDefault.includes('refreshSec')">기본값</em>
        </span>
        <input v-model.number="form.refreshSec" class="input input--sm" type="number" min="15" max="3600" />
        <small>짧을수록 토스 API 호출이 늘어납니다. 15초 미만은 서버가 되돌립니다.</small>
      </label>

      <div class="sp__row">
        <span class="sp__label">
          랭킹 종류
          <em v-if="usingDefault.includes('rankingTypes')">기본값</em>
        </span>
        <div class="sp__chips">
          <button
            v-for="(label, t) in RANKING_LABELS"
            :key="t"
            class="sp__chip"
            :class="{ 'sp__chip--on': form.rankingTypes.includes(t) }"
            @click="toggleRanking(t)"
          >{{ label }}</button>
        </div>
        <small>고른 만큼 호출이 늘어납니다(랭킹 한도 5/초).</small>
      </div>

      <label class="sp__row">
        <span class="sp__label">
          브리핑 추가 지시 (프롬프트)
          <em v-if="usingDefault.includes('briefingPrompt')">없음</em>
        </span>
        <textarea v-model="form.briefingPrompt" class="sp__area" rows="5"
          placeholder="예: 보유 비중과 환율 영향을 먼저 보고, 단기 대응보다 리스크를 우선해서 써 줘." />
        <small>모델에게 그대로 전달됩니다. 1000자까지.</small>
      </label>

      <label class="sp__row">
        <span class="sp__label">
          브리핑 자동 생성 주기 (cron)
          <em v-if="usingDefault.includes('briefingCron')">없음</em>
        </span>
        <input v-model="form.briefingCron" class="input input--sm" placeholder="예: 0 9,15 * * 1-5" />
        <small>비우면 자동 생성하지 않습니다.</small>
      </label>

      <footer class="sp__foot">
        <button class="btn" @click="emit('close')">닫기</button>
        <button class="btn btn--primary" :disabled="busy" @click="save">{{ busy ? '저장 중…' : '저장' }}</button>
      </footer>
    </aside>
  </div>
</template>

<style scoped>
.sp__backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; justify-content: flex-end; z-index: 40;
}
.sp {
  width: min(460px, 92vw); height: 100%; overflow-y: auto;
  background: var(--color-surface); border-left: 1px solid var(--color-hairline);
  padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-base);
}
.sp__head { display: flex; align-items: center; justify-content: space-between; }
.sp__head h2 { margin: 0; font-size: var(--text-lg); font-weight: 700; color: var(--color-ink); }
.sp__row { display: flex; flex-direction: column; gap: 6px; }
.sp__label { font-size: var(--text-md); font-weight: 600; color: var(--color-ink); display: flex; gap: 8px; align-items: center; }
.sp__label em {
  font-style: normal; font-size: var(--text-2xs); font-weight: 600;
  color: var(--color-faint); background: var(--color-flat-soft);
  padding: 1px 6px; border-radius: var(--rounded-pill);
}
.sp__row small { font-size: var(--text-xs); color: var(--color-muted); line-height: 1.5; }
.sp__area {
  background: var(--color-surface-sunken); border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-md); color: var(--color-ink); padding: var(--space-sm);
  font-size: var(--text-md); resize: vertical;
}
.sp__area:focus { outline: none; border-color: var(--color-primary-line); box-shadow: var(--ring); }
.sp__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sp__chip {
  border: 1px solid var(--color-hairline); background: var(--color-surface-sunken);
  color: var(--color-muted); font-size: var(--text-sm); padding: 4px 10px;
  border-radius: var(--rounded-pill); cursor: pointer;
}
.sp__chip--on { background: var(--color-primary-soft); border-color: var(--color-primary-line); color: var(--color-primary); }
.sp__err { margin: 0; color: var(--color-down); font-size: var(--text-md); }
.sp__ok { margin: 0; color: var(--color-up); font-size: var(--text-md); }
.sp__foot { margin-top: auto; display: flex; justify-content: flex-end; gap: var(--space-sm); padding-top: var(--space-base); }
</style>
