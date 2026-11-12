<script setup lang="ts">
import type { PostDetailPublic, PostHasTagPublic, PostSimplePublic } from '@/api'
import type { ScorerKind } from '@/shared'
import type { PMenuItem } from '@/ui'
import { useQueryClient } from '@tanstack/vue-query'
import { filesize } from 'filesize'
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAPIError } from '@/composables/useAPIError'
import { useInFlight } from '@/composables/useInFlight'
import { useScoreHotkeys } from '@/composables/useKeyScope'
import { usePostGroupEvidenceQuery } from '@/composables/usePostGroupEvidenceQuery'
import { usePostGroupQuery } from '@/composables/usePostGroupQuery'
import { UNCATEGORISED, useTopCategoryGrouper } from '@/composables/useTagTree'
import { formatDateTime } from '@/locale'
import { announce, commitCaption, commitRating, commitScore, commitSource, commitTag, commitTagSource, computeScore, hideNSFW, makePostCanonical, markPostsDifferent, openTagSelectorWindow, postFilter, RATING_LEVEL_COLORS, RATING_LEVEL_ICONS, ratingLevelNames, ratingName, ungroupPost } from '@/shared'
import { isGalleryRoute } from '@/shared/galleryView'
import { revealPost } from '@/shared/postPaths'
import { getPostThumbnailURL, isImageExtension, naturalizeTagName } from '@/utils'
import { colorNumToHex, labToRgbaString } from '@/utils/color'
import { isMac } from '@/utils/keyboard'

// Either the post's detail, or — while that request is in flight — the gallery
// row it was picked from. The row already carries the name, size, colours,
// rating and score, so the panel renders at once (no flash back to the gallery
// overview between a click and the response): rating and score stay editable
// (the row holds their current values, and the writes patch both caches);
// what only the detail has — tags, model scores, caption, source, dates — is a
// skeleton or disabled until it lands.
const props = defineProps<{
  post: PostDetailPublic | PostSimplePublic
}>()

const { t } = useI18n()
// The rating icons alone (sprout / heart / eye-off…) don't say which level is
// which: name each option, and spell the current one out next to the control.
const ratingLabels = computed(() => ratingLevelNames(t))
const ratingValueLabel = computed(() => ratingName(props.post.rating, t))
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()
async function onSelectScore(post_id: number, score: number = 0) {
  try {
    await commitScore(queryClient, [props.post], [post_id], score)
  }
  catch (error) {
    handleAPIError(error, t('error.scoreFailed'))
  }
}
async function onSelectRating(rating: number) {
  try {
    await commitRating(queryClient, [props.post], [props.post.id], rating)
  }
  catch (error) {
    handleAPIError(error, t('error.ratingFailed'))
  }
}
/** Grouping edits: one toast prefix, so a failed click never goes silent. */
async function guardGroup(run: () => Promise<void>) {
  try {
    await run()
  }
  catch (error) {
    handleAPIError(error, t('error.groupFailed'))
    return false
  }
  return true
}
const post = computed(() => props.post)
// `tags` is detail-only: the discriminant between the two shapes.
const detail = computed(() => 'tags' in props.post ? props.post : undefined)
// Fixed widths: a skeleton that changes shape on every render reads as noise.
const TAG_SKELETON_WIDTHS = [64, 88, 48, 72, 56, 96, 40, 68]
const router = useRouter()
const route = useRoute()

// Near-duplicate group: the hidden members this (canonical) post collapses.
const groupQuery = usePostGroupQuery(computed(() => props.post.id))
const groupMembers = computed(() => groupQuery.data.value ?? [])

async function onMakeCanonical(memberId: number) {
  if (await guardGroup(() => makePostCanonical(queryClient, memberId))) {
    // The promoted member is now canonical; follow it so the panel stays on the
    // visible representative instead of a now-hidden post.
    router.push(`/post/${memberId}`)
  }
}
async function onUngroupMember(memberId: number) {
  await guardGroup(() => ungroupPost(queryClient, memberId))
}
// Members whose relation to this post was decided by hand — a rebuild honours
// those verdicts, so the panel marks them apart from the automatic grouping.
const evidenceQuery = usePostGroupEvidenceQuery(computed(() => props.post.id))
const decidedMembers = computed(
  () => new Set((evidenceQuery.data.value ?? []).filter(e => e.userVerdict !== null).map(e => e.memberId)),
)
async function onMarkDifferent(memberId: number) {
  await guardGroup(() => markPostsDifferent(queryClient, post.value.id, memberId))
}
async function onUngroupSelf() {
  await guardGroup(() => ungroupPost(queryClient, post.value.id))
}
// Number-key scoring is owned by MainSection on gallery routes (the gallery and
// this side panel are mounted together when a single post is selected, so
// without a guard one keypress would fire twice → two undo entries). The shared
// 'postPage' scope is mutually exclusive with MainSection's 'grid', so digits
// only score here on the dedicated /post/:postId detail page — no route check.
useScoreHotkeys('postPage', score => onSelectScore(post.value.id, score))

