<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { controlledComputed, useDebounce } from '@vueuse/core'
import { computed, inject, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2ListTagGroup, v2ListTags } from '@/api'
import { useRovingFocus } from '@/composables/useRovingFocus'
import { resolvedLocale } from '@/locale'
import { announce, commitTag } from '@/shared'
import { queryKeys } from '@/shared/queryKeys'
import { naturalizeTagName } from '@/utils'
import { matchesShortcut, shortcutKeys } from '@/utils/keyboard'
import { idFragment, listboxKeyIndex } from '@/utils/listboxNav'
import { usePostQuery } from '../composables/usePostQuery'

/**
 * Tag editor for one post. Keyboard model (all handled on this component's
 * root — nothing listens on window, nothing steals focus):
 *
 * - Search input = APG combobox; the tag list = listbox (multi-select: an
 *   option is "selected" when the tag is on the post). DOM focus stays in the
 *   input, the cursor is `aria-activedescendant`. ↑↓ wrap, PageUp/PageDown,
 *   Ctrl+Home/End (bare Home/End only while the input is empty), Enter
 *   (IME-safe) toggles the active tag / adds the typed one.
 * - Mod+↓ / Mod+↑ in the input: next / previous tag group.
 * - Group column = tablist (roving tabindex, arrows, automatic activation).
 * - Tab moves between input → pin → groups normally; Escape is the window's
 *   (layer stack), not ours.
 */
const props = defineProps<{
  postId?: number
}>()

const { t } = useI18n()

const GROUP_NEXT = 'Mod+ArrowDown'
const GROUP_PREV = 'Mod+ArrowUp'

const postId = computed(() => props.postId)
const search = ref('')
const postQuery = usePostQuery(postId)
const tagGroupsQuery = useQuery({
  queryKey: queryKeys.tagGroups(),
  queryFn: async () => {
    const resp = await v2ListTagGroup({})
    return resp.data
  },
})

const tagGroups = computed(() => {
  return tagGroupsQuery.data.value
})

const tagsQuery = useQuery({
  // Shares the Tags page cache; locale folded into queryKeys.tags so a
  // language switch refetches the server-side translated names.
  queryKey: queryKeys.tags(),
  queryFn: async () => {
    const resp = await v2ListTags({ query: { lang: resolvedLocale.value } })
    return resp.data ?? []
  },
  staleTime: Infinity,
})

const tags = computed(() => {
  return tagsQuery.data.value ?? []
})

const finalTagGroups = computed(() => {
  return [
    {
      name: t('tagSelector.all'),
      id: undefined,
    },
    ...(tagGroups.value ?? []),
    {
      name: t('tagSelector.ungrouped'),
      id: null,
    },
  ] as { name: string, id: number | null | undefined }[]
})

const currentGroupId = ref<number | null | undefined>()
const currentGroupIndex = computed(() => Math.max(0, finalTagGroups.value.findIndex(group => group.id === currentGroupId.value)))

const currentTags = computed(() => {
  const tags = postQuery.data.value?.tags ?? []
  if (currentGroupId.value === undefined) {
    return tags
  }
  return tags.filter(tag => tag.tagInfo.group?.id === currentGroupId.value)
})

// 快照「进来时这个 post 已有哪些 tag」，让勾选/取消不会让行在两个分区之间跳。
// **不依赖 search**：搜索只是视图上的过滤，重算快照会连带把下面整棵列表推翻，
// 那正是每敲一个字就卡一下的原因。
const initCurrentTags = controlledComputed(() => [currentGroupId.value, postId.value, postQuery.isFetched.value], () => {
  return currentTags.value
})

const initCurrentTagNames = computed(() => new Set(initCurrentTags.value.map(tag => tag.tagInfo.name)))
// 行的勾选态每渲染一行查一次；库里 tag 上万时线性 some() 是平方级开销。
const currentTagNames = computed(() => new Set(currentTags.value.map(tag => tag.tagInfo.name)))

