<script setup>
const props = defineProps({
  title: {
    type: String,
    required: true,
  },
  subtitle: {
    type: String,
    default: '',
  },
  span: {
    type: String,
    default: 'md',
  },
  highlighted: {
    type: Boolean,
    default: false,
  },
  tone: {
    type: String,
    default: 'default',
  },
  loading: {
    type: Boolean,
    default: false,
  },
});
</script>

<template>
  <section
    class="panel-shell"
    :class="[
      `panel-shell--${props.span}`,
      `panel-shell--tone-${props.tone}`,
      { 'panel-shell--highlighted': props.highlighted },
    ]"
  >
    <header class="panel-shell__head">
      <div>
        <p v-if="subtitle" class="panel-shell__subtitle">{{ subtitle }}</p>
        <h2 class="panel-shell__title">{{ title }}</h2>
      </div>
      <div class="panel-shell__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="panel-shell__body" :class="{ 'panel-shell__body--loading': loading }">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel-shell {
  min-height: 0;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-xl);
  background: var(--color-canvas);
  box-shadow: var(--shadow-soft);
  display: flex;
  flex-direction: column;
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    border-color 0.22s ease,
    min-height 0.22s ease,
    opacity 0.22s ease;
}

.panel-shell--highlighted {
  border-color: rgba(0, 82, 255, 0.4);
  box-shadow:
    0 18px 34px rgba(0, 82, 255, 0.08),
    var(--shadow-soft);
  transform: translateY(-2px);
}

.panel-shell--tone-dark {
  background: var(--color-surface-dark);
  border-color: rgba(255, 255, 255, 0.08);
}

.panel-shell--sm {
  min-height: 180px;
}

.panel-shell--md {
  min-height: 260px;
}

.panel-shell--lg {
  min-height: 340px;
}

.panel-shell--xl {
  min-height: 460px;
}

.panel-shell--full {
  min-height: 560px;
}

.panel-shell__head {
  padding: var(--space-lg) var(--space-lg) var(--space-base);
  display: flex;
  justify-content: space-between;
  gap: var(--space-base);
  align-items: flex-start;
}

.panel-shell__subtitle {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-muted);
}

.panel-shell__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--color-ink);
  letter-spacing: -0.02em;
}

.panel-shell--tone-dark .panel-shell__subtitle {
  color: var(--color-on-dark-soft);
}

.panel-shell--tone-dark .panel-shell__title {
  color: var(--color-on-dark);
}

.panel-shell__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-xs);
}

.panel-shell__body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--space-lg) var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-base);
}

.panel-shell__body--loading {
  opacity: 0.72;
}
</style>
