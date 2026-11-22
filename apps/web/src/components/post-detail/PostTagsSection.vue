<script setup lang="ts">
import type { PostDetailPublic, PostHasTagPublic, PostSimplePublic } from '@/api'
import type { PMenuItem } from '@/ui'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, shallowRef, useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAPIError } from '@/composables/useAPIError'
import { UNCATEGORISED, useTopCategoryGrouper } from '@/composables/useTagTree'
import { commitTag, commitTagSource, openTagSelectorWindow } from '@/shared'
import { copyToClipboard } from '@/shared/clipboard'
import { filterByTag, runTagFilterAction, tagMenuHead } from '@/shared/tagMenu'
import { isMac } from '@/utils/keyboard'

// The post detail panel's tags section: pinned sort order, category grouping,
// and each tag's own menu. The gallery row standing in for the detail has no
// tags, so the section is a skeleton until the detail lands.
const props = defineProps<{
  post: PostDetailPublic | PostSimplePublic
}>()

const { t } = useI18n()
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()
const post = computed(() => props.post)
// `tags` is detail-only: the discriminant between the two shapes.
const detail = computed(() => 'tags' in props.post ? props.post : undefined)
// Fixed widths: a skeleton that changes shape on every render reads as noise.
const TAG_SKELETON_WIDTHS = [64, 88, 48, 72, 56, 96, 40, 68]

const groupNameOrder = ['artist', 'copyright', 'character', 'general', 'meta']
function sortByGroup(a: PostHasTagPublic, b: PostHasTagPublic) {
  // 手动标签排在同一堆的前面：分类是一回事，谁打的是另一回事，人打的先看。
  if (a.isAuto !== b.isAuto) {
    return a.isAuto ? 1 : -1
  }
  if (a.tagInfo.group && b.tagInfo.group) {
    return groupNameOrder.indexOf(a.tagInfo.group.name) - groupNameOrder.indexOf(b.tagInfo.group.name)
  }
  if (a.tagInfo.group) {
    return -1
  }
  if (b.tagInfo.group) {
    return 1
  }
  return a.tagInfo.name.localeCompare(b.tagInfo.name)
}
// 同一张图上的顺序在它显示期间钉住：确认（自动 → 人工）会改变 sortByGroup 的结果，
// 若当场重排，标签就从光标底下跳走，连续 Alt+点击会点到旁边那个。换图时重新排。
// 中途新加的标签没有座位，排在已有的后面（它们之间仍按 sortByGroup）。
let seatsFor: number | undefined
let seats = new Map<string, number>()
const seat = (tag: PostHasTagPublic) => seats.get(tag.tagInfo.name) ?? Number.POSITIVE_INFINITY
const tagSorted = computed(() => {
  const tags = detail.value?.tags
  if (!tags) {
    return []
  }
  const sorted = tags.toSorted(sortByGroup)
  if (seatsFor !== post.value.id) {
    seatsFor = post.value.id
    seats = new Map(sorted.map((tag, i) => [tag.tagInfo.name, i]))
    return sorted
  }
  return sorted.toSorted((a, b) => seat(a) - seat(b) || sortByGroup(a, b))
})
const autoTagCount = computed(() => tagSorted.value.reduce((n, t) => n + (t.isAuto ? 1 : 0), 0))

// 按顶层语义分类（服饰 / 发型 / 表情…）分堆。自动标签动辄几十个，平铺成一片时
// 眼睛没有着力点。手动和自动混在同一堆里——分类回答的是「这张图画了什么」，来源
// 不该把同一个问题的答案劈成两半；来源改由标签自身的样式（虚线 + 星标）承担。
const groupByCategory = useTopCategoryGrouper()
function categoryLabel(key: string) {
  return key === UNCATEGORISED ? t('tagsView.uncategorised') : t(`tagsView.group.${key}`)
}
const tagGroups = computed(() =>
  groupByCategory(tagSorted.value, tag => tag.tagInfo.name, tag => tag.tagInfo.group?.name, categoryLabel))
async function onCopyTags() {
  const tags = tagSorted.value.map(tag => tag.tagInfo.name).join(', ')
  if (!tags) {
    return
  }
  await copyToClipboard(tags, t('post.panel.tagsCopied'))
}

// ---- 单个标签的快捷操作 ----------------------------------------------------
// 点击（或右键）一个标签弹出它自己的菜单（筛选 / 确认 / 移除 / 编辑），锚在标签下方；
// 两个最常用的有直通手势：Alt+点击确认、Mod+点击加入筛选。
// 菜单只有一个（包住整片标签），打开前先记下是哪个标签 —— 右键时标签自己的
// contextmenu 冒泡在 PMenu 宿主之前，所以菜单打开时 activeTag 已经就位。
const activeTag = shallowRef<PostHasTagPublic | null>(null)
const tagMenu = useTemplateRef<{ openFor: (el: HTMLElement) => void }>('tagMenu')

const confirmTag = (tag: PostHasTagPublic) => commitTagSource(queryClient, post.value.id, tag.tagInfo.name, false)

const tagMenuData = computed<PMenuItem[]>(() => {
  const tag = activeTag.value
  if (!tag) {
    return []
  }
  return [
    ...tagMenuHead({ name: tag.tagInfo.name, translatedName: tag.tagInfo.translatedName }),
    { role: 'divider' },
    tag.isAuto
      ? { title: t('post.panel.tagConfirm'), icon: 'i-tabler-check', value: 'confirm' }
      : { title: t('post.panel.tagUnconfirm'), icon: 'i-tabler-sparkles', value: 'unconfirm' },
    { title: t('post.panel.tagRemove'), icon: 'i-tabler-trash', value: 'remove' },
    { role: 'divider' },
    { title: t('post.panel.tagEdit'), icon: 'i-tabler-edit', value: 'edit' },
  ]
})

