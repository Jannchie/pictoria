<script setup lang="ts">
import { autoUpdate, flip, offset as offsetMw, shift, useFloating } from '@floating-ui/vue'
import { computed, nextTick, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { useLayer } from '@/shared/layers'
import { focusElement, getFocusable } from '@/utils/focus'
import { nextInOrder } from './overlay'
import PTooltip from './PTooltip.vue'

// Anchored popover.
//
// trigger="click" — a non-modal disclosure popover (Radix Popover, non-modal):
// - The trigger is the first focusable element in the default slot (callers
//   pass a PButton). It gets aria-haspopup / aria-expanded / aria-controls
//   (and an id) via the DOM, so callers need no changes. It toggles on
//   `click`, so Enter / Space / AT synthetic clicks work.
// - Content is teleported to <body> and positioned with floating-ui
//   (flip + shift keep it in the viewport).
// - Opening moves focus into the content ([data-autofocus] → first
//   focusable → the content itself). Escape closes and returns focus to the
//   trigger; an outside pointerdown closes without stealing focus back;
//   closing from inside (a selection sets v-model false) returns focus to
//   the trigger. Tab past the last focusable closes and continues the page's
//   Tab order after the trigger; Shift+Tab before the first closes and lands
//   on the trigger.
//
// trigger="hover" — kept for backwards compatibility; it is a PTooltip
// (hover AND keyboard focus, delays, role=tooltip, aria-describedby).
type Position = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'left-start' | 'left-end' | 'right-start' | 'right-end' | 'top' | 'bottom' | 'left' | 'right'

const props = withDefaults(defineProps<{
  trigger?: 'hover' | 'click'
  position?: Position
  zIndex?: number | string
  offset?: number
  overlay?: boolean
  /** What the content is, for the trigger's aria-haspopup. `dialog` also puts role=dialog on the content. */
  popupRole?: 'dialog' | 'menu' | 'listbox'
  /** Accessible name of the content (role=dialog). Defaults to the trigger's name. */
  ariaLabel?: string
}>(), {
  trigger: 'click',
  position: 'bottom',
  zIndex: 'var(--p-z-popup)',
  offset: 4,
  overlay: false,
  popupRole: 'dialog',
})

defineSlots<{
  default: (properties_: any) => any
  content: (properties_: any) => any
}>()

const active = defineModel<boolean>({
  default: false,
})

const contentId = useId()
const wrapperRef = useTemplateRef<HTMLElement>('wrapperRef')
const triggerBox = useTemplateRef<HTMLElement>('triggerBox')
const contentRef = useTemplateRef<HTMLElement>('contentRef')
const isClick = computed(() => props.trigger === 'click')
const open = computed(() => isClick.value && active.value)

// ---- trigger --------------------------------------------------------------
const triggerEl = ref<HTMLElement | null>(null)

function resolveTrigger(): HTMLElement | null {
  const box = triggerBox.value
  if (!box) {
    return null
  }
  return getFocusable(box)[0] ?? box.querySelector<HTMLElement>('button, a[href], [tabindex]')
}

function syncTriggerAria() {
  if (!isClick.value) {
    return
  }
  const el = resolveTrigger() ?? triggerEl.value
  triggerEl.value = el
  if (!el) {
    return
  }
  if (!el.id) {
    el.id = `${contentId}-trigger`
  }
  el.setAttribute('aria-haspopup', props.popupRole)
  el.setAttribute('aria-expanded', String(open.value))
  if (open.value) {
    el.setAttribute('aria-controls', contentId)
  }
  else {
    el.removeAttribute('aria-controls')
  }
}

onMounted(syncTriggerAria)
watch([open, () => props.popupRole], () => nextTick(syncTriggerAria))

function onTriggerClick(e: MouseEvent) {
  const box = triggerBox.value
  if (!box || !(e.target instanceof Node) || !box.contains(e.target) || e.target === box) {
    return
  }
  const target = e.target instanceof Element ? e.target : e.target.parentElement
  const hit = target?.closest<HTMLElement>('button, a[href], [tabindex], input, select, textarea')
  if (hit && box.contains(hit)) {
    triggerEl.value = hit
  }
  // A disabled trigger never fires click, so no extra guard is needed.
  active.value = !active.value
}

// ---- positioning ------------------------------------------------------------
const { floatingStyles, isPositioned } = useFloating(wrapperRef, contentRef, {
  open,
  placement: () => props.position,
  strategy: 'fixed',
  transform: false,
  middleware: () => [offsetMw(props.offset), flip(), shift({ padding: 4 })],
  whileElementsMounted: autoUpdate,
})

// ---- layer + focus ------------------------------------------------------------
let closedByOutside = false

function close() {
  active.value = false
}

useLayer(open, {
  el: () => contentRef.value,
  inside: () => [triggerBox.value],
  onEscape: () => close(),
  onPointerDownOutside: () => {
    closedByOutside = true
    close()
  },
})

// Initial focus once the content is placed (hidden until positioned, and a
// hidden element can't take focus).
watch(isPositioned, (placed) => {
  if (!placed || !open.value) {
    return
  }
  const el = contentRef.value
  if (!el || el.contains(document.activeElement)) {
    return
  }
  const auto = el.querySelector<HTMLElement>('[data-autofocus]')
  if (focusElement(auto, { preventScroll: true })) {
    return
  }
  const [first] = getFocusable(el)
  if (focusElement(first, { preventScroll: true })) {
    return
  }
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1')
  }
  focusElement(el, { preventScroll: true })
}, { flush: 'post' })

