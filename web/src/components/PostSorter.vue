<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { postSort, postSortColor, postSortOrder, textSearchQuery } from '@/shared'

const { t } = useI18n()

// Labels stored as message keys so a locale switch re-renders them.
const sortOptions: {
  id: 'created_at' | 'published_at' | 'updated_at' | 'score' | 'rating' | 'file_name' | 'waifu_score' | 'silva_score' | 'discrepancy'
  labelKey: string
  icon: string
}[] = [
  { id: 'created_at', labelKey: 'sort.created', icon: 'i-tabler-calendar-event' },
  { id: 'published_at', labelKey: 'sort.published', icon: 'i-tabler-calendar-event' },
  { id: 'updated_at', labelKey: 'sort.updated', icon: 'i-tabler-clock-edit' },
  { id: 'score', labelKey: 'sort.score', icon: 'i-tabler-star' },
  { id: 'rating', labelKey: 'sort.rating', icon: 'i-tabler-thumb-up' },
  { id: 'file_name', labelKey: 'sort.fileName', icon: 'i-tabler-file' },
  { id: 'waifu_score', labelKey: 'sort.waifuScore', icon: 'i-tabler-heart' },
  { id: 'silva_score', labelKey: 'sort.silvaScore', icon: 'i-tabler-rosette' },
  { id: 'discrepancy', labelKey: 'sort.discrepancy', icon: 'i-tabler-git-compare' },
]

const orderOptions: {
  id: 'asc' | 'desc'
  labelKey: string
  icon: string
}[] = [
  { id: 'asc', labelKey: 'sort.asc', icon: 'i-tabler-arrow-up' },
  { id: 'desc', labelKey: 'sort.desc', icon: 'i-tabler-arrow-down' },
]

// Localised label of the active sort; the default 'id' sort has no option
// entry and shows its raw name, matching the previous behaviour.
const currentSortLabel = computed(() => {
  const opt = sortOptions.find(o => o.id === postSort.value)
  return opt ? t(opt.labelKey) : postSort.value
})

const show = ref(false)

// 文本搜索结果由后端按相关度排序，排序选项全部失效 —— 按钮降级为
// “按 相关度” 的禁用态，避免界面暗示排序仍然生效。
const sortOverriddenBySearch = computed(() => textSearchQuery.value.trim().length > 0)

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
    <PButton
      v-if="sortOverriddenBySearch"
      size="sm"
      disabled
      :title="$t('sort.searchOverride')"
      :aria-label="$t('sort.searchOverride')"
    >
      <i class="i-tabler-arrows-sort" aria-hidden="true" />
      <span class="flex-grow">
        {{ $t('sort.sortBy') }}
        <span class="font-bold">
          {{ $t('sort.relevance') }}
        </span>
      </span>
    </PButton>
    <PPopover
      v-else
      v-model="show"
      position="bottom-end"
    >
      <PButton
        size="sm"
        class="sort-main-btn"
        :class="{ joined: isNonDefaultSort }"
        :aria-label="$t('sort.sortPosts')"
      >
        <i class="i-tabler-arrows-sort" aria-hidden="true" />
        <span
          v-if="!postSortColor"
          class="flex-grow"
        >
          {{ $t('sort.sortBy') }}
          <span class="font-bold">
            {{ currentSortLabel }}
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
          class="p-popover-panel min-w-36"
        >
          <div class="flex flex-col gap-1">
            <div class="mt-1 p-2 border border-border-default rounded flex gap-2 items-center">
              <div class="flex-grow">
                <label for="post-sort-color" class="text-xs text-fg-subtle mb-1 block">
                  {{ $t('sort.sortColor') }}
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
                      :aria-label="$t('sort.sortColor')"
                      class="opacity-0 h-full w-full cursor-pointer"
                    >
                  </div>
                  <div class="text-xs font-mono">
                    {{ postSortColor?.toUpperCase() || $t('sort.colorNone') }}
                  </div>
                </div>
              </div>
              <PButton
                v-if="postSortColor"
                icon
                variant="ghost"
                :aria-label="$t('sort.clearSortColor')"
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
                  {{ $t(order.labelKey) }}
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
                {{ $t(option.labelKey) }}
              </span>
            </PButton>
          </div>
        </div>
      </template>
    </PPopover>
    <PButton
      v-if="isNonDefaultSort && !sortOverriddenBySearch"
      size="sm"
      icon
      class="sort-reset-btn"
      :aria-label="$t('sort.resetSort')"
      :title="$t('sort.resetSort')"
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