async function onTagMenuSelect(value: string | number | symbol) {
  const tag = activeTag.value
  if (!tag) {
    return
  }
  const id = post.value.id
  const name = tag.tagInfo.name
  if (runTagFilterAction(value, name)) {
    return
  }
  try {
    switch (value) {
      case 'confirm': { await confirmTag(tag); break }
      case 'unconfirm': { await commitTagSource(queryClient, id, name, true); break }
      case 'remove': { await commitTag(queryClient, id, name, false, { wasAuto: tag.isAuto }); break }
      case 'edit': { openTagSelectorWindow(name); break }
    }
  }
  catch (error) {
    handleAPIError(error)
  }
}

async function onTagClick(tag: PostHasTagPublic, e: MouseEvent) {
  if (isMac ? e.metaKey : e.ctrlKey) {
    filterByTag(tag.tagInfo.name, false)
    return
  }
  if (e.altKey) {
    if (tag.isAuto) {
      try {
        await confirmTag(tag)
      }
      catch (error) {
        handleAPIError(error)
      }
    }
    return
  }
  activeTag.value = tag
  tagMenu.value?.openFor(e.currentTarget as HTMLElement)
}

// The tag group is named by the section's visible title.
const tagsHeadingId = `${useId()}-tags`
</script>

<template>
  <section class="py-3 p-divider">
    <div class="mb-2 flex items-center justify-between">
      <h3 :id="tagsHeadingId" class="p-section-title">
        <i class="i-tabler-tag" aria-hidden="true" />
        <span>{{ $t('post.tags') }}</span>
      </h3>
      <div class="flex gap-1 items-center">
        <!-- 星标在图例里出现一次，虚线标签自己再带一个：混排之后，「哪些是
             机器打的」得能不点开就看懂。 -->
        <span
          v-if="autoTagCount > 0"
          class="text-2xs text-fg-subtle flex gap-1 items-center"
          :title="$t('post.autoTags')"
        >
          <i class="i-tabler-sparkles" aria-hidden="true" />
          {{ autoTagCount }}
          <span class="sr-only">{{ $t('post.autoTags') }}</span>
        </span>
        <!-- xs + negative margin: the affordance stays clickable without
             making this section heading taller than the others. -->
        <PButton
          v-if="tagSorted.length > 0"
          size="xs"
          icon
          class="-my-1.5"
          :aria-label="$t('post.copyTags')"
          :title="$t('post.copyTags')"
          @click="onCopyTags"
        >
          <i class="i-tabler-copy" aria-hidden="true" />
        </PButton>
      </div>
    </div>
    <!-- The gallery row has no tags: a skeleton until the detail lands. -->
    <div
      v-if="!detail"
      class="flex flex-wrap gap-1.5"
      role="status"
      :aria-label="$t('post.panel.loadingDetail')"
    >
      <span
        v-for="(w, i) in TAG_SKELETON_WIDTHS"
        :key="i"
        class="rounded-sm h-5 p-skeleton"
        :style="{ 'width': `${w}px`, '--i': i }"
      />
    </div>
    <PMenu
      v-else-if="tagSorted.length > 0"
      ref="tagMenu"
      :data="tagMenuData"
      trigger="contextmenu"
      :aria-label="activeTag ? $t('post.panel.tagMenu', { tag: activeTag.tagInfo.name }) : undefined"
      @select="onTagMenuSelect"
    >
      <div
        class="flex flex-col gap-2"
        role="group"
        :aria-labelledby="tagsHeadingId"
      >
        <div
          v-for="cat of tagGroups"
          :key="cat.path"
          class="flex flex-col gap-1"
        >
          <div class="text-2xs text-fg-subtle tracking-wide uppercase">
            {{ cat.name }}
          </div>
          <!-- Clicking a tag opens its own menu (filter / confirm / remove /
             edit). Tags are not Tab stops; the keyboard path is the
             "Add Tag" button below (one Tab stop instead of one per tag). -->
          <div
            class="flex flex-wrap gap-1"
            role="list"
            :aria-label="cat.name"
          >
            <!-- PostTag renders the localised display name itself (no slot). -->
            <PostTag
              v-for="tag of cat.items"
              :key="tag.tagInfo.name"
              role="listitem"
              class="cursor-pointer"
              :data="tag"
              :auto="tag.isAuto"
              :color="tag.tagInfo.group?.color"
              @click="onTagClick(tag, $event)"
              @contextmenu="activeTag = tag"
            />
          </div>
        </div>
        <button
          type="button"
          class="rounded-sm self-start"
          aria-haspopup="dialog"
          data-tag-editor-opener
          @click="openTagSelectorWindow()"
        >
          <PTag
            variant="outline"
            tone="neutral"
            size="xs"
            class="cursor-pointer"
          >
            <i class="i-tabler-plus" aria-hidden="true" />
            {{ $t('post.addTag') }}
          </PTag>
        </button>
      </div>
    </PMenu>
    <div
      v-else
      class="text-fg-muted flex flex-col gap-2"
    >
      <div class="op50 flex flex-col gap-1 items-center">
        <i class="i-tabler-bookmark-off" aria-hidden="true" />
        <div class="text-xs">
          {{ $t('post.noTag') }}
        </div>
      </div>
      <PButton
        size="sm"

        aria-haspopup="dialog"
        data-tag-editor-opener block
        @click="openTagSelectorWindow()"
      >
        <i class="i-tabler-bookmark-plus" aria-hidden="true" />
        {{ $t('post.addTag') }}
      </PButton>
    </div>
  </section>
</template>
