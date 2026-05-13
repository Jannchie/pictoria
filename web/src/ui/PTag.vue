<script setup lang="ts">
type Variant = 'soft' | 'outline' | 'solid'
type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

withDefaults(defineProps<{
  variant?: Variant
  tone?: Tone
  size?: 'xs' | 'sm' | 'md'
}>(), {
  variant: 'soft',
  tone: 'neutral',
  size: 'sm',
})
</script>

<template>
  <span
    class="p-tag"
    :class="[`p-tag--${variant}`, `p-tag--${tone}`, `p-tag--${size}`]"
  >
    <slot />
  </span>
</template>

<style scoped>
.p-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: var(--p-radius-full);
  font-weight: var(--p-weight-medium);
  line-height: 1;
  white-space: nowrap;
}

.p-tag--xs { padding: 2px 6px; font-size: 10px; }
.p-tag--sm { padding: 3px 8px; font-size: var(--p-text-xs); }
.p-tag--md { padding: 4px 10px; font-size: var(--p-text-sm); }

/* Neutral */
.p-tag--neutral.p-tag--soft     { background: var(--p-surface-2); color: var(--p-fg-muted); }
.p-tag--neutral.p-tag--outline  { background: transparent; color: var(--p-fg-muted); border-color: var(--p-border); }
.p-tag--neutral.p-tag--solid    { background: var(--p-surface-3); color: var(--p-fg); }

/* Primary */
.p-tag--primary.p-tag--soft     { background: var(--p-primary-soft); color: var(--p-primary); }
.p-tag--primary.p-tag--outline  { background: transparent; color: var(--p-primary); border-color: rgb(var(--p-primary-rgb) / 0.45); }
.p-tag--primary.p-tag--solid    { background: var(--p-primary); color: var(--p-on-primary); }

/* Success */
.p-tag--success.p-tag--soft     { background: var(--p-success-soft); color: var(--p-success); }
.p-tag--success.p-tag--outline  { background: transparent; color: var(--p-success); border-color: rgb(var(--p-success-rgb) / 0.45); }
.p-tag--success.p-tag--solid    { background: var(--p-success); color: #fff; }

/* Warning */
.p-tag--warning.p-tag--soft     { background: var(--p-warning-soft); color: var(--p-warning); }
.p-tag--warning.p-tag--outline  { background: transparent; color: var(--p-warning); border-color: rgb(var(--p-warning-rgb) / 0.45); }
.p-tag--warning.p-tag--solid    { background: var(--p-warning); color: #1a1d24; }

/* Danger */
.p-tag--danger.p-tag--soft      { background: var(--p-danger-soft); color: var(--p-danger); }
.p-tag--danger.p-tag--outline   { background: transparent; color: var(--p-danger); border-color: rgb(var(--p-danger-rgb) / 0.45); }
.p-tag--danger.p-tag--solid     { background: var(--p-danger); color: #fff; }

/* Info */
.p-tag--info.p-tag--soft        { background: rgb(var(--p-info-rgb) / 0.18); color: var(--p-info); }
.p-tag--info.p-tag--outline     { background: transparent; color: var(--p-info); border-color: rgb(var(--p-info-rgb) / 0.45); }
.p-tag--info.p-tag--solid       { background: var(--p-info); color: #fff; }
</style>
