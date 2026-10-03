<script setup>
/**
 * 🤖 자율형 트레이딩 앱 셸 (2026-10-03 — 와이어프레임 전면 준용)
 *
 * 와이어프레임(`자율형 주식 트레이딩 앱 와이어프레임.html` · 10장)의 공통 뼈대:
 *   좌측 사이드 메뉴(페이지 내비 + 연결 계좌) · 상단 상태 바(운용 상태 · 일일 손실/한도 ·
 *   일시정지 · 비상정지) · 본문 = 페이지.
 *
 * ⚠️ 종전 단일 화면(WorkspaceView)은 **대시보드 페이지**로 들어간다 — 3,343줄을 한 번에
 *    쪼개면 회귀 폭탄이라, 셸·신규 페이지를 먼저 세우고 대시보드는 다음 수술에서 나눈다.
 */
import AppShell from './components/AppShell.vue';
import { useUi } from './composables/useUi';

const { dialog, toast, confirmDialog, cancelDialog, dismissToast } = useUi();
</script>

<template>
  <div class="app-root">
    <AppShell>
      <router-view />
    </AppShell>

    <transition name="fade">
      <div v-if="dialog.open" class="dialog-backdrop" @click="cancelDialog">
        <section
          class="dialog-card"
          role="dialog"
          aria-modal="true"
          @click.stop
        >
          <h2 class="dialog-title">{{ dialog.title }}</h2>
          <p class="dialog-message">{{ dialog.message }}</p>
          <div class="dialog-actions">
            <button type="button" class="dialog-button secondary" @click="cancelDialog">
              {{ dialog.cancelLabel }}
            </button>
            <button
              type="button"
              class="dialog-button"
              :class="dialog.tone === 'danger' ? 'danger' : 'primary'"
              @click="confirmDialog"
            >
              {{ dialog.confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    </transition>

    <transition name="fade">
      <div
        v-if="toast.open"
        class="toast"
        :class="`toast-${toast.tone}`"
        role="status"
        aria-live="polite"
      >
        <span>{{ toast.message }}</span>
        <button type="button" class="toast-close" @click="dismissToast">닫기</button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.app-root {
  height: 100%;
  overflow: hidden;
}

.main {
  height: 100%;
  overflow: hidden;
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-base);
  background: rgba(10, 11, 13, 0.56);
}

.dialog-card {
  width: min(100%, 440px);
  background: var(--color-canvas);
  border-radius: var(--rounded-xl);
  padding: var(--space-xl);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.18);
}

.dialog-title {
  margin: 0 0 var(--space-sm);
  font-size: 25px;
  font-weight: 400;
  letter-spacing: -0.02em;
  color: var(--color-ink);
}

.dialog-message {
  margin: 0;
  color: var(--color-body);
  line-height: 1.6;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: var(--space-xl);
}

.dialog-button {
  height: 44px;
  padding: 0 var(--space-md);
  border: none;
  border-radius: var(--rounded-pill);
  font-size: 17px;
  font-weight: 600;
  cursor: pointer;
}

.dialog-button.primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.dialog-button.danger {
  background: var(--color-surface-dark);
  color: var(--color-on-dark);
}

.dialog-button.secondary {
  background: var(--color-surface-strong);
  color: var(--color-ink);
}

.toast {
  position: fixed;
  right: var(--space-lg);
  bottom: var(--space-lg);
  z-index: 120;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  max-width: min(92vw, 420px);
  padding: var(--space-sm) var(--space-base);
  border-radius: var(--rounded-lg);
  box-shadow: var(--shadow-soft);
  background: var(--color-surface-dark);
  color: var(--color-on-dark);
}

.toast-success {
  background: var(--color-surface-dark);
}

.toast-error {
  /* 하드코딩 색 제거 (2026-09-21) — 토큰으로 */
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.toast-info {
  background: var(--color-surface-dark);
}

.toast-close {
  border: none;
  background: transparent;
  color: var(--color-on-dark-soft);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 767px) {
  .toast {
    left: var(--space-base);
    right: var(--space-base);
    bottom: var(--space-base);
    max-width: none;
  }
}
</style>
