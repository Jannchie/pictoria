<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { useDebounce } from '@vueuse/core'
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAPIError } from '@/composables/useAPIError'
import { useTagCatalogueQuery } from '@/composables/useTagCatalogueQuery'
import { useTagSearchIndex } from '@/composables/useTagSearchIndex'
import { formatNumber } from '@/locale'
import { announce, commitTagMany } from '@/shared'
import { naturalizeTagName } from '@/utils'
import { idFragment, listboxKeyIndex } from '@/utils/listboxNav'
import { tagLabel } from '@/utils/tagName'

/**
 * "Add tag…" for a multi-selection: one tag onto every selected post.
 *
 * Deliberately not the TagSelector window: that editor is built around ONE
 * post (its list is split into the post's current tags vs. the rest, and every
 * row toggles on that post), which has no meaning for a set whose posts carry
 * different tags. This is the minimal batch entry: search the tag catalogue
 * (the same cached list TagSelector uses), pick one or type a new name, and it
 * is added to each post through the same per-post endpoint — one undo entry
 * covering only the posts that didn't already have it (commitTagMany).
 *
 * Keyboard: the input is an APG combobox with the shared listbox keys
 * (listboxKeyIndex: ↑↓, PageUp/Down, Ctrl+Home/End, Home/End while empty);
 * Enter adds the active option, Escape closes the popover.
 */
const props = defineProps<{
  ids: number[]
}>()

const { t } = useI18n()
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()

const open = ref(false)
const search = ref('')
const debounced = useDebounce(search, 100)
const busy = ref(false)
const listId = useId()
const activeIndex = ref(0)

const tagsQuery = useTagCatalogueQuery({ enabled: open, staleTime: Infinity })
// Shared with TagSelector (same cached catalogue array → same index).
const index = useTagSearchIndex(() => tagsQuery.data.value ?? [])

const LIMIT = 30
interface Option { id: string, name: string, label: string, isNew: boolean }
type Tag = NonNullable<typeof tagsQuery.data.value>[number]

/** Rank: exact name or translation 0, name prefix 1, any other match 2. */
function rankOf(hay: string, q: string): number {
  if (hay.startsWith(`${q}|`) || hay.endsWith(`|${q}`)) {
    return 0
  }
  return hay.startsWith(q) ? 1 : 2
}

const options = computed<Option[]>(() => {
  const name = debounced.value.trim()
  const q = name.toLowerCase()
  // Nothing to match until the catalogue is in — and offering "create <typed>"
  // then would mint a duplicate of a tag that does exist (typed by its
  // translated name, say).
  if (!q || !tagsQuery.data.value) {
    return []
  }
  // The best LIMIT by (rank, most used) without sorting every match: a short
  // sorted list that a candidate only enters if it beats the current last.
  const top: { tag: Tag, rank: number }[] = []
  const worse = (a: { tag: Tag, rank: number }, b: { tag: Tag, rank: number }) => a.rank - b.rank || b.tag.count - a.tag.count
  for (const [tag, hay] of index.value.entries) {
    if (!hay.includes(q)) {
      continue
    }
    const cand = { tag, rank: rankOf(hay, q) }
    if (top.length === LIMIT && worse(cand, top[LIMIT - 1]) >= 0) {
      continue
    }
    let i = top.length
    while (i > 0 && worse(cand, top[i - 1]) < 0) {
      i--
    }
    top.splice(i, 0, cand)
    if (top.length > LIMIT) {
      top.pop()
    }
  }
  const out: Option[] = top.map(({ tag }) => ({
    id: `${listId}-${idFragment(tag.name)}`,
    name: tag.name,
    label: tagLabel(tag.name, tag.translatedName),
    isNew: false,
  }))
  // New-tag rule as TagSelector's: the trimmed text, offered when it isn't
  // already a tag name.
  if (!index.value.names.has(name)) {
    out.push({ id: `${listId}-new`, name, label: t('batchTag.addNew', { name }), isNew: true })
  }
  return out
})

watch(options, () => {
  activeIndex.value = 0
})
watch(open, (v) => {
  if (!v) {
    search.value = ''
  }
})

