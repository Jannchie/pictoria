<script setup lang="ts">
import { ref } from 'vue'
import { postSort, postSortColor, postSortOrder } from '@/shared'

const sortOptions: {
  id: 'created_at' | 'published_at' | 'score' | 'rating' | 'file_name'
  label: string
  icon: string
}[] = [
  { id: 'created_at', label: 'Created', icon: 'i-tabler-calendar-event' },
  { id: 'published_at', label: 'Published', icon: 'i-tabler-calendar-event' },
  { id: 'score', label: 'Score', icon: 'i-tabler-star' },
  { id: 'rating', label: 'Rating', icon: 'i-tabler-thumb-up' },
  { id: 'file_name', label: 'File name', icon: 'i-tabler-file' },
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
</script>

<template>
  <div class="relative flex gap-2">
    <Popover
      v-model="show"
      position="bottom-end"
    >
      <PButton
        size="sm"
      >
        <i class="i-tabler-arrows-sort" />
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
          class="min-w-36 border border-border-default rounded bg-surface p-1 shadow-lg"
        >
          <div class="flex flex-col gap-1">
            <div class="mt-1 flex items-center gap-2 border border-border-default rounded p-2">
              <div class="flex-grow">
                <div class="mb-1 text-xs text-fg-subtle">
                  Sort Color
                </div>
                <div class="flex items-center gap-2">
                  <div
                    class="h-6 w-6 overflow-hidden border border-border-default rounded"
                    :style="{ backgroundColor: postSortColor || '#ffffff' }"
                  >
                    <input
                      v-model="postSortColor"
                      type="color"
                      class="h-full w-full cursor-pointer opacity-0"
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
                @click="postSortColor = undefined"
              >
                <i class="i-tabler-x" />
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
                <i :class="order.icon" />
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
              @click="postSort = option.id; show = false"
            >
              <i :class="option.icon" />
              <span class="flex-grow">
                {{ option.label }}
              </span>
            </PButton>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
