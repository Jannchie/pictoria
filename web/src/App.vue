<script setup lang="ts">
import type { TreeListCollapseData, TreeListItemData, TreeListLeafData } from './roku/TreeList.vue'
import type { DirectorySummary } from '@/api'
import { Pane, Splitpanes } from 'splitpanes'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useWatchRoute } from './composables'
import TreeList from './roku/TreeList.vue'
import { menuData, showMenu, useCurrentFolder, useFoldersQuery } from './shared'
import 'splitpanes/dist/splitpanes.css'

useWatchRoute()

const currentFolder = useCurrentFolder()
const router = useRouter()
const foldersQuery = useFoldersQuery()

const folderFilter = ref('')

function convertPathToTree(path: DirectorySummary): TreeListItemData[] {
  const children = path.children ?? []
  return children.map((child): TreeListItemData => {
    if ((child.children?.length ?? 0) > 0) {
      return {
        title: child.name,
        value: child.path,
        count: child.file_count,
        children: convertPathToTree(child),
      }
    }
    return {
      title: child.name,
      value: child.path,
      count: child.file_count,
    }
  })
}

const folderTree = computed<TreeListItemData[]>(() => {
  const root = foldersQuery.data.value
  if (!root) {
    return []
  }
  return [
    {
      title: 'Root',
      value: '@',
      icon: 'i-tabler-home',
      count: root.file_count,
    },
    ...convertPathToTree(root),
  ]
})

// Ancestor chain of the active folder — TreeList draws the matching guide
// line in primary tint so the user can see where they are inside the tree.
const highlightChain = computed(() => {
  const path = currentFolder.value
  if (!path || path === '@') {
    return []
  }
  const segments = path.split('/').filter(Boolean)
  const chain: string[] = []
  let acc = ''
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg
    chain.push(acc)
  }
  return chain
})

// Persisted open set lives in component state so manual expand/collapse
// survives data refetches (the old impl mutated input items and lost state).
const openPaths = ref(new Set<string>())

// Whenever the current route's folder changes, open its ancestors so the
// selected row is always visible without forcing every other branch open.
watch(currentFolder, (path) => {
  if (!path) {
    return
  }
  const segments = path.split('/').filter(Boolean)
  const next = new Set(openPaths.value)
  let acc = ''
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg
    next.add(acc)
  }
  if (next.size !== openPaths.value.size) {
    openPaths.value = next
  }
}, { immediate: true })

const numberFormater = new Intl.NumberFormat('en-US')

// Right-click on a folder row — fills menuData which the FloatWindow opens
// at the cursor position. The window-level showMenu state already lived in
// shared/.
const contextTarget = ref<TreeListLeafData | TreeListCollapseData | null>(null)
function onItemContext({ data }: { data: TreeListLeafData | TreeListCollapseData, event: MouseEvent }) {
  contextTarget.value = data
  menuData.value = data
}
function closeMenu() {
  menuData.value = null
}
async function revealInExplorer() {
  closeMenu()
}
async function copyPath() {
  if (!contextTarget.value?.value) {
    return
  }
  await navigator.clipboard.writeText(contextTarget.value.value).catch(() => {})
  closeMenu()
}
function openFolder() {
  if (!contextTarget.value?.value) {
    return
  }
  router.push(`/dir/${contextTarget.value.value}`)
  closeMenu()
}

function clearFilter() {
  folderFilter.value = ''
}

interface HighlightPart { text: string, match: boolean }
function splitHighlight(text: string, filter: string): HighlightPart[] {
  const f = filter.trim().toLowerCase()
  if (!f) {
    return [{ text, match: false }]
  }
  const lower = text.toLowerCase()
  const i = lower.indexOf(f)
  if (i === -1) {
    return [{ text, match: false }]
  }
  return [
    { text: text.slice(0, i), match: false },
    { text: text.slice(i, i + f.length), match: true },
    { text: text.slice(i + f.length), match: false },
  ]
}
</script>

