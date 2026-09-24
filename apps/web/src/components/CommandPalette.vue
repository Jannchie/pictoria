<script setup lang="ts">
import { useDebounceFn } from '@vueuse/core'
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useActiveFilters } from '@/composables/useActiveFilters'
import { useFocusTrap } from '@/composables/useFocusTrap'
import {
  announce,
  closeCommandPalette,
  commandPaletteOpen,
  hideNSFW,
  leftPaneCollapsed,
  postFilter,
  postSort,
  postSortOrder,
  rightPaneCollapsed,
  shortcutHelpOpen,
  textSearchQuery,
  useLayer,
} from '@/shared'
import { POverlay } from '@/ui'
import { hasFilterTerms, parseFilterQuery, stringifyFilterQuery } from '@/utils/filterDsl'
import { formatShortcut } from '@/utils/keyboard'
import { idFragment, listboxKeyIndex } from '@/utils/listboxNav'

/**
 * One input for the three things this app couldn't otherwise expose: semantic
 * search (previously a small box in the corner), the filter as a readable
 * expression (previously spread across six popovers), and the command surface
 * that makes the keyboard shortcuts discoverable at all.
 *
 * What the input means is decided by what's in it: `key:value` terms become
 * filter facets, everything else becomes the SigLIP2 prompt, and the list below
 * always offers the matching commands.
 *
 * Accessibility: APG combobox (the input) + listbox (the rows). DOM focus
 * never leaves the input; the active row is `aria-activedescendant`, keyed by
 * the command id so it is stable while the list filters. Keys: see
 * `utils/listboxNav.ts` (↑↓ wrap, PageUp/PageDown, Ctrl+Home/End always,
 * Home/End only with an empty input), Enter runs (IME-safe), Escape closes via
 * the layer stack. Modal layer + focus trap + focus return.
 */
const { t } = useI18n()
const router = useRouter()
const { isFiltered, clearAll, resetAll } = useActiveFilters()

const query = ref('')
const activeIndex = ref(0)
const inputRef = useTemplateRef<HTMLInputElement>('input')
const dialogRef = useTemplateRef<HTMLElement>('dialog')
const listboxRef = useTemplateRef<HTMLElement>('listbox')

const uid = useId()
const listboxId = `${uid}-listbox`
const syntaxId = `${uid}-syntax`
function optionId(cmd: Command) {
  return `${uid}-opt-${idFragment(cmd.id)}`
}

const parsed = computed(() => parseFilterQuery(query.value))
const hasTerms = computed(() => hasFilterTerms(parsed.value))
const promptText = computed(() => parsed.value.text)

type CommandGroup = 'action' | 'filter' | 'navigate' | 'sort' | 'view' | 'help'

interface Command {
  id: string
  label: string
  group: CommandGroup
  /** Shortcut in `useHotkey` grammar; rendered Mac-aware via formatShortcut. */
  shortcut?: string
  icon: string
  /** Extra words this command should match on, beyond its label. */
  keywords?: string
  run: () => void
}

