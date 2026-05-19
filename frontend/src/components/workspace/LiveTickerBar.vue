<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { usePortfolio } from '../../composables/usePortfolio';
import { useWorkspace } from '../../composables/useWorkspace';
import { useRealtimeSubscription } from '../../composables/useRealtimeSubscription';
import { useInsightDetail } from '../../composables/useInsightDetail';

defineProps({
  showExtras: { type: Boolean, default: true },
});

const emit = defineEmits(['toggle-extras', 'open-settings']);

const { system, holdings, manager } = usePortfolio();
const { activityFeed } = useWorkspace();
const { connectionState, reconnectAttempt, lastEventAt } = useRealtimeSubscription();
const { nextManagerBrief, marketPulse } = useInsightDetail();

const now = ref(new Date());
let clockTimer = null;

const liveClock = computed(() => {
  const date = now.value;
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = weekdays[date.getDay()];
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return {
    date: `${y}년 ${m}월 ${d}일 (${w})`,
    time: `${h}:${min}:${s}`,
  };
});

const connectionLabel = computed(() => {
  if (connectionState.value === 'connected') return '실시간 연결';
  if (connectionState.value === 'reconnecting') return `재연결 ${reconnectAttempt.value}`;
  if (connectionState.value === 'connecting') return '연결 중';
  return '오프라인';
});

const connectionTone = computed(() => {
  if (connectionState.value === 'connected') return 'ok';
  if (connectionState.value === 'reconnecting') return 'warn';
  return 'muted';
});

const marketItems = computed(() => {
  const items = [];
  const fx = system.value.market?.fx?.USDKRW;
  if (fx?.rate != null) {
    items.push({
      id: 'fx-usdkrw',
      label: 'USD/KRW',
      price: Number(fx.rate).toLocaleString('ko-KR', { maximumFractionDigits: 2 }),
      changePct: fx.changePct,
    });
  }

  for (const holding of holdings.value) {
    const details = holding.details || {};
    const ticker = String(details.ticker || '').trim();
    if (!ticker) continue;
    const price = details.currentPrice ?? details.lastQuote;
    let priceLabel = '—';
    if (Number.isFinite(Number(price))) {
      const currency = String(details.currency || '').toUpperCase();
      priceLabel =
        currency === 'USD'
          ? `$${Number(price).toFixed(2)}`
          : `${Math.round(Number(price)).toLocaleString('ko-KR')}`;
    }
    items.push({
      id: holding.id,
      label: ticker,
      sub: holding.name?.slice(0, 8) || '',
      price: priceLabel,
      changePct: details.priceChangePct,
    });
  }
  return items.slice(0, 10);
});

const alertItems = computed(() => {
  const rows = [];
  rows.push({
    id: 'session',
    tone: 'info',
    text: `장 상태 KR ${marketPulse.value.kr} · US ${marketPulse.value.us}`,
  });
  if (nextManagerBrief.value) {
    rows.push({
      id: 'next-brief',
      tone: 'accent',
      text: `예약 보고 ${nextManagerBrief.value.title} · ${nextManagerBrief.value.label}`,
    });
  }
  const marketError = String(system.value.market?.lastError || '').trim();
  if (marketError) {
    rows.push({
      id: 'market-err',
      tone: 'warn',
      text: marketError.slice(0, 100),
    });
  }
  if (manager.value?.latestReport?.summary) {
    rows.push({
      id: 'brief',
      tone: 'info',
      text: `최근 브리핑: ${String(manager.value.latestReport.summary).slice(0, 72)}…`,
    });
  }
  for (const item of activityFeed.value.slice(0, 3)) {
    rows.push({
      id: item.id,
      tone: item.tone === 'error' ? 'warn' : item.tone === 'warning' ? 'warn' : 'muted',
      text: `${item.title} · ${item.description}`.slice(0, 110),
    });
  }
  return rows.slice(0, 6);
});

const lastSyncLabel = computed(() => {
  const iso = lastEventAt.value || system.value.market?.lastSuccessAt;
  if (!iso) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
});

function formatPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

onMounted(() => {
  clockTimer = window.setInterval(() => {
    now.value = new Date();
  }, 1000);
});

onUnmounted(() => {
  if (clockTimer) window.clearInterval(clockTimer);
});
</script>

