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
  fill: {
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
      { 'panel-shell--highlighted': props.highlighted, 'panel-shell--fill': props.fill },
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
  max-height: 100%;
  border: 1px solid var(--color-hairline);
  border-radius: var(--rounded-lg);
  background: var(--color-surface-soft);
  box-shadow: none;
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  overflow: hidden;
  transition:
    border-color 0.18s ease,
    flex 0.18s ease,
    opacity 0.18s ease;
}

.panel-shell--highlighted {
  border-color: rgba(122, 154, 184, 0.28);
}

.panel-shell--tone-dark {
  background: var(--color-surface-dark);
  border-color: rgba(255, 255, 255, 0.08);
}

.panel-shell--sm {
  flex: 0.8 1 0;
}

.panel-shell--xs {
  flex: 0.62 1 0;
}

.panel-shell--md {
  flex: 1 1 0;
}

.panel-shell--lg {
  flex: 1.28 1 0;
}

.panel-shell--xl {
  flex: 1.7 1 0;
}

.panel-shell--full {
  flex: 1 1 auto;
}

.panel-shell__head {
  padding: var(--space-sm) var(--space-base) var(--space-xs);
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  align-items: flex-start;
}

.panel-shell__subtitle {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-shell__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-ink);
  letter-spacing: -0.02em;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  padding: 0 var(--space-base) var(--space-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  overflow: auto;
}

.panel-shell--full .panel-shell__body,
.panel-shell--fill .panel-shell__body {
  overflow: hidden;
}

.panel-shell--fill .panel-shell__body {
  padding-bottom: 0;
}

.panel-shell__body--loading {
  opacity: 0.72;
}
</style>
