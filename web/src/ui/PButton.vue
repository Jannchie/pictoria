<script setup lang="ts">
type Variant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger' | 'success' | 'warning' | 'info'
type Size = 'xs' | 'sm' | 'md' | 'lg'
type Rounded = 'sm' | 'md' | 'lg' | 'full'

withDefaults(defineProps<{
  variant?: Variant
  size?: Size
  rounded?: Rounded
  icon?: boolean
  block?: boolean
  loading?: boolean
  disabled?: boolean
  active?: boolean
  type?: 'button' | 'submit' | 'reset'
}>(), {
  variant: 'secondary',
  size: 'md',
  rounded: 'md',
  type: 'button',
})
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    class="p-btn"
    :class="[
      `p-btn--${variant}`,
      `p-btn--${size}`,
      `p-btn--r-${rounded}`,
      {
        'p-btn--icon': icon,
        'p-btn--block': block,
        'p-btn--loading': loading,
        'p-btn--active': active,
      },
    ]"
  >
    <span v-if="loading" class="p-btn__spinner" />
    <slot />
  </button>
</template>

<style scoped>
.p-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: inherit;
  font-weight: var(--p-weight-medium);
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  line-height: 1;
  background: transparent;
  color: var(--p-fg);
  transition:
    background-color var(--p-duration-fast) var(--p-ease),
    border-color var(--p-duration-fast) var(--p-ease),
    color var(--p-duration-fast) var(--p-ease),
    box-shadow var(--p-duration-fast) var(--p-ease),
    transform var(--p-duration-fast) var(--p-ease);
}
.p-btn:focus-visible {
  outline: 2px solid var(--p-primary);
  outline-offset: 2px;
}
.p-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.p-btn:active:not(:disabled) {
  transform: translateY(1px);
}
.p-btn--block { width: 100%; }
.p-btn--icon { padding-inline: 0; aspect-ratio: 1 / 1; }

.p-btn--r-sm  { border-radius: var(--p-radius-sm); }
.p-btn--r-md  { border-radius: var(--p-radius-md); }
.p-btn--r-lg  { border-radius: var(--p-radius-lg); }
.p-btn--r-full{ border-radius: var(--p-radius-full); }

.p-btn--xs { height: 22px; padding: 0 8px;  font-size: var(--p-text-xs); }
.p-btn--sm { height: 28px; padding: 0 10px; font-size: var(--p-text-xs); }
.p-btn--md { height: 36px; padding: 0 14px; font-size: var(--p-text-base); }
.p-btn--lg { height: 44px; padding: 0 18px; font-size: var(--p-text-md); }

/* Primary — solid brand */
.p-btn--primary {
  background: var(--p-primary);
  color: var(--p-on-primary);
  border-color: var(--p-primary);
}
.p-btn--primary:hover:not(:disabled),
.p-btn--primary.p-btn--active {
  background: var(--p-primary-hover);
  border-color: var(--p-primary-hover);
}

/* Secondary — surface-1 + border */
.p-btn--secondary {
  background: var(--p-surface-1);
  color: var(--p-fg);
  border-color: var(--p-border);
}
.p-btn--secondary:hover:not(:disabled),
.p-btn--secondary.p-btn--active {
  background: var(--p-surface-2);
  border-color: var(--p-border-strong);
}

/* Ghost — transparent, surface fill on hover */
.p-btn--ghost {
  background: transparent;
  color: var(--p-fg-muted);
}
.p-btn--ghost:hover:not(:disabled),
.p-btn--ghost.p-btn--active {
  background: var(--p-surface-2);
  color: var(--p-fg);
}

/* Subtle — soft primary wash */
.p-btn--subtle {
  background: var(--p-primary-soft);
  color: var(--p-primary);
}
.p-btn--subtle:hover:not(:disabled),
.p-btn--subtle.p-btn--active {
  background: rgb(var(--p-primary-rgb) / 0.28);
}

/* Status colors — light variant (soft fill, status fg) */
.p-btn--danger {
  background: var(--p-danger-soft);
  color: var(--p-danger);
}
.p-btn--danger:hover:not(:disabled) {
  background: rgb(var(--p-danger-rgb) / 0.28);
}

.p-btn--success {
  background: var(--p-success-soft);
  color: var(--p-success);
}
.p-btn--success:hover:not(:disabled) {
  background: rgb(var(--p-success-rgb) / 0.28);
}

.p-btn--warning {
  background: var(--p-warning-soft);
  color: var(--p-warning);
}
.p-btn--warning:hover:not(:disabled) {
  background: rgb(var(--p-warning-rgb) / 0.28);
}

.p-btn--info {
  background: rgb(var(--p-info-rgb) / 0.18);
  color: var(--p-info);
}
.p-btn--info:hover:not(:disabled) {
  background: rgb(var(--p-info-rgb) / 0.28);
}

.p-btn__spinner {
  display: inline-block;
  width: 1em;
  height: 1em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: p-btn-spin 700ms linear infinite;
}
@keyframes p-btn-spin { to { transform: rotate(360deg); } }
</style>