<template>
  <header class="live-bar">
    <div class="live-bar__top">
      <div class="live-bar__brand">
        <span class="live-badge">LIVE</span>
        <span class="live-badge live-badge--sub">실시간</span>
        <h1 class="live-bar__title">Quant Manager</h1>
      </div>

      <div class="live-bar__clock" aria-live="polite">
        <span class="live-bar__date">{{ liveClock.date }}</span>
        <strong class="live-bar__time mono-num">{{ liveClock.time }}</strong>
        <span v-if="lastSyncLabel" class="live-bar__sync">동기화 {{ lastSyncLabel }}</span>
      </div>

      <div class="live-bar__actions">
        <span class="conn" :class="`conn--${connectionTone}`">
          <span class="conn__dot" />
          {{ connectionLabel }}
        </span>
        <button type="button" class="live-btn" @click="emit('toggle-extras')">
          {{ showExtras ? '대화만' : '패널' }}
        </button>
        <button type="button" class="live-btn" @click="emit('open-settings')">설정</button>
      </div>
    </div>

    <div v-if="marketItems.length" class="live-bar__ticker" aria-label="시세 티커">
      <div class="live-bar__ticker-track">
        <article v-for="item in marketItems" :key="item.id" class="quote-chip">
          <span class="quote-chip__label">{{ item.label }}</span>
          <strong class="quote-chip__price mono-num">{{ item.price }}</strong>
          <span
            class="quote-chip__pct mono-num"
            :class="
              item.changePct == null
                ? ''
                : Number(item.changePct) >= 0
                  ? 'up'
                  : 'down'
            "
          >
            {{ formatPct(item.changePct) }}
          </span>
        </article>
      </div>
    </div>

    <div v-if="alertItems.length" class="live-bar__alerts">
      <span class="live-bar__alerts-label">알림·활동</span>
      <div class="live-bar__alerts-track">
        <span
          v-for="item in alertItems"
          :key="item.id"
          class="alert-chip"
          :class="`alert-chip--${item.tone}`"
        >
          {{ item.text }}
        </span>
      </div>
    </div>
  </header>
</template>

<style scoped>
.live-bar {
  display: grid;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xl);
  background:
    linear-gradient(180deg, rgba(110, 123, 255, 0.08), rgba(6, 8, 12, 0.92)),
    var(--color-surface-strong);
  box-shadow: var(--shadow-soft);
}

.live-bar__top {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.live-bar__brand {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.live-badge {
  padding: 2px 6px;
  border-radius: var(--rounded-pill);
  background: rgba(207, 32, 47, 0.2);
  color: #ff6b6b;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  animation: live-pulse 2s ease-in-out infinite;
}

.live-badge--sub {
  background: rgba(110, 123, 255, 0.15);
  color: #9aa8ff;
  animation: none;
  letter-spacing: 0.06em;
}

@keyframes live-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.65;
  }
}

.live-bar__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-ink);
  letter-spacing: -0.02em;
  white-space: nowrap;
}

.live-bar__clock {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  min-width: 0;
}

.live-bar__date {
  color: var(--color-muted);
  font-size: 12px;
}

.live-bar__time {
  color: var(--color-ink);
  font-size: clamp(18px, 2vw, 22px);
  font-weight: 600;
  letter-spacing: 0.04em;
  font-family: var(--font-mono);
  line-height: 1;
}

.live-bar__sync {
  color: var(--color-muted-soft);
  font-size: 10px;
}

.live-bar__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.conn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: var(--rounded-pill);
  border: 1px solid var(--color-hairline-soft);
  font-size: 11px;
  font-weight: 600;
  color: var(--color-muted);
}

.conn--ok {
  border-color: rgba(5, 177, 105, 0.35);
  color: #05b169;
}

.conn--warn {
  border-color: rgba(244, 176, 0, 0.35);
  color: #f4b000;
}

.conn__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.live-btn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-pill);
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-ink);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.live-bar__ticker {
  overflow: hidden;
  border-top: 1px solid var(--color-hairline-soft);
  padding-top: 6px;
}

.live-bar__ticker-track {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: thin;
  padding-bottom: 2px;
}

.quote-chip {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: auto auto auto;
  gap: 6px;
  align-items: center;
  padding: 4px 10px;
  border-radius: var(--rounded-pill);
  border: 1px solid var(--color-hairline-soft);
  background: rgba(255, 255, 255, 0.03);
}

.quote-chip__label {
  color: var(--color-ink);
  font-size: 12px;
  font-weight: 700;
}

.quote-chip__price {
  color: var(--color-body);
  font-size: 12px;
}

.quote-chip__pct {
  font-size: 11px;
  font-weight: 700;
}

.quote-chip__pct.up {
  color: var(--color-semantic-up);
}

.quote-chip__pct.down {
  color: var(--color-semantic-down);
}

.live-bar__alerts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  border-top: 1px solid var(--color-hairline-soft);
  padding-top: 6px;
}

.live-bar__alerts-label {
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding-top: 3px;
}

.live-bar__alerts-track {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

.alert-chip {
  padding: 3px 8px;
  border-radius: var(--rounded-pill);
  border: 1px solid var(--color-hairline-soft);
  background: rgba(255, 255, 255, 0.02);
  color: var(--color-body);
  font-size: 11px;
  line-height: 1.3;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.alert-chip--accent {
  border-color: rgba(110, 123, 255, 0.3);
  color: #b8c0ff;
}

.alert-chip--warn {
  border-color: rgba(244, 176, 0, 0.35);
  color: #f4d03f;
}

.alert-chip--info {
  border-color: rgba(5, 177, 105, 0.25);
  color: #7ddeb0;
}

@media (max-width: 900px) {
  .live-bar__top {
    grid-template-columns: 1fr;
    justify-items: stretch;
  }

  .live-bar__clock {
    justify-content: flex-start;
  }

  .live-bar__actions {
    justify-content: flex-start;
  }
}
</style>
