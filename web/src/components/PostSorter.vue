<script setup lang="ts">
import { postSort, postSortOrder } from '@/shared'
import { Btn } from '@roku-ui/vue'
import { ref } from 'vue'

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
          Sort by {{ postSort }}
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
                size="sm"
                class="w-full"
                :variant="postSortOrder === 'asc' ? 'filled' : 'default'"
                @click="postSortOrder = 'asc'; show = false"
              >
                <i class="i-tabler-arrow-up" />
                <span class="flex-grow">
                  Asc
                </span>
              </Btn>
              <Btn
                size="sm"
                class="w-full"
                :variant="postSortOrder === 'desc' ? 'filled' : 'default'"
                @click="postSortOrder = 'desc'; show = false"
              >
                <i class="i-tabler-arrow-down" />
                <span class="flex-grow">
                  Desc
                </span>
              </Btn>
            </div>
            <Btn
              size="sm"
              class="w-full"
              @click="postSort = 'created_at'; show = false"
            >
              <i class="i-tabler-calendar-event" />
              <span class="flex-grow">
                Created
              </span>
            </Btn>
            <Btn
              size="sm"
              class="w-full"
              @click="postSort = 'score'; show = false"
            >
              <i class="i-tabler-star" />
              <span class="flex-grow">
                Score
              </span>
            </Btn>
            <Btn
              size="sm"
              class="w-full"
              @click="postSort = 'rating'; show = false"
            >
              <i class="i-tabler-thumb-up" />
              <span class="flex-grow">
                Rating
              </span>
            </Btn>
            <Btn
              size="sm"
              class="w-full"
              @click="postSort = 'file_name'; show = false"
            >
              <i class="i-tabler-file" />
              <span class="flex-grow">
                File name
              </span>
            </Btn>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
