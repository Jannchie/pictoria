<script setup lang="ts">
import { computed, ref } from 'vue'
import { postSort, postSortColor, postSortOrder } from '@/shared'

const sortOptions: {
  id: 'created_at' | 'published_at' | 'updated_at' | 'score' | 'rating' | 'file_name' | 'waifu_score' | 'silva_score'
  label: string
  icon: string
}[] = [
  { id: 'created_at', label: 'Created', icon: 'i-tabler-calendar-event' },
  { id: 'published_at', label: 'Published', icon: 'i-tabler-calendar-event' },
  { id: 'updated_at', label: 'Updated', icon: 'i-tabler-clock-edit' },
  { id: 'score', label: 'Score', icon: 'i-tabler-star' },
  { id: 'rating', label: 'Rating', icon: 'i-tabler-thumb-up' },
  { id: 'file_name', label: 'File name', icon: 'i-tabler-file' },
  { id: 'waifu_score', label: 'Waifu score', icon: 'i-tabler-heart' },
  { id: 'silva_score', label: 'SILVA score', icon: 'i-tabler-rosette' },
]

const orderOptions: {
  id: 'asc' | 'desc'
  label: string
  icon: string
}[] = [
  { id: 'asc', label: 'Asc', icon: 'i-tabler-arrow-up' },
  { id: 'desc', label: 'Desc', icon: 'i-tabler-arrow-down' },
]

function underlineToSpace(s: string) {
  return s.replaceAll('_', ' ')
}

const show = ref(false)

// 默认排序 = 按 id / 降序 / 无颜色，等价于“无特定排序”。非默认时才提供取消入口。
const isNonDefaultSort = computed(() =>
  postSort.value !== 'id' || postSortOrder.value !== 'desc' || !!postSortColor.value,
)

function resetSort() {
  postSort.value = 'id'
  postSortOrder.value = 'desc'
  postSortColor.value = undefined
  show.value = false
}
</script>

<template>
  <div class="sort-group flex relative">
    <Popover
      v-model="show"
      position="bottom-end"
    >
      <PButton
        size="sm"
        class="sort-main-btn"
        :class="{ joined: isNonDefaultSort }"
        aria-label="Sort posts"
      >
        <i class="i-tabler-arrows-sort" aria-hidden="true" />
        <span
          v-if="!postSortColor"
          class="flex-grow"
        >
          Sort by
          <span class="font-bold">
            {{ underlineToSpace(postSort) }}
          </span>
        </span>
        <span
          v-else
          class="flex-grow"
        >
          <PColorSwatch :color="postSortColor" />
        </span>
      </PButton>
      <template #content>
        <div
          class="p-1 border border-border-default rounded bg-surface min-w-36 shadow-lg"
        >
          <div class="flex flex-col gap-1">
            <div class="mt-1 p-2 border border-border-default rounded flex gap-2 items-center">
              <div class="flex-grow">
                <label for="post-sort-color" class="text-xs text-fg-subtle mb-1 block">
                  Sort Color
                </label>
                <div class="flex gap-2 items-center">
                  <div
                    class="border border-border-default rounded h-6 w-6 overflow-hidden"
                    :style="{ backgroundColor: postSortColor || '#ffffff' }"
                  >
                    <input
                      id="post-sort-color"
                      v-model="postSortColor"
                      type="color"
                      aria-label="Sort color"
                      class="opacity-0 h-full w-full cursor-pointer"
                    >
                  </div>
                  <div class="text-xs font-mono">
                    {{ postSortColor?.toUpperCase() || 'None' }}
                  </div>
                </div>
              </div>
              <PButton
                v-if="postSortColor"
                icon
                variant="ghost"
                aria-label="Clear sort color"
                @click="postSortColor = undefined"
              >
                <i class="i-tabler-x" aria-hidden="true" />
              </PButton>
            </div>
            <div class="flex gap-1">
              <PButton
                v-for="order in orderOptions"
                :key="order.id"
                :disabled="!!postSortColor"
                size="sm"
                block
                :variant="postSortOrder === order.id && !postSortColor ? 'primary' : 'secondary'"
                @click="postSortOrder = order.id; show = false"
              >
                <i :class="order.icon" aria-hidden="true" />
                <span class="flex-grow">
                  {{ order.label }}
                </span>
              </PButton>
            </div>
            <PButton
              v-for="option in sortOptions"
              :key="option.id"
              size="sm"
              block
              :disabled="!!postSortColor"
              :variant="postSort === option.id && !postSortColor ? 'primary' : 'secondary'"
              @click="postSort = postSort === option.id ? 'id' : option.id; show = false"
            >
              <i :class="option.icon" aria-hidden="true" />
              <span class="flex-grow">
                {{ option.label }}
              </span>
            </PButton>
          </div>
        </div>
      </template>
    </Popover>
    <PButton
      v-if="isNonDefaultSort"
      size="sm"
      icon
      class="sort-reset-btn"
      aria-label="Reset sort"
      title="取消排序"
      @click="resetSort"
    >
      <i class="i-tabler-x" aria-hidden="true" />
    </PButton>
  </div>
</template>

<style scoped>
/* 取消排序按钮做成 Sort 主按钮的“附属”：去掉相邻侧圆角、让边框重叠，
   两个 sm 按钮拼成一个 segmented 复合按钮。仅在 X 存在(.joined)时抹平主按钮右圆角。 */
.sort-group :deep(.sort-main-btn.joined) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.sort-group :deep(.sort-reset-btn) {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  margin-left: -1px;
}
/* hover 时把该按钮的边框抬到上层，避免重叠处被相邻边框压住 */
.sort-group :deep(.p-btn:hover) {
  position: relative;
  z-index: 1;
}
</style>
