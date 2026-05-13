<script setup lang="ts">
import { useColorMode } from '@vueuse/core'
import { computed } from 'vue'

const mode = useColorMode({
  attribute: 'data-scheme',
  modes: { light: 'light', dark: 'dark' },
  storageKey: 'pictoria-color-scheme',
  initialValue: 'dark',
})

const options = [
  { value: 'dark', icon: 'i-tabler-moon', label: 'Dark' },
  { value: 'light', icon: 'i-tabler-sun', label: 'Light' },
  { value: 'auto', icon: 'i-tabler-device-desktop', label: 'System' },
] as const

const current = computed(() => mode.value)

function pick(value: typeof options[number]['value']) {
  document.documentElement.classList.add('is-theme-switching')
  mode.value = value
  // Drop the suppressor after the next paint to re-enable transitions.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('is-theme-switching')
    })
  })
}
</script>

<template>
  <div class="p-scheme">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      class="p-scheme__btn"
      :class="{ 'p-scheme__btn--active': current === opt.value }"
      :aria-label="opt.label"
      :title="opt.label"
      @click="pick(opt.value)"
    >
      <i :class="opt.icon" />
    </button>
  </div>
</template>

<style scoped>
.p-scheme {
  display: inline-flex;
  padding: 2px;
  background: var(--p-surface-1);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-full);
  gap: 2px;
}
.p-scheme__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--p-radius-full);
  border: none;
  background: transparent;
  color: var(--p-fg-subtle);
  cursor: pointer;
  transition:
    background-color var(--p-duration-fast) var(--p-ease),
    color var(--p-duration-fast) var(--p-ease);
}
.p-scheme__btn:hover { color: var(--p-fg); }
.p-scheme__btn--active {
  background: var(--p-surface-3);
  color: var(--p-fg);
}
</style>