const GROUP_LABEL_KEYS: Record<CommandGroup, string> = {
  action: 'command.groupAction',
  filter: 'command.groupFilter',
  navigate: 'command.groupNavigate',
  sort: 'command.groupSort',
  view: 'command.groupView',
  help: 'command.groupHelp',
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
    { id: 'nav-all', group: 'navigate', label: t('nav.all'), icon: 'i-tabler-photo', keywords: 'gallery home', run: go('/all') },
    { id: 'nav-recently', group: 'navigate', label: t('nav.recently'), icon: 'i-tabler-clock', run: go('/recently') },
    { id: 'nav-random', group: 'navigate', label: t('nav.random'), icon: 'i-tabler-arrows-cross', run: go('/random') },
    { id: 'nav-tags', group: 'navigate', label: t('nav.tagManager'), icon: 'i-tabler-bookmarks', run: go('/tags') },
    { id: 'nav-annotate', group: 'navigate', label: t('nav.annotate'), icon: 'i-tabler-checklist', run: go('/annotate') },
    { id: 'nav-settings', group: 'navigate', label: t('common.settings'), icon: 'i-tabler-settings', run: go('/settings') },

    { id: 'sort-score', group: 'sort', label: t('command.sortBy', { label: t('sort.score') }), icon: 'i-tabler-star', run: sortBy('score') },
    { id: 'sort-rating', group: 'sort', label: t('command.sortBy', { label: t('sort.rating') }), icon: 'i-tabler-thumb-up', run: sortBy('rating') },
    { id: 'sort-silva', group: 'sort', label: t('command.sortBy', { label: t('sort.silvaScore') }), icon: 'i-tabler-rosette', run: sortBy('silva_score') },
    { id: 'sort-silva-luna', group: 'sort', label: t('command.sortBy', { label: t('sort.silvaLunaScore') }), icon: 'i-tabler-moon', run: sortBy('silva_luna_score') },
    { id: 'sort-waifu', group: 'sort', label: t('command.sortBy', { label: t('sort.waifuScore') }), icon: 'i-tabler-heart', run: sortBy('waifu_score') },
    { id: 'sort-discrepancy', group: 'sort', label: t('command.sortBy', { label: t('sort.discrepancy') }), icon: 'i-tabler-git-compare', keywords: 'model vs me disagree', run: sortBy('discrepancy') },
    { id: 'sort-created', group: 'sort', label: t('command.sortBy', { label: t('sort.created') }), icon: 'i-tabler-calendar-event', run: sortBy('created_at') },

    {
      id: 'view-left',
      group: 'view',
      label: t('pane.toggleLeft'),
      shortcut: 'Mod+B',
      icon: 'i-tabler-layout-sidebar-left-collapse',
      run: () => {
        leftPaneCollapsed.value = !leftPaneCollapsed.value
      },
    },
    {
      id: 'view-right',
      group: 'view',
      label: t('pane.toggleRight'),
      shortcut: 'Mod+Shift+B',
      icon: 'i-tabler-layout-sidebar-right-collapse',
      run: () => {
        rightPaneCollapsed.value = !rightPaneCollapsed.value
      },
    },
    {
      id: 'view-nsfw',
      group: 'view',
      label: t('command.toggleNsfw'),
      icon: 'i-tabler-eye-off',
      run: () => {
        hideNSFW.value = !hideNSFW.value
      },
    },
    {
      id: 'help-shortcuts',
      group: 'help',
      label: t('command.shortcuts'),
      shortcut: '?',
      icon: 'i-tabler-keyboard',
      keywords: 'keyboard help hotkeys',
      run: () => {
        shortcutHelpOpen.value = true
      },
    },
  ]
  if (isFiltered.value) {
    list.unshift(
      { id: 'filter-clear', group: 'filter', label: t('overview.clearAll'), icon: 'i-tabler-filter-off', keywords: 'reset filters', run: clearAll },
      { id: 'filter-reset', group: 'filter', label: t('command.resetAll'), icon: 'i-tabler-restore', keywords: 'reset sort filters', run: resetAll },
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
      waifuScoreLevels: p.waifuScoreLevels,
      silvaScoreLevels: p.silvaScoreLevels,
      silvaLunaScoreLevels: p.silvaLunaScoreLevels,
    }
  }
  textSearchQuery.value = p.text
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
    group: 'action',
    label,
    icon: hasTerms.value ? 'i-tabler-filter' : 'i-tabler-search',
    run: applyQuery,
  }
})

const rows = computed<Command[]>(() => {
  const action = applyAction.value
  return action ? [action, ...matchedCommands.value] : matchedCommands.value
})

interface RowSection {
  group: CommandGroup
  labelId: string
  items: { cmd: Command, index: number }[]
}

/**
 * Consecutive rows of the same group → one `role=group` section. The flat
 * `rows` order is what the keyboard walks; sections only wrap it.
 */
const sections = computed<RowSection[]>(() => {
  const out: RowSection[] = []
  for (const [index, cmd] of rows.value.entries()) {
    const last = out.at(-1)
    if (last && last.group === cmd.group) {
      last.items.push({ cmd, index })
    }
    else {
      out.push({ group: cmd.group, labelId: `${uid}-group-${cmd.group}`, items: [{ cmd, index }] })
    }
  }
  return out
})

const activeDescendant = computed(() => {
  const cmd = rows.value[activeIndex.value]
  return cmd ? optionId(cmd) : undefined
})

// Typing re-ranks the list: the most relevant row (the first) becomes active.
watch(query, () => {
  activeIndex.value = 0
})
// …and the list may shrink under a locale/filter change without typing.
watch(rows, (list) => {
  if (activeIndex.value >= list.length) {
    activeIndex.value = Math.max(0, list.length - 1)
  }
})