/** 只在 tag 表变化时算一次的小写检索串：每次按键重新 toLowerCase 全库太贵。 */
const searchHaystack = computed(() => {
  const map = new Map<string, string>()
  for (const tag of tags.value) {
    // `|` 只是防止跨字段误匹配的分隔符：tag 名是下划线英文，译名是中日文，都不含它。
    map.set(tag.name, `${tag.name}|${tag.translatedName ?? ''}`.toLowerCase())
  }
  return map
})

// 输入即时回显，过滤走防抖：连打时中间态不值得各跑一遍全库扫描。
const debouncedSearch = useDebounce(search, 120)

const DISPLAY_LIMIT = 100

/**
 * 分组过滤 + 排除已选 + 搜索匹配，一次遍历做完，顺带数出命中总数。
 *
 * 之前这里是三个链式 computed 加模板里再来一次 `filter().length`，同一份上万行
 * 的 tag 表每次按键要走四遍。
 */
const groupMatches = computed(() => {
  const q = debouncedSearch.value.toLowerCase()
  const excluded = initCurrentTagNames.value
  const haystack = searchHaystack.value
  const gid = currentGroupId.value
  const list: typeof tags.value = []
  let total = 0
  for (const tag of tags.value) {
    if (gid !== undefined && tag.group?.id !== gid) {
      continue
    }
    if (excluded.has(tag.name)) {
      continue
    }
    if (q && !haystack.get(tag.name)?.includes(q)) {
      continue
    }
    total++
    if (list.length < DISPLAY_LIMIT) {
      list.push(tag)
    }
  }
  return { list, total }
})

// 同时匹配原始下划线名与本地化显示名（忽略大小写），中文输入也能搜到 tag。
function isSearchMatch(tag: { name: string, translatedName?: string | null }) {
  if (!debouncedSearch.value) {
    return true
  }
  const q = debouncedSearch.value.toLowerCase()
  return tag.name.toLowerCase().includes(q) || !!tag.translatedName?.toLowerCase().includes(q)
}

const queryClient = useQueryClient()
async function toggleTag(tagName: string) {
  if (!postId.value) {
    return
  }
  const isOn = currentTagNames.value.has(tagName)
  // 已在 post 上 → 移除（add=false）；否则 → 添加（add=true）
  await commitTag(queryClient, postId.value, tagName, !isOn)
  announce(t(isOn ? 'tagSelector.tagRemoved' : 'tagSelector.tagAdded', { name: naturalizeTagName(tagName) }))
}
const pinned = inject('pinned', ref(false))

async function addTag(tagName: string) {
  if (!postId.value) {
    return
  }
  await commitTag(queryClient, postId.value, tagName, true)
  announce(t('tagSelector.tagAdded', { name: naturalizeTagName(tagName) }))
}

const showAddTag = computed(() => {
  return search.value !== '' && !searchHaystack.value.has(search.value)
})

// 行文本：自然英文名为主（去下划线兜底），有翻译时附在后面。
// 搜索 / 提交仍用原始下划线名。
function tagLabel(name: string, translated: string | null | undefined): string {
  const natural = naturalizeTagName(name)
  return translated ? `${natural}（${translated}）` : natural
}

const searchingInitCurrentTags = computed(() => {
  return initCurrentTags.value.filter(tag => isSearchMatch(tag.tagInfo))
})

// ---- listbox model -------------------------------------------------------

const uid = useId()
const listboxId = `${uid}-listbox`
const panelId = `${uid}-panel`
const currentHeaderId = `${uid}-current`
const allHeaderId = `${uid}-all`
function tabId(index: number) {
  return `${uid}-tab-${index}`
}

interface TagOption {
  /** Stable element id — derived from the tag name, not the row index. */
  id: string
  kind: 'add' | 'current' | 'group'
  tagName: string
  label: string
}

/**
 * The flat, render-ordered option list the keyboard walks. A tag appears at
 * most once (the "all" section excludes the snapshot of current tags), so the
 * tag name is a stable id.
 */
