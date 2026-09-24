<script setup lang="ts">
import type { ShortcutGroup } from '@/shared/shortcuts'
import { computed, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { shortcutHelpOpen, useLayer } from '@/shared'
import { shortcutChords, shortcutGroups } from '@/shared/shortcuts'
import { POverlay } from '@/ui'

/**
 * The keyboard shortcut sheet, rendered from the catalogue in
 * `shared/shortcuts.ts` (the same entries several binding sites import, so
 * the list cannot drift from the code).
 *
 * APG modal dialog: a `modal` layer (Escape / click outside close, the rest of
 * the page is inert), focus trapped inside, initial focus on the filter field,
 * focus returned to whatever opened it.
 */
const { t } = useI18n()
const uid = useId()
const titleId = `${uid}-title`

const dialogRef = useTemplateRef<HTMLElement>('dialog')
const filterRef = useTemplateRef<HTMLInputElement>('filter')
const query = ref('')

function close() {
  shortcutHelpOpen.value = false
}

useLayer(shortcutHelpOpen, {
  el: () => dialogRef.value,
  modal: true,
  onEscape: close,
  onPointerDownOutside: close,
})
useFocusTrap(dialogRef, shortcutHelpOpen, { initialFocus: () => filterRef.value })

watch(shortcutHelpOpen, (open) => {
  if (open) {
    query.value = ''
  }
})

interface Row {
  id: string
  desc: string
  chords: ReturnType<typeof shortcutChords>
  gesture?: string
  /** Lower-cased description + key caps, for the filter. */
  haystack: string
}
interface Group {
  id: string
  title: string
  rows: Row[]
}

const groups = computed<Group[]>(() => shortcutGroups.map((group: ShortcutGroup) => ({
  id: group.id,
  title: t(group.titleKey),
  rows: group.entries.map((entry) => {
    const chords = shortcutChords(entry)
    const gesture = entry.gestureKey ? t(entry.gestureKey) : undefined
    const desc = t(entry.descKey)
    const caps = chords.flatMap(c => [...c.mods, ...c.keys])
    return {
      id: entry.id,
      desc,
      chords,
      gesture,
      haystack: [desc, ...caps, gesture ?? ''].join(' ').toLowerCase(),
    }
  }),
})))

const visibleGroups = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) {
    return groups.value
  }
  return groups.value
    .map(g => ({ ...g, rows: g.title.toLowerCase().includes(q) ? g.rows : g.rows.filter(r => r.haystack.includes(q)) }))
    .filter(g => g.rows.length > 0)
})

/** `[from, to, from, to…]` → `[[from, to], …]` for range chords. */
function rangePairs(keys: readonly string[]): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i + 1 < keys.length; i += 2) {
    out.push([keys[i], keys[i + 1]])
  }
  return out
}
</script>

<template>
  <POverlay
    v-if="shortcutHelpOpen"
    class="p-4 flex items-center justify-center"
  >
    <div
      ref="dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      class="border border-border-default rounded-lg bg-surface flex flex-col max-h-[85vh] max-w-full w-200 shadow-md overflow-hidden"
    >
      <div class="px-4 pb-3 pt-4 flex shrink-0 flex-col gap-3">
        <div class="flex items-center justify-between">
          <h2
            :id="titleId"
            class="text-sm text-fg font-semibold flex gap-2 items-center"
          >
            <i class="i-tabler-keyboard" aria-hidden="true" />
            {{ $t('shortcuts.title') }}
          </h2>
          <PButton
            size="sm"
            icon
            variant="ghost"
            :aria-label="$t('common.close')"
            @click="close"
          >
            <i class="i-tabler-x" aria-hidden="true" />
          </PButton>
        </div>
        <input
          ref="filter"
          v-model="query"
          type="search"
          autocomplete="off"
          spellcheck="false"
          :aria-label="$t('shortcuts.filter')"
          :placeholder="$t('shortcuts.filter')"
          class="text-sm text-fg px-2.5 border border-border-default rounded-md bg-surface h-8 w-full placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-0 focus-visible:outline"
        >
      </div>

      <!-- Scrollable, so keyboard users need a tab stop to scroll it. -->
      <div
        tabindex="0"
        role="region"
        :aria-labelledby="titleId"
        class="px-4 pb-4 flex-1 min-h-0 overflow-y-auto focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px] focus-visible:outline"
      >
        <p
          v-if="visibleGroups.length === 0"
          class="text-xs text-fg-subtle py-6 text-center"
        >
          {{ $t('shortcuts.noMatch') }}
        </p>
        <div class="gap-x-8 gap-y-5 grid sm:grid-cols-2">
          <section
            v-for="group in visibleGroups"
            :key="group.id"
            :aria-labelledby="`${uid}-${group.id}`"
          >
            <h3
              :id="`${uid}-${group.id}`"
              class="text-2xs text-fg-subtle tracking-wider font-semibold mb-1.5 uppercase"
            >
              {{ group.title }}
            </h3>
            <dl class="flex flex-col">
              <div
                v-for="row in group.rows"
                :key="row.id"
                class="text-xs py-1 flex gap-3 items-center justify-between"
              >
                <dt class="text-fg-muted">
                  {{ row.desc }}
                </dt>
                <dd class="m-0 flex shrink-0 flex-wrap gap-1 items-center justify-end">
                  <template v-for="(chord, ci) in row.chords" :key="ci">
                    <span v-if="ci > 0" class="text-fg-subtle" aria-hidden="true">/</span>
                    <kbd v-for="m in chord.mods" :key="`m-${m}`" class="shortcut-kbd">{{ m }}</kbd>
                    <template v-if="chord.range">
                      <span v-for="([from, to], ri) in rangePairs(chord.keys)" :key="`r-${ri}`" class="flex gap-0.5 items-center">
                        <kbd class="shortcut-kbd">{{ from }}</kbd>
                        <span class="text-fg-subtle">–</span>
                        <kbd class="shortcut-kbd">{{ to }}</kbd>
                      </span>
                    </template>
                    <template v-else>
                      <kbd v-for="k in chord.keys" :key="`k-${k}`" class="shortcut-kbd">{{ k }}</kbd>
                    </template>
                  </template>
                  <kbd v-if="row.gesture" class="shortcut-kbd">{{ row.gesture }}</kbd>
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  </POverlay>
</template>

<style scoped>
.shortcut-kbd {
  font-family: var(--p-font-mono);
  font-size: 10px;
  line-height: 1;
  color: var(--p-fg);
  padding: 3px 6px;
  border: 1px solid var(--p-border-subtle);
  border-radius: 4px;
  background: var(--p-surface-1);
  min-width: 1.5em;
  text-align: center;
}
</style>