const activeId = computed(() => options.value[activeIndex.value]?.id)
// Keep the active row visible while moving through a scrolled list.
watch(activeId, async (id) => {
  if (!id) {
    return
  }
  await nextTick()
  document.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'nearest' })
})

async function add(option: Option | undefined) {
  if (!option || busy.value || props.ids.length === 0) {
    return
  }
  busy.value = true
  try {
    const { done, already } = await commitTagMany(queryClient, [...props.ids], option.name)
    announce(t('batchTag.done', { tag: naturalizeTagName(option.name), added: formatNumber(done.length), already: formatNumber(already.length) }))
    open.value = false
  }
  catch (error) {
    handleAPIError(error, t('batchTag.failed'))
  }
  finally {
    busy.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  const next = listboxKeyIndex(e, { index: activeIndex.value, count: options.value.length, inputEmpty: search.value === '' })
  if (next !== null) {
    e.preventDefault()
    activeIndex.value = next
    return
  }
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    // Not while the list still shows the previous query (debounce pending):
    // Enter would act on a stale row.
    if (search.value === debounced.value) {
      void add(options.value[activeIndex.value])
    }
  }
}
</script>

<template>
  <PPopover
    v-model="open"
    position="bottom-start"
    :aria-label="$t('batchTag.title', { n: formatNumber(ids.length) }, ids.length)"
  >
    <PButton
      size="sm"
      variant="subtle"
      block
      :disabled="ids.length === 0"
    >
      <i class="i-tabler-tag" aria-hidden="true" />
      {{ $t('batchTag.button') }}
    </PButton>
    <template #content>
      <div class="p-popover-panel flex flex-col gap-1 w-64">
        <div class="text-xs text-fg-subtle px-1">
          {{ $t('batchTag.title', { n: formatNumber(ids.length) }, ids.length) }}
        </div>
        <PInput
          v-model="search"
          size="sm"

          data-autofocus block
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="options.length > 0"
          :aria-controls="listId"
          :aria-activedescendant="activeId"
          :aria-label="$t('batchTag.searchLabel')"
          :placeholder="$t('batchTag.placeholder')"
          :disabled="busy"
          @keydown="onKeydown"
        />
        <div
          :id="listId"
          role="listbox"
          :aria-label="$t('batchTag.listLabel')"
          class="flex flex-col max-h-60 overflow-y-auto"
        >
          <div
            v-for="(option, i) in options"
            :id="option.id"
            :key="option.id"
            role="option"
            :aria-selected="i === activeIndex"
            class="text-xs px-2 py-1 rounded flex gap-1.5 cursor-pointer items-center"
            :class="i === activeIndex ? 'bg-surface-2 text-fg' : 'text-fg-muted'"
            @pointermove="activeIndex = i"
            @mousedown.prevent
            @click="add(option)"
          >
            <i :class="option.isNew ? 'i-tabler-plus' : 'i-tabler-tag'" class="text-fg-subtle shrink-0" aria-hidden="true" />
            <span class="truncate">{{ option.label }}</span>
          </div>
        </div>
        <div
          v-if="tagsQuery.isError.value"
          class="text-xs text-danger px-1 flex gap-1.5 items-center"
          role="alert"
        >
          <i class="i-tabler-alert-circle" aria-hidden="true" />
          {{ $t('batchTag.loadFailed') }}
        </div>
        <div
          v-else-if="tagsQuery.isPending.value && search"
          class="text-xs text-fg-subtle px-1 flex gap-1.5 items-center"
          role="status"
        >
          <i class="i-tabler-loader animate-spin" aria-hidden="true" />
          {{ $t('batchTag.loadingTags') }}
        </div>
        <div
          v-else-if="busy"
          class="text-xs text-fg-subtle px-1 flex gap-1.5 items-center"
          role="status"
        >
          <i class="i-tabler-loader animate-spin" aria-hidden="true" />
          {{ $t('batchTag.adding') }}
        </div>
        <div
          v-else-if="!search.trim()"
          class="text-xs text-fg-subtle px-1"
        >
          {{ $t('batchTag.hint') }}
        </div>
      </div>
    </template>
  </PPopover>
</template>
