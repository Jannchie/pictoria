<script setup lang="ts">
import type { DirectorySummary } from '@/api'
import { refDebounced } from '@vueuse/core'
import { computed, nextTick, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { formatNumber } from '@/locale'
import { useCurrentFolder, useFoldersQuery } from '@/shared'
import { PInput } from '@/ui'
import { childrenOf, filterSubfolders, previewSubfolders, SUBFOLDER_PREVIEW } from '@/utils/subfolders'

const route = useRoute()
const currentFolder = useCurrentFolder()
const foldersQuery = useFoldersQuery()

// /random and /recently resolve to the root folder too, but they are views
// over the whole library, not a place in the tree — no sub-folder shortcuts.
const isFolderView = computed(() => route.path !== '/random' && route.path !== '/recently')

// shallowRef + explicit watch: the folder tree can hold tens of thousands of
// nodes; deep reactivity over it is pure overhead for a read-only lookup.
const children = shallowRef<DirectorySummary[]>([])
watch([() => foldersQuery.data.value, currentFolder, isFolderView], ([root, folder, show]) => {
  children.value = show ? childrenOf(root as DirectorySummary | undefined, folder) : []
}, { immediate: true })

/**
 * A folder can have ~25k direct children (one per artist). Rendering them all
 * as links froze the page for 20 s and made every scroll frame ~200 ms, so:
 * collapsed = a short preview (the biggest ones when there are many);
 * expanded = a filter box plus a capped, scrolling result list.
 */
const expanded = ref(false)
const filter = ref('')
const debouncedFilter = refDebounced(filter, 80)
watch(currentFolder, () => {
  expanded.value = false
  filter.value = ''
})

const overflow = computed(() => Math.max(0, children.value.length - SUBFOLDER_PREVIEW))
const preview = computed(() => previewSubfolders(children.value))
const results = computed(() => filterSubfolders(children.value, debouncedFilter.value))
const shown = computed(() => (expanded.value ? results.value.items : preview.value))

const panelId = useId()
const filterBox = useTemplateRef<InstanceType<typeof PInput>>('filterBox')
const toggleButton = useTemplateRef<HTMLButtonElement>('toggleButton')

function toggle() {
  expanded.value = !expanded.value
  if (expanded.value) {
    nextTick(() => filterBox.value?.focus())
  }
  else {
    filter.value = ''
    nextTick(() => toggleButton.value?.focus())
  }
}

function collapseFromFilter(e: KeyboardEvent) {
  if (e.key === 'Escape' && !e.isComposing) {
    // Local Escape: the filter is not a layer, so stop it before the grid's
    // clear-selection hotkey sees it.
    e.preventDefault()
    e.stopPropagation()
    expanded.value = false
    filter.value = ''
    nextTick(() => toggleButton.value?.focus())
  }
}
</script>

<template>
  <!-- Sub-folder shortcuts above the grid: text rows with a folder glyph, no
       card chrome — they are navigation, and must not compete with the
       thumbnails directly below. -->
  <nav
    v-if="children.length > 0"
    :aria-label="$t('sidebar.subfolders')"
    class="px-3 pb-1 pt-2 flex shrink-0 flex-col gap-1.5"
  >
    <div
      v-if="expanded"
      class="flex gap-2 items-center"
    >
      <PInput
        ref="filterBox"
        v-model="filter"
        size="sm"
        class="max-w-72"
        :placeholder="$t('sidebar.subfoldersFilter', { n: formatNumber(children.length) })"
        :aria-label="$t('sidebar.subfoldersFilter', { n: formatNumber(children.length) })"
        :aria-controls="panelId"
        @keydown="collapseFromFilter"
      >
        <template #leftSection>
          <i class="i-tabler-filter" />
        </template>
      </PInput>
      <button
        ref="toggleButton"
        type="button"
        class="text-xs text-fg-subtle px-2 py-1 rounded-md flex shrink-0 gap-1 transition-colors items-center hover:text-fg hover:bg-surface-1"
        :aria-expanded="true"
        :aria-controls="panelId"
        @pointerdown.stop
        @click="toggle"
      >
        <i class="i-tabler-chevron-up" aria-hidden="true" />
        {{ $t('sidebar.subfoldersLess') }}
      </button>
      <span class="text-xs text-fg-subtle truncate" role="status">
        {{ results.total > results.items.length
          ? $t('sidebar.subfoldersTruncated', { shown: formatNumber(results.items.length), total: formatNumber(results.total) })
          : $t('sidebar.subfoldersMatches', { n: formatNumber(results.total) }, results.total) }}
      </span>
    </div>
    <div
      :id="panelId"
      class="flex flex-wrap gap-x-1 gap-y-0.5"
      :class="{ 'max-h-64 overflow-y-auto': expanded }"
    >
      <RouterLink
        v-for="f in shown"
        :key="f.path"
        class="text-xs text-fg-muted px-2 py-1 border border-border-subtle rounded-md flex gap-1.5 max-w-56 min-w-0 truncate transition-colors items-center hover:text-fg hover:border-border-default hover:bg-surface-1"
        :to="{ path: `/dir/${f.path}`, query: $route.query }"
        :title="$t('sidebar.subfolderTitle', { name: f.name, n: formatNumber(f.fileCount) }, f.fileCount)"
        @pointerdown.stop
      >
        <i class="i-tabler-folder text-fg-subtle shrink-0" aria-hidden="true" />
        <span class="truncate">
          {{ f.name }}
        </span>
      </RouterLink>
      <button
        v-if="overflow > 0 && !expanded"
        ref="toggleButton"
        type="button"
        class="text-xs text-fg-subtle px-2 py-1 rounded-md flex gap-1 transition-colors items-center hover:text-fg hover:bg-surface-1"
        :aria-expanded="false"
        :aria-controls="panelId"
        @pointerdown.stop
        @click="toggle"
      >
        <i class="i-tabler-dots" aria-hidden="true" />
        {{ $t('sidebar.subfoldersMore', { n: formatNumber(overflow) }) }}
      </button>
    </div>
  </nav>
</template>
