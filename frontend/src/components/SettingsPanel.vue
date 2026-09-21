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

const form = ref({
  momentumPct: 3, refreshSec: 60, rankingTypes: [], rankingCountries: [],
  briefingPrompt: '', briefingCron: '',
  /**
   * 종목별 목표가·손절가 (2026-09-21 사용자 지시).
   * ⚠️ 화면에서는 **행 배열**로 다룬다 — 객체로 두면 빈 행을 못 만들고 지우기도 까다롭다.
   *    저장할 때 객체로 바꾼다.
   */
  targetRows: [],
});
/** 테마 그룹 관리 — 사용자가 "새 테마 추가도 설정에서" 라고 했다(2026-09-21) */
const groups = ref([]);
const newGroup = ref('');
const groupBusy = ref(false);
const usingDefault = ref([]);
const busy = ref(false);
const msg = ref('');
const err = ref('');

/** 🔴 토스 실제 enum 이다. 임의로 만들면 400 이 나고 랭킹이 빈다(2026-09-21에 겪었다) */
const RANKING_LABELS = {
  TOP_GAINERS: '급등',
  TOP_LOSERS: '급락',
  MARKET_TRADING_AMOUNT: '거래대금',
  MARKET_TRADING_VOLUME: '거래량',
  TOSS_SECURITIES_TRADING_AMOUNT: '토스 거래대금',
  TOSS_SECURITIES_TRADING_VOLUME: '토스 거래량',
};

/** 행 배열 → `{ SYMBOL: {target, stop} }`. ⚠️ 빈 행은 버린다(빈 껍데기를 저장하지 않는다) */
function targetsObject() {
  const out = {};
  for (const r of form.value.targetRows) {
    const sym = String(r.symbol || '').trim().toUpperCase();
    if (!sym) continue;
    const target = r.target === '' || r.target == null ? null : Number(r.target);
    const stop = r.stop === '' || r.stop == null ? null : Number(r.stop);
    if (target == null && stop == null) continue;
    out[sym] = { target, stop };
  }
  return out;
}

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
        rankingCountries: [...(s.rankingCountries || [])],
        briefingPrompt: s.briefingPrompt || '',
        briefingCron: s.briefingCron || '',
        targetRows: Object.entries(s.targets || {}).map(([symbol, v]) => ({
          symbol, target: v?.target ?? '', stop: v?.stop ?? '',
        })),
      };
      usingDefault.value = s.usingDefault || [];
    }
    const w = await apiFetch('/api/watchlist');
    if (w.ok) groups.value = (await w.json())?.groups || [];
  } catch (e) {
    err.value = e.message;
  }
}

