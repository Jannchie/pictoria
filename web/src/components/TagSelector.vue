<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
import { v2AddTagToPost, v2ListTagGroup, v2ListTags, v2RemoveTagFromPost } from '@/api'
import { usePostQuery } from '../composables/usePostQuery'

const props = defineProps<{
  postId?: number
}>()

const postId = computed(() => props.postId)
const search = ref('')
const postQuery = usePostQuery(postId)
const tagGroupsQuery = useQuery({
  queryKey: ['tagGroups', postId],
  queryFn: async () => {
    const resp = await v2ListTagGroup({})
    return resp.data
  },
})

const tagGroups = computed(() => {
  return tagGroupsQuery.data.value
})

const tagsQuery = useQuery({
  queryKey: ['tags'],
  queryFn: async () => {
    const resp = await v2ListTags({})
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

const initCurrentTags = controlledComputed(() => [currentGroupId.value, postId.value, search.value, postQuery.isFetched.value], () => {
  return currentTags.value
})

const initCurrentTagNames = computed(() => {
  return initCurrentTags.value.map(tag => tag.tagInfo.name)
})

const currentGroupTags = computed(() => {
  if (currentGroupId.value === undefined) {
    return tags.value.filter(tag => !initCurrentTagNames.value.includes(tag.name)) ?? []
  }
  return tags.value.filter(tag => tag.group?.id === currentGroupId.value).filter(tag => !initCurrentTagNames.value.includes(tag.name)) ?? []
})
const displayCurrentGroupTags = computed(() => {
  // only top 100
  return currentGroupTags.value.filter(d => isSearchMatch(d.name)).slice(0, 100)
})

function isSearchMatch(tagName: string) {
  if (!search.value) {
    return true
  }
  return tagName.includes(search.value)
}

const queryClient = useQueryClient()
async function onPointerUp(tagName: string) {
  if (!postId.value) {
    return
  }
  await (currentTags.value.some(tag => tag.tagInfo.name === tagName)
    ? v2RemoveTagFromPost({
        path: {
          post_id: postId.value,
          tag_name: tagName,
        },
      })
    : v2AddTagToPost({
        path: {
          post_id: postId.value,
          tag_name: tagName,
        },
      }))
  queryClient.invalidateQueries({
    queryKey: ['post', postId],
  })
}
const pinned = inject('pinned', ref(false))
const addTagText = computed(() => {
  return `Add New Tag "${search.value}"`
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
  await v2AddTagToPost({
    path: {
      post_id: postId.value,
      tag_name: tagName,
    },
  })
  queryClient.invalidateQueries({
    queryKey: ['post', postId],
  })
  queryClient.invalidateQueries({
    queryKey: ['tags'],
  })
}

const showAddTag = computed(() => {
  return search.value !== '' && !tags.value?.some(tag => search.value === tag.name)
})

const currentHoverIndex = ref(-1)
const initCurrentTagsRef = ref([])
const currentGroupTagsRef = ref([])
const addTagRef = ref(null)
const referenceList = computed<any[]>(() => {
  const refs = addTagRef.value
    ? [addTagRef.value, ...initCurrentTagsRef.value, ...currentGroupTagsRef.value]
    : [...initCurrentTagsRef.value, ...currentGroupTagsRef.value]
  return refs.toSorted((a: any, b: any) => a.$el.offsetTop - b.$el.offsetTop)
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

onKeyStroke('ArrowDown', () => {
  currentHoverIndex.value = currentHoverIndex.value + 1 >= referenceList.value.length ? 0 : Math.min(currentHoverIndex.value + 1, referenceList.value.length - 1)

  referenceList.value[currentHoverIndex.value]?.$el.scrollIntoView({
    block: 'nearest',
  })
})

onKeyStroke('ArrowUp', () => {
  currentHoverIndex.value = currentHoverIndex.value - 1 < 0 ? referenceList.value.length - 1 : Math.max(currentHoverIndex.value - 1, 0)
  referenceList.value[currentHoverIndex.value]?.$el.scrollIntoView({
    block: 'nearest',
  })
})

onKeyStroke('Enter', () => {
  const reference = referenceList.value[currentHoverIndex.value]
  currentHoverIndex.value === 0 && showAddTag.value
    ? addTag(search.value)
    : reference && onPointerUp(reference.title)
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
  return initCurrentTags.value.filter(tag => isSearchMatch(tag.tagInfo.name))
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
        No Post Selected
      </span>
    </div>
  </div>
  <div
    v-else
    class="text-sm text-fg border border-border-default rounded bg-bg flex flex-col h-96 max-h-96 max-w-96 w-96 shadow-md"
  >
    <div class="p-2 border-b border-border-default flex gap-2">
      <PInput
        ref="searchRef"
        v-model="search"
        size="sm"
        placeholder="Search"
        class="flex-grow"
      />
      <PButton
        icon
        size="sm"
        :variant="pinned ? 'primary' : 'secondary'"
        @pointerup="pinned = !pinned"
      >
        <i class="i-tabler-pin" />
      </PButton>
    </div>
    <div class="flex flex-grow overflow-auto">
      <div class="p-1 border-r border-border-default flex-shrink-0 w-32">
        <ListItem
          v-for="group, i in finalTagGroups"
          :key="i"
          class="cursor-pointer"
          :title="group.name"
          icon="i-tabler-bookmark"
          :active="group.id === currentGroupId"
          @click="currentGroupId = group.id"
        />
      </div>
      <ScrollArea
        class="flex-grow"
      >
        <div
          v-if="showAddTag"
          class="border-b border-border-default"
        >
          <ListItem
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
          v-if="initCurrentTags.some(tag => isSearchMatch(tag.tagInfo.name))"
          class="border-b border-border-default"
        >
          <div class="text-xs text-fg-subtle tracking-wider font-medium px-3 py-1.5 uppercase">
            Already Selected · {{ searchingInitCurrentTags.length }}
          </div>
          <template
            v-for="tag, i in initCurrentTags"
            :key="i"
          >
            <ListItem
              v-if="isSearchMatch(tag.tagInfo.name)"
              ref="initCurrentTagsRef"
              v-highlight="search"
              class="cursor-pointer"
              :title="tag.tagInfo.name"
              :active="currentTags.some(predicate => predicate.tagInfo.name === tag.tagInfo.name)"
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
            All · {{ currentGroupTags.filter(tag => isSearchMatch(tag.name)).length }}
          </div>
          <template
            v-for="tag, i in displayCurrentGroupTags"
            :key="tag.name"
          >
            <ListItem
              ref="currentGroupTagsRef"
              v-highlight="search"
              class="cursor-pointer"
              :title="tag.name"
              :active="currentTags.some(predicate => predicate.tagInfo.name === tag.name)"
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
          v-if="displayCurrentGroupTags.length === 100"
          class="text-xs p-1 text-center op50"
        >
          Only Show Top 100
        </div>
      </ScrollArea>
    </div>
    <div class="text-xs text-fg-muted px-3 py-2 border-t border-border-default flex flex-wrap gap-x-3 gap-y-1 items-center">
      <span class="flex gap-1 items-center">
        <kbd>↑</kbd><kbd>↓</kbd>
        <span>navigate</span>
      </span>
      <span class="flex gap-1 items-center">
        <kbd>↵</kbd>
        <span>select</span>
      </span>
      <span class="flex gap-1 items-center">
        <kbd>Tab</kbd>
        <span>switch group</span>
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