const options = computed<TagOption[]>(() => {
  const out: TagOption[] = []
  if (showAddTag.value) {
    out.push({ id: `${uid}-add`, kind: 'add', tagName: search.value, label: t('tagSelector.addNew', { name: search.value }) })
  }
  for (const tag of searchingInitCurrentTags.value) {
    out.push({ id: `${uid}-t-${idFragment(tag.tagInfo.name)}`, kind: 'current', tagName: tag.tagInfo.name, label: tagLabel(tag.tagInfo.name, tag.tagInfo.translatedName) })
  }
  for (const tag of groupMatches.value.list) {
    out.push({ id: `${uid}-t-${idFragment(tag.name)}`, kind: 'group', tagName: tag.name, label: tagLabel(tag.name, tag.translatedName) })
  }
  return out
})
const addOption = computed(() => options.value.find(o => o.kind === 'add'))
const currentOptions = computed(() => options.value.filter(o => o.kind === 'current'))
const groupOptions = computed(() => options.value.filter(o => o.kind === 'group'))
const optionIndex = computed(() => new Map(options.value.map((o, i) => [o.id, i])))

const activeIndex = ref(-1)
const activeOption = computed(() => options.value[activeIndex.value])

// A new search puts the cursor on the best row (the "add" row when the text is
// new, else the first match). An empty search leaves nothing active so a stray
// Enter doesn't toggle an arbitrary tag.
watch([debouncedSearch, showAddTag], () => {
  activeIndex.value = search.value && options.value.length > 0 ? 0 : -1
})
watch(options, (list) => {
  if (activeIndex.value >= list.length) {
    activeIndex.value = list.length - 1
  }
})

