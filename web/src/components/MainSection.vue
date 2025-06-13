<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import type LazyWaterfall from './LazyWaterfall.vue'
import type { Area } from './SelectArea.vue'
import { v2DeletePosts } from '@/api'
import { useRotateImageMutation } from '@/composables/mutations/useRotateImageMutation'
import { useElementOffset } from '@/composables/useElementOffset'
import { selectedPostIdSet, selectingPostIdSet, unselectedPostIdSet as unselectingPostId, updateScoreForSelectedPosts, useInfinityPostsQuery, waterfallRowCount } from '@/shared'
import { Btn, Menu } from '@roku-ui/vue'
import { useQueryClient } from '@tanstack/vue-query'
import { logicAnd } from '@vueuse/math'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
const infinityPostsQuery = useInfinityPostsQuery()
const posts = computed<Array<PostSimplePublic>>(() => {
  return infinityPostsQuery.data.value?.pages.flat().filter(post => post !== undefined) ?? []
})
const items = computed(() => posts.value.map(post => ({
  width: post.width ?? 1,
  height: post.height ?? 1,
})))

const waterfallRef = ref<InstanceType<typeof LazyWaterfall> | null>(null)
const waterfallWrapperDom = computed(() => waterfallRef.value?.wrapper)
const waterfallWrapperBounds = useElementBounding(waterfallWrapperDom)
const waterfallItemWidth = computed(() => {
  return Math.floor((waterfallWrapperBounds.width.value - 8 * 2 - 24 * (waterfallRowCount.value - 1)) / waterfallRowCount.value)
})
const cols = computed(() => Math.floor((waterfallWrapperBounds.width.value + 20 - 8 * 2) / (waterfallItemWidth.value + 20)))
const layoutData = computed(() => {
  return waterfallRef.value?.layoutData
})
const waterfallOffset = useElementOffset(waterfallWrapperDom)
async function onSelectChange(selectArea: Area, { shift, ctrl }: { target: EventTarget | null, shift: boolean, ctrl: boolean }) {
  // 如果 selectArea 的面积小于 100px，则无视后续
  if ((selectArea.right - selectArea.left) < 10 || (selectArea.bottom - selectArea.top) < 10) {
    return
  }

  // layoutData 是 x,y,width,height 的数组，selectArea 是 left,rihht,top,bottom 的对象。
  // 通过计算两者的交集，得到选中的元素 index
  const currentSelectingId: Set<number | undefined> = new Set()

  if (layoutData.value) {
    for (const [index, element] of layoutData.value.entries()) {
      const elementLeft = element.x + waterfallOffset.offsetLeft.value
      const elementRight = element.x + element.width + waterfallOffset.offsetLeft.value
      const elementTop = element.y + waterfallOffset.offsetTop.value
      const elementBottom = element.y + element.height + waterfallOffset.offsetTop.value

      // Check if there is an intersection between the element and the selectArea
      const isIntersecting
    = !(elementLeft > selectArea.right
      || elementRight < selectArea.left
      || elementTop > selectArea.bottom
      || elementBottom < selectArea.top)
    // 如果按住了 shift，则是追加选择，如果按住了 ctrl，则是补集选择
      const post = posts.value[index]
      if (isIntersecting) {
        currentSelectingId.add(post.id)
      }
    }
  }
  if (shift) {
    selectingPostIdSet.value = new Set([...selectingPostIdSet.value, ...currentSelectingId])
  }
  else if (ctrl) {
    // 如果原来已经选中了，则取消选中，否则添加选中
    for (const postId of currentSelectingId) {
      if (selectedPostIdSet.value.has(postId)) {
        unselectingPostId.value.add(postId)
      }
      else {
        selectingPostIdSet.value.add(postId)
      }
    }
  }
  else {
    selectedPostIdSet.value = currentSelectingId
    selectingPostIdSet.value = currentSelectingId
  }
}
function onSelectEnd() {
  // 将 selecting 和 unselected 应用到 selected，然后清空 selecting 和 unselected
  selectedPostIdSet.value = new Set([...selectedPostIdSet.value, ...selectingPostIdSet.value].filter(id => !unselectingPostId.value.has(id)))
  selectingPostIdSet.value = new Set()
  unselectingPostId.value = new Set()
}

function emptyPointerDown(e: PointerEvent) {
  // 如果是右键，且没有按 ctrl 或者 shift
  if (!e.ctrlKey && !e.shiftKey) {
    selectedPostIdSet.value = new Set()
    // 保留现有的查询参数，只清除 post_id
    const currentQuery = { ...route.query }
    delete currentQuery.post_id
    router.replace({ query: currentQuery })
  }
}

const { Ctrl_A } = useMagicKeys()
const activeElement = useActiveElement()
const notUsingInput = computed(() =>
  activeElement.value?.tagName !== 'INPUT'
  && activeElement.value?.tagName !== 'TEXTAREA')

// Add keyboard shortcuts for batch rating
const { 1: one, 2: two, 3: three, 4: four, 5: five } = useMagicKeys()
const queryClient = useQueryClient()

// Watch for number key presses to apply ratings to all selected posts
watchEffect(async () => {
  // Only process keyboard input when not in a text field and having posts selected
  if (!notUsingInput.value || selectedPostIdSet.value.size === 0) {
    return
  }

  if (one.value) {
    await updateScoreForSelectedPosts(1)
  }
  if (two.value) {
    await updateScoreForSelectedPosts(2)
  }
  if (three.value) {
    await updateScoreForSelectedPosts(3)
  }
  if (four.value) {
    await updateScoreForSelectedPosts(4)
  }
  if (five.value) {
    await updateScoreForSelectedPosts(5)
  }
  // Invalidate queries to refresh UI
  const selectedIds = [...selectedPostIdSet.value].filter(id => id !== undefined) as number[]
  queryClient.invalidateQueries({ queryKey: ['count', 'score'] })
  for (const postId of selectedIds) {
    queryClient.invalidateQueries({ queryKey: ['post', postId] })
  }
})

