<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Waterfall } from 'vue-wf'
import { useGalleryGrid } from '@/composables/useGalleryGrid'
import { useKeyScope } from '@/composables/useKeyScope'
import { clear as clearSelection } from '@/shared'

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
    clearSelection()
  }
}

// Same listbox keyboard model as the gallery grid (useGalleryGrid). While
// focus is in here the post page's own ←/→/Enter/Space stand down (the
// listbox is a widget), so they drive this grid instead. Delete is left to
// the page, which owns the delete dialog for the similar-post selection.
const router = useRouter()
const activeKeyScope = useKeyScope()
const ids = computed(() => data.value.map(p => p.id))
useGalleryGrid({
  container: () => waterfallRef.value?.wrapper,
  // Post.vue passes the PScrollArea instance; its exposed `$el` is the scroller.
  scroller: () => {
    const el = scrollElement.value as HTMLElement & { $el?: HTMLElement }
    return el.$el ?? el
  },
  ids,
  layout: () => waterfallRef.value?.layoutData,
  enabled: () => activeKeyScope.value === 'postPage',
  open: id => router.push(`/post/${id}`),
})
</script>

<template>
  <template v-if="query.status.value === 'pending'">
    <div class="text-sm text-fg-muted op-50 flex flex-col gap-2 h-64 items-center justify-center" role="status">
      <i class="i-tabler-loader text-2xl animate-spin" aria-hidden="true" />
      <span>
        {{ $t('post.loadingSimilar') }}
      </span>
    </div>
  </template>
  <PEmpty
    v-else-if="data.length === 0"
    icon="i-tabler-photo-off"
    class="h-64"
  >
    {{ $t('post.noSimilar') }}
  </PEmpty>
  <Waterfall
    v-else
    ref="waterfallRef"
    class="select-none focus:outline-none"
    role="listbox"
    tabindex="0"
    aria-multiselectable="true"
    :aria-label="$t('gallery.similarGridLabel')"
    data-gallery-grid
    :scroll-element="scrollElement"
    :items="data.map(p => ({ width: p.width ?? 1, height: p.height ?? 1 }))"
    :cols="cols"
    :gap="24"
    :padding-x="8"
    :padding-y="8"
    @pointerdown="emptyPointerDown"
  >
    <PostItem
      v-for="(p, index) in data"
      :id="`post-item-${p.id}`"
      :key="p.id"
      :post="p"
      :aria-posinset="index + 1"
      :aria-setsize="data.length"
    />
  </Waterfall>
</template>