function scrollActiveIntoView() {
  nextTick(() => {
    listboxRef.value
      ?.querySelector(`[data-option-index="${activeIndex.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function close() {
  closeCommandPalette()
}

/**
 * Close first, run after: the focus trap returns focus to where the palette
 * was opened from (a microtask), and only then does the command act — so a
 * command that opens another layer (the shortcut sheet) remembers the page
 * element, not the palette's vanishing input, as its own focus-return target.
 */
function runRow(index: number) {
  const cmd = rows.value[index]
  if (!cmd) {
    return
  }
  close()
  setTimeout(cmd.run, 0)
}

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) {
    return
  }
  const next = listboxKeyIndex(e, {
    index: activeIndex.value,
    count: rows.value.length,
    inputEmpty: query.value === '',
  })
  if (next !== null) {
    e.preventDefault()
    activeIndex.value = next
    scrollActiveIntoView()
    return
  }
  // IME: Enter that confirms a composition must not run the command.
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229
    && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault()
    runRow(activeIndex.value)
  }
}

useLayer(commandPaletteOpen, {
  el: () => dialogRef.value,
  modal: true,
  onEscape: close,
  onPointerDownOutside: close,
})
useFocusTrap(dialogRef, commandPaletteOpen, { initialFocus: () => inputRef.value })

// Live result count for screen readers, debounced so each keystroke doesn't
// queue an announcement.
const announceCount = useDebounceFn(() => {
  if (!commandPaletteOpen.value) {
    return
  }
  const n = rows.value.length
  announce(n === 0 ? t('command.noMatch') : t('command.resultCount', { n }, n))
}, 500)
watch(query, () => {
  if (commandPaletteOpen.value) {
    announceCount()
  }
})

// Opening seeds the input with the live filter so the palette reads as "here is
// what's applied", editable in place — not an empty box that silently discards
// the current state on submit.
watch(commandPaletteOpen, (open) => {
  if (open) {
    query.value = stringifyFilterQuery(postFilter.value, textSearchQuery.value)
    activeIndex.value = 0
    nextTick(() => {
      inputRef.value?.select()
    })
  }
})
</script>

<template>
  <Teleport to="body">
    <POverlay
      v-if="commandPaletteOpen"
      class="pt-[12vh] flex justify-center"
    >
      <div
        ref="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('command.title')"
        class="border border-border-default rounded-lg bg-surface flex flex-col max-h-[70vh] max-w-[90vw] w-160 shadow-md overflow-hidden"
      >
        <div class="px-3 border-b border-border-subtle flex shrink-0 gap-2.5 h-12 items-center">
          <i class="i-tabler-search text-fg-subtle shrink-0" aria-hidden="true" />
          <input
            ref="input"
            v-model="query"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            :aria-controls="listboxId"
            :aria-activedescendant="activeDescendant"
            :aria-describedby="syntaxId"
            autocomplete="off"
            spellcheck="false"
            :placeholder="$t('command.placeholder')"
            :aria-label="$t('command.title')"
            class="text-base text-fg outline-none bg-transparent flex-grow"
            @keydown="onKeydown"
          >
          <kbd
            class="text-2xs text-fg-subtle font-mono px-1.5 py-0.5 border border-border-subtle rounded shrink-0"
            aria-hidden="true"
          >{{ formatShortcut('Esc') }}</kbd>
        </div>

        <!-- Parse feedback: shows terms that were understood but matched nothing
             we support, so a typo doesn't quietly become search text. -->
        <div
          v-if="parsed.unknown.length > 0"
          class="text-xs text-fg-subtle px-3 py-1.5 border-b border-border-subtle"
        >
          {{ $t('command.unknownTerms', { terms: parsed.unknown.join(', ') }) }}
        </div>

        <!-- mousedown.prevent: clicking a row must not pull focus out of the
             combobox input (rows are not focusable; the input owns the cursor). -->
        <div
          :id="listboxId"
          ref="listbox"
          role="listbox"
          :aria-label="$t('command.listLabel')"
          class="flex-grow overflow-y-auto"
          @mousedown.prevent
        >
          <div
            v-for="section in sections"
            :key="section.group"
            role="group"
            :aria-labelledby="section.labelId"
          >
            <!-- Group names are for assistive tech; the list keeps its flat look. -->
            <div :id="section.labelId" class="sr-only">
              {{ $t(GROUP_LABEL_KEYS[section.group]) }}
            </div>
            <div
              v-for="{ cmd, index } in section.items"
              :id="optionId(cmd)"
              :key="cmd.id"
              role="option"
              :aria-selected="index === activeIndex"
              :data-option-index="index"
              class="text-sm px-3 py-2 text-left flex gap-2.5 w-full cursor-pointer transition-colors items-center"
              :class="index === activeIndex ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-1'"
              @click="runRow(index)"
              @mousemove="activeIndex = index"
            >
              <i :class="cmd.icon" class="shrink-0" aria-hidden="true" />
              <span class="flex-grow truncate">{{ cmd.label }}</span>
              <kbd
                v-if="cmd.shortcut"
                class="text-2xs text-fg-subtle font-mono px-1.5 py-0.5 border border-border-subtle rounded shrink-0"
              >{{ formatShortcut(cmd.shortcut) }}</kbd>
            </div>
          </div>
        </div>
        <div
          v-if="rows.length === 0"
          class="text-sm text-fg-subtle px-3 py-6 text-center"
        >
          {{ $t('command.noMatch') }}
        </div>

        <!-- Syntax cheat line: the DSL is only usable if it's visible. Also the
             input's description, so screen readers hear the grammar once. -->
        <div
          :id="syntaxId"
          class="text-xs text-fg-subtle px-3 py-1.5 border-t border-border-subtle flex shrink-0 gap-3 overflow-x-auto"
        >
          <span class="font-mono whitespace-nowrap">rating:&gt;=3</span>
          <span class="font-mono whitespace-nowrap">score:5</span>
          <span class="font-mono whitespace-nowrap">tag:1girl</span>
          <span class="font-mono whitespace-nowrap">ext:png</span>
          <span class="font-mono whitespace-nowrap">silva:best</span>
          <span class="font-mono whitespace-nowrap">luna:best</span>
        </div>
      </div>
    </POverlay>
  </Teleport>
</template>