whenever(logicAnd(Ctrl_A, notUsingInput), () => {
  selectedPostIdSet.value = new Set(posts.value.map(post => post.id))
})

const shouldScroll = ref(true)
watchEffect(async () => {
  if (route.query.post_id) {
    // 如果有 post_id 参数，则选中这个 post，并且滚动到这个 post
    const postId = Number(route.query.post_id)
    if (posts.value.length === 0) {
      return
    }
    const postIndex = posts.value.findIndex(post => post.id === postId)
    if (postIndex === -1 && !infinityPostsQuery.hasNextPage.value) {
      // 保留现有的查询参数，只清除 post_id
      const currentQuery = { ...route.query }
      delete currentQuery.post_id
      await router.replace({ query: currentQuery })
      return
    }
    if (postId) {
      const postLayout = waterfallRef.value?.layoutData?.[postIndex]
      if (postLayout) {
        const res = document.querySelector(`#post-item-${postId}`)
        if (!res && shouldScroll.value) {
          waterfallWrapperDom.value?.scrollTo({
            top: postLayout.y,
            behavior: 'smooth',
          })
        }
        shouldScroll.value = false
        selectedPostIdSet.value = new Set([postId])
      }
    }
  }
})

// FIXME: 滚动到指定元素，但是有 Bug，会导致无法通过前进后退变更路由
// 如果 selectedPostIdSet 只有一个元素，则变更路由，但是不要滚动
// watchEffect(() => {
//   if (selectedPostIdSet.value.size === 1) {
//     const postId = selectedPostIdSet.value.values().next().value
//     if (postId) {
//       router.push({ query: { post_id: postId } })
//     }
//   }
// })

const menuData = computed(() => {
  if (selectedPostIdSet.value.size > 0) {
    return [
      {
        role: 'label',
        title: 'Post Actions',
      },
      {
        value: 'rotate-clockwise',
        title: 'Rotate Clockwise',
        icon: 'i-fluent-arrow-rotate-clockwise-24-regular',
      },
      {
        value: 'rotate-counterclockwise',
        title: 'Rotate Counterclockwise',
        icon: 'i-fluent-arrow-rotate-counterclockwise-24-regular',
      },
      { role: 'divider' },
      {
        value: 'delete',
        title: 'Delete',
        icon: 'i-tabler-trash',
      },
    ]
  }
  return [
    {
      role: 'label',
      title: 'No Post Selected',
    },
  ]
})

async function deleteSelectingPosts() {
  const ids = [...selectedPostIdSet.value].filter(id => id !== undefined) as number[]
  if (ids.length === 0) {
    return
  }
  const batchSize = 100
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize)
    await v2DeletePosts({
      query: {
        ids: batch,
      },
    })
  }
  queryClient.invalidateQueries({ queryKey: ['posts'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'score'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'rating'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'extension'] })
}

const rotateImageMutation = useRotateImageMutation()
function onMenuSelect(value: string | number | symbol) {
  const selectedPostIds = [...selectedPostIdSet.value]
  for (const postId of selectedPostIds) {
    if (!postId) {
      continue
    }
    switch (value) {
      case 'rotate-clockwise': {
        rotateImageMutation.mutate({ postId, clockwise: true })
        break
      }
      case 'rotate-counterclockwise': {
        rotateImageMutation.mutate({ postId, clockwise: false })
        break
      }
      case 'delete': {
        deleteSelectingPosts()
        break
      }
    }
  }
}
const mainSectionRef = ref<HTMLElement>()
</script>

<template>
  <ScrollArea
    ref="mainSectionRef"
    class="relative flex flex-grow basis-0 flex-col"
  >
    <SelectArea
      :target="mainSectionRef"
      @select-change="onSelectChange"
      @select-end="onSelectEnd"
    />
    <Menu
      :data="menuData"
      trigger="contextmenu"
      class="h-full w-full shrink-0 grow-1 basis-0"
      @select="onMenuSelect"
    >
      <FolderSection />
      <div v-if="infinityPostsQuery.isLoading.value && posts.length === 0">
        <div class="flex flex-col items-center p-16 op-50">
          <i class="i-tabler-loader animate-spin text-2xl" />
          <div class="text-sm">
            Loading posts...
          </div>
        </div>
      </div>
      <div v-else-if="posts.length === 0">
        <div class="flex flex-col items-center p-16 op-50">
          <i class="i-tabler-alert-triangle text-2xl" />
          <div class="text-sm">
            No posts found
          </div>
        </div>
      </div>

      <LazyWaterfall
        ref="waterfallRef"
        class="waterfall-wrapper select-none"
        :scroll-element="mainSectionRef"
        :items="items"
        :item-width="waterfallItemWidth"
        :cols="cols"
        :gap="24"
        :padding-x="8"
        :padding-y="8"
        :y-gap="36"
        @pointerdown="emptyPointerDown"
      >
        <PostItem
          v-for="post in posts"
          :id="`post-item-${post.id}`"
          :key="post.id"
          :post="post"
        />
      </LazyWaterfall>
      <div
        v-if="posts.length > 0 && infinityPostsQuery.hasNextPage.value"
        class="flex justify-center p-4"
      >
        <Btn
          :loading="infinityPostsQuery.isLoading.value"
          @click="infinityPostsQuery.fetchNextPage()"
        >
          Load More
        </Btn>
      </div>
    </Menu>
  </ScrollArea>
</template>