// Memoize per filePath — opening 30 posts in a row was rebuilding the same
// breadcrumb arrays 30 times. The map is process-local so it never grows
// beyond what the gallery has actually visited.
const foldersCache = new Map<string, Array<{ name: string, path: string }>>()
function buildFolders(filePath: string) {
  const cached = foldersCache.get(filePath)
  if (cached) {
    return cached
  }
  const names = filePath.split('/')
  const result = names.map((name, index) => ({
    name,
    path: names.slice(0, index + 1).join('/'),
  }))
  foldersCache.set(filePath, result)
  return result
}
const folders = computed(() => buildFolders(post.value.filePath))

// 描述 / 来源：本地草稿，失焦或 Mod+Enter（来源是单行，Enter）才提交——一次编辑
// 一条撤销记录，而不是每停顿 500 ms 记一条。失败：回滚到服务端的值并标红。
function useTextField(
  read: () => string,
  commit: (id: number, oldValue: string, newValue: string) => Promise<void>,
  failedKey: string,
) {
  const draft = ref<string>(read())
  const invalid = ref(false)
  let editing = false
  // 服务端值变化（换图 / 撤销 / 别处改了）且没在编辑时，草稿跟上。
  watch([() => post.value.id, read], () => {
    if (!editing) {
      draft.value = read()
    }
  })
  watch(() => post.value.id, () => {
    invalid.value = false
  })
  async function save() {
    editing = false
    // The fields are disabled until the detail is in; without it the old value
    // would be a stand-in ''.
    if (!detail.value) {
      return
    }
    const id = post.value.id
    const oldValue = read()
    const newValue = draft.value ?? ''
    if (newValue === oldValue) {
      return
    }
    try {
      await commit(id, oldValue, newValue)
      invalid.value = false
    }
    catch (error) {
      handleAPIError(error, t(failedKey))
      if (post.value.id === id) {
        draft.value = oldValue
        invalid.value = true
      }
    }
  }
  return {
    draft,
    invalid,
    onFocus: () => {
      editing = true
    },
    save,
  }
}
const caption = useTextField(
  () => detail.value?.caption ?? '',
  (id, o, n) => commitCaption(queryClient, id, o, n),
  'error.captionFailed',
)
const source = useTextField(
  () => detail.value?.source ?? '',
  (id, o, n) => commitSource(queryClient, id, o, n),
  'error.sourceFailed',
)
const captionDraft = caption.draft
const captionInvalid = caption.invalid
const sourceDraft = source.draft
const sourceInvalid = source.invalid
function onCaptionKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey) && !e.isComposing) {
    e.preventDefault()
    caption.save()
  }
}
function onSourceKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    source.save()
  }
}
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
  try {
    await navigator.clipboard.writeText(tags)
    announce(t('post.panel.tagsCopied'))
  }
  catch {
    announce(t('post.panel.copyFailed'), 'assertive')
  }
}

// ---- 单个标签的快捷操作 ----------------------------------------------------
// 点击（或右键）一个标签弹出它自己的菜单（筛选 / 确认 / 移除 / 编辑），锚在标签下方；
// 两个最常用的有直通手势：Alt+点击确认、Mod+点击加入筛选。
// 菜单只有一个（包住整片标签），打开前先记下是哪个标签 —— 右键时标签自己的
// contextmenu 冒泡在 PMenu 宿主之前，所以菜单打开时 activeTag 已经就位。
const activeTag = shallowRef<PostHasTagPublic | null>(null)
const tagMenu = useTemplateRef<{ openFor: (el: HTMLElement) => void }>('tagMenu')

function filterByTag(name: string, only: boolean) {
  const current = postFilter.value.tags
  postFilter.value.tags = only ? [name] : current.includes(name) ? current : [...current, name]
  // 独立详情页上没有画廊可筛：带着筛选回画廊。
  if (!isGalleryRoute(route)) {
    router.push('/')
  }
}

const confirmTag = (tag: PostHasTagPublic) => commitTagSource(queryClient, post.value.id, tag.tagInfo.name, false)

