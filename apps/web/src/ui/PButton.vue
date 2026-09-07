<script setup lang="ts">
import { computed } from 'vue'

type Variant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger' | 'success' | 'warning' | 'info'
type Size = 'xs' | 'sm' | 'md' | 'lg'
type Rounded = 'sm' | 'md' | 'lg' | 'full'

const props = withDefaults(defineProps<{
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
  size: 'md',
  rounded: 'md',
  type: 'button',
})

// An icon-only button carries no label to anchor a filled box, so it defaults
// to the lightest variant in the set: transparent until hovered. Passing
// `variant` explicitly still wins (the sort segmented control needs `subtle`).
const variant = computed<Variant>(() => props.variant ?? (props.icon ? 'ghost' : 'secondary'))
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
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
    <span v-if="loading" class="p-btn__spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.p-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--p-control-gap);
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
    background-color var(--p-transition-fast),
    border-color var(--p-transition-fast),
    color var(--p-transition-fast),
    box-shadow var(--p-transition-fast),
    transform var(--p-transition-fast);
}
.p-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.p-btn:active:not(:disabled) {
  transform: translateY(1px);
}
@media (prefers-reduced-motion: reduce) {
  .p-btn { transition: none; }
  .p-btn:active:not(:disabled) { transform: none; }
}
.p-btn--block { width: 100%; }

.p-btn--r-sm  { border-radius: var(--p-radius-sm); }
.p-btn--r-md  { border-radius: var(--p-radius-md); }
.p-btn--r-lg  { border-radius: var(--p-radius-lg); }
.p-btn--r-full{ border-radius: var(--p-radius-full); }

.p-btn--xs { --p-btn-h: var(--p-control-h-xs); --p-btn-icon-size: 14px; height: var(--p-btn-h); padding: 0 var(--p-control-px-xs); font-size: var(--p-text-xs); }
.p-btn--sm { --p-btn-h: var(--p-control-h-sm); --p-btn-icon-size: 16px; height: var(--p-btn-h); padding: 0 var(--p-control-px-sm); font-size: var(--p-text-xs); }
.p-btn--md { --p-btn-h: var(--p-control-h-md); --p-btn-icon-size: 20px; height: var(--p-btn-h); padding: 0 var(--p-control-px-md); font-size: var(--p-text-base); }
.p-btn--lg { --p-btn-h: var(--p-control-h-lg); --p-btn-icon-size: 24px; height: var(--p-btn-h); padding: 0 var(--p-control-px-lg); font-size: var(--p-text-md); }

/* Icon-only: exactly square. Declared *after* the size classes on purpose —
   they set `padding` and `font-size` at the same specificity, so an earlier
   rule (which is what `padding-inline: 0` + `aspect-ratio` used to be) loses
   the cascade and leaves the button a horizontal pill. */
.p-btn--icon {
  inline-size: var(--p-btn-h);
  padding: 0;
  flex: none;
  /* Iconify glyphs are 1em, so the icon is sized here once instead of at
     every call site. */
  font-size: var(--p-btn-icon-size);
}
.p-btn--icon.p-btn--block { inline-size: 100%; }

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
  /* The faintest border in the set: enough of an edge to read as a control,
     not enough to turn a row of facets into a row of boxes. */
  border-color: var(--p-border-subtle);
}
.p-btn--secondary:hover:not(:disabled),
.p-btn--secondary.p-btn--active {
  background: var(--p-surface-2);
  border-color: var(--p-border);
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
  /* Same edge as secondary so a filtered facet sits at the same visual
     weight as an unfiltered one — only the fill changes. */
  border-color: rgb(var(--p-primary-rgb) / 0.22);
}
.p-btn--subtle:hover:not(:disabled),
.p-btn--subtle.p-btn--active {
  background: rgb(var(--p-primary-rgb) / 0.28);
  border-color: rgb(var(--p-primary-rgb) / 0.32);
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
@media (prefers-reduced-motion: reduce) {
  .p-btn__spinner { animation-duration: 2s; }
}
</style>
