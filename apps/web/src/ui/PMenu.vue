<script setup lang="ts">
import type { VirtualElement } from '@floating-ui/vue'
import { autoUpdate, flip, offset as offsetMw, shift, useFloating } from '@floating-ui/vue'
import { computed, nextTick, onMounted, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useFocusReturn } from '@/composables/useFocusTrap'
import { useRovingFocus } from '@/composables/useRovingFocus'
import { useLayer } from '@/shared/layers'
import { focusElement, getFocusable } from '@/utils/focus'
import { matchesShortcut } from '@/utils/keyboard'
import { lastInputWasKeyboard, trackInputModality } from './inputModality'
import { clipRectToViewport, groupMenuItems, isKeyboardContextMenu } from './overlay'

// Context / click menu (APG "menu").
//
// Opening
// - trigger="contextmenu": right click opens at the cursor; Shift+F10 or the
//   ContextMenu key opens anchored to the focused element inside the host.
// - trigger="click": the host's first focusable element is the menu button
//   (aria-haspopup=menu, aria-expanded, aria-controls). A keyboard click
//   (Enter / Space) anchors to it, a pointer click to the cursor.
// - floating-ui flip + shift keep the menu inside the viewport.
//
// Inside (focus is on the items — roving tabindex)
// - ↑ / ↓ wrap, Home / End, typeahead; Enter / Space activate (native button);
//   disabled items are focusable but inert (aria-disabled).
// - Escape closes and returns focus to where it was; Tab closes (no trap)
//   and returns focus likewise; an outside pointerdown closes.
// - Label rows start a role=group (aria-labelledby = the label) that holds
//   the items up to the next divider / label.
export interface PMenuItem {
  role?: 'label' | 'divider' | 'item'
  title?: string
  icon?: string
  value?: string | number | symbol
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  data: PMenuItem[]
  trigger?: 'contextmenu' | 'click'
  /** Accessible name of the menu. */
  ariaLabel?: string
}>(), {
  trigger: 'contextmenu',
})

const emit = defineEmits<{
  (e: 'select', value: string | number | symbol): void
}>()

trackInputModality()

const menuId = useId()
const host = useTemplateRef<HTMLElement>('host')
const menuRef = useTemplateRef<HTMLElement>('menuRef')
const open = shallowRef(false)
/** Where focus was when the menu opened — it goes back there on close. */
let invoker: HTMLElement | null = null

const sections = computed(() => groupMenuItems(props.data))
const labelId = (index: number) => `${menuId}-label-${index}`

// ---- anchor ---------------------------------------------------------------
const reference = shallowRef<VirtualElement | null>(null)

function pointAnchor(x: number, y: number): VirtualElement {
  return {
    getBoundingClientRect: () => ({ x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 }),
  }
}

function elementAnchor(el: HTMLElement): VirtualElement {
  return {
    contextElement: el,
    getBoundingClientRect: () => {
      const r = el.getBoundingClientRect()
      const c = clipRectToViewport(r, { width: window.innerWidth, height: window.innerHeight })
      return { ...c, left: c.x, top: c.y, right: c.x + c.width, bottom: c.y + c.height }
    },
  }
}

const { floatingStyles, isPositioned } = useFloating(reference, menuRef, {
  open,
  placement: 'bottom-start',
  strategy: 'fixed',
  transform: false,
  middleware: [offsetMw(2), flip({ padding: 4 }), shift({ padding: 4, crossAxis: true })],
  whileElementsMounted: autoUpdate,
})

// ---- open / close -------------------------------------------------------------
function currentFocusInHost(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null
  return active && active !== document.body && host.value?.contains(active) ? active : null
}

function openWith(anchor: VirtualElement) {
  const active = document.activeElement as HTMLElement | null
  invoker = active && active !== document.body ? active : null
  reference.value = anchor
  open.value = true
}

function openFromKeyboard() {
  const target = currentFocusInHost() ?? menuButton() ?? host.value
  if (target) {
    openWith(elementAnchor(target))
  }
}

function onContextMenu(e: MouseEvent) {
  if (props.trigger !== 'contextmenu') {
    return
  }
  e.preventDefault()
  if (isKeyboardContextMenu(e, lastInputWasKeyboard())) {
    openFromKeyboard()
  }
  else {
    openWith(pointAnchor(e.clientX, e.clientY))
  }
}

function onHostKeydown(e: KeyboardEvent) {
  // Some engines never fire `contextmenu` for Shift+F10; open it ourselves.
  // (If they do, the follow-up contextmenu re-anchors to the same element.)
  if (props.trigger !== 'contextmenu' || e.defaultPrevented || e.isComposing) {
    return
  }
  if (matchesShortcut(e, 'Shift+F10')) {
    e.preventDefault()
    openFromKeyboard()
  }
}

