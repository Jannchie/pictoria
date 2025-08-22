<script setup lang="ts">
import { Btn } from '@roku-ui/vue'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { v2GetExtensionCount } from '@/api'
import { postFilter } from '@/shared'

const ratingFilterData = computed({
  get() {
    return postFilter.value.extension
  },
  set(value: string[]) {
    postFilter.value.extension = value
  },
})
function hasExt(extension: string) {
  return ratingFilterData.value.includes(extension)
}
function onPointerDown(extension: string) {
  ratingFilterData.value = hasExt(extension) ? ratingFilterData.value.filter(s => s !== extension) : [...ratingFilterData.value, extension]
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
        ...filterWithoutExtension.value, // 使用不包含自己筛选条件的过滤器
      },
    })
    return resp.data
  },
})

const scoreCountList = computed(() => {
  const resp: Record<string, number> = {}
  const data = extensionCountMutation.data
  if (data.value) {
    for (const d of data.value) {
      resp[d.extension] = d.count
    }
  }
  return resp
})

// 确保已选择的扩展名选项始终显示在列表中
const extensions = computed(() => {
  // 从API获取的扩展名列表
  const apiExtensions = extensionCountMutation.data.value?.map(d => d.extension) ?? []

  // 已选择的扩展名（可能不在API结果中）
  const selectedExtensions = ratingFilterData.value

  // 合并并去重
  return [...new Set([...apiExtensions, ...selectedExtensions])]
})

const btnText = computed(() => {
  const item = ratingFilterData.value
  return item.length === 0 ? 'Extension' : item.map(s => getExtensionName(s)).join(', ')
})
function getExtensionName(extension: string) {
  return extension
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
          class="p-1 border border-surface rounded bg-surface min-w-52"
        >
          <div
            v-for="ext in extensions"
            :key="ext"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-variant-1"
            @pointerdown="onPointerDown(ext)"
          >
            <Checkbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasExt(ext)"
            />
            <div class="flex flex-grow gap-1 h-16px">
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
            <div
              v-else-if="hasExt(ext)"
              class="text-gray-400 flex-shrink-0"
            >
              0
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
