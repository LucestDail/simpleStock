<!--
  주문 티켓 · 사전 점검 모달 (2026-10-02 — 와이어프레임 ⑨)

  원문 원칙: *"에이전트는 주문 '초안'까지만 만든다. 실제 주문 전송은 사람의 최종 확인
  한 번을 반드시 거친다."*

  ## 왜 만들었나
  종전 화면에는 **제안 → 실제 주문 경로가 없었다.** 매매 제안이 *"승인"* 이라는 문구로만
  존재했고, 사람이 승인 버튼을 누를 때 **무엇을 근거로** 누르는지가 화면에 없었다 —
  잔고가 충분한지, 장이 열려 있는지, 같은 종목에 미체결이 있는지, 체결되면 비중이
  어떻게 바뀌는지가 전부 보이지 않았다.

  ## ⚠️ 새 집행 경로를 만들지 않았다
  이 모달의 주 버튼은 기존과 **같은 `approve`** 다. 실제 전송(`execute`)은 종전 경로를
  그대로 쓴다 — 되돌리기 어려운 행위의 문을 늘리지 않는다.
-->
<template>
  <div class="ticket__scrim" @click.self="$emit('close')">
    <section class="ticket" role="dialog" aria-modal="true" :aria-label="`${sideKo} ${proposal.symbol} 주문 검토`">
      <header class="ticket__head">
        <div>
          <p class="ticket__eyebrow">AI 매매 제안 · 검토</p>
          <h2 class="ticket__title">
            <span :class="`ticket__side ticket__side--${proposal.side.toLowerCase()}`">{{ sideKo }}</span>
            {{ proposal.symbol }}
            <span class="mono-num">{{ proposal.quantity }}주</span>
            <small class="mono-num">{{ proposal.conditional ? '예약' : '지정가' }} {{ priceShown }}</small>
          </h2>
        </div>
        <button class="ticket__x" aria-label="닫기" @click="$emit('close')">✕</button>
      </header>

      <!-- ── 사전 점검 ──────────────────────────────────────────── -->
      <h3 class="ticket__h">사전 점검</h3>
      <p v-if="loading" class="ticket__skel">점검 중…</p>
      <!--
        🔴 **못 읽은 것을 통과로 보여주지 않는다.** 점검 자체가 실패하면 그 사실을 적는다 —
           빈 목록을 보여주면 "문제 없음" 으로 읽힌다.
      -->
      <p v-else-if="error" class="ticket__fail">사전 점검을 하지 못했습니다 — {{ error }}</p>
      <ul v-else class="checks">
        <li v-for="c in checks" :key="c.key" :class="`checks__row checks__row--${c.status}`">
          <span class="checks__icon" aria-hidden="true">{{ icon(c.status) }}</span>
          <span class="checks__label">{{ c.label }}</span>
          <span class="checks__detail">{{ c.detail }}</span>
          <!-- ⚠️ 깎으면 되는 경우는 **선택지를 준다** — 사용자가 직접 계산하게 두지 않는다 -->
          <button
            v-if="c.suggestQuantity"
            class="btn ticket__trim"
            @click="$emit('trim', { proposal, quantity: c.suggestQuantity })"
          >{{ c.suggestQuantity }}주로 줄이기</button>
        </li>
      </ul>

      <!-- ── 포트폴리오 영향 ────────────────────────────────────── -->
      <template v-if="impact">
        <h3 class="ticket__h">체결 후 포트폴리오</h3>
        <table class="impact">
          <thead><tr><th>항목</th><th class="ta-r">현재</th><th class="ta-r">체결 후</th><th class="ta-r">변화</th></tr></thead>
          <tbody>
            <tr v-for="r in impactRows" :key="r.label">
              <td>{{ r.label }}</td>
              <td class="ta-r mono-num">{{ r.before }}%</td>
              <td class="ta-r mono-num">{{ r.after }}%</td>
              <td class="ta-r mono-num" :class="r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''">
                {{ r.delta > 0 ? '+' : '' }}{{ r.delta }}%p
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- ── 근거 ───────────────────────────────────────────────── -->
      <template v-if="proposal.reason">
        <h3 class="ticket__h">근거</h3>
        <p class="ticket__why">{{ proposal.reason }}</p>
      </template>

      <!--
        🔴 **판정을 숨기지 않는다.** `blocked` 면 왜 막혔는지가 위 목록에 있고,
           승인 버튼은 비활성이다. 버튼만 사라지면 사용자는 이유를 모른다.
      -->
      <p v-if="verdict === 'blocked'" class="ticket__fail">
        지금은 이 주문이 성립하지 않습니다 — 위 🔴 항목을 먼저 해결해야 합니다.
      </p>
      <p v-else-if="verdict === 'caution'" class="ticket__warn">
        확인이 필요한 항목이 있습니다. 위 ⚠️·❔ 를 읽고 판단하세요.
      </p>

      <footer class="ticket__foot">
        <label class="ticket__ack">
          <input v-model="acked" type="checkbox" />
          주문 내용과 점검 결과를 확인했습니다
        </label>
        <div class="ticket__btns">
          <button class="btn" @click="$emit('close')">나중에</button>
          <button class="btn" @click="$emit('reject', proposal)">거절</button>
          <button
            class="btn btn--primary"
            :disabled="!acked || verdict === 'blocked' || loading"
            @click="$emit('approve', proposal)"
          >승인</button>
        </div>
      </footer>
      <!--
        ⚠️ **승인 ≠ 전송.** 승인은 되돌릴 수 있고, 실제 주문 전송은 목록에서 한 번 더
           누른다. 이 모달이 전송까지 하면 **되돌리기 어려운 행위의 문이 하나 늘어난다.**
      -->
      <p class="ticket__note">승인해도 주문은 아직 나가지 않습니다 — 목록에서 한 번 더 확인합니다.</p>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const props = defineProps({
  proposal: { type: Object, required: true },
  /** 호출자가 주입한다 — 컴포넌트가 직접 fetch 를 들면 테스트가 실물을 타게 된다 */
  fetchPrecheck: { type: Function, required: true },
});
defineEmits(['close', 'approve', 'reject', 'trim']);

