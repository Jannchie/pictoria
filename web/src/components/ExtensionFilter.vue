<script setup lang="ts">
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
      <PButton
        size="sm"
      >
        <i class="i-tabler-file" />
        <span class="flex-grow">
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <div
          class="min-w-52 border border-border-default rounded bg-surface p-1 shadow-lg"
        >
          <div
            v-for="ext in extensions"
            :key="ext"
            class="w-full flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-surface-2"
            @pointerdown="onPointerDown(ext)"
          >
            <Checkbox
              class="pointer-events-none flex-shrink-0"
              :model-value="hasExt(ext)"
            />
            <div class="flex flex-grow items-center gap-1">
              <template v-if="ext === ''">
                <span class="text-fg-subtle italic">No extension</span>
              </template>
              <template v-else>
                <span class="font-mono">.{{ getExtensionName(ext) }}</span>
              </template>
            </div>
            <div
              v-if="scoreCountList[ext]"
              class="flex-shrink-0 text-fg-muted tabular-nums"
            >
              {{ scoreCountList[ext] }}
            </div>
            <div
              v-else-if="hasExt(ext)"
              class="flex-shrink-0 text-fg-subtle tabular-nums"
            >
              0
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
