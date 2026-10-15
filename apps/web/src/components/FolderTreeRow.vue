<script setup lang="ts">
import type { TreeListCollapseData, TreeListLeafData } from '@/ui/PTreeList.vue'
import { RouterLink } from 'vue-router'
import { CHEVRON_SLOT, LEVEL_INDENT } from '@/ui/PTreeList.vue'
import { hasStatsLine } from '@/utils/folderTree'
import { splitHighlight } from '@/utils/highlight'
import FolderStatsLine from './FolderStatsLine.vue'

/**
 * The body of one sidebar folder-tree row, shared by FolderTree's `#collapse`
 * and `#link` slots: the RouterLink that IS the treeitem (the slot's
 * `itemProps` — role, roving tabindex, aria-*, data-tree-value — fall through
 * onto it as attrs), the indent guides, the highlighted title and the stats
 * line. Its height must match `folderTreeItemHeight`.
 */
defineProps<{
  data: TreeListLeafData | TreeListCollapseData
  level: number
  isSelected: boolean
  inChain: boolean
  /** The folder filter text, highlighted in the title. */
  filter: string
  /** Leading icon class (leaves only); without it the slot is kept as blank space. */
  icon?: string
}>()
</script>

<template>
  <RouterLink
    :to="{ path: `/dir/${data.value}`, query: $route.query }"
    :title="data.value"
    class="group/row text-sm pr-3 rounded-md flex h-full w-full cursor-pointer transition-colors items-center relative focus-visible:[outline-offset:-2px]"
    :class="[
      isSelected ? 'text-fg bg-primary/10 hover:bg-primary/15' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
    ]"
    :style="{ paddingLeft: `${CHEVRON_SLOT + level * LEVEL_INDENT}px` }"
  >
    <span
      v-for="i in level"
      :key="i"
      aria-hidden="true"
      class="w-px pointer-events-none bottom-0 top-0 absolute"
      :class="[
        inChain && i === level ? 'bg-primary/40' : 'bg-border-subtle',
      ]"
      :style="{ left: `${10 + (i - 1) * LEVEL_INDENT}px` }"
    />
    <div class="flex flex-grow flex-col min-w-0 justify-center">
      <div class="flex gap-1.5 h-6 items-center">
        <span aria-hidden="true" class="inline-flex shrink-0 h-3.5 w-3.5 items-center justify-center">
          <i v-if="icon" class="h-3.5 w-3.5" :class="[icon]" />
        </span>
        <span class="truncate">
          <template
            v-for="(part, i) in splitHighlight(data.title, filter)"
            :key="i"
          >
            <mark
              v-if="part.match"
              class="text-fg px-0.5 rounded-sm bg-primary/30"
            >{{ part.text }}</mark>
            <template v-else>{{ part.text }}</template>
          </template>
        </span>
      </div>
      <FolderStatsLine
        v-if="hasStatsLine(data as TreeListLeafData)"
        v-bind="data.meta"
        :count="data.count"
        class="pl-5"
      />
    </div>
  </RouterLink>
</template>