const tagMenuData = computed<PMenuItem[]>(() => {
  const tag = activeTag.value
  if (!tag) {
    return []
  }
  const label = tag.tagInfo.translatedName ?? naturalizeTagName(tag.tagInfo.name)
  return [
    { role: 'label', title: label },
    { title: t('post.panel.tagFilter'), icon: 'i-tabler-filter-plus', value: 'filter' },
    { title: t('post.panel.tagFilterOnly'), icon: 'i-tabler-filter', value: 'filterOnly' },
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
  try {
    switch (value) {
      case 'filter': { filterByTag(name, false); break }
      case 'filterOnly': { filterByTag(name, true); break }
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

// Ids so each section / control group is named by its visible title.
const uid = useId()
const tagsHeadingId = `${uid}-tags`
const ratingLabelId = `${uid}-rating`
const scoreLabelId = `${uid}-score`
const captionHintId = `${uid}-caption-hint`

const SILVA_SCORER = 'silva'
const silvaScore = computed(
  () => detail.value?.aestheticScores?.find(s => s.scorer === SILVA_SCORER)?.score,
)

// In-flight computes keyed by scorer AND post: each scorer's button spins
// independently, and since the panel is reused when it shows another post, a
// compute still running for the previous one must not spin (or block) here.
const computing = useInFlight<string>('computeScore')
const computeKey = (kind: ScorerKind, postId: number) => `${kind}:${postId}`
const isComputing = (kind: ScorerKind) => computing.has(computeKey(kind, post.value.id))
const COMPUTE_FAILED_KEYS: Record<ScorerKind, string> = {
  silva: 'error.silvaComputeFailed',
}

function onComputeScore(kind: ScorerKind) {
  const postId = post.value.id
  return computing.run(computeKey(kind, postId), async () => {
    try {
      await computeScore(queryClient, kind, postId)
    }
    catch (error) {
      handleAPIError(error, t(COMPUTE_FAILED_KEYS[kind]))
    }
  })
}
</script>

<template>
  <PScrollArea
    class="text-xs h-full overflow-x-hidden overflow-y-auto"
    :aria-busy="detail ? undefined : 'true'"
  >
    <!-- px-3: the pane has no padding of its own (the scrollbar hugs its
         edge), so the scrolled content owns the 12px gutter. -->
    <div class="px-3 flex flex-col">
      <!-- Preview first (user preference): thumbnail + dominant/palette colour
           band. Still collapsed by default — the same image is already the
           subject of the main view — and the open state persists, so opening
           it once keeps it on top permanently. -->
      <PDisclosure
        v-if="isImageExtension(post.extension) || post.dominantColor || (post.colors && post.colors.length > 0)"
        storage-key="post.preview"
        icon="i-tabler-photo"
        :title="$t('post.preview')"
        :default-open="false"
      >
        <div class="flex flex-col gap-3">
          <div
            v-if="isImageExtension(post.extension)"
            class="flex justify-center"
          >
            <img
              :src="getPostThumbnailURL(post)"
              :alt="$t('post.panel.previewAlt', { name: `${post.fileName}.${post.extension}` })"
              class="rounded-md h-40 max-w-full ring-1 ring-border-subtle object-contain"
              :class="{
                blur: (post?.rating ?? 0) >= 3 && hideNSFW,
              }"
            >
          </div>
          <div
            v-if="post.dominantColor || (post.colors && post.colors.length > 0)"
            class="flex flex-wrap gap-1 items-center justify-center"
            aria-hidden="true"
          >
            <PColorSwatch
              v-if="post.dominantColor"
              :size="28"
              bordered
              :color="labToRgbaString(post.dominantColor[0], post.dominantColor[1], post.dominantColor[2]) ?? '#000000'"
            />
            <PColorSwatch
              v-for="color in post.colors"
              :key="color.color"
              :color="colorNumToHex(color.color)"
            />
          </div>
        </div>
      </PDisclosure>

      <!-- Ratings next, always expanded: scoring is the core loop (manual 1–5
           vs the model's SILVA), so it stays reachable with minimal
           scrolling and zero clicks. Everything below is reference material
           and collapses. -->
      <section class="pb-3 pt-3 p-divider">
        <h3
          class="p-section-title mb-2"
        >
          <i class="i-tabler-star" aria-hidden="true" />
          <span>{{ $t('post.ratings') }}</span>
        </h3>
        <div
          class="gap-y-1 p-kv-grid items-center odd:children:text-fg-muted"
        >
          <div :id="ratingLabelId">
            {{ $t('post.ratingLabel') }}
          </div>
          <div class="flex gap-2 items-center">
            <PRating
              :aria-labelledby="ratingLabelId"
              :model-value="post.rating"
              highlight-selected-only
              :count="4"
              :colors="RATING_LEVEL_COLORS"
              :icons="RATING_LEVEL_ICONS"
              :labels="ratingLabels"
              @select="onSelectRating"
            />
            <span class="text-fg-subtle truncate" aria-hidden="true">{{ ratingValueLabel }}</span>
          </div>
          <div :id="scoreLabelId">
            {{ $t('post.scoreLabel') }}
          </div>
          <div>
            <PRating
              :aria-labelledby="scoreLabelId"
              :model-value="post.score"
              :count="5"
              @select="(d) => onSelectScore(post.id, d)"
            />
          </div>
          <div>{{ $t('post.silvaLabel') }}</div>
          <div>
            <span v-if="!detail" class="rounded-sm h-5 w-16 block p-skeleton" />
            <template v-else-if="silvaScore !== undefined">
              <ModelScoreLevel :score="silvaScore * 10" />
            </template>
            <template v-else>
              <PButton
                size="sm"
                variant="subtle"
                :loading="isComputing('silva')"
                @click="onComputeScore('silva')"
              >
                {{ isComputing('silva') ? $t('common.computing') : $t('common.compute') }}
              </PButton>
            </template>
          </div>
        </div>
      </section>

      <!-- Near-duplicate group: members hidden behind this canonical post -->
      <section
        v-if="post.canonicalPostId != null || groupMembers.length > 0"
        class="py-3 p-divider"
      >
        <h3
          class="p-section-title mb-2"
        >
          <i class="i-tabler-stack-2" aria-hidden="true" />
          <span>{{ $t('post.sameGroup') }}</span>
        </h3>

        <!-- This post is itself a hidden member of another group. -->
        <div
          v-if="post.canonicalPostId != null"
          class="flex flex-col gap-2"
        >
          <div class="text-fg-muted">
            {{ $t('post.groupChildNotice') }}
          </div>
          <div class="flex gap-2">
            <PButton
              size="sm"
              block
              @click="router.push(`/post/${post.canonicalPostId}`)"
            >
              <i class="i-tabler-arrow-up-right" aria-hidden="true" />
              {{ $t('post.viewRepresentative') }}
            </PButton>
            <PButton
              size="sm"
              variant="subtle"
              @click="onUngroupSelf"
            >
              {{ $t('post.removeFromGroup') }}
            </PButton>
          </div>
        </div>

        <!-- This post is the canonical head; list its hidden members. -->
        <div
          v-else
          class="flex flex-col gap-2"
        >
          <div class="text-fg-subtle">
            {{ $t('post.moreSimilar', { n: groupMembers.length }, groupMembers.length) }}
          </div>
          <div
            v-for="m in groupMembers"
            :key="m.id"
            class="p-1 rounded-md flex gap-2 transition-colors items-center -mx-1 hover:bg-surface-1"
          >
            <RouterLink
              :to="`/post/${m.id}`"
              class="rounded-sm shrink-0"
              :aria-label="$t('post.panel.openMember', { width: m.width, height: m.height })"
            >
              <img
                :src="getPostThumbnailURL(m)"
                alt=""
                class="rounded-sm h-12 w-12 block cursor-pointer object-cover"
                :class="{ blur: (m.rating ?? 0) >= 3 && hideNSFW }"
              >
            </RouterLink>
            <div class="text-fg-subtle flex-1 tabular-nums" aria-hidden="true">
              {{ m.width }} × {{ m.height }}
            </div>
            <i
              v-if="decidedMembers.has(m.id)"
              class="i-tabler-pin text-fg-subtle"
              role="img"
              :aria-label="`${$t('post.groupPinned')} — ${$t('post.groupUserPriorityNote')}`"
              :title="`${$t('post.groupPinned')} — ${$t('post.groupUserPriorityNote')}`"
            />
            <PButton
              size="sm"
              icon
              :aria-label="$t('post.setRepresentative')"
              :title="$t('post.setRepresentative')"
              @click="onMakeCanonical(m.id)"
            >
              <i class="i-tabler-crown" aria-hidden="true" />
            </PButton>
            <PButton
              size="sm"
              icon
              :aria-label="$t('post.markDifferent')"
              :title="$t('post.markDifferent')"
              @click="onMarkDifferent(m.id)"
            >
              <i class="i-tabler-equal-not" aria-hidden="true" />
            </PButton>
            <PButton
              size="sm"
              icon
              :aria-label="$t('post.removeFromGroup')"
              :title="$t('post.removeFromGroup')"
              @click="onUngroupMember(m.id)"
            >
              <i class="i-tabler-unlink" aria-hidden="true" />
            </PButton>
          </div>
        </div>
      </section>

      <!-- Annotation history: SILVA multi-dimension events (hidden when empty) -->
      <AnnotationHistory :post-id="post.id" />

      <!-- File info: pure metadata, numbers tabular-aligned. Reference data —
           collapsed by default. -->
      <PDisclosure
        storage-key="post.fileInfo"
        icon="i-tabler-file-info"
        :title="$t('post.fileInfo')"
        :default-open="false"
      >
        <div
          class="gap-y-1 p-kv-grid odd:children:text-fg-muted"
        >
          <template v-if="post.size > 0">
            <div>{{ $t('post.size') }}</div>
            <div class="tabular-nums">
              {{ filesize(post.size) }}
            </div>
          </template>
          <div>{{ $t('post.path') }}</div>
          <div>{{ post.filePath }}</div>
          <div>{{ $t('post.name') }}</div>
          <div>{{ post.fileName }}</div>
          <div>{{ $t('post.dimension') }}</div>
          <div class="tabular-nums">
            {{ post.width }} × {{ post.height }}
          </div>
          <div>{{ $t('post.format') }}</div>
          <div class="uppercase">
            {{ post.extension }}
          </div>
          <template v-if="detail?.createdAt">
            <div>{{ $t('post.createdAt') }}</div>
            <div class="tabular-nums">
              {{ formatDateTime(detail.createdAt) }}
            </div>
          </template>
          <template v-if="detail?.publishedAt">
            <div>{{ $t('post.publishedAt') }}</div>
            <div class="tabular-nums">
              {{ formatDateTime(detail.publishedAt) }}
            </div>
          </template>
        </div>
      </PDisclosure>

      <!-- Folder breadcrumb -->
      <PDisclosure
        storage-key="post.folder"
        icon="i-tabler-folder"
        :title="$t('post.folder')"
        :default-open="false"
      >
        <div class="flex flex-wrap gap-2">
          <div
            v-if="folders.length === 0"
            class="text-fg-muted flex flex-col h-8 w-full items-center justify-center"
          >
            <div class="op50 flex flex-col items-center">
              <i class="i-tabler-folder-off" aria-hidden="true" />
              <div>
                {{ $t('post.noFolder') }}
              </div>
            </div>
          </div>
          <PButton
            v-for="folder in folders"
            :key="folder.path"
            size="sm"
            @click="revealPost(post, folder.path)"
          >
            {{ folder.name }}
          </PButton>
        </div>
      </PDisclosure>

      <!-- Tags: stays a plain always-open section — tagging is high-frequency. -->
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

      <!-- Caption -->
      <PDisclosure
        storage-key="post.caption"
        icon="i-tabler-blockquote"
        :title="$t('post.caption')"
        :default-open="false"
      >
        <PTextarea
          v-model="captionDraft"
          :aria-label="$t('post.caption')"
          :aria-describedby="captionHintId"
          :invalid="captionInvalid"
          :disabled="!detail"
          size="sm"
          :max-rows="10"
          @focus="caption.onFocus"
          @blur="caption.save"
          @keydown="onCaptionKeydown"
        />
        <div :id="captionHintId" class="text-2xs text-fg-subtle mt-1">
          {{ $t('post.panel.captionHint', { shortcut: isMac ? '⌘ Enter' : 'Ctrl+Enter' }) }}
        </div>
      </PDisclosure>

      <!-- Source -->
      <PDisclosure
        storage-key="post.source"
        icon="i-tabler-link"
        :title="$t('post.source')"
        :default-open="false"
      >
        <PInput
          :model-value="sourceDraft"
          :aria-label="$t('post.source')"
          :invalid="sourceInvalid"
          :disabled="!detail"
          size="sm"
          block
          @update:model-value="(v) => sourceDraft = String(v ?? '')"
          @focus="source.onFocus"
          @blur="source.save"
          @keydown="onSourceKeydown"
        />
      </PDisclosure>

      <!-- Commands -->
      <PDisclosure
        storage-key="post.command"
        icon="i-tabler-wand"
        :title="$t('post.command')"
        :default-open="false"
      >
        <div class="flex flex-col gap-2">
          <AutoGenerateBtn kind="tag" :post-id="post.id" />
          <AutoGenerateBtn kind="caption" :post-id="post.id" />
        </div>
      </PDisclosure>
    </div>
  </PScrollArea>
</template>
