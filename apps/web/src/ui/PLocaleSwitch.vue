<script setup lang="ts">
import type { LocaleSetting } from '@/locale'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { localeSetting } from '@/locale'

const { t } = useI18n()

// Language names stay in their own language (endonyms) on purpose: a user
// looking at a UI in the wrong language must still recognise their own.
const options = computed<{ value: LocaleSetting, label: string }[]>(() => [
  { value: 'auto', label: t('settings.languageAuto') },
  { value: 'en', label: 'English' },
  { value: 'zh-Hans', label: '简体中文' },
])
</script>

<template>
  <div class="p-locale" role="radiogroup" :aria-label="t('settings.language')">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      class="p-locale__btn"
      :class="{ 'p-locale__btn--active': localeSetting === opt.value }"
      :aria-checked="localeSetting === opt.value"
      @click="localeSetting = opt.value"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.p-locale {
  display: inline-flex;
  padding: 2px;
  background: var(--p-surface-1);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-full);
  gap: 2px;
}
.p-locale__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--p-control-h-sm);
  padding: 0 var(--p-control-px-sm);
  font-size: 12px;
  border-radius: var(--p-radius-full);
  border: none;
  background: transparent;
  color: var(--p-fg-subtle);
  cursor: pointer;
  transition:
    background-color var(--p-transition-fast),
    color var(--p-transition-fast);
}
.p-locale__btn:hover { color: var(--p-fg); }
.p-locale__btn--active {
  background: var(--p-surface-3);
  color: var(--p-fg);
}
</style>
