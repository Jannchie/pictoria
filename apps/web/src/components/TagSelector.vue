<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2ListTagGroup, v2ListTags } from '@/api'
import { useRovingIndex } from '@/composables/useRovingIndex'
import { resolvedLocale } from '@/locale'
import { commitTag } from '@/shared'
import { queryKeys } from '@/shared/queryKeys'
import { naturalizeTagName } from '@/utils'
import { usePostQuery } from '../composables/usePostQuery'

const props = defineProps<{
  postId?: number
}>()

const { t } = useI18n()

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
      name: 'All',
      id: undefined,
    },
    ...(tagGroups.value ?? []),
    {
      name: 'not grouped',
      id: null,
    },
  ]
})

const currentGroupId = ref<number | null | undefined>()

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
const displayCurrentGroupTags = computed(() => groupMatches.value.list)

// 同时匹配原始下划线名与本地化显示名（忽略大小写），中文输入也能搜到 tag。
function isSearchMatch(tag: { name: string, translatedName?: string | null }) {
  if (!debouncedSearch.value) {
    return true
  }
  const q = debouncedSearch.value.toLowerCase()
  return tag.name.toLowerCase().includes(q) || !!tag.translatedName?.toLowerCase().includes(q)
}

const queryClient = useQueryClient()
async function onPointerUp(tagName: string) {
  if (!postId.value) {
    return
  }
  const isOn = currentTags.value.some(tag => tag.tagInfo.name === tagName)
  // 已在 post 上 → 移除（add=false）；否则 → 添加（add=true）
  await commitTag(queryClient, postId.value, tagName, !isOn)
}
const pinned = inject('pinned', ref(false))
const addTagText = computed(() => {
  return t('tagSelector.addNew', { name: search.value })
})

const { tab } = useMagicKeys({
  passive: false,
  onEventFired(e) {
    if (e.key === 'Tab') {
      e.preventDefault()
    }
  },
})
watchEffect(() => {
  // 在 finalTagGroups 中找到 currentGroupId 的 index
  const index = finalTagGroups.value.findIndex(group => group.id === currentGroupId.value)
  if (tab.value) {
    currentGroupId.value = finalTagGroups.value[(index + 1) % finalTagGroups.value.length].id
  }
})

async function addTag(tagName: string) {
  if (!postId.value) {
    return
  }
  await commitTag(queryClient, postId.value, tagName, true)
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

const currentHoverIndex = ref(-1)
const initCurrentTagsRef = ref([])
const currentGroupTagsRef = ref([])
const addTagRef = ref(null)
const referenceList = computed<any[]>(() => {
  // 拼接顺序即渲染顺序，也正是 getIndexOfRef 假设的顺序。别按 offsetTop 重排：
  // 读一次 offsetTop 就强制一次同步布局，排序里读上百次会把输入卡死。
  return addTagRef.value
    ? [addTagRef.value, ...initCurrentTagsRef.value, ...currentGroupTagsRef.value]
    : [...initCurrentTagsRef.value, ...currentGroupTagsRef.value]
})

function getIndexOfRef(type: string, index: number) {
  if (type === 'current') {
    return addTagRef.value ? index + 1 : index
  }
  else if (type === 'group') {
    return addTagRef.value ? index + 1 + initCurrentTagsRef.value.length : index + initCurrentTagsRef.value.length
  }
  else {
    return 0
  }
}

const { move: moveHover } = useRovingIndex({
  count: () => referenceList.value.length,
  index: currentHoverIndex,
  onMove: (index) => {
    referenceList.value[index]?.$el.scrollIntoView({
      block: 'nearest',
    })
  },
})

onKeyStroke('ArrowDown', () => moveHover(1))

onKeyStroke('ArrowUp', () => moveHover(-1))

onKeyStroke('Enter', () => {
  const reference = referenceList.value[currentHoverIndex.value]
  // data-tag-name 携带原始下划线名 —— title 现在是本地化显示文本
  // （自然英文＋中文注解），不能再当 tag 名提交。
  currentHoverIndex.value === 0 && showAddTag.value
    ? addTag(search.value)
    : reference && onPointerUp(reference.$el?.dataset?.tagName ?? reference.title)
})
const searchRef = ref(null)
onKeyStroke(true, (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab' && searchRef.value) {
    const element = (searchRef.value as any).$el
    if (element) {
      // 在 el 中，寻找 input 元素，并 focus
      const input = element.querySelector('input')
      if (input) {
        input.focus()
      }
    }
  }
})
watchEffect(() => {
  if (showAddTag.value && search.value) {
    currentHoverIndex.value = 0
  }
})
const searchingInitCurrentTags = computed(() => {
  return initCurrentTags.value.filter(tag => isSearchMatch(tag.tagInfo))
})
</script>

