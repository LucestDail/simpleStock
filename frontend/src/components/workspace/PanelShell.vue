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
  background: rgba(15, 23, 36, 0.9);
  box-shadow: var(--shadow-soft);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    border-color 0.22s ease,
    flex 0.22s ease,
    opacity 0.22s ease;
}

.panel-shell--highlighted {
  border-color: rgba(0, 82, 255, 0.4);
  box-shadow:
    0 16px 30px rgba(0, 82, 255, 0.14),
    var(--shadow-soft);
  transform: translateY(-1px);
}

.panel-shell--tone-dark {
  background: var(--color-surface-dark);
  border-color: rgba(255, 255, 255, 0.08);
}

.panel-shell--sm {
  flex: 0.72 1 0;
}

.panel-shell--md {
  flex: 0.95 1 0;
}

.panel-shell--lg {
  flex: 1.15 1 0;
}

.panel-shell--xl {
  flex: 1.45 1 0;
}

.panel-shell--full {
  flex: 1.8 1 0;
}

.panel-shell__head {
  padding: var(--space-base) var(--space-base) var(--space-sm);
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: flex-start;
}

.panel-shell__subtitle {
  margin: 0 0 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-muted);
}

.panel-shell__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-ink);
  letter-spacing: -0.02em;
  line-height: 1.2;
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
  padding: 0 var(--space-base) var(--space-base);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  overflow: hidden;
}

.panel-shell__body--loading {
  opacity: 0.72;
}
</style>
