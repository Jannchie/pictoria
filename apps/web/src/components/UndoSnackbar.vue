<script setup lang="ts">
import { useTimeoutFn } from '@vueuse/core'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { announce } from '@/shared/announce'
import { dismissUndoSnackbar, performRedo, performUndo, undoSnackbar } from '@/shared/undoSnackbar'
import { focusElement } from '@/utils/focus'
import { formatShortcut, isMac } from '@/utils/keyboard'

const { t } = useI18n()

const AUTO_DISMISS_MS = 5000

// The global chords live in useGlobalUndoRedo (Mod+Z / Mod+Shift+Z, Ctrl+Y);
// the snackbar only advertises them. aria-keyshortcuts wants the literal
// modifier names, the visible hint the platform glyphs.
const SHORTCUTS = {
  undo: { display: formatShortcut('Mod+Z'), aria: isMac ? 'Meta+Z' : 'Control+Z' },
  redo: { display: formatShortcut('Mod+Shift+Z'), aria: isMac ? 'Meta+Shift+Z' : 'Control+Shift+Z Control+Y' },
} as const

const data = computed(() => undoSnackbar.value)
const shortcut = computed(() => (data.value?.action ? SHORTCUTS[data.value.action] : undefined))
const actionLabel = computed(() => (data.value?.action === 'redo' ? t('common.redo') : t('common.undo')))
const actionIcon = computed(() => (data.value?.action === 'redo' ? 'i-tabler-arrow-forward-up' : 'i-tabler-arrow-back-up'))

// Auto-dismiss pauses while the pointer is over the snackbar OR keyboard
// focus is inside it (WCAG 2.2.1): a keyboard user tabbing to "Undo" must
// not have it vanish under them.
const hovered = ref(false)
const focused = ref(false)
const { start, stop } = useTimeoutFn(dismissUndoSnackbar, AUTO_DISMISS_MS, { immediate: false })

function syncTimer() {
  if (!data.value || hovered.value || focused.value) {
    stop()
  }
  else {
    start()
  }
}

// One announcement per snackbar through the shared live regions — the toast
// markup itself is not a live region here (inserting a role=status node is
// read unreliably). Errors go out assertively.
watch(() => data.value?.id, (id) => {
  syncTimer()
  const d = data.value
  if (id === undefined || !d) {
    return
  }
  if (d.tone === 'error' || !d.action || !shortcut.value) {
    announce(d.message, d.tone === 'error' ? 'assertive' : 'polite')
    return
  }
  const key = d.action === 'redo' ? 'undo.announceRedo' : 'undo.announceUndo'
  announce(t(key, { message: d.message, shortcut: shortcut.value.display }))
}, { immediate: true })

// Where focus came from when it entered the snackbar; handed back when the
// action button goes away under it (error result, or dismissed with Escape),
// so focus never drops to <body>.
let returnTo: HTMLElement | null = null
const root = useTemplateRef<HTMLElement>('root')

function isFocusVisible(el: HTMLElement | null): boolean {
  try {
    return !!el?.matches(':focus-visible')
  }
  catch {
    return true
  }
}

function onFocusin(e: FocusEvent) {
  const from = e.relatedTarget as HTMLElement | null
  if (!focused.value && from && !root.value?.contains(from)) {
    returnTo = from
  }
  // Only keyboard focus pauses: a mouse click also focuses the button, and
  // that must not pin the snackbar on screen after the pointer has left.
  focused.value = isFocusVisible(e.target as HTMLElement | null)
  syncTimer()
}
function onFocusout(e: FocusEvent) {
  const to = e.relatedTarget as Node | null
  if (to && root.value?.contains(to)) {
    return
  }
  focused.value = false
  syncTimer()
}
function onPointerEnter() {
  hovered.value = true
  syncTimer()
}
function onPointerLeave() {
  hovered.value = false
  syncTimer()
}

function handFocusBack() {
  const target = returnTo
  returnTo = null
  focused.value = false
  if (!(target?.isConnected && focusElement(target))) {
    focusElement(document.querySelector<HTMLElement>('#main-content'))
  }
  syncTimer()
}

function restoreFocusIfLost() {
  const active = document.activeElement
  if (active && active !== document.body && root.value?.contains(active)) {
    return
  }
  if (!active || active === document.body) {
    handFocusBack()
  }
}

async function onAction() {
  await (data.value?.action === 'redo' ? performRedo() : performUndo())
  await nextTick()
  restoreFocusIfLost()
}

// Element-level Escape (not a window binding): only reachable while focus is
// on the snackbar's own button, and the snackbar is not on the layer stack.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) {
    return
  }
  e.preventDefault()
  // Move focus first: the card leaves through a transition, so its button
  // would still hold focus for a moment and then drop it to <body>.
  handFocusBack()
  dismissUndoSnackbar()
}
</script>

<template>
  <div
    ref="root"
    class="px-4 pb-6 flex pointer-events-none bottom-0 left-0 right-0 justify-center fixed z-[var(--p-z-toast)]"
    @focusin="onFocusin"
    @focusout="onFocusout"
    @keydown="onKeydown"
  >
    <Transition name="undo-snackbar">
      <!-- 同一张卡片，只是换了个角落：顶部通知队列用的也是 PToast。这里单条、
           宽度随内容(fluid)，并把撤销/重做塞进 action 插槽。role="none"：朗读
           走上面的 announce()，卡片本身不再是 live region，免得读两遍。 -->
      <PToast
        v-if="data"
        fluid
        role="none"
        class="pointer-events-none"
        :message="data.message"
        :icon="data.tone === 'error' ? 'i-tabler-alert-triangle' : undefined"
        icon-color="var(--p-fg-muted)"
      >
        <template #action>
          <button
            v-if="data.action"
            type="button"
            class="text-primary font-medium px-2 py-0.5 rounded flex flex-shrink-0 gap-1 pointer-events-auto transition-colors items-center focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 focus-visible:outline hover:bg-surface-2"
            :aria-keyshortcuts="shortcut?.aria"
            @click="onAction"
            @pointerenter="onPointerEnter"
            @pointerleave="onPointerLeave"
          >
            <i :class="actionIcon" aria-hidden="true" />
            {{ actionLabel }}
            <kbd
              v-if="shortcut"
              class="text-2xs text-fg-subtle leading-none font-mono font-normal px-1 py-0.5 border border-border-subtle rounded-xs"
              aria-hidden="true"
            >{{ shortcut.display }}</kbd>
          </button>
        </template>
      </PToast>
    </Transition>
  </div>
</template>

<style scoped>
.undo-snackbar-enter-active,
.undo-snackbar-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.undo-snackbar-enter-from,
.undo-snackbar-leave-to {
  opacity: 0;
  transform: translateY(1rem);
}
</style>