<template>
  <div
    v-if="!postQuery.data.value"
    class="text-sm text-fg border border-border-default rounded bg-bg flex flex-col h-96 max-h-96 max-w-96 w-96 shadow-md relative"
  >
    <div class="text-fg-muted flex flex-grow flex-col h-full w-full items-center justify-center">
      <i class="i-tabler-tag text-2xl p-4" />
      <span class="text-xs mt-2">
        {{ $t('tagSelector.noPostSelected') }}
      </span>
    </div>
  </div>
  <div
    v-else
    class="text-sm text-fg border border-border-default rounded bg-bg flex flex-col h-96 max-h-96 max-w-96 w-96 shadow-md"
  >
    <!-- The search row is the panel's own top edge: one border-b divides it
         from the list, and the field carries no frame or focus highlight of
         its own. Same shape as the command palette. -->
    <div class="px-3 border-b border-border-default flex shrink-0 gap-2 h-10 items-center">
      <i class="i-tabler-search text-fg-subtle shrink-0" aria-hidden="true" />
      <PInput
        ref="searchRef"
        v-model="search"
        variant="plain"
        size="sm"
        class="!px-0"
        :placeholder="$t('tagSelector.searchPlaceholder')"
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
        @pointerup="pinned = !pinned"
      >
        <i :class="pinned ? 'i-tabler-pin-filled text-primary' : 'i-tabler-pin'" />
      </PButton>
    </div>
    <div class="flex flex-grow overflow-auto">
      <div class="p-1 border-r border-border-default flex-shrink-0 w-32">
        <PListItem
          v-for="group, i in finalTagGroups"
          :key="i"
          class="cursor-pointer"
          :title="group.name"
          icon="i-tabler-bookmark"
          :active="group.id === currentGroupId"
          @click="currentGroupId = group.id"
        />
      </div>
      <PScrollArea
        class="flex-grow"
      >
        <div
          v-if="showAddTag"
          class="border-b border-border-default"
        >
          <PListItem
            ref="addTagRef"
            class="cursor-pointer"
            :title="addTagText"
            icon="i-tabler-plus"
            :class="{
              'bg-surface-2': currentHoverIndex === 0,
            }"
            @pointerup="addTag(search)"
            @pointermove="currentHoverIndex = 0"
          />
        </div>
        <div
          v-if="searchingInitCurrentTags.length > 0"
          class="border-b border-border-default"
        >
          <div class="text-xs text-fg-subtle tracking-wider font-medium px-3 py-1.5 uppercase">
            {{ $t('tagSelector.alreadySelected') }} · {{ searchingInitCurrentTags.length }}
          </div>
          <template
            v-for="tag, i in searchingInitCurrentTags"
            :key="tag.tagInfo.name"
          >
            <PListItem
              ref="initCurrentTagsRef"
              v-highlight="debouncedSearch"
              class="cursor-pointer"
              :data-tag-name="tag.tagInfo.name"
              :title="tagLabel(tag.tagInfo.name, tag.tagInfo.translatedName)"
              :active="currentTagNames.has(tag.tagInfo.name)"
              type="checkbox"
              :class="{
                'bg-surface-2': currentHoverIndex === getIndexOfRef('current', i),
              }"
              @pointerup="onPointerUp(tag.tagInfo.name)"
              @pointermove="currentHoverIndex = getIndexOfRef('current', i)"
            />
          </template>
        </div>
        <div>
          <div class="text-xs text-fg-subtle tracking-wider font-medium px-3 py-1.5 uppercase">
            {{ $t('tagSelector.all') }} · {{ groupMatches.total }}
          </div>
          <template
            v-for="tag, i in displayCurrentGroupTags"
            :key="tag.name"
          >
            <PListItem
              ref="currentGroupTagsRef"
              v-highlight="debouncedSearch"
              class="cursor-pointer"
              :data-tag-name="tag.name"
              :title="tagLabel(tag.name, tag.translatedName)"
              :active="currentTagNames.has(tag.name)"
              type="checkbox"
              :class="{
                'bg-surface-2': currentHoverIndex === getIndexOfRef('group', i),
              }"
              @pointerup="onPointerUp(tag.name)"
              @pointermove="currentHoverIndex = getIndexOfRef('group', i)"
            />
          </template>
        </div>
        <div
          v-if="groupMatches.total > DISPLAY_LIMIT"
          class="text-xs p-1 text-center op50"
        >
          {{ $t('tagSelector.onlyTop') }}
        </div>
      </PScrollArea>
    </div>
    <div class="text-xs text-fg-muted px-3 py-2 border-t border-border-default flex flex-wrap gap-x-3 gap-y-1 items-center">
      <span class="flex gap-1 items-center">
        <kbd>↑</kbd><kbd>↓</kbd>
        <span>{{ $t('tagSelector.navigate') }}</span>
      </span>
      <span class="flex gap-1 items-center">
        <kbd>↵</kbd>
        <span>{{ $t('tagSelector.select') }}</span>
      </span>
      <span class="flex gap-1 items-center">
        <kbd>Tab</kbd>
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
</style>
