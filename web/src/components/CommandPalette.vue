<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useActiveFilters } from '@/composables/useActiveFilters'
import {
  commandPaletteOpen,
  hideNSFW,
  leftPaneCollapsed,
  postFilter,
  postSort,
  postSortOrder,
  rightPaneCollapsed,
  shortcutHelpOpen,
  textSearchQuery,
} from '@/shared'
import { openDialogCount, POverlay } from '@/ui'
import { hasFilterTerms, parseFilterQuery, stringifyFilterQuery } from '@/utils/filterDsl'

/**
 * One input for the three things this app couldn't otherwise expose: semantic
 * search (previously a small box in the corner), the filter as a readable
 * expression (previously spread across six popovers), and the command surface
 * that makes the keyboard shortcuts discoverable at all.
 *
 * What the input means is decided by what's in it: `key:value` terms become
 * filter facets, everything else becomes the SigLIP2 prompt, and the list below
 * always offers the matching commands.
 */
const { t } = useI18n()
const router = useRouter()
const { isFiltered, clearAll, resetAll } = useActiveFilters()

const query = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement>()

const parsed = computed(() => parseFilterQuery(query.value))
const hasTerms = computed(() => hasFilterTerms(parsed.value))
const promptText = computed(() => parsed.value.text)

interface Command {
  id: string
  label: string
  hint?: string
  icon: string
  /** Extra words this command should match on, beyond its label. */
  keywords?: string
  run: () => void
}

function go(path: string) {
  return () => router.push(path)
}

function sortBy(id: typeof postSort.value) {
  return () => {
    postSort.value = id
    // Descending is what "best/newest first" means for every value column here.
    postSortOrder.value = 'desc'
  }
}

// Static command set. Labels resolve through t() inside the computed so a
// locale switch rebuilds them.
const commands = computed<Command[]>(() => {
  const list: Command[] = [
    { id: 'nav-all', label: t('nav.all'), icon: 'i-tabler-photo', keywords: 'gallery home', run: go('/all') },
    { id: 'nav-recently', label: t('nav.recently'), icon: 'i-tabler-clock', run: go('/recently') },
    { id: 'nav-random', label: t('nav.random'), icon: 'i-tabler-arrows-cross', run: go('/random') },
    { id: 'nav-tags', label: t('nav.tagManager'), icon: 'i-tabler-bookmarks', run: go('/tags') },
    { id: 'nav-annotate', label: t('nav.annotate'), icon: 'i-tabler-checklist', run: go('/annotate') },
    { id: 'nav-settings', label: t('common.settings'), icon: 'i-tabler-settings', run: go('/settings') },

    { id: 'sort-score', label: t('command.sortBy', { label: t('sort.score') }), icon: 'i-tabler-star', run: sortBy('score') },
    { id: 'sort-rating', label: t('command.sortBy', { label: t('sort.rating') }), icon: 'i-tabler-thumb-up', run: sortBy('rating') },
    { id: 'sort-silva', label: t('command.sortBy', { label: t('sort.silvaScore') }), icon: 'i-tabler-rosette', run: sortBy('silva_score') },
    { id: 'sort-waifu', label: t('command.sortBy', { label: t('sort.waifuScore') }), icon: 'i-tabler-heart', run: sortBy('waifu_score') },
    { id: 'sort-discrepancy', label: t('command.sortBy', { label: t('sort.discrepancy') }), icon: 'i-tabler-git-compare', keywords: 'model vs me disagree', run: sortBy('discrepancy') },
    { id: 'sort-created', label: t('command.sortBy', { label: t('sort.created') }), icon: 'i-tabler-calendar-event', run: sortBy('created_at') },

    {
      id: 'view-left',
      label: t('pane.toggleLeft'),
      hint: 'Ctrl+B',
      icon: 'i-tabler-layout-sidebar-left-collapse',
      run: () => {
        leftPaneCollapsed.value = !leftPaneCollapsed.value
      },
    },
    {
      id: 'view-right',
      label: t('pane.toggleRight'),
      hint: 'Ctrl+Shift+B',
      icon: 'i-tabler-layout-sidebar-right-collapse',
      run: () => {
        rightPaneCollapsed.value = !rightPaneCollapsed.value
      },
    },
    {
      id: 'view-nsfw',
      label: t('command.toggleNsfw'),
      icon: 'i-tabler-eye-off',
      run: () => {
        hideNSFW.value = !hideNSFW.value
      },
    },
    {
      id: 'help-shortcuts',
      label: t('command.shortcuts'),
      hint: '?',
      icon: 'i-tabler-keyboard',
      keywords: 'keyboard help hotkeys',
      run: () => {
        shortcutHelpOpen.value = true
      },
    },
  ]
  if (isFiltered.value) {
    list.unshift(
      { id: 'filter-clear', label: t('overview.clearAll'), icon: 'i-tabler-filter-off', keywords: 'reset filters', run: clearAll },
      { id: 'filter-reset', label: t('command.resetAll'), icon: 'i-tabler-restore', keywords: 'reset sort filters', run: resetAll },
    )
  }
  return list
})

/** Plain substring match — predictable beats clever for a 20-item list. */
const matchedCommands = computed(() => {
  // Filter terms are not command words; match on the free text only.
  const q = (hasTerms.value ? promptText.value : query.value).trim().toLowerCase()
  if (!q) {
    return commands.value
  }
  return commands.value.filter(c =>
    c.label.toLowerCase().includes(q) || (c.keywords?.toLowerCase().includes(q) ?? false),
  )
})