<template>
  <DropOverlay />
  <div
    class="text-fg bg-bg flex flex-col h-100vh w-100vw select-none overflow-hidden"
  >
    <FloatWindow v-model="showMenu">
      <div class="text-sm border border-border-default rounded-lg bg-surface min-w-44 shadow-lg overflow-hidden">
        <div class="text-xs text-fg-subtle tracking-wide font-semibold px-3 py-2 border-b border-border-subtle uppercase">
          <span class="max-w-60 block truncate">{{ contextTarget?.title ?? '操作' }}</span>
        </div>
        <ListItem
          title="打开此目录"
          icon="i-tabler-folder-open"
          @click="openFolder"
        />
        <ListItem
          title="复制路径"
          icon="i-tabler-copy"
          @click="copyPath"
        />
        <ListItem
          title="在系统中显示"
          icon="i-tabler-external-link"
          @click="revealInExplorer"
        />
        <div class="my-1 border-t border-border-subtle" />
        <ListItem
          title="新建子目录"
          icon="i-tabler-folder-plus"
        />
        <ListItem
          title="删除目录"
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
        class="border-r border-border-default flex flex-col min-w-64"
      >
        <div class="text-xl tracking-tight font-semibold px-3 py-3 flex shrink-0 gap-2 items-center justify-center">
          <img
            src="/Pictoria.svg"
            alt=""
            class="h-5 w-5"
          >
          <span>Pictoria</span>
        </div>
        <div class="px-2 pb-2">
          <SpecialPathList />
        </div>
        <div class="px-2 pb-2">
          <div class="relative">
            <i class="i-tabler-search text-fg-subtle h-3.5 w-3.5 left-2.5 top-1/2 absolute -translate-y-1/2" />
            <input
              v-model="folderFilter"
              placeholder="过滤目录…"
              class="text-sm text-fg pl-8 pr-7 outline-none border border-border-subtle rounded-md bg-surface h-8 w-full transition-colors focus:border-primary/50 hover:border-border-default focus:bg-bg"
              @keydown.escape="clearFilter"
            >
            <button
              v-if="folderFilter"
              class="text-fg-subtle rounded flex h-5 w-5 transition-colors items-center right-1.5 top-1/2 justify-center absolute hover:text-fg hover:bg-surface-1 -translate-y-1/2"
              @click="clearFilter"
            >
              <i class="i-tabler-x h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <ScrollArea class="px-2 pb-1 flex-grow">
          <TreeList
            :model-value="currentFolder"
            :open-paths="openPaths"
            :items="folderTree"
            :filter="folderFilter"
            :highlight-chain="highlightChain"
            :loading="foldersQuery.isPending.value && folderTree.length === 0"
            empty-text="没有匹配的目录"
            @update:open-paths="(v) => (openPaths = v)"
            @item-context="onItemContext"
          >
            <template #collapse="{ data, level, isOpen, isSelected, inChain, toggle }">
              <RouterLink
                :to="`/dir/${data.value}`"
                tabindex="0"
                :data-tree-value="data.value"
                :title="data.value"
                class="group/row text-sm pr-1 rounded-md flex gap-1.5 h-8 w-full cursor-pointer transition-colors items-center relative focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:ring-inset"
                :class="[
                  isSelected ? 'text-fg bg-primary/10' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
                ]"
                :style="{ paddingLeft: `${16 + level * 14}px` }"
                @contextmenu.prevent="onItemContext({ data, event: $event })"
              >
                <span
                  v-for="i in level"
                  :key="i"
                  class="w-px pointer-events-none bottom-0 top-0 absolute"
                  :class="[
                    inChain && i === level ? 'bg-primary/40' : 'bg-border-subtle',
                  ]"
                  :style="{ left: `${10 + (i - 1) * 14}px` }"
                />
                <span
                  v-if="isSelected"
                  class="rounded-r-full bg-primary w-[2px] pointer-events-none bottom-1.5 left-0 top-1.5 absolute"
                />
                <button
                  type="button"
                  class="text-fg-subtle rounded flex shrink-0 h-3.5 w-3.5 transition items-center justify-center hover:text-fg hover:bg-surface-2"
                  :style="{ marginLeft: '-14px' }"
                  :aria-label="isOpen ? '收起' : '展开'"
                  @click.stop.prevent="toggle"
                >
                  <i
                    class="i-tabler-chevron-down h-3 w-3 transition-transform"
                    :class="[isOpen ? 'rotate-0' : '-rotate-90']"
                  />
                </button>
                <span class="truncate">
                  <template
                    v-for="(part, i) in splitHighlight(data.title, folderFilter)"
                    :key="i"
                  >
                    <mark
                      v-if="part.match"
                      class="text-fg px-0.5 rounded-sm bg-primary/30"
                    >{{ part.text }}</mark>
                    <template v-else>{{ part.text }}</template>
                  </template>
                </span>
                <span
                  class="text-[10px] font-mono ml-auto px-1.5 py-0.5 rounded shrink-0 transition-colors tabular-nums"
                  :class="[
                    isSelected ? 'bg-primary/15 text-primary' : 'text-fg-subtle group-hover/row:text-fg-muted',
                  ]"
                >
                  {{ numberFormater.format(data.count ?? 0) }}
                </span>
              </RouterLink>
            </template>
            <template #link="{ data, level, isSelected, inChain }">
              <RouterLink
                :to="`/dir/${data.value}`"
                tabindex="0"
                :data-tree-value="data.value"
                :title="data.value"
                class="group/row text-sm pr-1 rounded-md flex gap-1.5 h-8 w-full cursor-pointer transition-colors items-center relative focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:ring-inset"
                :class="[
                  isSelected ? 'text-fg bg-primary/10' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
                ]"
                :style="{ paddingLeft: `${16 + level * 14}px` }"
                @contextmenu.prevent="onItemContext({ data, event: $event })"
              >
                <span
                  v-for="i in level"
                  :key="i"
                  class="w-px pointer-events-none bottom-0 top-0 absolute"
                  :class="[
                    inChain && i === level ? 'bg-primary/40' : 'bg-border-subtle',
                  ]"
                  :style="{ left: `${10 + (i - 1) * 14}px` }"
                />
                <span
                  v-if="isSelected"
                  class="rounded-r-full bg-primary w-[2px] pointer-events-none bottom-1.5 left-0 top-1.5 absolute"
                />
                <i
                  v-if="data.icon"
                  class="shrink-0 h-3.5 w-3.5"
                  :class="[data.icon as string]"
                />
                <span class="truncate">
                  <template
                    v-for="(part, i) in splitHighlight(data.title, folderFilter)"
                    :key="i"
                  >
                    <mark
                      v-if="part.match"
                      class="text-fg px-0.5 rounded-sm bg-primary/30"
                    >{{ part.text }}</mark>
                    <template v-else>{{ part.text }}</template>
                  </template>
                </span>
                <span
                  v-if="data.count != null"
                  class="text-[10px] font-mono ml-auto px-1.5 py-0.5 rounded shrink-0 transition-colors tabular-nums"
                  :class="[
                    isSelected ? 'bg-primary/15 text-primary' : 'text-fg-subtle group-hover/row:text-fg-muted',
                  ]"
                >
                  {{ numberFormater.format(data.count) }}
                </span>
              </RouterLink>
            </template>
          </TreeList>
        </ScrollArea>
        <div class="p-2 border-t border-border-subtle">
          <ListItem
            icon="i-tabler-settings"
            :active="$route.path === '/settings'"
            title="Settings"
            @click="$router.push('/settings')"
          />
        </div>
      </Pane>
      <Pane class="relative">
        <RouterView />
      </Pane>
      <Pane
        :min-size="12"
        :size="12"
        :max-size="36"
        class="p-1 border-l border-border-default min-w-64"
      >
        <RightPanel />
      </Pane>
    </Splitpanes>
    <BottomBar />
  </div>
</template>

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
