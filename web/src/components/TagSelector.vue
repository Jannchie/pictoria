<script setup lang="ts">
import { v1AddTagToPost, v1GetTagGroups, v1GetTags, v1RemoveTagFromPost } from '@/api'
import { Btn, TextField } from '@roku-ui/vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
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
    const resp = await v1GetTagGroups({})
    return resp.data
  },
})

const tagGroups = computed(() => {
  return tagGroupsQuery.data.value
})

const tagsQuery = useQuery({
  queryKey: ['tags'],
  queryFn: async () => {
    const resp = await v1GetTags({})
    return resp.data
  },
  staleTime: Infinity,
})

const tags = computed(() => {
  return tagsQuery.data.value
})

const currentGroupId = ref<number | null>()
const currentTags = computed(() => {
  const tags = postQuery.data.value?.tags ?? []
  if (currentGroupId.value === undefined) {
    return tags
  }
  return tags.filter(tag => tag.tag_info.group?.id === currentGroupId.value)
})

const initCurrentTags = controlledComputed(() => [currentGroupId.value, postId.value, search.value, postQuery.isFetched.value], () => {
  return currentTags.value
})

const initCurrentTagNames = computed(() => {
  return initCurrentTags.value.map(tag => tag.tag_info.name)
})

const currentGroupTags = computed(() => {
  if (currentGroupId.value === undefined) {
    return tags.value?.filter(tag => !initCurrentTagNames.value.includes(tag.tag_info.name)) ?? []
  }
  return tags.value?.filter(tag => tag.tag_info.group?.id === currentGroupId.value).filter(tag => !initCurrentTagNames.value.includes(tag.tag_info.name)) ?? []
})
const displayCurrentGroupTags = computed(() => {
  // only top 100
  return currentGroupTags.value.filter(d => isSearchMatch(d.tag_info.name)).slice(0, 100)
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
  if (currentTags.value.some(tag => tag.tag_info.name === tagName)) {
    // remove
    await v1RemoveTagFromPost({

      path: {
        post_id: postId.value,
        tag_name: tagName,
      },
    })
  }
  else {
    await v1AddTagToPost({

      path: {
        post_id: postId.value,
        tag_name: tagName,
      },
    })
  }
  queryClient.invalidateQueries({
    queryKey: ['post', postId],
  })
}
const pinned = inject('pinned', ref(false))
const addTagText = computed(() => {
  return `Add New Tag "${search.value}"`
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
  await v1AddTagToPost({

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
  return search.value !== '' && !tags.value?.some(tag => search.value === tag.tag_info.name)
})

const currentHoverIndex = ref(-1)
const initCurrentTagsRef = ref([])
const currentGroupTagsRef = ref([])
const addTagRef = ref(null)
const refList = computed<any[]>(() => {
  if (addTagRef.value) {
    return [addTagRef.value, ...initCurrentTagsRef.value, ...currentGroupTagsRef.value].sort((a: any, b: any) => a.$el.offsetTop - b.$el.offsetTop)
  }
  else {
    return [...initCurrentTagsRef.value, ...currentGroupTagsRef.value].sort((a: any, b: any) => a.$el.offsetTop - b.$el.offsetTop)
  }
})

function getIndexOfRef(type: string, i: number) {
  if (type === 'current') {
    if (addTagRef.value) {
      return i + 1
    }
    else {
      return i
    }
  }
  else if (type === 'group') {
    if (addTagRef.value) {
      return i + 1 + initCurrentTagsRef.value.length
    }
    else {
      return i + initCurrentTagsRef.value.length
    }
  }
  else {
    return 0
  }
}

onKeyStroke('ArrowDown', () => {
  if (currentHoverIndex.value + 1 >= refList.value.length) {
    currentHoverIndex.value = 0
  }
  else {
    currentHoverIndex.value = Math.min(currentHoverIndex.value + 1, refList.value.length - 1)
  }

  refList.value[currentHoverIndex.value]?.$el.scrollIntoView({
    block: 'nearest',
  })
})

onKeyStroke('ArrowUp', () => {
  if (currentHoverIndex.value - 1 < 0) {
    currentHoverIndex.value = refList.value.length - 1
  }
  else {
    currentHoverIndex.value = Math.max(currentHoverIndex.value - 1, 0)
  }
  refList.value[currentHoverIndex.value]?.$el.scrollIntoView({
    block: 'nearest',
  })
})

onKeyStroke('Enter', () => {
  if (currentHoverIndex.value === 0 && showAddTag.value) {
    addTag(search.value)
  }
  else {
    const ref = refList.value[currentHoverIndex.value]
    if (ref) {
      onPointerUp(ref.title)
    }
  }
})
const searchRef = ref(null)
onKeyStroke(true, (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') {
    if (searchRef.value) {
      const el = (searchRef.value as any).$el
      if (el) {
        // 在 el 中，寻找 input 元素，并 focus
        const input = el.querySelector('input')
        if (input) {
          input.focus()
        }
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
  return initCurrentTags.value.filter(tag => isSearchMatch(tag.tag_info.name))
})
</script>

<template>
  <div
    v-if="!postQuery.data.value"
    class="text-surface-on-high max-w-96 min-h-96 w-96 flex flex-col border rounded bg-surface-base text-sm shadow-md"
  >
    <div class="h-full w-full flex flex-grow flex-col items-center justify-center text-surface-dimmed">
      <i class="i-tabler-tag p-4 text-2xl" />
      <span class="mt-2 text-xs">
        No Post Selected
      </span>
    </div>
  </div>
  <div
    v-else
    class="text-surface-on-high max-w-96 min-h-96 w-96 flex flex-col border rounded bg-surface-base text-sm shadow-md"
  >
    <div class="flex gap-2 border-b border-surface p-2">
      <TextField
        ref="searchRef"
        v-model="search"
        size="sm"
        placeholder="Search"
        class="flex-grow"
      />
      <Btn
        icon
        size="sm"
        :variant="pinned ? 'filled' : 'default'"
        @pointerup="pinned = !pinned"
      >
        <i class="i-tabler-pin" />
      </Btn>
    </div>
    <div class="flex flex-grow">
      <div class="w-36 flex-shrink-0 border-r border-surface">
        <ListItem
          v-for="group, i in finalTagGroups"
          :key="i"
          class="cursor-pointer p-2"
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
          class="border-b border-surface"
        >
          <ListItem
            ref="addTagRef"
            class="cursor-pointer"
            :title="addTagText"
            icon="i-tabler-plus"
            :class="{
              'bg-surface-high': currentHoverIndex === 0,
            }"
            @pointerup="addTag(search)"
            @pointermove="currentHoverIndex = 0"
          />
        </div>
        <div
          v-if="initCurrentTags.filter(tag => isSearchMatch(tag.tag_info.name)).length"
          class="border-b border-surface"
        >
          <div class="p-2 text-surface-dimmed">
            Already Selected ({{ searchingInitCurrentTags.length }})
          </div>
          <template
            v-for="tag, i in initCurrentTags"
            :key="i"
          >
            <ListItem
              v-if="isSearchMatch(tag.tag_info.name)"
              ref="initCurrentTagsRef"
              v-highlight="search"
              class="cursor-pointer"
              :title="tag.tag_info.name"
              :active="currentTags.some(predicate => predicate.tag_info.name === tag.tag_info.name)"
              type="checkbox"
              :class="{
                'bg-surface-high': currentHoverIndex === getIndexOfRef('current', i),
              }"
              @pointerup="onPointerUp(tag.tag_info.name)"
              @pointermove="currentHoverIndex = getIndexOfRef('current', i)"
            />
          </template>
        </div>
        <div>
          <div class="p-2 text-surface-dimmed">
            All ({{ currentGroupTags.filter(tag => isSearchMatch(tag.tag_info.name)).length }})
          </div>
          <template
            v-for="tag, i in displayCurrentGroupTags"
            :key="tag.tag_info.name"
          >
            <ListItem
              ref="currentGroupTagsRef"
              v-highlight="search"
              class="cursor-pointer"
              :title="tag.tag_info.name"
              :active="currentTags.some(predicate => predicate.tag_info.name === tag.tag_info.name)"
              type="checkbox"
              :class="{
                'bg-surface-high': currentHoverIndex === getIndexOfRef('group', i),
              }"
              @pointerup="onPointerUp(tag.tag_info.name)"
              @pointermove="currentHoverIndex = getIndexOfRef('group', i)"
            />
          </template>
        </div>
        <div
          v-if="displayCurrentGroupTags.length === 100"
          class="p-1 text-center text-xs op50"
        >
          Only Show Top 100
        </div>
      </ScrollArea>
    </div>
    <div class="border-t border-surface p-2 text-xs">
      <kbd>↑</kbd> <kbd>↓</kbd> to navigate, <kbd>Enter</kbd> to select, <kbd>Tab</kbd> to switch group
    </div>
  </div>
</template>

<style>
.highlight{
  color: rgb(var(--r-color-primary-on));
  font-weight: bolder;
}
</style>

<style>
kbd {
  background-color: rgb(var(--r-color-surface-base));
  color: rgb(var(--r-color-surface-on-high));
  padding: 0.1em 0.3em;
  border-radius: 0.2em;
  margin: 0 0.2em;
  box-shadow: 0 0 0 1px rgb(var(--r-color-surface-border-high));
  border-bottom: 1px solid rgb(var(--r-color-surface-border-high));
}
</style>
