<script setup lang="ts" generic="T">
import { nextTick, ref, useTemplateRef, watch } from 'vue'
import { focusElement, focusFirst } from '@/utils/focus'

const props = defineProps<{
  items: T[]
  /** Stable key per item (e.g. its id). Index keys make Vue reuse a toast's DOM for its neighbour, which re-announces it. */
  itemKey?: (item: T, index: number) => PropertyKey
}>()
const emit = defineEmits<{
  /** The pointer is over a toast or focus is inside the region: hold auto-dismiss. */
  pause: []
  /** Neither any more. */
  resume: []
}>()
defineExpose({})
const positionClass = 'fixed top-25 w-full items-center z-[var(--p-z-toast)]'
const layoutClass = 'flex flex-col gap-2'

const root = useTemplateRef<HTMLElement>('root')
const hovered = ref(false)
const focusWithin = ref(false)
// Where focus came from when it entered the region (F6 / Tab / click), so a
// keyboard user who dismisses the last toast lands back there, not on <body>.
let returnTarget: HTMLElement | null = null

watch(() => hovered.value || focusWithin.value, (holding) => {
  if (holding) {
    emit('pause')
  }
  else {
    emit('resume')
  }
})

function onFocusin(e: FocusEvent) {
  const from = e.relatedTarget as HTMLElement | null
  if (!focusWithin.value && from && !root.value?.contains(from)) {
    returnTarget = from
  }
  focusWithin.value = true
}
function onFocusout(e: FocusEvent) {
  const to = e.relatedTarget as Node | null
  if (!to || !root.value?.contains(to)) {
    focusWithin.value = false
  }
}

// A removed toast takes its hovered / focused state with it without firing
// pointerleave / focusout, so recompute after every list change. If focus
// was inside and the focused toast is gone, move it to the next toast still
// shown, else back to where it came from.
watch(() => props.items.length, async () => {
  await nextTick()
  const el = root.value
  if (!el) {
    return
  }
  hovered.value = el.matches(':hover') && props.items.length > 0
  if (!focusWithin.value) {
    return
  }
  const active = document.activeElement
  if (active && active !== document.body && el.contains(active)) {
    return
  }
  if (focusFirst(el)) {
    return
  }
  focusWithin.value = false
  if (returnTarget?.isConnected) {
    focusElement(returnTarget)
  }
  returnTarget = null
}, { flush: 'post' })
</script>

<template>
  <!-- Not a live region itself: each PToast is one (status / alert by tone).
       data-layer-keep-active: a modal layer must not make toasts inert —
       an error raised behind a dialog still has to be announced and
       dismissable; it only works on a direct child of <body>, hence the
       Teleport (the container is position:fixed, so nothing moves).
       pointer-events only on the toasts: the full-width strip must not
       swallow clicks on the page below it. -->
  <Teleport to="body">
    <div
      ref="root"
      :role="items.length > 0 ? 'region' : undefined"
      :aria-label="items.length > 0 ? $t('controls.notifications') : undefined"
      data-layer-keep-active
      class="pointer-events-none"
      :class="[positionClass, layoutClass]"
      style="padding-top: env(safe-area-inset-top, 0);"
      @focusin="onFocusin"
      @focusout="onFocusout"
    >
      <div
        v-for="item, i in items"
        :key="itemKey ? itemKey(item, i) : i"
        class="pointer-events-auto"
        @pointerenter="hovered = true"
        @pointerleave="hovered = false"
      >
        <slot :item="item" />
      </div>
    </div>
  </Teleport>
</template>