function applyQuery() {
  const p = parsed.value
  if (hasTerms.value) {
    postFilter.value = {
      ...postFilter.value,
      rating: p.rating,
      score: p.score,
      tags: p.tags,
      extension: p.extension,
      waifu_score_levels: p.waifu_score_levels,
      silva_score_levels: p.silva_score_levels,
    }
  }
  textSearchQuery.value = p.text
  commandPaletteOpen.value = false
}

// The top entry, when the input says something the commands can't: apply the
// filter expression and/or run the semantic search.
const applyAction = computed<Command | null>(() => {
  if (!hasTerms.value && !promptText.value) {
    return null
  }
  const label = hasTerms.value
    ? (promptText.value
        ? t('command.applyFilterAndSearch', { query: promptText.value })
        : t('command.applyFilter'))
    : t('command.searchFor', { query: promptText.value })
  return {
    id: '__apply',
    label,
    icon: hasTerms.value ? 'i-tabler-filter' : 'i-tabler-search',
    run: applyQuery,
  }
})

const rows = computed<Command[]>(() => {
  const action = applyAction.value
  return action ? [action, ...matchedCommands.value] : matchedCommands.value
})

// Keep the highlight in range as the list shrinks under typing.
watch(rows, (list) => {
  if (activeIndex.value >= list.length) {
    activeIndex.value = Math.max(0, list.length - 1)
  }
})

function move(delta: number) {
  const n = rows.value.length
  if (n === 0) {
    return
  }
  activeIndex.value = (activeIndex.value + delta + n) % n
  nextTick(() => {
    document.querySelector(`#cmd-row-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' })
  })
}

function runActive() {
  const cmd = rows.value[activeIndex.value]
  if (!cmd) {
    return
  }
  cmd.run()
  // The apply action closes the palette itself; commands close here.
  if (cmd.id !== '__apply') {
    commandPaletteOpen.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowDown': { e.preventDefault(); move(1); break }
    case 'ArrowUp': { e.preventDefault(); move(-1); break }
    case 'Enter': { e.preventDefault(); runActive(); break }
    case 'Escape': { e.preventDefault(); commandPaletteOpen.value = false; break }
  }
}

// Opening seeds the input with the live filter so the palette reads as "here is
// what's applied", editable in place — not an empty box that silently discards
// the current state on submit.
watch(commandPaletteOpen, (open) => {
  if (open) {
    query.value = stringifyFilterQuery(postFilter.value, textSearchQuery.value)
    activeIndex.value = 0
    // Count as a dialog so grid/page hotkeys stand down while it's up.
    openDialogCount.value++
    nextTick(() => {
      inputRef.value?.focus()
      inputRef.value?.select()
    })
  }
  else {
    openDialogCount.value = Math.max(0, openDialogCount.value - 1)
  }
})
</script>

<template>
  <POverlay
    v-if="commandPaletteOpen"
    class="pt-[12vh] flex justify-center"
    @click.self="commandPaletteOpen = false"
  >
    <div
      role="dialog"
      aria-modal="true"
      :aria-label="$t('command.title')"
      class="border border-border-default rounded-lg bg-surface flex flex-col max-h-[70vh] max-w-[90vw] w-160 shadow-md overflow-hidden"
    >
      <div class="px-3 border-b border-border-subtle flex shrink-0 gap-2 h-11 items-center">
        <i class="i-tabler-search text-fg-subtle shrink-0" aria-hidden="true" />
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="$t('command.placeholder')"
          :aria-label="$t('command.title')"
          class="text-sm text-fg outline-none bg-transparent flex-grow"
          @keydown="onKeydown"
        >
        <kbd class="text-[10px] text-fg-subtle font-mono px-1.5 py-0.5 border border-border-subtle rounded shrink-0">Esc</kbd>
      </div>

      <!-- Parse feedback: shows terms that were understood but matched nothing
           we support, so a typo doesn't quietly become search text. -->
      <div
        v-if="parsed.unknown.length > 0"
        class="text-xs text-fg-subtle px-3 py-1.5 border-b border-border-subtle"
      >
        {{ $t('command.unknownTerms', { terms: parsed.unknown.join(', ') }) }}
      </div>

      <div class="flex-grow overflow-y-auto">
        <button
          v-for="(cmd, i) in rows"
          :id="`cmd-row-${i}`"
          :key="cmd.id"
          type="button"
          class="text-sm px-3 py-2 text-left flex gap-2.5 w-full transition-colors items-center"
          :class="i === activeIndex ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-1'"
          @click="activeIndex = i; runActive()"
          @mousemove="activeIndex = i"
        >
          <i :class="cmd.icon" class="shrink-0" aria-hidden="true" />
          <span class="flex-grow truncate">{{ cmd.label }}</span>
          <kbd
            v-if="cmd.hint"
            class="text-[10px] text-fg-subtle font-mono px-1.5 py-0.5 border border-border-subtle rounded shrink-0"
          >{{ cmd.hint }}</kbd>
        </button>
        <div
          v-if="rows.length === 0"
          class="text-sm text-fg-subtle px-3 py-6 text-center"
        >
          {{ $t('command.noMatch') }}
        </div>
      </div>

      <!-- Syntax cheat line: the DSL is only usable if it's visible. -->
      <div class="text-[11px] text-fg-subtle px-3 py-1.5 border-t border-border-subtle flex shrink-0 gap-3 overflow-x-auto">
        <span class="font-mono whitespace-nowrap">rating:&gt;=3</span>
        <span class="font-mono whitespace-nowrap">score:5</span>
        <span class="font-mono whitespace-nowrap">tag:1girl</span>
        <span class="font-mono whitespace-nowrap">ext:png</span>
        <span class="font-mono whitespace-nowrap">silva:best</span>
      </div>
    </div>
  </POverlay>
</template>
