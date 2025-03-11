<script setup lang="ts">
import { postSort, postSortOrder } from '@/shared'
import { Btn } from '@roku-ui/vue'
import { ref } from 'vue'

// Sort options data
const sortOptions: {
  id: 'created_at' | 'published_at' | 'score' | 'rating' | 'file_name'
  label: string
  icon: string
}[] = [
  { id: 'created_at', label: 'Created', icon: 'i-tabler-calendar-event' },
  { id: 'published_at', label: 'Published', icon: 'i-tabler-calendar-event' },
  { id: 'score', label: 'Score', icon: 'i-tabler-star' },
  { id: 'rating', label: 'Rating', icon: 'i-tabler-thumb-up' },
  { id: 'file_name', label: 'File name', icon: 'i-tabler-file' }
]

// Order options data
const orderOptions: {
  id: 'asc' | 'desc'
  label: string
  icon: string
}[] = [
  { id: 'asc', label: 'Asc', icon: 'i-tabler-arrow-up' },
  { id: 'desc', label: 'Desc', icon: 'i-tabler-arrow-down' }
]

function underlineToSpace(str: string) {
  return str.replace(/_/g, ' ')
}

const show = ref(false)
</script>

<template>
  <div class="relative">
    <Popover
      v-model="show"
      position="bottom-end"
    >
      <Btn
        size="sm"
      >
        <i class="i-tabler-arrows-sort" />
        <span class="flex-grow">
          Sort by
          <span class="font-bold">
            {{ underlineToSpace(postSort) }}
          </span>
        </span>
      </Btn>
      <template #content>
        <div
          class="min-w-36 border border-surface rounded bg-surface p-1"
        >
          <div
            class="flex flex-col gap-1"
          >
            <div class="flex gap-1">
              <Btn
                v-for="order in orderOptions"
                :key="order.id"
                size="sm"
                class="w-full"
                :variant="postSortOrder === order.id ? 'filled' : 'default'"
                @click="postSortOrder = order.id; show = false"
              >
                <i :class="order.icon" />
                <span class="flex-grow">
                  {{ order.label }}
                </span>
              </Btn>
            </div>
            <Btn
              v-for="option in sortOptions"
              :key="option.id"
              size="sm"
              class="w-full"
              @click="postSort = option.id; show = false"
            >
              <i :class="option.icon" />
              <span class="flex-grow">
                {{ option.label }}
              </span>
            </Btn>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>