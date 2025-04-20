<script setup lang="ts">
import { v2GetExtensionCount } from '@/api'
import { postFilter } from '@/shared'
import { Btn } from '@roku-ui/vue'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'

const ratingFilterData = computed({
  get() {
    return postFilter.value.extension
  },
  set(val: string[]) {
    postFilter.value.extension = val
  },
})
function hasExt(ext: string) {
  return ratingFilterData.value.includes(ext)
}
function onPointerDown(ext: string) {
  if (hasExt(ext)) {
    ratingFilterData.value = ratingFilterData.value.filter(s => s !== ext)
  }
  else {
    ratingFilterData.value = [...ratingFilterData.value, ext]
  }
}
const filterWithoutExtension = computed(() => {
  return {
    ...postFilter.value,
    extension: [],
  }
})

const extensionCountMutation = useQuery({
  queryKey: ['count', 'extension', filterWithoutExtension],
  queryFn: async () => {
    const resp = await v2GetExtensionCount({
      body: {
        ...postFilter.value,
      },
    })
    return resp.data
  },
})

const scoreCountList = computed(() => {
  const resp: Record<string, number> = {}
  const data = extensionCountMutation.data
  data.value?.forEach((d) => {
    resp[d.extension] = d.count
  })
  return resp
})

const extensions = computed(() => {
  return extensionCountMutation.data.value?.map(d => d.extension) ?? []
})

const btnText = computed(() => {
  const item = ratingFilterData.value
  if (item.length === 0) {
    return 'Extension'
  }
  else {
    return item.map(s => getExtensionName(s)).join(', ')
  }
})
function getExtensionName(ext: string) {
  return ext
}
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <Btn
        size="sm"
      >
        <i class="i-tabler-file" />
        <span class="flex-grow">
          {{ btnText }}
        </span>
      </Btn>
      <template #content>
        <div
          class="min-w-52 border border-surface rounded bg-surface p-1"
        >
          <div
            v-for="ext in extensions"
            :key="ext"
            class="w-full flex cursor-pointer items-center gap-2 rounded hover:bg-surface-variant-1 px-2 py-1 text-xs"
            @pointerdown="onPointerDown(ext)"
          >
            <Checkbox
              class="pointer-events-none flex-shrink-0"
              :model-value="hasExt(ext)"
            />
            <div class="h-16px flex flex-grow gap-1">
              <template v-if="ext === ''">
                Not Scored Yet
              </template>
              <template v-else>
                {{ getExtensionName(ext) }}
              </template>
            </div>
            <div
              v-if="scoreCountList[ext]"
              class="flex-shrink-0"
            >
              {{ scoreCountList[ext] }}
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
