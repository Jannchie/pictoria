<script setup lang="ts">
import type { TreeListItemData } from './roku/TreeList.vue'
import type { DirectorySummary } from '@/api'
import { Pane, Splitpanes } from 'splitpanes'
import { RouterLink, useRoute } from 'vue-router'
import { useWatchRoute } from './composables'
import TreeList from './roku/TreeList.vue'
import { showMenu, useCurrentFolder, useFoldersQuery } from './shared'
import 'splitpanes/dist/splitpanes.css'

useWatchRoute()

const currentFolder = useCurrentFolder()

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
      for (const child of folder.children) {
        count(child)
      }
    }
    result[folder.path] = folder.file_count
  }
  count(f)
  return result
})

const indicatorClass = computed(() => {
  return ['before:absolute before:left-4 before:h-full before:border-r before:border-border-default before:content-[""]']
})
const numberFormater = new Intl.NumberFormat('en-US')
const route = useRoute()
const folderStr = computed(() => {
  if (!route.params.folder) {
    return ''
  }
  if (Array.isArray(route.params.folder)) {
    return route.params.folder.join('/')
  }
  return route.params.folder
})
</script>

<template>
  <DropOverlay />
  <div class="h-100vh w-100vw flex flex-col select-none overflow-hidden bg-bg text-fg">
    <FloatWindow v-model="showMenu">
      <div class="overflow-hidden border border-border-default rounded-lg bg-surface text-sm shadow-lg">
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
    <Splitpanes class="max-h-[calc(100vh-24px)]">
      <Pane
        :min-size="8"
        :size="12"
        :max-size="36"
        class="min-w-64 flex flex-col border-r border-border-default p-2"
      >
        <div class="h-36px flex shrink-0 items-center justify-center gap-2 text-xl font-semibold tracking-tight">
          <img
            src="/Pictoria.svg"
            alt=""
            class="h-5 w-5"
          >
          <span>Pictoria</span>
        </div>
        <SpecialPathList />
        <ScrollArea class="flex-grow py-2">
          <TreeList
            :model-value="currentFolder"
            :items="folderTree"
          >
            <template #collapse="{ data, level }">
              <RouterLink
                :to="`/dir/${data.value}`"
                class="relative h-8 w-full flex cursor-pointer items-center gap-2 rounded-full py-1 pr-1 focus-visible:bg-surface-1 focus-visible:outline-none"
                :class="[{
                  'hover:bg-surface-1 hover:text-fg text-fg-muted': folderStr !== data.value,
                  'text-primary bg-surface-2': folderStr === data.value,
                }]"
                :style="{
                  paddingLeft: `${32 + level * 8}px`,
                }"
                @click="data.open = true"
              >
                <i
                  class="i-tabler-chevron-down absolute left-2 h-4 w-4 py-1 transition-transform"
                  :class="[
                    data.open ? 'rotate-0' : '-rotate-90',
                  ]"
                />
                <i
                  v-if="data.icon"
                  class="h-4 w-4 py-1"
                  :class="[
                    data.icon,
                  ]"
                />
                <span class="truncate">
                  {{ data.title }}
                </span>
              </RouterLink>
            </template>
            <template #link="{ data, level }">
              <RouterLink
                class="hover-source relative h-8 w-full flex cursor-pointer items-center gap-2 rounded-full py-1 pr-1 focus-visible:bg-surface-1 focus-visible:outline-none"
                :class="[
                  {
                    'hover:bg-surface-1 hover:text-fg text-fg-muted': folderStr !== data.value,
                    'text-primary bg-surface-2': folderStr === data.value,
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
                  <PButton
                    icon
                    size="sm"
                    rounded="full"
                    variant="ghost"
                  >
                    <i class="i-tabler-dots-vertical" />
                  </PButton>
                </div>
              </RouterLink>
            </template>
          </TreeList>
        </ScrollArea>
        <ListItem
          class="text-sm"
          icon="i-tabler-settings"
          :active="$route.path === '/settings'"
          title="Settings"
          @click="$router.push('/settings')"
        />
      </Pane>
      <Pane class="relative">
        <RouterView />
      </Pane>
      <Pane
        :min-size="12"
        :size="12"
        :max-size="36"
        class="min-w-64 border-l border-border-default p-1"
      >
        <RightPanel />
      </Pane>
    </Splitpanes>
    <BottomBar />
  </div>
</template>

<style scoped>
.hover-target {
  display: none;
}
.hover-source:hover > .hover-target {
  display: block;
}
</style>

<!-- splitpanes overrides must be global: the third-party component's internal
     class names (.splitpanes__splitter, .splitpanes__pane) live outside this
     component's scope, so scoped selectors cannot reach them. -->
<style>
.splitpanes__splitter:hover:before {
  opacity: 1;
  background-color: var(--p-border-strong);
}
.splitpanes--vertical > .splitpanes__splitter:before {left: -4px;right: -4px;height: 100%;}
.splitpanes--vertical .splitpanes__pane {
    transition: none;
    overflow: unset;
}
.splitpanes__splitter {
  width: 4px;
}
</style>
