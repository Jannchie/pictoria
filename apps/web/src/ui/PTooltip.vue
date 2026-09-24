<script setup lang="ts">
import type { Placement } from '@floating-ui/vue'
import { autoUpdate, flip, offset as offsetMw, shift, useFloating } from '@floating-ui/vue'
import { computed, onBeforeUnmount, onMounted, ref, useId, useSlots, useTemplateRef, watch } from 'vue'
import { useLayer } from '@/shared/layers'
import { getFocusable } from '@/utils/focus'

// Tooltip (APG "tooltip" + WCAG 1.4.13 content on hover or focus).
//
// - Shows on pointer hover (after `openDelay`) AND on keyboard focus of the
//   trigger (`:focus-visible`, immediately). Hides on pointer leave (after
//   `closeDelay`), blur, pointerdown on the trigger, and Escape.
// - Hoverable: moving the pointer from the trigger onto the tooltip keeps it.
// - Dismissable: Escape hides it via the layer stack (no focus moves).
// - Never takes focus. The trigger (first focusable in the default slot, else
//   the anchor itself) gets `aria-describedby` pointing at an always-present
//   hidden copy of the content, so the description exists before the visible
//   bubble has rendered.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  /** Plain-text tooltip. Use the `content` slot for rich content. */
  content?: string
  position?: Placement
  offset?: number
  zIndex?: number | string
  openDelay?: number
  closeDelay?: number
  disabled?: boolean
  /** Anchor element tag. */
  as?: string
}>(), {
  position: 'top',
  offset: 4,
  zIndex: 'var(--p-z-popup)',
  openDelay: 400,
  closeDelay: 100,
  disabled: false,
  as: 'span',
})

defineSlots<{
  default: (props: Record<string, never>) => any
  content?: (props: Record<string, never>) => any
}>()

const slots = useSlots()
const tooltipId = useId()
const descId = useId()
const anchor = useTemplateRef<HTMLElement>('anchor')
const bubble = useTemplateRef<HTMLElement>('bubble')
const open = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function clearTimer() {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
}
function show(delay: number) {
  clearTimer()
  if (props.disabled) {
    return
  }
  if (delay <= 0) {
    open.value = true
    return
  }
  timer = setTimeout(() => {
    open.value = true
  }, delay)
}
function hide(delay = 0) {
  clearTimer()
  if (delay <= 0) {
    open.value = false
    return
  }
  timer = setTimeout(() => {
    open.value = false
  }, delay)
}

watch(() => props.disabled, (d) => {
  if (d) {
    hide()
  }
})

function onPointerEnter(e: PointerEvent) {
  if (e.pointerType === 'touch') {
    return
  }
  show(open.value ? 0 : props.openDelay)
}
function onPointerLeave() {
  hide(props.closeDelay)
}
function onFocusIn(e: FocusEvent) {
  const target = e.target as HTMLElement | null
  // Keyboard focus only — a click focusing the button must not pop a tooltip.
  let keyboardFocus = false
  try {
    keyboardFocus = !!target?.matches(':focus-visible')
  }
  catch {
    // Engines without :focus-visible support — treat focus as keyboard focus.
    keyboardFocus = true
  }
  if (keyboardFocus) {
    show(0)
  }
}
function onFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (next && anchor.value?.contains(next)) {
    return
  }
  hide()
}

// ---- trigger wiring -------------------------------------------------------
const triggerEl = ref<HTMLElement | null>(null)
function resolveTrigger(): HTMLElement | null {
  const root = anchor.value
  if (!root) {
    return null
  }
  return getFocusable(root)[0] ?? root.querySelector<HTMLElement>('button, a[href], [tabindex]') ?? root
}
function wireTrigger() {
  const el = resolveTrigger()
  if (triggerEl.value && triggerEl.value !== el) {
    removeDescribedBy(triggerEl.value)
  }
  triggerEl.value = el
  if (el) {
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    if (!ids.includes(descId)) {
      el.setAttribute('aria-describedby', [...ids, descId].join(' '))
    }
  }
}
function removeDescribedBy(el: HTMLElement) {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== descId)
  if (ids.length > 0) {
    el.setAttribute('aria-describedby', ids.join(' '))
  }
  else {
    el.removeAttribute('aria-describedby')
  }
}
onMounted(wireTrigger)
watch(open, (v) => {
  if (v) {
    wireTrigger()
  }
})
onBeforeUnmount(() => {
  clearTimer()
  if (triggerEl.value) {
    removeDescribedBy(triggerEl.value)
  }
})

// ---- positioning + layer --------------------------------------------------
const { floatingStyles, isPositioned } = useFloating(anchor, bubble, {
  open,
  placement: () => props.position,
  strategy: 'fixed',
  transform: false,
  middleware: () => [offsetMw(props.offset), flip(), shift({ padding: 4 })],
  whileElementsMounted: autoUpdate,
})

useLayer(open, {
  el: () => bubble.value,
  onEscape: () => hide(),
})

const hasRichContent = computed(() => !!slots.content)
</script>

<template>
  <component
    :is="as"
    ref="anchor"
    class="p-tooltip-anchor"
    v-bind="$attrs"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
    @pointerdown="hide()"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <slot />
    <span :id="descId" hidden>
      <slot name="content">{{ content }}</slot>
    </span>
  </component>
  <Teleport to="body">
    <Transition name="p-float">
      <div
        v-if="open"
        :id="tooltipId"
        ref="bubble"
        role="tooltip"
        class="p-tooltip"
        :class="{ 'p-tooltip--text': !hasRichContent }"
        :style="[floatingStyles, { zIndex }, isPositioned ? null : { visibility: 'hidden' }]"
        @pointerenter="show(0)"
        @pointerleave="onPointerLeave"
      >
        <slot name="content">
          {{ content }}
        </slot>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.p-tooltip-anchor {
  display: inline-flex;
}
.p-tooltip--text {
  max-width: 280px;
  padding: 4px 8px;
  background: var(--p-surface);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-sm);
  box-shadow: var(--p-shadow-sm);
  color: var(--p-fg);
  font-size: var(--p-text-xs);
  line-height: var(--p-leading-normal);
}
</style>