function onHostClick(e: MouseEvent) {
  if (props.trigger !== 'click') {
    return
  }
  if (open.value) {
    close()
    return
  }
  // detail === 0 → keyboard / AT activation.
  if (e.detail === 0) {
    openFromKeyboard()
  }
  else {
    openWith(pointAnchor(e.clientX, e.clientY))
  }
}

function close() {
  open.value = false
}

function pick(item: PMenuItem) {
  if (item.disabled || item.role === 'label' || item.role === 'divider') {
    return
  }
  close()
  // Put focus back BEFORE the caller reacts, so a dialog opened from the
  // selection remembers the invoker (not a menu item about to vanish).
  focusElement(invoker, { preventScroll: true })
  if (item.value !== undefined) {
    emit('select', item.value)
  }
}

useLayer(open, {
  el: () => menuRef.value,
  inside: () => props.trigger === 'click' ? [host.value] : [],
  onEscape: () => close(),
  onPointerDownOutside: () => close(),
})

useFocusReturn(open, {
  container: menuRef,
  returnFocus: () => invoker,
})

// ---- items ------------------------------------------------------------------
const roving = useRovingFocus({
  container: menuRef,
  itemSelector: '[role="menuitem"]',
  orientation: 'vertical',
  typeahead: true,
  skipDisabled: false,
  pageSize: false,
})

watch(isPositioned, async (placed) => {
  if (!placed || !open.value) {
    return
  }
  await nextTick()
  roving.sync()
  const items = [...(menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  const first = items.findIndex(el => el.getAttribute('aria-disabled') !== 'true')
  roving.focusItem(first === -1 ? 0 : first)
})

function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault()
    close()
    focusElement(invoker, { preventScroll: true })
  }
}

function onItemPointerMove(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  if (document.activeElement !== el) {
    focusElement(el, { preventScroll: true })
  }
}

// ---- click-trigger ARIA -------------------------------------------------------
function menuButton(): HTMLElement | null {
  if (props.trigger !== 'click' || !host.value) {
    return null
  }
  return getFocusable(host.value).find(el => !menuRef.value?.contains(el)) ?? null
}

function syncButtonAria() {
  const btn = menuButton()
  if (!btn) {
    return
  }
  btn.setAttribute('aria-haspopup', 'menu')
  btn.setAttribute('aria-expanded', String(open.value))
  if (open.value) {
    btn.setAttribute('aria-controls', menuId)
  }
  else {
    btn.removeAttribute('aria-controls')
  }
}
onMounted(syncButtonAria)
watch(open, () => nextTick(syncButtonAria))
</script>

<template>
  <div
    ref="host"
    class="p-menu-host"
    @contextmenu="onContextMenu"
    @keydown="onHostKeydown"
    @click="onHostClick"
  >
    <slot />
    <Teleport to="body">
      <Transition name="p-float">
        <div
          v-if="open"
          :id="menuId"
          ref="menuRef"
          class="p-menu"
          :style="[floatingStyles, isPositioned ? null : { visibility: 'hidden' }]"
          role="menu"
          :aria-label="ariaLabel"
          @keydown="onMenuKeydown"
          @contextmenu.prevent
        >
          <template v-for="section in sections" :key="section.key">
            <div
              v-if="section.kind === 'divider'"
              class="p-menu__divider"
              role="separator"
            />
            <div
              v-else
              :role="section.label ? 'group' : 'none'"
              :aria-labelledby="section.label ? labelId(section.label.index) : undefined"
            >
              <div
                v-if="section.label"
                :id="labelId(section.label.index)"
                class="p-menu__label"
                role="presentation"
              >
                {{ section.label.title }}
              </div>
              <button
                v-for="{ item, index } in section.items"
                :key="index"
                type="button"
                class="p-menu__item"
                :class="{ 'p-menu__item--disabled': item.disabled }"
                :aria-disabled="item.disabled ? 'true' : undefined"
                role="menuitem"
                @click="pick(item)"
                @pointermove="onItemPointerMove"
              >
                <i v-if="item.icon" :class="item.icon" class="p-menu__icon" aria-hidden="true" />
                <span>{{ item.title }}</span>
              </button>
            </div>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.p-menu-host { display: block; }
</style>

<style>
.p-menu {
  z-index: var(--p-z-popover);
  min-width: 180px;
  padding: 4px;
  background: var(--p-surface);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  box-shadow: var(--p-shadow-md);
  font-size: var(--p-text-sm);
  color: var(--p-fg);
  user-select: none;
}
.p-menu:focus {
  outline: none;
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
.p-menu__item:hover:not(.p-menu__item--disabled),
.p-menu__item:focus-visible:not(.p-menu__item--disabled) {
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
