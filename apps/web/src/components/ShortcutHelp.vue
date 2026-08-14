<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { shortcutHelpOpen } from '@/shared'
import { openDialogCount, POverlay } from '@/ui'

/**
 * The app implements a lot of keyboard behaviour — grid navigation with real
 * geometric neighbour resolution, 1–5 batch scoring, drag-select, Ctrl+wheel
 * column sizing — none of which was discoverable without reading the source.
 * This is that list. Keep it in sync when a hotkey is added.
 */
const { t } = useI18n()

interface Shortcut {
  keys: string[]
  desc: string
}
interface Group {
  title: string
  items: Shortcut[]
}

const groups = computed<Group[]>(() => [
  {
    title: t('shortcuts.global'),
    items: [
      { keys: ['Ctrl', 'K'], desc: t('shortcuts.openPalette') },
      { keys: ['?'], desc: t('shortcuts.openHelp') },
      { keys: ['Ctrl', 'B'], desc: t('pane.toggleLeft') },
      { keys: ['Ctrl', 'Shift', 'B'], desc: t('pane.toggleRight') },
      { keys: ['Ctrl', 'Z'], desc: t('common.undo') },
      { keys: ['Ctrl', 'Shift', 'Z'], desc: t('common.redo') },
    ],
  },
  {
    title: t('shortcuts.grid'),
    items: [
      { keys: ['←', '→', '↑', '↓'], desc: t('shortcuts.gridMove') },
      { keys: ['Enter'], desc: t('shortcuts.openPost') },
      { keys: ['Ctrl', 'A'], desc: t('multiSelect.selectAll') },
      { keys: ['Esc'], desc: t('multiSelect.clearSelection') },
      { keys: ['Delete'], desc: t('shortcuts.deleteSelected') },
      { keys: ['1', '–', '5'], desc: t('shortcuts.scoreSelected') },
      { keys: ['Ctrl', t('shortcuts.wheel')], desc: t('shortcuts.columns') },
      { keys: [t('shortcuts.drag')], desc: t('shortcuts.dragSelect') },
    ],
  },
  {
    title: t('shortcuts.postPage'),
    items: [
      { keys: ['←', '→'], desc: t('shortcuts.prevNext') },
      { keys: ['Space'], desc: t('shortcuts.fullscreen') },
      { keys: ['Esc'], desc: t('common.back') },
      { keys: ['1', '–', '5'], desc: t('shortcuts.scorePost') },
    ],
  },
])

function close() {
  shortcutHelpOpen.value = false
}

watch(shortcutHelpOpen, (open) => {
  // Mirror PDialog's bookkeeping so page hotkeys stand down while this is up.
  if (open) {
    openDialogCount.value++
  }
  else {
    openDialogCount.value = Math.max(0, openDialogCount.value - 1)
  }
})

onKeyStroke('Escape', (e) => {
  if (!shortcutHelpOpen.value) {
    return
  }
  e.preventDefault()
  close()
})
</script>

<template>
  <POverlay
    v-if="shortcutHelpOpen"
    class="flex items-center justify-center"
    @click.self="close"
  >
    <div
      role="dialog"
      aria-modal="true"
      :aria-label="$t('shortcuts.title')"
      class="p-4 border border-border-default rounded-lg bg-surface max-h-[80vh] max-w-[90vw] w-160 shadow-md overflow-y-auto"
    >
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm text-fg font-semibold flex gap-2 items-center">
          <i class="i-tabler-keyboard" aria-hidden="true" />
          {{ $t('shortcuts.title') }}
        </h2>
        <PButton
          size="sm"
          icon
          variant="ghost"
          :aria-label="$t('common.cancel')"
          @click="close"
        >
          <i class="i-tabler-x" aria-hidden="true" />
        </PButton>
      </div>

      <div class="gap-x-6 gap-y-4 grid sm:grid-cols-2">
        <section
          v-for="group in groups"
          :key="group.title"
        >
          <div class="text-[11px] text-fg-subtle tracking-wider font-semibold mb-1.5 uppercase">
            {{ group.title }}
          </div>
          <div class="flex flex-col">
            <div
              v-for="item in group.items"
              :key="item.desc"
              class="text-xs py-1 flex gap-3 items-center justify-between"
            >
              <span class="text-fg-muted">{{ item.desc }}</span>
              <span class="flex shrink-0 gap-1 items-center">
                <kbd
                  v-for="key in item.keys"
                  :key="key"
                  class="text-[10px] text-fg font-mono px-1.5 py-0.5 border border-border-subtle rounded bg-surface-1"
                >{{ key }}</kbd>
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </POverlay>
</template>
