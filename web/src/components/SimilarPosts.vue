<script setup lang="ts">
import { Waterfall } from 'vue-wf'
import { selectedPostIdSet } from '@/shared'

const props = defineProps<{
  postId: number
  scrollElement: MaybeRef<HTMLElement>
}>()
const scrollElement = computed(() => toValue(props.scrollElement) ?? document.documentElement)
const postId = computed(() => props.postId)
// Shares the ['similarPosts', { postId }] cache with Post.vue, which reads the
// same array to drive box-selection — see useWaterfallSelection wiring there.
const query = useSimilarPostsQuery(postId)

const data = computed(() => query.data.value ?? [])
const { width } = useElementSize(scrollElement)
const cols = computed(() => Math.floor(width.value / 300))

// Exposed so Post.vue can read layoutData/wrapper for drag-box selection,
// mirroring how MainSection owns its own Waterfall ref.
const waterfallRef = ref<InstanceType<typeof Waterfall> | null>(null)
defineExpose({ waterfall: waterfallRef })

// Click on empty waterfall background clears the selection — identical to the
// list waterfall's emptyPointerDown. PostItem stops propagation on pointerdown,
// so this only fires for the gaps between items, not the items themselves.
function emptyPointerDown(e: PointerEvent) {
  if (!e.ctrlKey && !e.shiftKey) {
    selectedPostIdSet.value = new Set()
  }
}
</script>

<template>
  <template v-if="query.status.value === 'pending'">
    <div class="text-sm text-fg-muted op-50 flex flex-col gap-2 h-64 items-center justify-center">
      <i class="i-tabler-loader text-2xl animate-spin" />
      <span>
        {{ $t('post.loadingSimilar') }}
      </span>
    </div>
  </template>
  <Waterfall
    v-else
    ref="waterfallRef"
    class="select-none"
    :scroll-element="scrollElement"
    :items="data.map(p => ({ width: p.width ?? 1, height: p.height ?? 1 }))"
    :cols="cols"
    :gap="24"
    :padding-x="8"
    :padding-y="8"
    :y-gap="36"
    @pointerdown="emptyPointerDown"
  >
    <PostItem
      v-for="p in data"
      :id="`post-item-${p.id}`"
      :key="p.id"
      :post="p"
    />
  </Waterfall>
</template>
