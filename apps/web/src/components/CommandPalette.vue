<script setup lang="ts">
import type { TagCountRequest } from '@/api'
import type { TokenSpan } from '@/utils/paletteToken'
import { keepPreviousData, useQuery } from '@tanstack/vue-query'
import { refDebounced, useDebounceFn, useEventListener } from '@vueuse/core'
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { v2GetTagCount } from '@/api'
import { useActiveFilters } from '@/composables/useActiveFilters'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { formatNumber, resolvedLocale } from '@/locale'
import {
  announce,
  closeCommandPalette,
  commandPaletteOpen,
  hideNSFW,
  leftPaneCollapsed,
  postFilter,
  postSort,
  postSortOrder,
  queryKeys,
  rightPaneCollapsed,
  shortcutHelpOpen,
  textSearchQuery,
  useLayer,
} from '@/shared'
import { shortcuts } from '@/shared/shortcuts'
import { POverlay } from '@/ui'
import { naturalizeTagName } from '@/utils'
import { hasFilterTerms, parseFilterQuery, stringifyFilterQuery } from '@/utils/filterDsl'
import { formatShortcut, shortcutKeys } from '@/utils/keyboard'
import { idFragment, listboxKeyIndex } from '@/utils/listboxNav'
import {
  FILTER_KEYS,
  rankTagSuggestions,
  removeSpan,
  replaceSpan,
  replaceSpanKeepTyping,
  syntaxCompletions,
  tagSuggestQuery,
  tagTerm,
  tokenAt,
  tokenSpans,
} from '@/utils/paletteToken'

/**
 * One input for the three things this app couldn't otherwise expose: semantic
 * search, the filter as a readable expression, and the command surface that
 * makes the keyboard shortcuts discoverable.
 *
 * What the input means is decided by what's in it: `key:value` terms become
 * filter facets, everything else becomes the SigLIP2 prompt. The list below
 * reads the term under the caret and offers what it could become:
 *
 * - **Tags** — typing part of a tag name (in English or its translation), or
 *   `tag:…`, suggests real tags with their counts in the current scope.
 *   Enter / Tab turns the term into `tag:name` and keeps the palette open to
 *   keep composing; Mod+Enter inserts and applies in one go.
 * - **Syntax** — a bare prefix of a filter key (`ra` → `rating:`) and the
 *   values of a known key (`rating:` → general, sensitive…).
 * - **Commands** — navigation, sort, view, help.
 *
 * Understood filter terms are echoed as removable chips under the input, so the
 * DSL reads back as what it did.
 *
 * Accessibility: APG combobox (the input) + listbox (the rows). DOM focus stays
 * in the input; the active row is `aria-activedescendant`, tracked by row id so
 * it survives async suggestion updates. Keys: `utils/listboxNav.ts` (↑↓ wrap,
 * PageUp/PageDown, Mod+Home/End, Home/End only with an empty input), Enter
 * runs / inserts (IME-safe), Tab completes, Mod+Enter applies now, Escape
 * closes via the layer stack. Modal layer + focus trap + focus return.
 */
const { t } = useI18n()
const router = useRouter()
const { isFiltered, clearAll, resetAll } = useActiveFilters()

const query = ref('')
/** What the input said when the palette opened (the live filter). */
const seededQuery = ref('')
const caret = ref(0)
const inputRef = useTemplateRef<HTMLInputElement>('input')
const dialogRef = useTemplateRef<HTMLElement>('dialog')
const listboxRef = useTemplateRef<HTMLElement>('listbox')

const uid = useId()
const listboxId = `${uid}-listbox`
const hintsId = `${uid}-hints`
function optionId(row: Row) {
  return `${uid}-opt-${idFragment(row.id)}`
}

const parsed = computed(() => parseFilterQuery(query.value))
const hasTerms = computed(() => hasFilterTerms(parsed.value))
const promptText = computed(() => parsed.value.text)

