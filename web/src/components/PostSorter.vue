<script setup lang="ts">
import { Btn, ColorSwatch } from '@roku-ui/vue'
import { ref } from 'vue'
import { postSort, postSortColor, postSortOrder } from '@/shared'

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
  { id: 'file_name', label: 'File name', icon: 'i-tabler-file' },
]

// Order options data
const orderOptions: {
  id: 'asc' | 'desc'
  label: string
  icon: string
}[] = [
  { id: 'asc', label: 'Asc', icon: 'i-tabler-arrow-up' },
  { id: 'desc', label: 'Desc', icon: 'i-tabler-arrow-down' },
]

function underlineToSpace(string_: string) {
  return string_.replaceAll('_', ' ')
}

const show = ref(false)
</script>

<template>
  <div class="flex gap-2 relative">
    <Popover
      v-model="show"
      position="bottom-end"
    >
      <Btn
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
          <ColorSwatch
            :color="postSortColor"
          />

        </span>
      </Btn>
      <template #content>
        <div
          class="bg-base border-base p-1 border rounded min-w-36"
        >
          <div
            class="flex flex-col gap-1"
          >
            <div class="border-base mt-1 p-2 border rounded flex gap-2 items-center">
              <div class="flex-grow">
                <div class="text-muted text-xs mb-1">
                  Sort Color
                </div>
                <div class="flex gap-2 items-center">
                  <div
                    class="border-base border rounded h-6 w-6 overflow-hidden"
                    :style="{ backgroundColor: postSortColor || '#ffffff' }"
                  >
                    <input
                      v-model="postSortColor"
                      type="color"
                      class="opacity-0 h-full w-full cursor-pointer"
                    >
                  </div>
                  <div class="text-xs font-mono">
                    {{ postSortColor?.toUpperCase() || 'None' }}
                  </div>
                </div>
              </div>
              <Btn
                v-if="postSortColor"
                icon
                variant="transparent"
                color="surface"
                @click="postSortColor = undefined"
              >
                <i class="i-tabler-x" />
              </Btn>
            </div>
            <div class="flex gap-1">
              <Btn
                v-for="order in orderOptions"
                :key="order.id"
                :disabled="!!postSortColor"
                size="sm"
                class="w-full"
                :variant="postSortOrder === order.id && !postSortColor ? 'filled' : 'default'"
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
              :disabled="!!postSortColor"
              :variant="postSort === option.id && !postSortColor ? 'filled' : 'default'"
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
