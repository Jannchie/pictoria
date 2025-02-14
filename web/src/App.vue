<script setup lang="ts">
import type { DirectorySummary } from '@/api'
import type { TreeListItemData } from './roku/TreeList.vue'
import { Btn, primaryColor, RokuProvider } from '@roku-ui/vue'
import { Pane, Splitpanes } from 'splitpanes'
import { RouterLink } from 'vue-router'
import { useWatchRoute } from './composables'
import TreeList from './roku/TreeList.vue'
import { showMenu, useCurrentFolder, useFoldersQuery } from './shared'
import 'splitpanes/dist/splitpanes.css'

useWatchRoute()

const currentFolder = useCurrentFolder()

primaryColor.value = '#A7A'

const foldersQuery = useFoldersQuery()
function convertPathToTree(path: DirectorySummary): TreeListItemData[] {
  if (!path) {
    return []
  }
  const children = path.children ?? []
  return children.map((child) => {
    if ((child.children?.length ?? 0) > 0) {
      return {
        title: child.name,
        children: convertPathToTree(child),
        value: child.path,
        open: currentFolder.value.startsWith(child.path),
      }
    }
    return {
      title: child.name,
      value: child.path,
    }
  })
}
const folderTree = computed(() => {
  if (!foldersQuery.data.value) {
    return []
  }
  return [{
    title: 'Root',
    value: '@',
  }, ...convertPathToTree(foldersQuery.data.value)]
})

const folderPath2Count = computed(() => {
  const f = foldersQuery.data.value
  if (!f) {
    return {}
  }
  const result: Record<string, number> = {}
  const count = (folder: DirectorySummary) => {
    if (folder.children) {
      folder.children.forEach((child) => {
        count(child)
      })
    }
    result[folder.path] = folder.file_count
  }
  count(f)
  return result
})

const indicatorClass = computed(() => {
  return ['before:absolute before:left-4 before:h-full before:border-r before:content-[""]']
})
const numberFormater = new Intl.NumberFormat('en-US')
</script>

<template>
  <!-- <ToastSystem /> -->
  <RokuProvider>
    <DropOverlay />
    <div class="h-100vh w-100vw flex flex-col select-none overflow-hidden">
      <FloatWindow v-model="showMenu">
        <div class="overflow-hidden rounded-lg bg-surface-base text-sm">
          <ListItem
            title="New Folder"
            icon="i-tabler-folder-plus"
          />
          <ListItem
            title="Delete Folder"
            icon="i-tabler-folder-x"
          />
        </div>
      </FloatWindow>
      <TagSelectorWindow />
      <!-- <DialogContainer /> -->
      <Splitpanes class="max-h-[calc(100vh-24px)]">
        <Pane
          :min-size="8"
          :size="12"
          :max-size="36"
          class="min-w-64 flex flex-col border-r border-surface p-2"
        >
          <div class="h-36px flex shrink-0 items-center justify-center text-xl font-black">
            Pictoria
          </div>
          <SpecialPathList />
          <ScrollArea>
            <TreeList
              :model-value="currentFolder"
              :items="folderTree"
            >
              <template #link="{ data, level }">
                <RouterLink
                  class="hover-source relative h-8 w-full flex flex cursor-pointer items-center gap-2 rounded-full focus-visible:bg-surface-variant-1 py-1 pr-1 focus-visible:outline-none"
                  :class="[
                    {
                      'hover:bg-surface-variant-1 hover:text-surface text-surface-dimmed': currentFolder !== data.value,
                      'text-primary bg-surface-variant-2': currentFolder === data.value,
                    },
                    indicatorClass,
                  ]"
                  :style="{
                    paddingLeft: `${32 + level * 8}px`,
                  }"
                  :to="`/dir/${data.value}`"
                >
                  <span class="w-full truncate">
                    {{ data.title }}
                  </span>

                  <span class="mx-2 text-xs">
                    {{ numberFormater.format(folderPath2Count[data.value] ?? 0) }}
                  </span>

                  <div class="hover-target">
                    <Btn
                      icon
                      size="sm"
                      rounded="full"
                      variant="transparent"
                      hover-variant="light"
                      color="surface"
                    >
                      <i class="i-tabler-dots-vertical" />
                    </Btn>
                  </div>
                </RouterLink>
              </template>
            </TreeList>
          </ScrollArea>
        </Pane>
        <Pane class="relative">
          <RouterView />
        </Pane>
        <Pane
          :min-size="12"
          :size="12"
          :max-size="36"
          class="min-w-64 border-l border-surface p-1"
        >
          <RightPanel />
        </Pane>
      </Splitpanes>
      <BottomBar />
    </div>
  </RokuProvider>
</template>

<style>
.splitpanes__splitter:hover:before {
  opacity: 1;
  background-color: #e0e0e0;
}
.splitpanes--vertical > .splitpanes__splitter:before {left: -4px;right: -4px;height: 100%;}
.splitpanes--vertical .splitpanes__pane {
    transition: none;
    overflow: unset;
}
.splitpanes__splitter {
  width: 4px;
}

.hover-target {
  display: none;
}
.hover-source:hover > .hover-target {
  display: block;
}
</style>
