<script setup>
import { ref, onMounted } from 'vue';
import { RouterLink, RouterView } from 'vue-router';

const menuOpen = ref(false);

const links = [
  { to: '/', label: '대시보드' },
  { to: '/holdings', label: '자산 입력' },
  { to: '/history', label: '일별 기록' },
  { to: '/settings', label: '설정' },
];

onMounted(() => {
  window.addEventListener('resize', () => {
    if (window.innerWidth >= 768) menuOpen.value = false;
  });
});
</script>

<template>
  <div class="app-root">
    <header class="top-nav">
      <div class="nav-inner">
        <RouterLink to="/" class="wordmark" @click="menuOpen = false">SimpleStock</RouterLink>

        <button
          type="button"
          class="nav-toggle"
          aria-label="메뉴"
          @click="menuOpen = !menuOpen"
        >
          <span />
          <span />
          <span />
        </button>

        <nav class="nav-links" :class="{ open: menuOpen }">
          <RouterLink
            v-for="l in links"
            :key="l.to"
            :to="l.to"
            class="nav-link"
            active-class="nav-link-active"
            @click="menuOpen = false"
          >
            {{ l.label }}
          </RouterLink>
        </nav>
      </div>
    </header>

    <main class="main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.top-nav {
  position: sticky;
  top: 0;
  z-index: 40;
  height: var(--nav-height);
  background: var(--color-canvas);
  border-bottom: 1px solid var(--color-hairline);
}

.nav-inner {
  max-width: var(--content-max);
  margin: 0 auto;
  padding: 0 var(--space-base);
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-lg);
}

.wordmark {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-primary);
  text-decoration: none;
  letter-spacing: -0.02em;
}

.wordmark:hover {
  color: var(--color-primary-active);
}

.nav-toggle {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.nav-toggle span {
  display: block;
  height: 2px;
  width: 20px;
  background: var(--color-ink);
  border-radius: 1px;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.nav-link {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--color-body);
  text-decoration: none;
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--rounded-pill);
}

.nav-link:hover {
  color: var(--color-ink);
  background: var(--color-surface-soft);
}

.nav-link-active {
  color: var(--color-primary);
}

.main {
  flex: 1;
}

@media (max-width: 767px) {
  .nav-toggle {
    display: flex;
  }

  .nav-links {
    position: fixed;
    top: var(--nav-height);
    left: 0;
    right: 0;
    flex-direction: column;
    align-items: stretch;
    padding: var(--space-base);
    background: var(--color-canvas);
    border-bottom: 1px solid var(--color-hairline);
    gap: 0;
    display: none;
  }

  .nav-links.open {
    display: flex;
  }

  .nav-link {
    padding: var(--space-base);
    border-radius: var(--rounded-md);
  }
}
</style>