/** The term the caret is in — what completions act on. */
const currentSpan = computed<TokenSpan | null>(() => tokenAt(query.value, caret.value))

function syncCaret() {
  const el = inputRef.value
  if (el) {
    caret.value = el.selectionStart ?? el.value.length
  }
}
// Arrow keys / clicks / Home/End move the caret without an input event.
useEventListener(() => (commandPaletteOpen.value ? document : null), 'selectionchange', () => {
  if (document.activeElement === inputRef.value) {
    syncCaret()
  }
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type SectionKey = 'apply' | 'tags' | 'syntax' | 'filter' | 'navigate' | 'sort' | 'view' | 'help'

interface Row {
  id: string
  section: SectionKey
  icon: string
  label: string
  /** Substring of `label` to emphasise (the part that matched the input). */
  match?: string
  /** Secondary text (translation, description). */
  hint?: string
  /** Right-aligned mono detail (a count). */
  meta?: string
  /** Shortcut in `useHotkey` grammar, rendered Mac-aware. */
  shortcut?: string
  /** Completion rows fill the input instead of closing the palette. */
  kind: 'command' | 'completion'
  /**
   * `enter` / `tab`: the row's primary action. `apply`: Mod+Enter — for a
   * completion, insert it and apply the whole query at once.
   */
  activate: (mode: 'enter' | 'tab' | 'apply') => void
}

const SECTION_LABEL_KEYS: Record<SectionKey, string> = {
  apply: 'command.groupAction',
  tags: 'command.groupTags',
  syntax: 'command.groupSyntax',
  filter: 'command.groupFilter',
  navigate: 'command.groupNavigate',
  sort: 'command.groupSort',
  view: 'command.groupView',
  help: 'command.groupHelp',
}

interface CommandDef {
  id: string
  label: string
  section: Extract<SectionKey, 'filter' | 'navigate' | 'sort' | 'view' | 'help'>
  shortcut?: string
  icon: string
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

const commands = computed<CommandDef[]>(() => {
  const list: CommandDef[] = [
    { id: 'nav-all', section: 'navigate', label: t('nav.all'), icon: 'i-tabler-photo', keywords: 'gallery home', run: go('/all') },
    { id: 'nav-recently', section: 'navigate', label: t('nav.recently'), icon: 'i-tabler-clock', run: go('/recently') },
    { id: 'nav-random', section: 'navigate', label: t('nav.random'), icon: 'i-tabler-arrows-cross', run: go('/random') },
    { id: 'nav-tags', section: 'navigate', label: t('nav.tagManager'), icon: 'i-tabler-bookmarks', run: go('/tags') },
    { id: 'nav-annotate', section: 'navigate', label: t('nav.annotate'), icon: 'i-tabler-checklist', run: go('/annotate') },
    { id: 'nav-settings', section: 'navigate', label: t('common.settings'), icon: 'i-tabler-settings', run: go('/settings') },

    { id: 'sort-score', section: 'sort', label: t('command.sortBy', { label: t('sort.score') }), icon: 'i-tabler-star', run: sortBy('score') },
    { id: 'sort-rating', section: 'sort', label: t('command.sortBy', { label: t('sort.rating') }), icon: 'i-tabler-thumb-up', run: sortBy('rating') },
    { id: 'sort-silva', section: 'sort', label: t('command.sortBy', { label: t('sort.silvaScore') }), icon: 'i-tabler-rosette', run: sortBy('silva_score') },
    { id: 'sort-silva-luna', section: 'sort', label: t('command.sortBy', { label: t('sort.silvaLunaScore') }), icon: 'i-tabler-moon', run: sortBy('silva_luna_score') },
    { id: 'sort-waifu', section: 'sort', label: t('command.sortBy', { label: t('sort.waifuScore') }), icon: 'i-tabler-heart', run: sortBy('waifu_score') },
    { id: 'sort-discrepancy', section: 'sort', label: t('command.sortBy', { label: t('sort.discrepancy') }), icon: 'i-tabler-git-compare', keywords: 'model vs me disagree', run: sortBy('discrepancy') },
    { id: 'sort-created', section: 'sort', label: t('command.sortBy', { label: t('sort.created') }), icon: 'i-tabler-calendar-event', run: sortBy('created_at') },

    {
      id: 'view-left',
      section: 'view',
      label: t('pane.toggleLeft'),
      shortcut: shortcuts.global.toggleLeft.keys[0],
      icon: 'i-tabler-layout-sidebar-left-collapse',
      run: () => {
        leftPaneCollapsed.value = !leftPaneCollapsed.value
      },
    },
    {
      id: 'view-right',
      section: 'view',
      label: t('pane.toggleRight'),
      shortcut: shortcuts.global.toggleRight.keys[0],
      icon: 'i-tabler-layout-sidebar-right-collapse',
      run: () => {
        rightPaneCollapsed.value = !rightPaneCollapsed.value
      },
    },
    {
      id: 'view-nsfw',
      section: 'view',
      label: t('command.toggleNsfw'),
      icon: 'i-tabler-eye-off',
      run: () => {
        hideNSFW.value = !hideNSFW.value
      },
    },
    {
      id: 'help-shortcuts',
      section: 'help',
      label: t('command.shortcuts'),
      shortcut: shortcuts.global.openHelp.keys[0],
      icon: 'i-tabler-keyboard',
      keywords: 'keyboard help hotkeys',
      run: () => {
        shortcutHelpOpen.value = true
      },
    },
  ]
  if (isFiltered.value) {
    list.unshift(
      { id: 'filter-clear', section: 'filter', label: t('overview.clearAll'), icon: 'i-tabler-filter-off', keywords: 'reset filters', run: clearAll },
      { id: 'filter-reset', section: 'filter', label: t('command.resetAll'), icon: 'i-tabler-restore', keywords: 'reset sort filters', run: resetAll },
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

/**
 * Close first, run after: the focus trap returns focus to where the palette
 * was opened from (a microtask), and only then does the command act — so a
 * command that opens another layer (the shortcut sheet) remembers the page
 * element, not the palette's vanishing input, as its own focus-return target.
 */
function closeThen(run: () => void) {
  close()
  setTimeout(run, 0)
}

/**
 * The input is seeded with the live filter on open, so it IS the facet state:
 * applying writes every facet, including the ones whose terms were deleted
 * (removing a chip and applying must drop that filter).
 */
function applyQuery() {
  const p = parsed.value
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
  textSearchQuery.value = p.text
}

/** Writes new input text and puts the caret where the completion left it. */
function setQuery(text: string, nextCaret: number) {
  query.value = text
  caret.value = nextCaret
  nextTick(() => {
    const el = inputRef.value
    if (el) {
      el.focus()
      el.setSelectionRange(nextCaret, nextCaret)
    }
  })
}

// ── Tag suggestions ────────────────────────────────────────────────────────

const TAG_SUGGEST_LIMIT = 8
/** Candidates fetched per query (top-N by count) before re-ranking by match quality. */
const TAG_SUGGEST_FETCH = 40

const tagQuery = computed(() => tagSuggestQuery(currentSpan.value))
const debouncedTagQuery = refDebounced(tagQuery, 120)

/**
 * Counts are scoped like the gallery would be after applying: the live filter,
 * with the facets typed in the palette laid over it, minus tags (a tag's count
 * should say how many posts it would add, not be zeroed by the tags already
 * typed).
 */
const suggestScope = computed(() => {
  const p = parsed.value
  const base = { ...postFilter.value, tags: [] as string[] }
  if (!hasTerms.value) {
    return base
  }
  return {
    ...base,
    rating: p.rating,
    score: p.score,
    extension: p.extension,
    waifuScoreLevels: p.waifuScoreLevels,
    silvaScoreLevels: p.silvaScoreLevels,
    silvaLunaScoreLevels: p.silvaLunaScoreLevels,
  }
})

const tagSuggestQueryResult = useQuery({
  queryKey: queryKeys.tagSuggest(computed(() => ({
    q: debouncedTagQuery.value,
    filter: suggestScope.value,
    lang: resolvedLocale.value,
  }))),
  queryFn: async () => {
    const body: TagCountRequest = {
      ...suggestScope.value,
      query: debouncedTagQuery.value ?? '',
      limit: TAG_SUGGEST_FETCH,
      lang: resolvedLocale.value,
    }
    const resp = await v2GetTagCount({ body })
    return resp.data ?? []
  },
  enabled: computed(() => commandPaletteOpen.value && debouncedTagQuery.value !== null),
  placeholderData: keepPreviousData,
  staleTime: 30_000,
})

/** A newer query is in flight (the shown rows are filtered stale results). */
const tagsLoading = computed(() =>
  tagSuggestQueryResult.isFetching.value || debouncedTagQuery.value !== tagQuery.value,
)

function insertTag(span: TokenSpan, name: string, mode: 'enter' | 'tab' | 'apply') {
  const { text, caret: next } = replaceSpan(query.value, span, tagTerm(name))
  setQuery(text, next)
  announce(t('command.tagInserted', { tag: naturalizeTagName(name) }))
  if (mode === 'apply') {
    applyQuery()
    close()
  }
}

const tagRows = computed<Row[]>(() => {
  const span = currentSpan.value
  // Hide at once when the caret leaves a taggable term — don't wait for the
  // debounce or show stale results for a term that's no longer being typed.
  if (!span || tagQuery.value === null) {
    return []
  }
  const taken = new Set(parsed.value.tags)
  const candidates = (tagSuggestQueryResult.data.value ?? []).filter(d => !taken.has(d.tagName))
  return rankTagSuggestions(candidates, tagQuery.value, TAG_SUGGEST_LIMIT)
    .map(d => ({
      id: `tag:${d.tagName}`,
      section: 'tags' as const,
      icon: 'i-tabler-tag',
      label: naturalizeTagName(d.tagName),
      match: tagQuery.value ?? undefined,
      hint: d.translatedName ?? undefined,
      meta: formatNumber(d.count),
      kind: 'completion' as const,
      activate: (mode: 'enter' | 'tab' | 'apply') => insertTag(span, d.tagName, mode),
    }))
})

// ── Syntax completions ─────────────────────────────────────────────────────

const syntaxRows = computed<Row[]>(() => {
  const span = currentSpan.value
  if (!span) {
    return []
  }
  return syntaxCompletions(span).map(c => ({
    id: `syntax:${c.insert}`,
    section: 'syntax' as const,
    icon: c.complete ? 'i-tabler-filter' : 'i-tabler-code',
    label: c.insert,
    match: span.raw,
    hint: t(c.descKey),
    kind: 'completion' as const,
    activate: (mode: 'enter' | 'tab' | 'apply') => {
      if (!c.complete) {
        const { text, caret: next } = replaceSpanKeepTyping(query.value, span, c.insert)
        setQuery(text, next)
        return
      }
      const { text, caret: next } = replaceSpan(query.value, span, c.insert)
      setQuery(text, next)
      if (mode === 'apply') {
        applyQuery()
        close()
      }
    },
  }))
})

/** Empty input: list the filter keys so the syntax is discoverable at all. */
const syntaxIntroRows = computed<Row[]>(() => {
  if (query.value.trim() !== '') {
    return []
  }
  return FILTER_KEYS.map(k => ({
    id: `intro:${k.key}`,
    section: 'syntax' as const,
    icon: 'i-tabler-code',
    label: `${k.key}:`,
    hint: t(k.descKey),
    kind: 'completion' as const,
    activate: () => {
      const insert = `${k.key}:`
      const base = query.value.replace(/\s+$/, '')
      const text = base ? `${base} ${insert}` : insert
      setQuery(text, text.length)
    },
  }))
})

// ── Apply row ──────────────────────────────────────────────────────────────

/** The input no longer says what the gallery currently shows. */
const isDirty = computed(() => query.value.trim() !== seededQuery.value.trim())

const applyRow = computed<Row | null>(() => {
  if (!hasTerms.value && !promptText.value) {
    // Every term deleted from a filtered view: offer to clear.
    if (isDirty.value && seededQuery.value.trim() !== '') {
      return {
        id: '__apply',
        section: 'apply',
        icon: 'i-tabler-filter-off',
        label: t('command.applyClear'),
        kind: 'command',
        activate: () => closeThen(applyQuery),
      }
    }
    return null
  }
  const label = hasTerms.value
    ? (promptText.value
        ? t('command.applyFilterAndSearch', { query: promptText.value })
        : t('command.applyFilter'))
    : t('command.searchFor', { query: promptText.value })
  return {
    id: '__apply',
    section: 'apply',
    icon: hasTerms.value ? 'i-tabler-filter' : 'i-tabler-search',
    label,
    hint: hasTerms.value ? undefined : t('command.semanticHint'),
    kind: 'command',
    activate: () => closeThen(applyQuery),
  }
})

const commandRows = computed<Row[]>(() => matchedCommands.value.map(c => ({
  id: c.id,
  section: c.section,
  icon: c.icon,
  label: c.label,
  shortcut: c.shortcut,
  kind: 'command' as const,
  activate: () => closeThen(c.run),
})))

/**
 * Order follows intent. While a `key:` term is being typed, the completions
 * are what the user is after, so they lead; for a bare word the search /
 * apply row leads and the tag suggestions sit right under it.
 */
const rows = computed<Row[]>(() => {
  const apply = applyRow.value ? [applyRow.value] : []
  // Syntax first: a key prefix (`ra` → `rating:`) is a stronger signal than a
  // tag that merely contains the letters.
  const completions = [...syntaxRows.value, ...tagRows.value]
  const lead = currentSpan.value?.key == null
    ? [...apply, ...completions]
    : [...completions, ...apply]
  // Mid-way through a `key:` term the commands are noise — the user is
  // writing a filter, not looking for "Sort by…".
  const commandsShown = currentSpan.value?.key == null ? commandRows.value : []
  return [...lead, ...commandsShown, ...syntaxIntroRows.value]
})

interface RowSection {
  key: SectionKey
  labelId: string
  items: { row: Row, index: number }[]
}

const sections = computed<RowSection[]>(() => {
  const out: RowSection[] = []
  for (const [index, row] of rows.value.entries()) {
    const last = out.at(-1)
    if (last && last.key === row.section) {
      last.items.push({ row, index })
    }
    else {
      out.push({ key: row.section, labelId: `${uid}-sec-${row.section}-${out.length}`, items: [{ row, index }] })
    }
  }
  return out
})

// ── Active row (tracked by id so async suggestions don't move it) ─────────

const activeId = ref<string | null>(null)
const activeIndex = computed(() => {
  const i = rows.value.findIndex(r => r.id === activeId.value)
  return i === -1 ? 0 : i
})
const activeRow = computed(() => rows.value[activeIndex.value])
const activeDescendant = computed(() => (activeRow.value ? optionId(activeRow.value) : undefined))

function setActive(index: number) {
  activeId.value = rows.value[index]?.id ?? null
}

// Typing re-ranks the list: the most relevant row (the first) becomes active.
watch(query, () => {
  activeId.value = null
})

function scrollActiveIntoView() {
  nextTick(() => {
    listboxRef.value
      ?.querySelector(`[data-option-index="${activeIndex.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

// ── Chips: the understood terms, read back ────────────────────────────────

const KNOWN_KEYS = new Set(['tag', 't', 'rating', 'r', 'score', 'sc', 'ext', 'extension', ...FILTER_KEYS.map(k => k.key)])

interface Chip {
  span: TokenSpan
  label: string
  unknown: boolean
}

/** The term whose end the caret sits on is still being typed, not a finished filter. */
function isBeingTyped(s: TokenSpan): boolean {
  return currentSpan.value?.start === s.start && caret.value === s.end
}

const chips = computed<Chip[]>(() => {
  // parseFilterQuery reports unknown terms as tokenize() yields them: quotes stripped.
  const unknown = new Set(parsed.value.unknown)
  return tokenSpans(query.value)
    .filter(s => s.key !== null && s.value !== '' && !isBeingTyped(s))
    .map((s) => {
      const key = s.key!
      return {
        span: s,
        label: `${key}: ${key === 'tag' || key === 't' ? naturalizeTagName(s.value) : s.value}`,
        unknown: !KNOWN_KEYS.has(key) || unknown.has(s.raw.replaceAll(/["']/g, '')),
      }
    })
})

function removeChip(chip: Chip) {
  const text = removeSpan(query.value, chip.span)
  setQuery(text, Math.min(chip.span.start, text.length))
  announce(t('command.termRemoved', { term: chip.label }))
}

// ── Keys ───────────────────────────────────────────────────────────────────

function close() {
  closeCommandPalette()
}

function clearInput() {
  setQuery('', 0)
}

function onInput() {
  syncCaret()
}

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) {
    return
  }
  const next = listboxKeyIndex(e, {
    index: activeIndex.value,
    count: rows.value.length,
    inputEmpty: query.value === '',
  })
  if (next !== null) {
    e.preventDefault()
    setActive(next)
    scrollActiveIntoView()
    return
  }
  const noMods = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
  // Tab completes: the active row if it is a completion, else the first one.
  if (e.key === 'Tab' && noMods) {
    const row = activeRow.value?.kind === 'completion'
      ? activeRow.value
      : rows.value.find(r => r.id.startsWith('syntax:') || r.section === 'tags')
    if (row) {
      e.preventDefault()
      row.activate('tab')
    }
    return
  }
  if (e.key === 'Enter') {
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
    if (mod) {
      e.preventDefault()
      const row = activeRow.value
      if (row?.kind === 'completion') {
        row.activate('apply')
      }
      else {
        closeThen(applyQuery)
      }
      return
    }
    if (noMods) {
      e.preventDefault()
      activeRow.value?.activate('enter')
    }
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
  const tags = tagRows.value.length
  if (n === 0) {
    announce(t('command.noMatch'))
  }
  else if (tags > 0) {
    announce(t('command.resultCountWithTags', { n, tags }))
  }
  else {
    announce(t('command.resultCount', { n }, n))
  }
}, 600)
watch([query, () => tagRows.value.length], () => {
  if (commandPaletteOpen.value) {
    announceCount()
  }
})

// Opening seeds the input with the live filter so the palette reads as "here is
// what's applied", editable in place — not an empty box that silently discards
// the current state on submit.
watch(commandPaletteOpen, (open) => {
  if (open) {
    const seeded = stringifyFilterQuery(postFilter.value, textSearchQuery.value)
    // Trailing space: the caret starts on a fresh term, not inside the last one.
    query.value = seeded ? `${seeded} ` : ''
    seededQuery.value = query.value
    caret.value = query.value.length
    activeId.value = null
    // Caret at the end, not select-all: typing refines what's applied
    // (search within the filter); dropping a term is a deliberate act
    // (Backspace or its chip's ×), since applying writes every facet.
    nextTick(() => {
      const el = inputRef.value
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }
})

// ── Rendering helpers ──────────────────────────────────────────────────────

/** Splits `text` around the first case-insensitive occurrence of `needle`. */
function highlight(text: string, needle?: string): { text: string, hit: boolean }[] {
  const n = needle?.replace(/^[a-z]+:/i, '').replaceAll(/["']/g, '').replaceAll('_', ' ').trim()
  if (!n) {
    return [{ text, hit: false }]
  }
  const i = text.toLowerCase().indexOf(n.toLowerCase())
  if (i === -1) {
    return [{ text, hit: false }]
  }
  return [
    { text: text.slice(0, i), hit: false },
    { text: text.slice(i, i + n.length), hit: true },
    { text: text.slice(i + n.length), hit: false },
  ].filter(p => p.text)
}

const hintKeys = computed(() => [
  { keys: ['↑', '↓'], label: t('command.hintNavigate') },
  { keys: shortcutKeys('Enter'), label: activeRow.value?.kind === 'completion' ? t('command.hintInsert') : t('command.hintRun') },
  { keys: shortcutKeys('Tab'), label: t('command.hintComplete') },
  { keys: shortcutKeys('Mod+Enter'), label: t('command.hintApplyNow') },
])
</script>

<template>
  <Teleport to="body">
    <POverlay
      v-if="commandPaletteOpen"
      class="pt-[12vh] flex items-start justify-center"
    >
      <div
        ref="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('command.title')"
        class="border border-border-default rounded-lg bg-surface flex flex-col max-h-[72vh] max-w-[92vw] w-168 shadow-md overflow-hidden"
      >
        <!-- Input row -->
        <div class="px-4 flex shrink-0 gap-3 h-13 items-center">
          <i class="i-tabler-search text-lg text-fg-subtle shrink-0" aria-hidden="true" />
          <input
            ref="input"
            v-model="query"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            :aria-controls="listboxId"
            :aria-activedescendant="activeDescendant"
            :aria-describedby="hintsId"
            autocomplete="off"
            spellcheck="false"
            :placeholder="$t('command.placeholder')"
            :aria-label="$t('command.title')"
            class="text-base text-fg outline-none bg-transparent flex-grow min-w-0 placeholder:text-fg-subtle"
            @input="onInput"
            @keydown="onKeydown"
          >
          <button
            v-if="query"
            type="button"
            class="text-fg-subtle rounded flex shrink-0 h-6 w-6 transition-colors items-center justify-center hover:text-fg hover:bg-surface-2"
            :aria-label="$t('command.clearInput')"
            @click="clearInput"
          >
            <i class="i-tabler-x" aria-hidden="true" />
          </button>
          <kbd class="p-palette-kbd" aria-hidden="true">{{ formatShortcut('Esc') }}</kbd>
        </div>

        <!-- Understood terms, read back as chips (removable). Unknown terms are
             flagged: they fall through to search text, which a typo shouldn't
             do silently. -->
        <div
          v-if="chips.length > 0"
          class="px-4 pb-2.5 flex shrink-0 flex-wrap gap-1.5"
          role="group"
          :aria-label="$t('command.termsLabel')"
        >
          <button
            v-for="chip in chips"
            :key="`${chip.span.start}:${chip.span.raw}`"
            type="button"
            class="group/chip text-xs font-mono px-2 border rounded-full inline-flex gap-1 h-6 transition-colors items-center"
            :class="chip.unknown
              ? 'text-warning border-warning/40 hover:bg-warning/10'
              : 'text-fg-muted border-border-default hover:text-fg hover:bg-surface-2'"
            :title="chip.unknown ? $t('command.unknownTerm') : undefined"
            :aria-label="chip.unknown
              ? $t('command.removeUnknownTerm', { term: chip.label })
              : $t('command.removeTerm', { term: chip.label })"
            @click="removeChip(chip)"
          >
            <i v-if="chip.unknown" class="i-tabler-alert-triangle" aria-hidden="true" />
            <span>{{ chip.label }}</span>
            <i class="i-tabler-x opacity-50 group-hover/chip:opacity-100" aria-hidden="true" />
          </button>
        </div>

        <div class="border-t border-border-subtle" />

        <!-- mousedown.prevent: clicking a row must not pull focus out of the
             combobox input (rows are not focusable; the input owns the cursor). -->
        <div
          :id="listboxId"
          ref="listbox"
          role="listbox"
          :aria-label="$t('command.listLabel')"
          class="py-1.5 flex-grow overflow-y-auto"
          @mousedown.prevent
        >
          <div
            v-for="section in sections"
            :key="section.labelId"
            role="group"
            :aria-labelledby="section.labelId"
            class="pb-1"
          >
            <div
              :id="section.labelId"
              class="text-2xs text-fg-subtle tracking-wider font-semibold px-4 pb-1 pt-2 flex gap-1.5 uppercase items-center"
            >
              {{ $t(SECTION_LABEL_KEYS[section.key]) }}
              <i
                v-if="section.key === 'tags' && tagsLoading"
                class="i-tabler-loader-2 animate-spin"
                aria-hidden="true"
              />
            </div>
            <div
              v-for="{ row, index } in section.items"
              :id="optionId(row)"
              :key="row.id"
              role="option"
              :aria-selected="index === activeIndex"
              :data-option-index="index"
              class="text-sm mx-1.5 px-2.5 rounded-md flex gap-3 h-9 cursor-pointer items-center"
              :class="index === activeIndex ? 'bg-surface-2 text-fg' : 'text-fg-muted'"
              @click="row.activate('enter')"
              @mousemove="activeId = row.id"
            >
              <i
                :class="[row.icon, index === activeIndex ? 'text-fg' : 'text-fg-subtle']"
                class="shrink-0"
                aria-hidden="true"
              />
              <span
                class="flex-shrink truncate"
                :class="{ 'font-mono text-[0.8125rem]': row.section === 'syntax' }"
              >
                <template v-for="(part, i) in highlight(row.label, row.match)" :key="i">
                  <span v-if="part.hit" class="text-fg font-semibold">{{ part.text }}</span>
                  <template v-else>{{ part.text }}</template>
                </template>
              </span>
              <span
                v-if="row.hint"
                class="text-xs text-fg-subtle flex-shrink-[2] min-w-0 truncate"
              >
                <template v-for="(part, i) in highlight(row.hint, row.section === 'tags' ? row.match : undefined)" :key="i">
                  <span v-if="part.hit" class="text-fg-muted font-semibold">{{ part.text }}</span>
                  <template v-else>{{ part.text }}</template>
                </template>
              </span>
              <span class="flex-grow" />
              <span
                v-if="row.meta"
                class="text-xs text-fg-subtle font-mono shrink-0 tabular-nums"
              >{{ row.meta }}</span>
              <kbd
                v-if="row.shortcut"
                class="p-palette-kbd"
              >{{ formatShortcut(row.shortcut) }}</kbd>
              <i
                v-if="row.kind === 'completion' && index === activeIndex"
                class="i-tabler-corner-down-left text-fg-subtle shrink-0"
                aria-hidden="true"
              />
            </div>
          </div>
          <div
            v-if="rows.length === 0"
            class="text-sm text-fg-subtle px-4 py-8 text-center"
          >
            {{ $t('command.noMatch') }}
          </div>
        </div>

        <!-- Key hints. Also the input's description, so screen readers hear
             the keyboard model once. -->
        <div
          :id="hintsId"
          class="text-xs text-fg-subtle px-4 py-2 border-t border-border-subtle flex shrink-0 flex-wrap gap-x-4 gap-y-1"
        >
          <span
            v-for="hint in hintKeys"
            :key="hint.label"
            class="inline-flex gap-1.5 items-center"
          >
            <span class="inline-flex gap-0.5" aria-hidden="true">
              <kbd v-for="k in hint.keys" :key="k" class="p-palette-kbd">{{ k }}</kbd>
            </span>
            <span>{{ hint.label }}</span>
          </span>
        </div>
      </div>
    </POverlay>
  </Teleport>
</template>

<style scoped>
.p-palette-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.3rem;
  flex-shrink: 0;
  border: 1px solid var(--p-border-subtle);
  border-radius: var(--p-radius-sm);
  font-family: var(--p-font-mono);
  font-size: var(--p-text-2xs);
  color: var(--p-fg-subtle);
  line-height: 1;
}
</style>