const loading = ref(true);
const error = ref('');
const checks = ref([]);
const impact = ref(null);
const verdict = ref('caution');
const acked = ref(false);

const sideKo = computed(() => (props.proposal.side === 'BUY' ? '매수' : '매도'));
const priceShown = computed(() => props.proposal.conditional?.triggerPrice ?? props.proposal.price ?? '—');

const icon = (s) => ({ pass: '✅', warn: '⚠️', fail: '🔴', unknown: '❔' }[s] || '·');

/** 🔴 **변화량을 코드가 계산해 준다** — 사용자가 두 숫자를 빼게 두지 않는다 */
const impactRows = computed(() => {
  const i = impact.value;
  if (!i) return [];
  const sym = String(props.proposal.symbol || '').toUpperCase();
  const pick = (w) => w.holdings.find((h) => h.symbol === sym)?.pct ?? 0;
  const rows = [
    { label: `${sym} 비중`, before: pick(i.before), after: pick(i.after) },
    { label: '레버리지 노출', before: i.before.leveragePct, after: i.after.leveragePct },
    { label: '현금 비중', before: i.before.cashPct, after: i.after.cashPct },
  ];
  return rows.map((r) => ({ ...r, delta: Math.round((r.after - r.before) * 10) / 10 }));
});

onMounted(async () => {
  try {
    const r = await props.fetchPrecheck(props.proposal.id);
    if (!r?.ok) throw new Error(r?.error || '사전 점검 실패');
    checks.value = r.checks || [];
    impact.value = r.impact || null;
    verdict.value = r.verdict || 'caution';
  } catch (e) {
    // ⚠️ 조용히 비우지 않는다 — 빈 목록은 "문제 없음" 으로 읽힌다
    error.value = e.message || '사전 점검 실패';
    verdict.value = 'caution';
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.ticket__scrim {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, .55);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.ticket {
  width: min(560px, 100%); max-height: 88vh; overflow: auto;
  background: var(--color-surface, #14161c); color: var(--color-text, #e8ebf2);
  border: 1px solid var(--color-border, rgba(255,255,255,.12)); border-radius: 14px;
  padding: 18px 20px; display: flex; flex-direction: column; gap: 10px;
}
.ticket__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ticket__eyebrow { font-size: 11px; color: var(--color-muted, #8b93a7); margin: 0 0 2px; }
.ticket__title { margin: 0; font-size: 17px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ticket__title small { font-size: 12px; color: var(--color-muted, #8b93a7); font-weight: 400; }
.ticket__side { padding: 1px 7px; border-radius: 6px; font-size: 12px; }
.ticket__side--buy { background: rgba(70,180,120,.18); color: #5fc48f; }
.ticket__side--sell { background: rgba(224,96,58,.18); color: #ef7a55; }
.ticket__x { background: none; border: 0; color: var(--color-muted, #8b93a7); cursor: pointer; font-size: 15px; }
.ticket__h { margin: 6px 0 0; font-size: 12px; color: var(--color-muted, #8b93a7); font-weight: 600; }
.ticket__skel { color: var(--color-muted, #8b93a7); font-size: 13px; margin: 0; }
.ticket__fail { color: #ef7a55; font-size: 13px; margin: 0; }
.ticket__warn { color: #e0ad48; font-size: 13px; margin: 0; }
.ticket__why { font-size: 13px; line-height: 1.55; margin: 0; }
.ticket__note { font-size: 11px; color: var(--color-muted, #8b93a7); margin: 0; }

.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.checks__row { display: grid; grid-template-columns: 18px 1fr auto auto; align-items: center; gap: 8px; font-size: 13px; }
.checks__icon { font-size: 12px; line-height: 1; }
.checks__label { color: var(--color-text, #e8ebf2); }
.checks__detail { color: var(--color-muted, #8b93a7); font-size: 12px; }
.checks__row--fail .checks__detail { color: #ef7a55; }
.checks__row--warn .checks__detail { color: #e0ad48; }

.impact { width: 100%; border-collapse: collapse; font-size: 13px; }
.impact th, .impact td { padding: 5px 6px; border-bottom: 1px solid var(--color-border, rgba(255,255,255,.08)); }
.impact th { font-size: 11px; color: var(--color-muted, #8b93a7); font-weight: 500; text-align: left; }
/* ⚠️ `.impact th` 가 `.ta-r` 를 이긴다 — 헤더만 반대쪽에 붙으므로 **명시**한다 */
.impact th.ta-r { text-align: right; }
.ta-r { text-align: right; }
.up { color: #5fc48f; }
.down { color: #ef7a55; }

.ticket__foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; }
.ticket__ack { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
.ticket__btns { display: flex; gap: 6px; }
/* ⚠️ `btn--xs` 는 **남의 scoped 클래스**였다 — 여기서 쓰면 스타일이 안 먹는다(가드가 잡았다) */
.ticket__trim { font-size: 11px; padding: 2px 8px; }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
</style>
