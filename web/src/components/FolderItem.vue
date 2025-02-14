<script setup lang="ts">
import type { DirectorySummary } from '@/api'
import { menuData, postFilter, selectedPostIdSet, showPost } from '@/shared'
import { ref } from 'vue'

const props = defineProps<{
  folder: DirectorySummary
  depth: number
}>()
const collapsed = ref(props.folder.children?.length !== 0)
const folderItemRef = ref<HTMLElement | null>(null)
function onContextmenu(_: MouseEvent) {
  menuData.value = null
  nextTick(() => {
    menuData.value = {
      type: 'folder',
      path: props.folder.path,
    }
  })
}
// on drop
useEventListener(folderItemRef, 'drop', (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  const selected = selectedPostIdSet.value
  selected.values()
})
</script>

<template>
  <div
    @contextmenu.prevent.stop="onContextmenu"
  >
    <div
      class="flex flex-shrink-0 items-center gap-0.5"
      :class="{
        'border-l border-surface': depth !== 0,
      }"
    >
      <ListItem
        ref="folderItemRef"
        class="flex-grow"
        :active="postFilter.folder === folder.path"
        :icon="collapsed || postFilter.folder === folder.path ? 'i-tabler-folder-open' : 'i-tabler-folder'"
        :title="folder.name "
        :extra-info="folder.file_count"
        @click="$router.push(`/dir/${folder.path === '.' ? '@' : folder.path}`); showPost = null"
        @dblclick="collapsed = !collapsed"
      />
    </div>
    <div
      v-if="collapsed"
      class="pl-2"
    >
      <FolderItem
        v-for="subFolder in folder.children"
        :key="subFolder.path"
        :folder="subFolder"
        :depth="depth + 1"
      />
    </div>
  </div>
</template>