// Remember the content element while open — the ref is gone by close time.
let lastContent: HTMLElement | null = null
watch(contentRef, (el) => {
  if (el) {
    lastContent = el
  }
}, { flush: 'sync' })

watch(open, (on) => {
  if (on) {
    closedByOutside = false
    return
  }
  const skip = closedByOutside
  closedByOutside = false
  const container = lastContent
  lastContent = null
  if (skip) {
    return
  }
  // Microtask: let a same-tick focus move (Tab-out, a dialog opening) win.
  queueMicrotask(() => {
    const current = document.activeElement
    const inside = !current || current === document.body || !!container?.contains(current)
    if (inside) {
      focusElement(triggerEl.value, { preventScroll: true })
    }
  })
}, { flush: 'sync' })

function onContentKeydown(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) {
    return
  }
  const el = contentRef.value
  if (!el) {
    return
  }
  const items = getFocusable(el)
  const current = document.activeElement as HTMLElement | null
  const trigger = triggerEl.value
  if (e.shiftKey) {
    if (items.length === 0 || current === items[0] || current === el) {
      e.preventDefault()
      close()
      focusElement(trigger)
    }
    return
  }
  if (items.length === 0 || current === items.at(-1)) {
    e.preventDefault()
    // Where Tab would have gone from the trigger, ignoring the content itself.
    const next = trigger
      ? nextInOrder(getFocusable(document.body), trigger, c => el.contains(c) || !!triggerBox.value?.contains(c))
      : null
    close()
    if (!focusElement(next)) {
      focusElement(trigger)
    }
  }
}

const contentRole = computed(() => props.popupRole === 'dialog' ? 'dialog' : undefined)
const contentLabelledBy = computed(() =>
  contentRole.value && !props.ariaLabel && triggerEl.value?.id ? triggerEl.value.id : undefined,
)

defineExpose({ close })
</script>

<template>
  <PTooltip
    v-if="!isClick"
    as="div"
    class="relative"
    :position="position"
    :offset="offset"
    :z-index="zIndex"
  >
    <slot />
    <template #content>
      <slot name="content" />
    </template>
  </PTooltip>
  <div
    v-else
    ref="wrapperRef"
    class="relative"
  >
    <div
      ref="triggerBox"
      @click="onTriggerClick"
    >
      <slot />
    </div>
    <POverlay
      v-if="open && overlay"
      :opacity="0"
      :style="{ zIndex }"
      @pointerup="close"
    />
    <Teleport to="body">
      <Transition name="p-float">
        <div
          v-if="open"
          :id="contentId"
          ref="contentRef"
          class="p-popover-content"
          :role="contentRole"
          :aria-label="contentRole ? ariaLabel : undefined"
          :aria-labelledby="contentLabelledBy"
          :style="[floatingStyles, { zIndex }, isPositioned ? null : { visibility: 'hidden' }]"
          @keydown="onContentKeydown"
        >
          <slot name="content" />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style>
/* Teleported to <body>, so it no longer inherits the app shell's
   `select-none`; keep popover chrome non-selectable (inputs still are). */
.p-popover-content {
  user-select: none;
}
.p-popover-content:focus {
  outline: none;
}
</style>