async function addGroup() {
  const name = newGroup.value.trim();
  if (!name || groupBusy.value) return;
  groupBusy.value = true;
  err.value = '';
  try {
    const res = await apiFetch('/api/watchlist/groups', { method: 'POST', body: JSON.stringify({ name }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `추가 실패 (${res.status})`);
    newGroup.value = '';
    await load();
    emit('saved');
  } catch (e) {
    err.value = e.message;
  } finally {
    groupBusy.value = false;
  }
}

async function removeGroup(g) {
  // ⚠️ 되돌릴 수 없다 — 담긴 종목이 함께 사라진다. 한 번 묻는다.
  if (!window.confirm(`"${g.name}" 테마를 지웁니다. 담긴 종목 ${g.tickers?.length || 0}개도 함께 사라집니다.`)) return;
  err.value = '';
  try {
    const res = await apiFetch(`/api/watchlist/groups/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`삭제 실패 (${res.status})`);
    await load();
    emit('saved');
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
      // 🔴 화면은 **행 배열**, 서버는 **객체** 다 — 여기서 한 번만 바꾼다
      body: JSON.stringify({ dashboard: { ...form.value, targetRows: undefined, targets: targetsObject() } }),
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

function toggleCountry(c) {
  const i = form.value.rankingCountries.indexOf(c);
  if (i >= 0) form.value.rankingCountries.splice(i, 1);
  else form.value.rankingCountries.push(c);
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
        <div class="sp__presets">
          <button v-for="v in [1, 2, 3, 5, 10]" :key="v" class="sp__chip"
            :class="{ 'sp__chip--on': form.momentumPct === v }" @click="form.momentumPct = v">{{ v }}%</button>
        </div>
        <input v-model.number="form.momentumPct" type="number" step="0.1" min="0.1" max="50" />
        <small>당일 등락이 이만큼 움직인 종목만 <b>모멘텀</b>에 올라옵니다. 작게 할수록 많이 보입니다.</small>
      </label>

      <label class="sp__row">
        <span class="sp__label">
          자동 갱신 주기 (초)
          <em v-if="usingDefault.includes('refreshSec')">기본값</em>
        </span>
        <div class="sp__presets">
          <button v-for="v in [30, 60, 180, 600]" :key="v" class="sp__chip"
            :class="{ 'sp__chip--on': form.refreshSec === v }" @click="form.refreshSec = v">
            {{ v < 60 ? v + '초' : v / 60 + '분' }}
          </button>
        </div>
        <input v-model.number="form.refreshSec" type="number" min="15" max="3600" />
        <small>화면 숫자를 얼마나 자주 새로 받을지. 짧을수록 토스 호출이 늘어납니다.</small>
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
        <small>오른쪽 <b>랭킹</b> 패널에 어떤 순위를 보여줄지 고릅니다.</small>
      </div>

      <div class="sp__row">
        <span class="sp__label">랭킹 시장</span>
        <div class="sp__chips">
          <button v-for="c in ['US', 'KR']" :key="c" class="sp__chip"
            :class="{ 'sp__chip--on': form.rankingCountries.includes(c) }" @click="toggleCountry(c)">
            {{ c === 'US' ? '미국' : '한국' }}
          </button>
        </div>
        <small>미국장을 주로 보시면 <b>미국</b>만 켜 두셔도 됩니다.</small>
      </div>

      <div class="sp__row sp__row--sep">
        <span class="sp__label">관심 테마</span>
        <ul class="sp__groups">
          <li v-for="g in groups" :key="g.id">
            <span>{{ g.name }}</span>
            <span class="sp__gcount">{{ g.tickers?.length || 0 }}</span>
            <button class="sp__gdel" title="삭제" @click="removeGroup(g)">×</button>
          </li>
          <li v-if="!groups.length" class="sp__gempty">아직 테마가 없습니다.</li>
        </ul>
        <div class="sp__gadd">
          <input v-model="newGroup" type="text" placeholder="예: 반도체, 미국 ETF, 배당주" @keyup.enter="addGroup" />
          <button class="btn btn--primary" :disabled="groupBusy || !newGroup.trim()" @click="addGroup">추가</button>
        </div>
        <small>테마를 만들면 상단 스트립에 카드로 나타납니다. 종목은 거기서 넣습니다.</small>
      </div>

      <label class="sp__row">
        <span class="sp__label">
          매매 분석 추가 지시 (프롬프트)
          <em v-if="usingDefault.includes('briefingPrompt')">없음</em>
        </span>
        <textarea v-model="form.briefingPrompt" class="sp__area" rows="5"
          placeholder="예: 보유 비중과 환율 영향을 먼저 보고, 단기 대응보다 리스크를 우선해서 써 줘." />
        <small>매매 분석 AI 가 <b>이 문장을 그대로</b> 따릅니다. 비워도 됩니다.</small>
      </label>

      <label class="sp__row">
        <span class="sp__label">
          분석 자동 실행 주기 (cron)
          <em v-if="usingDefault.includes('briefingCron')">없음</em>
        </span>
        <input v-model="form.briefingCron" type="text" placeholder="예: 0 9,15 * * 1-5" />
        <small>비워 두면 자동 실행하지 않습니다(버튼으로 직접).</small>
      </label>

        <section class="sp__sec">
          <h3 class="sp__h">
            목표가 · 손절선
            <small>종목별 기준선을 넘으면 텔레그램으로 알립니다</small>
          </h3>
          <!--
            🔴 **사람이 정한 기준이라 오경보가 없다** — 급변(%)은 시장이 정하지만 이건 내가 정한다.
            ⚠️ 통화를 환산하지 않는다 — 그 종목 화면에서 보는 단위 그대로 적는다
               (환산해 두면 환율이 움직일 때 **기준선이 조용히 이동한다**).
          -->
          <div v-for="(row, i) in form.targetRows" :key="i" class="sp__target">
            <input v-model="row.symbol" class="input sp__xs" placeholder="종목코드" />
            <input v-model="row.target" class="input sp__xs" type="number" placeholder="목표가" />
            <input v-model="row.stop" class="input sp__xs" type="number" placeholder="손절가" />
            <button class="sp__icon" aria-label="삭제" title="삭제" @click="form.targetRows.splice(i, 1)">×</button>
          </div>
          <button class="btn sp__add" @click="form.targetRows.push({ symbol: '', target: '', stop: '' })">
            + 기준선 추가
          </button>
        </section>

      <footer class="sp__foot">
        <button class="btn" @click="emit('close')">닫기</button>
        <button class="btn btn--primary" :disabled="busy" @click="save">{{ busy ? '저장 중…' : '저장' }}</button>
      </footer>
    </aside>
  </div>
</template>

<style scoped>
/*
  🔴 **자기 스타일만 쓴다.** 첫 판은 `input--xs`·`btn--xs`·`btn--soft`·`iconbtn` 을 그대로 썼는데
     그건 전부 **WorkspaceView 의 scoped 클래스**라 여기서는 **아무 스타일도 안 먹는다.**
     내가 오늘 만든 `noBorrowedScopedClass` 가드가 정확히 이걸 잡았다(입력칸이 맨몸으로 나왔을 것).
*/
.sp__target { display: grid; grid-template-columns: 1fr 1fr 1fr 26px; gap: 4px; margin-bottom: 4px; }
.sp__xs { height: 28px; font-size: var(--text-xs); padding: 0 8px; }
.sp__icon {
  width: 26px; height: 28px; padding: 0; line-height: 1; cursor: pointer;
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm);
  background: var(--color-surface-sunken); color: var(--color-body);
}
.sp__icon:hover { background: var(--color-surface-hover); }
.sp__add {
  height: 28px; padding: 0 10px; font-size: var(--text-xs);
  background: var(--color-primary-soft); border-color: var(--color-primary-line); color: var(--color-primary);
}
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
/**
 * 🔴 2026-09-21: 입력값이 화면에서 **안 보였다.**
 *    `.input` 은 WorkspaceView 의 **scoped** 스타일이라 이 컴포넌트에는 적용되지 않는다 —
 *    글자색·배경이 지정되지 않아 브라우저 기본(어두운 배경 위 어두운 글자)이 됐다.
 *    ⇒ 이 컴포넌트가 **자기 입력 스타일을 갖는다.** 남의 scoped 에 기대지 않는다.
 */
.sp input[type='text'],
.sp input[type='number'],
.sp .sp__area {
  width: 100%;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-hairline-strong);
  border-radius: var(--rounded-md);
  color: var(--color-ink);
  font-size: var(--text-base);
  padding: 10px var(--space-base);
}
.sp input::placeholder,
.sp .sp__area::placeholder { color: var(--color-faint); }
.sp input:focus,
.sp .sp__area:focus {
  outline: none; border-color: var(--color-primary-line); box-shadow: var(--ring);
}
.sp .sp__area { resize: vertical; line-height: 1.6; }
.sp__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sp__chip {
  border: 1px solid var(--color-hairline); background: var(--color-surface-sunken);
  color: var(--color-muted); font-size: var(--text-sm); padding: 4px 10px;
  border-radius: var(--rounded-pill); cursor: pointer;
}
.sp__chip--on { background: var(--color-primary-soft); border-color: var(--color-primary-line); color: var(--color-primary); }
.sp__err { margin: 0; color: var(--color-down); font-size: var(--text-md); }
.sp__ok { margin: 0; color: var(--color-up); font-size: var(--text-md); }
/**
 * 🔴 `.btn`·`.iconbtn` 도 WorkspaceView 의 **scoped** 스타일이라 여기선 안 먹는다.
 *    입력만 고치고 버튼을 안 훑어서 **닫기 ×와 추가 버튼이 흰 상자**로 남아 있었다
 *    (사용자 스크린샷에서 보였다). *"한 곳 고치면 전수 훑는다"* 를 또 어겼다.
 *    ⇒ 이 컴포넌트가 쓰는 것은 **이 컴포넌트가 정의한다.**
 */
.sp .btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 36px; padding: 0 var(--space-md);
  border: 1px solid var(--color-hairline-strong); border-radius: var(--rounded-md);
  background: var(--color-surface-raised); color: var(--color-ink);
  font-size: var(--text-md); font-weight: 600; white-space: nowrap; cursor: pointer;
}
.sp .btn:hover:not(:disabled) { background: var(--color-surface-hover); }
.sp .btn:disabled { opacity: 0.42; cursor: not-allowed; }
.sp .btn--primary {
  background: var(--color-primary); border-color: transparent; color: var(--color-on-primary);
}
.sp .btn--primary:hover:not(:disabled) { background: var(--color-primary-hover); }
.sp .iconbtn {
  width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; background: transparent; border-radius: var(--rounded-sm);
  color: var(--color-muted); font-size: var(--text-xl); line-height: 1; cursor: pointer;
}
.sp .iconbtn:hover { background: var(--color-surface-hover); color: var(--color-ink); }

.sp__presets { display: flex; gap: 6px; flex-wrap: wrap; }
.sp__row--sep { border-top: 1px solid var(--color-hairline); padding-top: var(--space-base); }
.sp__groups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sp__groups li { display: flex; align-items: center; gap: 8px; font-size: var(--text-md); color: var(--color-ink); }
.sp__gcount { margin-left: auto; font-size: var(--text-xs); color: var(--color-faint); }
.sp__gdel { border: 0; background: none; color: var(--color-muted); cursor: pointer; font-size: var(--text-lg); }
.sp__gdel:hover { color: var(--color-danger); }
.sp__gempty { color: var(--color-faint); font-size: var(--text-sm); }
.sp__gadd { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
.sp__foot { margin-top: auto; display: flex; justify-content: flex-end; gap: var(--space-sm); padding-top: var(--space-base); }
</style>
