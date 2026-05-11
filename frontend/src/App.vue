<script setup>
import WorkspaceView from './views/WorkspaceView.vue';
import { useUi } from './composables/useUi';

const { dialog, toast, confirmDialog, cancelDialog, dismissToast } = useUi();
</script>

<template>
  <div class="app-root">
    <main class="main">
      <WorkspaceView />
    </main>

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
  font-size: 24px;
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
  font-size: 16px;
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
  background: #3a1418;
}

.toast-info {
  background: var(--color-surface-dark);
}

.toast-close {
  border: none;
  background: transparent;
  color: var(--color-on-dark-soft);
  font-size: 14px;
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
