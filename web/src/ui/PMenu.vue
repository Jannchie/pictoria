<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

export interface PMenuItem {
  role?: 'label' | 'divider' | 'item'
  title?: string
  icon?: string
  value?: string | number | symbol
  disabled?: boolean
}

withDefaults(defineProps<{
  data: PMenuItem[]
  trigger?: 'contextmenu' | 'click'
}>(), {
  trigger: 'contextmenu',
})

const emit = defineEmits<{
  (e: 'select', value: string | number | symbol): void
}>()

const open = ref(false)
const x = ref(0)
const y = ref(0)
const menuRef = ref<HTMLElement>()

function openAt(clientX: number, clientY: number) {
  x.value = clientX
  y.value = clientY
  open.value = true
}

function onTrigger(e: MouseEvent) {
  e.preventDefault()
  openAt(e.clientX, e.clientY)
}

function close() {
  open.value = false
}

function pick(item: PMenuItem) {
  if (item.disabled || item.role === 'label' || item.role === 'divider') {
    return
  }
  if (item.value !== undefined) {
    emit('select', item.value)
  }
  close()
}

function onDocPointer(e: PointerEvent) {
  if (!menuRef.value) {
    return
  }
  if (e.target instanceof Node && menuRef.value.contains(e.target)) {
    return
  }
  close()
}

watch(open, (v) => {
  if (v) {
    document.addEventListener('pointerdown', onDocPointer, true)
    document.addEventListener('keydown', onKey)
  }
  else {
    document.removeEventListener('pointerdown', onDocPointer, true)
    document.removeEventListener('keydown', onKey)
  }
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    close()
  }
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div
    class="p-menu-host"
    @contextmenu="trigger === 'contextmenu' ? onTrigger($event) : undefined"
    @click="trigger === 'click' ? onTrigger($event) : undefined"
  >
    <slot />
    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="p-menu"
        :style="{ left: `${x}px`, top: `${y}px` }"
        role="menu"
      >
        <template v-for="(item, i) in data" :key="i">
          <div
            v-if="item.role === 'divider'"
            class="p-menu__divider"
            role="separator"
          />
          <div
            v-else-if="item.role === 'label'"
            class="p-menu__label"
          >
            {{ item.title }}
          </div>
          <button
            v-else
            type="button"
            class="p-menu__item"
            :class="{ 'p-menu__item--disabled': item.disabled }"
            :disabled="item.disabled"
            role="menuitem"
            @click="pick(item)"
          >
            <i v-if="item.icon" :class="item.icon" class="p-menu__icon" />
            <span>{{ item.title }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.p-menu-host { display: block; }
</style>

<style>
.p-menu {
  position: fixed;
  z-index: var(--p-z-popover);
  min-width: 180px;
  padding: 4px;
  background: var(--p-surface);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  box-shadow: var(--p-shadow-lg);
  font-size: var(--p-text-sm);
  color: var(--p-fg);
}
.p-menu__item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: var(--p-radius-sm);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.p-menu__item:hover:not(.p-menu__item--disabled) {
  background: var(--p-surface-2);
}
.p-menu__item--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.p-menu__icon {
  flex-shrink: 0;
  font-size: 1.05em;
  color: var(--p-fg-muted);
}
.p-menu__divider {
  height: 1px;
  background: var(--p-border-subtle);
  margin: 4px 2px;
}
.p-menu__label {
  padding: 6px 10px 4px;
  color: var(--p-fg-subtle);
  font-size: var(--p-text-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: var(--p-weight-semibold);
}
</style>