const listboxRef = useTemplateRef<HTMLElement>('listbox')
function scrollActiveIntoView() {
  nextTick(() => {
    const id = activeOption.value?.id
    if (id) {
      listboxRef.value?.querySelector(`[id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  })
}

function activate(option: TagOption | undefined) {
  if (!option) {
    return
  }
  if (option.kind === 'add') {
    addTag(option.tagName)
  }
  else {
    toggleTag(option.tagName)
  }
}

function onOptionClick(option: TagOption) {
  activeIndex.value = optionIndex.value.get(option.id) ?? -1
  activate(option)
}

function selectGroupAt(index: number) {
  const groups = finalTagGroups.value
  const next = groups[(index + groups.length) % groups.length]
  currentGroupId.value = next?.id
}

function onRootKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) {
    return
  }
  const target = e.target as HTMLElement | null
  if (!target?.matches('[data-tag-search]')) {
    return
  }
  if (matchesShortcut(e, GROUP_NEXT) || matchesShortcut(e, GROUP_PREV)) {
    e.preventDefault()
    selectGroupAt(currentGroupIndex.value + (matchesShortcut(e, GROUP_NEXT) ? 1 : -1))
    announce(t('tagSelector.groupSwitched', { name: finalTagGroups.value[currentGroupIndex.value]?.name ?? '' }))
    return
  }
  const next = listboxKeyIndex(e, {
    index: activeIndex.value,
    count: options.value.length,
    inputEmpty: search.value === '',
  })
  if (next !== null) {
    e.preventDefault()
    activeIndex.value = next
    scrollActiveIntoView()
    return
  }
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229
    && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault()
    activate(activeOption.value)
  }
}

// Group column: one Tab stop, arrows move and select (automatic activation).
const tablistRef = useTemplateRef<HTMLElement>('tablist')
useRovingFocus({
  container: tablistRef,
  itemSelector: '[role=tab]',
  orientation: 'both',
  typeahead: true,
  onMove: (_el, index) => selectGroupAt(index),
})
</script>

<template>
  <div
    v-if="!postQuery.data.value"
    class="text-sm text-fg border border-border-default rounded bg-bg flex flex-col h-96 max-h-96 max-w-96 w-96 shadow-md relative"
  >
    <div class="text-fg-muted flex flex-grow flex-col h-full w-full items-center justify-center">
      <i class="i-tabler-tag text-2xl p-4" aria-hidden="true" />
      <span class="text-xs mt-2">
        {{ $t('tagSelector.noPostSelected') }}
      </span>
    </div>
  </div>
  <div
    v-else
    class="text-sm text-fg border border-border-default rounded bg-bg flex flex-col h-96 max-h-96 max-w-96 w-96 shadow-md"
    @keydown="onRootKeydown"
  >
    <!-- The search row is the panel's own top edge: one border-b divides it
         from the list, and the field carries no frame or focus highlight of
         its own. Same shape as the command palette. It doubles as the
         window's drag handle (PFloatWindow drags from [data-drag-handle]). -->
    <div
      class="px-3 border-b border-border-default flex shrink-0 gap-2 h-10 items-center"
      data-drag-handle
    >
      <i class="i-tabler-search text-fg-subtle shrink-0" aria-hidden="true" />
      <PInput
        v-model="search"
        variant="plain"
        size="sm"
        class="!px-0"
        :placeholder="$t('tagSelector.searchPlaceholder')"
        :aria-label="$t('tagSelector.searchLabel')"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        :aria-controls="listboxId"
        :aria-activedescendant="activeOption?.id"
        autocomplete="off"
        :spellcheck="false"
        data-tag-search
        data-autofocus
        block
      />
      <PButton
        icon
        size="sm"
        variant="ghost"
        :active="pinned"
        :aria-pressed="pinned"
        :aria-label="$t('tagSelector.pinWindow')"
        :title="$t('tagSelector.pinWindow')"
        class="shrink-0 -mr-1.5"
        @click="pinned = !pinned"
      >
        <i :class="pinned ? 'i-tabler-pin-filled text-primary' : 'i-tabler-pin'" aria-hidden="true" />
      </PButton>
    </div>
    <div class="flex flex-grow overflow-auto">
      <div
        ref="tablist"
        role="tablist"
        aria-orientation="vertical"
        :aria-label="$t('tagSelector.groupsLabel')"
        class="p-1 border-r border-border-default flex flex-shrink-0 flex-col w-32"
      >
        <button
          v-for="group, i in finalTagGroups"
          :id="tabId(i)"
          :key="group.id ?? String(group.id)"
          type="button"
          role="tab"
          :aria-selected="i === currentGroupIndex"
          :aria-controls="panelId"
          class="px-2.5 text-left rounded flex gap-2 min-h-7 w-full cursor-pointer transition-colors items-center"
          :class="i === currentGroupIndex
            ? 'text-fg bg-primary/10 font-medium hover:bg-primary/15'
            : 'text-fg-muted hover:text-fg hover:bg-surface-1'"
          @click="selectGroupAt(i)"
        >
          <i
            class="i-tabler-bookmark flex-shrink-0 h-4 w-4"
            :class="i === currentGroupIndex ? 'text-primary' : 'text-fg-subtle'"
            aria-hidden="true"
          />
          <span class="flex-grow truncate">{{ group.name }}</span>
        </button>
      </div>
      <PScrollArea
        :id="panelId"
        role="tabpanel"
        :aria-labelledby="tabId(currentGroupIndex)"
        class="flex-grow"
      >
        <!-- mousedown.prevent: rows are not focusable; a click must leave focus
             where it was (normally the search input that owns the cursor). -->
        <div
          :id="listboxId"
          ref="listbox"
          role="listbox"
          aria-multiselectable="true"
          :aria-label="$t('tagSelector.listLabel')"
          @mousedown.prevent
        >
          <div
            v-if="addOption"
            class="border-b border-border-default"
          >
            <div
              :id="addOption.id"
              role="option"
              aria-selected="false"
              class="px-2.5 rounded flex gap-2 min-h-7 w-full cursor-pointer transition-colors items-center"
              :class="activeOption?.id === addOption.id ? 'text-fg bg-surface-2' : 'text-fg-muted hover:bg-surface-1'"
              @click="onOptionClick(addOption)"
              @pointermove="activeIndex = optionIndex.get(addOption.id) ?? -1"
            >
              <i class="i-tabler-plus text-fg-subtle flex-shrink-0 h-4 w-4" aria-hidden="true" />
              <span class="flex-grow truncate">{{ addOption.label }}</span>
            </div>
          </div>
          <div
            v-if="currentOptions.length > 0"
            role="group"
            :aria-labelledby="currentHeaderId"
            class="border-b border-border-default"
          >
            <div
              :id="currentHeaderId"
              class="text-xs text-fg-subtle tracking-wider font-medium px-3 py-1.5 uppercase"
            >
              {{ $t('tagSelector.alreadySelected') }} · {{ currentOptions.length }}
            </div>
            <div
              v-for="option in currentOptions"
              :id="option.id"
              :key="option.id"
              role="option"
              :aria-selected="currentTagNames.has(option.tagName)"
              :data-tag-name="option.tagName"
              class="px-2.5 rounded flex gap-2 min-h-7 w-full cursor-pointer transition-colors items-center"
              :class="activeOption?.id === option.id ? 'text-fg bg-surface-2' : 'text-fg-muted hover:bg-surface-1'"
              @click="onOptionClick(option)"
              @pointermove="activeIndex = optionIndex.get(option.id) ?? -1"
            >
              <span
                class="tag-check"
                :class="{ 'tag-check--on': currentTagNames.has(option.tagName) }"
                aria-hidden="true"
              >
                <i v-if="currentTagNames.has(option.tagName)" class="i-tabler-check h-3 w-3 block" />
              </span>
              <span v-highlight="debouncedSearch" class="flex-grow truncate">{{ option.label }}</span>
            </div>
          </div>
          <div
            role="group"
            :aria-labelledby="allHeaderId"
          >
            <div
              :id="allHeaderId"
              class="text-xs text-fg-subtle tracking-wider font-medium px-3 py-1.5 uppercase"
            >
              {{ $t('tagSelector.all') }} · {{ groupMatches.total }}
            </div>
            <div
              v-for="option in groupOptions"
              :id="option.id"
              :key="option.id"
              role="option"
              :aria-selected="currentTagNames.has(option.tagName)"
              :data-tag-name="option.tagName"
              class="px-2.5 rounded flex gap-2 min-h-7 w-full cursor-pointer transition-colors items-center"
              :class="activeOption?.id === option.id ? 'text-fg bg-surface-2' : 'text-fg-muted hover:bg-surface-1'"
              @click="onOptionClick(option)"
              @pointermove="activeIndex = optionIndex.get(option.id) ?? -1"
            >
              <span
                class="tag-check"
                :class="{ 'tag-check--on': currentTagNames.has(option.tagName) }"
                aria-hidden="true"
              >
                <i v-if="currentTagNames.has(option.tagName)" class="i-tabler-check h-3 w-3 block" />
              </span>
              <span v-highlight="debouncedSearch" class="flex-grow truncate">{{ option.label }}</span>
            </div>
          </div>
        </div>
        <div
          v-if="groupMatches.total > DISPLAY_LIMIT"
          class="text-xs p-1 text-center op50"
        >
          {{ $t('tagSelector.onlyTop') }}
        </div>
      </PScrollArea>
    </div>
    <div
      class="text-xs text-fg-muted px-3 py-2 border-t border-border-default flex flex-wrap gap-x-3 gap-y-1 items-center"
      aria-hidden="true"
    >
      <span class="flex gap-1 items-center">
        <kbd>↑</kbd><kbd>↓</kbd>
        <span>{{ $t('tagSelector.navigate') }}</span>
      </span>
      <span class="flex gap-1 items-center">
        <kbd>↵</kbd>
        <span>{{ $t('tagSelector.select') }}</span>
      </span>
      <span class="flex gap-1 items-center">
        <kbd v-for="k in shortcutKeys(GROUP_NEXT)" :key="k">{{ k }}</kbd>
        <span>{{ $t('tagSelector.switchGroup') }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
kbd {
  background-color: var(--p-bg);
  color: var(--p-fg);
  padding: 0.1em 0.3em;
  border-radius: 0.2em;
  margin: 0 0.2em;
  box-shadow: 0 0 0 1px var(--p-border-strong);
  border-bottom: 1px solid var(--p-border-strong);
}

/* Visual-only checkbox (the row itself is the option and carries
   aria-selected) — same look as PCheckbox without its focusable input. */
.tag-check {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 0.875rem;
  height: 0.875rem;
  border-radius: var(--p-radius-xs);
  border: 1px solid var(--p-border);
  background: var(--p-surface-1);
  color: var(--p-on-primary);
  transition: background-color var(--p-transition-fast);
}
.tag-check--on {
  border-color: var(--p-primary);
  background: var(--p-primary);
}
</style>
