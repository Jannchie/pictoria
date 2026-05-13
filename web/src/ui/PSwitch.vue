<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg'
  onIcon?: string
  offIcon?: string
  disabled?: boolean
}>(), {
  size: 'md',
})

const model = defineModel<boolean>({ default: false })

const sizeClass = computed(() => `p-switch--${props.size}`)
function toggle() {
  if (props.disabled) {
    return
  }
  model.value = !model.value
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    :disabled="disabled"
    class="p-switch"
    :class="[sizeClass, { 'p-switch--on': model }]"
    @click="toggle"
  >
    <span class="p-switch__thumb">
      <i v-if="model && onIcon" :class="onIcon" />
      <i v-else-if="!model && offIcon" :class="offIcon" />
    </span>
  </button>
</template>

<style scoped>
.p-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: 1px solid var(--p-border);
  background: var(--p-surface-1);
  border-radius: var(--p-radius-full);
  cursor: pointer;
  transition:
    background-color var(--p-duration-fast) var(--p-ease),
    border-color var(--p-duration-fast) var(--p-ease);
}
.p-switch:focus-visible {
  outline: 2px solid var(--p-primary);
  outline-offset: 2px;
}
.p-switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.p-switch--sm { width: 32px; height: 18px; }
.p-switch--md { width: 40px; height: 22px; }
.p-switch--lg { width: 52px; height: 28px; }

.p-switch--on {
  background: var(--p-primary);
  border-color: var(--p-primary);
}

.p-switch__thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1 / 1;
  background: var(--p-fg);
  color: var(--p-on-primary);
  border-radius: var(--p-radius-full);
  font-size: 0.75em;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.18);
  transform: translateX(0);
  transition: transform var(--p-duration-base) var(--p-ease);
}
.p-switch--sm .p-switch__thumb { width: 14px; }
.p-switch--md .p-switch__thumb { width: 18px; }
.p-switch--lg .p-switch__thumb { width: 24px; }

.p-switch--on .p-switch__thumb {
  background: var(--p-on-primary);
  color: var(--p-primary);
  transform: translateX(calc(100% + 0px));
}
.p-switch--sm.p-switch--on .p-switch__thumb { transform: translateX(14px); }
.p-switch--md.p-switch--on .p-switch__thumb { transform: translateX(18px); }
.p-switch--lg.p-switch--on .p-switch__thumb { transform: translateX(24px); }
</style>
