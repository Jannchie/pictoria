<script setup lang="ts">
import type { VirtualElement } from '@floating-ui/vue'
import { autoUpdate, flip, offset as offsetMw, shift, useFloating } from '@floating-ui/vue'
import { computed, nextTick, onMounted, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { focusElement, getFocusable } from '@/utils/focus'
import { matchesShortcut } from '@/utils/keyboard'
import { lastInputWasKeyboard, trackInputModality } from './inputModality'
import { useLayer } from './layers'
import { clipRectToViewport, groupMenuItems, isKeyboardContextMenu } from './overlay'
import { useFocusReturn } from './useFocusTrap'
import { useRovingFocus } from './useRovingFocus'

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
// - `checked` (true / false) makes an item a `menuitemradio` — one choice of a
//   labelled group, e.g. the current score; leave it undefined for a plain item.
// - `shortcut` is display text for the key that does the same thing outside the
//   menu (format it with `formatShortcut`); it is drawn right-aligned and is
//   not a binding.
// - `role: 'row'` packs a small radio set onto one line (`title` = its visible
//   name, `items` = the choices): e.g. score 1–5. Each choice is still a
//   `menuitemradio` in the roving order (↑↓ walk through them like any item,
//   ←→ too), named by its `title`, drawn as its `icon` and/or `short` text.
//   With `clearValue`, the checked choice is a toggle: picking it again emits
//   `clearValue` instead of its own value, and its name says so.
export interface PMenuItem {
  role?: 'label' | 'divider' | 'item' | 'row'
  title?: string
  icon?: string
  /** Icon colour (a CSS colour / token) — for row choices such as rating levels. */
  iconColor?: string
  /** Compact visible text of a row choice (e.g. "3"); `title` stays its name. */
  short?: string
  value?: string | number | symbol
  disabled?: boolean
  checked?: boolean
  shortcut?: string
  /** The choices of a `row`. */
  items?: PMenuItem[]
  /** A `row`'s value for "clear": emitted when its checked choice is picked again. */
  clearValue?: string | number | symbol
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
  /** The menu is opening — the moment to build its items (see MainSection). */
  (e: 'open'): void
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

/**
 * Keyboard anchor: a composite that keeps DOM focus on its container and
 * points at the logical item with `aria-activedescendant` (the gallery grid,
 * a combobox) anchors the menu to that item, not to the whole container.
 */
function keyboardAnchorTarget(focused: HTMLElement): HTMLElement {
  const id = focused.getAttribute('aria-activedescendant')
  if (!id) {
    return focused
  }
  return host.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? focused
}

function openWith(anchor: VirtualElement) {
  const active = document.activeElement as HTMLElement | null
  invoker = active && active !== document.body ? active : null
  reference.value = anchor
  emit('open')
  open.value = true
}

function openFromKeyboard() {
  const focused = currentFocusInHost()
  const target = (focused ? keyboardAnchorTarget(focused) : null) ?? menuButton() ?? host.value
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

/**
 * 从外部打开，锚在某个元素下方 —— 给"点一下某个子项就弹出它自己的菜单"用
 * （宿主仍是 contextmenu 触发，右键照常）。
 */
function openFor(el: HTMLElement) {
  openWith(elementAnchor(el))
}

defineExpose({ openFor, close })

/** A row choice's name; a clearable row's checked choice says it clears. */
function choiceName(row: PMenuItem, choice: PMenuItem, t: (key: string, named: Record<string, unknown>) => string): string {
  const name = choice.title ?? ''
  return choice.checked && row.clearValue !== undefined ? t('rating.pickAgainToClear', { name }) : name
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
const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]'
const roving = useRovingFocus({
  container: menuRef,
  itemSelector: ITEM_SELECTOR,
  // Both axes: ↑↓ walk the list, ←→ also step along an inline row; there are
  // no submenus for ←→ to mean anything else.
  orientation: 'both',
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
  const items = [...(menuRef.value?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])]
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
              <template v-for="{ item, index } in section.items" :key="index">
                <div
                  v-if="item.role === 'row'"
                  class="p-menu__row"
                  role="group"
                  :aria-label="item.title"
                >
                  <span class="p-menu__row-label" aria-hidden="true">{{ item.title }}</span>
                  <button
                    v-for="(choice, ci) in item.items ?? []"
                    :key="ci"
                    type="button"
                    class="p-menu__choice"
                    :class="{ 'p-menu__choice--checked': choice.checked, 'p-menu__item--disabled': choice.disabled }"
                    :aria-disabled="choice.disabled ? 'true' : undefined"
                    role="menuitemradio"
                    :aria-checked="!!choice.checked"
                    :aria-label="choiceName(item, choice, $t)"
                    :title="choice.shortcut ? `${choiceName(item, choice, $t)} (${choice.shortcut})` : choiceName(item, choice, $t)"
                    @click="pick(choice.checked && item.clearValue !== undefined ? { ...choice, value: item.clearValue } : choice)"
                    @pointermove="onItemPointerMove"
                  >
                    <i v-if="choice.icon" :class="choice.icon" :style="choice.iconColor ? { color: choice.iconColor } : undefined" aria-hidden="true" />
                    <span v-if="choice.short" aria-hidden="true">{{ choice.short }}</span>
                  </button>
                </div>
                <button
                  v-else
                  type="button"
                  class="p-menu__item"
                  :class="{ 'p-menu__item--disabled': item.disabled }"
                  :aria-disabled="item.disabled ? 'true' : undefined"
                  :role="item.checked === undefined ? 'menuitem' : 'menuitemradio'"
                  :aria-checked="item.checked"
                  @click="pick(item)"
                  @pointermove="onItemPointerMove"
                >
                  <i v-if="item.icon" :class="item.icon" class="p-menu__icon" aria-hidden="true" />
                  <span class="p-menu__title">{{ item.title }}</span>
                  <i v-if="item.checked" class="i-tabler-check p-menu__check" aria-hidden="true" />
                  <kbd v-if="item.shortcut" class="p-menu__shortcut" aria-hidden="true">{{ item.shortcut }}</kbd>
                </button>
              </template>
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
  /* Never taller than the viewport: a long menu scrolls instead of pushing
     its last items (Delete) off-screen. */
  max-height: calc(100vh - 8px);
  overflow-y: auto;
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
.p-menu__row {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px 2px 10px;
}
.p-menu__row-label {
  flex-grow: 1;
  margin-right: 8px;
  color: var(--p-fg-muted);
}
.p-menu__choice {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 26px;
  height: 26px;
  padding: 0 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--p-radius-sm);
  color: var(--p-fg-muted);
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.p-menu__choice:hover:not(.p-menu__item--disabled),
.p-menu__choice:focus-visible:not(.p-menu__item--disabled) {
  background: var(--p-surface-2);
  color: var(--p-fg);
}
.p-menu__choice--checked {
  border-color: var(--p-primary);
  color: var(--p-fg);
}
.p-menu__title {
  flex-grow: 1;
}
.p-menu__check {
  flex-shrink: 0;
  color: var(--p-primary);
}
.p-menu__shortcut {
  flex-shrink: 0;
  margin-left: 16px;
  color: var(--p-fg-subtle);
  font-family: var(--p-font-mono);
  font-size: var(--p-text-xs);
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
