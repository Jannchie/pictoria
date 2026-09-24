<script setup lang="ts">
import { computed, ref, useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { activateOptionOnKey } from '@/composables/useFacetFilter'
import { useRovingFocus } from '@/composables/useRovingFocus'
import { postSort, postSortColor, postSortOrder, textSearchQuery } from '@/shared'

const { t } = useI18n()

// Labels stored as message keys so a locale switch re-renders them.
const sortOptions: {
  id: 'created_at' | 'published_at' | 'updated_at' | 'score' | 'rating' | 'file_name' | 'waifu_score' | 'silva_score' | 'silva_luna_score' | 'discrepancy'
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
  { id: 'silva_luna_score', labelKey: 'sort.silvaLunaScore', icon: 'i-tabler-moon' },
  { id: 'discrepancy', labelKey: 'sort.discrepancy', icon: 'i-tabler-git-compare' },
]

const orderOptions: {
  id: 'asc' | 'desc'
  labelKey: string
  /** Unabbreviated spoken name ("Ascending" for the visible "Asc"). */
  ariaKey: string
  icon: string
}[] = [
  { id: 'asc', labelKey: 'sort.asc', ariaKey: 'sort.ascending', icon: 'i-tabler-arrow-up' },
  { id: 'desc', labelKey: 'sort.desc', ariaKey: 'sort.descending', icon: 'i-tabler-arrow-down' },
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

// Trigger name: the visible text drops the direction (and becomes a bare
// swatch under colour sort), so spell the whole ordering out for AT.
const triggerLabel = computed(() => {
  if (postSortColor.value) {
    return t('sort.triggerColor', { color: postSortColor.value.toUpperCase() })
  }
  const order = orderOptions.find(o => o.id === postSortOrder.value)
  return t('sort.triggerSummary', { field: currentSortLabel.value, order: order ? t(order.ariaKey) : postSortOrder.value })
})

// Sort field = single-select listbox: arrows / Home / End / typeahead move
// focus, Enter / Space / click pick it and close the popover (picking the
// current field again returns to the default order, as before). Not a radio
// group on purpose — APG radios check on arrow, and every check here closes
// the popover and refetches the gallery.
const fieldListId = useId()
const fieldHintId = useId()
const fieldList = useTemplateRef<HTMLElement>('fieldList')
useRovingFocus({ container: fieldList, itemSelector: '[role=option]', typeahead: true })
const fieldDisabled = computed(() => !!postSortColor.value)
const autofocusFieldIndex = computed(() => {
  const i = sortOptions.findIndex(o => o.id === postSort.value)
  return i === -1 ? 0 : i
})

function pickField(id: typeof sortOptions[number]['id']) {
  if (fieldDisabled.value) {
    return
  }
  postSort.value = postSort.value === id ? 'id' : id
  show.value = false
}

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
      variant="ghost"
      disabled
      :title="$t('sort.searchOverride')"
      :aria-label="$t('sort.searchOverride')"
    >
      <i class="i-tabler-arrows-sort" aria-hidden="true" />
      <span class="flex-grow">
        {{ $t('sort.sortBy') }}
        <span class="font-semibold">
          {{ $t('sort.relevance') }}
        </span>
      </span>
    </PButton>
    <PPopover
      v-else
      v-model="show"
      position="bottom-end"
    >
      <!-- Same rest/active vocabulary as the facet buttons to its left: ghost
           until a non-default sort is applied, then the primary wash. -->
      <PButton
        size="sm"
        class="sort-main-btn"
        :variant="isNonDefaultSort ? 'subtle' : 'secondary'"
        :active="show"
        :class="{ joined: isNonDefaultSort }"
        :aria-label="triggerLabel"
      >
        <i class="i-tabler-arrows-sort" aria-hidden="true" />
        <span
          v-if="!postSortColor"
          class="flex-grow"
        >
          {{ $t('sort.sortBy') }}
          <span class="font-semibold">
            {{ currentSortLabel }}
          </span>
        </span>
        <span
          v-else
          class="flex-grow"
        >
          <PColorSwatch :color="postSortColor" aria-hidden="true" />
        </span>
      </PButton>
      <template #content>
        <div
          class="p-popover-panel min-w-44"
        >
          <!-- Colour sort: a divider-separated group, not a boxed sub-panel. -->
          <div class="px-2 pb-2 pt-1 p-divider flex gap-2 items-center">
            <div class="flex-grow">
              <label for="post-sort-color" class="text-xs text-fg-subtle mb-1 block">
                {{ $t('sort.sortColor') }}
              </label>
              <div class="flex gap-2 items-center">
                <div
                  class="border border-border-default rounded h-5 w-5 overflow-hidden"
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
                <div class="text-xs font-mono" :class="postSortColor ? 'text-fg' : 'text-fg-subtle'">
                  {{ postSortColor?.toUpperCase() || $t('sort.colorNone') }}
                </div>
              </div>
            </div>
            <PButton
              v-if="postSortColor"
              icon
              size="sm"
              variant="ghost"
              :aria-label="$t('sort.clearSortColor')"
              @click="postSortColor = undefined"
            >
              <i class="i-tabler-x" aria-hidden="true" />
            </PButton>
          </div>
          <!-- Direction: two toggle buttons, the current one pressed. -->
          <div
            role="group"
            :aria-label="$t('sort.orderGroup')"
            class="my-1 pb-1 p-divider flex gap-1"
          >
            <PButton
              v-for="order in orderOptions"
              :key="order.id"
              :disabled="!!postSortColor"
              size="sm"
              block
              :variant="postSortOrder === order.id && !postSortColor ? 'subtle' : 'ghost'"
              :aria-pressed="postSortOrder === order.id && !postSortColor"
              :aria-label="$t(order.ariaKey)"
              @click="postSortOrder = order.id; show = false"
            >
              <i :class="order.icon" aria-hidden="true" />
              <span class="flex-grow">
                {{ $t(order.labelKey) }}
              </span>
            </PButton>
          </div>
          <!-- Same look as PListItem (primary wash for the current field), but
               an ARIA option: PListItem is a plain clickable div. -->
          <div
            :id="fieldListId"
            ref="fieldList"
            role="listbox"
            :aria-label="$t('sort.fieldList')"
            :aria-describedby="fieldDisabled ? fieldHintId : undefined"
            class="flex flex-col"
            :class="{ 'op-50 pointer-events-none': fieldDisabled }"
          >
            <div
              v-for="(option, i) in sortOptions"
              :key="option.id"
              role="option"
              :aria-selected="postSort === option.id && !fieldDisabled"
              :aria-disabled="fieldDisabled || undefined"
              :data-autofocus="(!fieldDisabled && i === autofocusFieldIndex) || undefined"
              class="px-2.5 rounded flex gap-2 min-h-7 w-full cursor-pointer transition-colors items-center focus-visible:[outline-offset:-2px]"
              :class="postSort === option.id && !fieldDisabled
                ? 'text-fg bg-primary/10 font-medium hover:bg-primary/15'
                : 'text-fg-muted hover:text-fg hover:bg-surface-1'"
              @click="pickField(option.id)"
              @keydown="activateOptionOnKey($event, () => pickField(option.id))"
            >
              <i
                class="flex-shrink-0 h-4 w-4"
                :class="[option.icon, postSort === option.id && !fieldDisabled ? 'text-primary' : 'text-fg-subtle']"
                aria-hidden="true"
              />
              <div class="flex-grow truncate">
                {{ $t(option.labelKey) }}
              </div>
            </div>
          </div>
          <span
            v-if="fieldDisabled"
            :id="fieldHintId"
            class="sr-only"
          >{{ $t('sort.fieldDisabledByColor') }}</span>
        </div>
      </template>
    </PPopover>
    <PButton
      v-if="isNonDefaultSort && !sortOverriddenBySearch"
      size="sm"
      icon
      variant="subtle"
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
/* 取消排序按钮做成 Sort 主按钮的“附属”：去掉相邻侧圆角，两个 sm 按钮拼成一个
   segmented 复合按钮。仅在 X 存在(.joined)时抹平主按钮右圆角。 */
.sort-group :deep(.sort-main-btn.joined) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.sort-group :deep(.sort-reset-btn) {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  margin-left: 1px;
}
</style>
