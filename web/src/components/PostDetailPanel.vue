<script setup lang="ts">
import type { PostDetailPublic, PostHasTagPublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { filesize } from 'filesize'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { v2GetSilvaScorerOne, v2GetWaifuScorerOne } from '@/api'
import { useAPIError } from '@/composables/useAPIError'
import { usePostGroupQuery } from '@/composables/usePostGroupQuery'
import { formatDateTime } from '@/locale'
import { commitCaption, commitRating, commitScore, commitSource, hideNSFW, makePostCanonical, openTagSelectorWindow, queryKeys, RATING_LEVEL_COLORS, RATING_LEVEL_ICONS, showPostDetail, ungroupPost } from '@/shared'
import { getPostThumbnailURL } from '@/utils'
import { colorNumToHex, labToRgbaString } from '@/utils/color'

const props = defineProps<{
  post: PostDetailPublic
}>()

const { t } = useI18n()
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()
async function onSelectScore(post_id: number, score: number = 0) {
  await commitScore(queryClient, [props.post], [post_id], score)
}
const post = computed(() => props.post)
const route = useRoute()
const router = useRouter()

// Near-duplicate group: the hidden members this (canonical) post collapses.
const groupQuery = usePostGroupQuery(computed(() => props.post.id))
const groupMembers = computed(() => groupQuery.data.value ?? [])

async function onMakeCanonical(memberId: number) {
  await makePostCanonical(queryClient, memberId)
  // The promoted member is now canonical; follow it so the panel stays on the
  // visible representative instead of a now-hidden post.
  router.push(`/post/${memberId}`)
}
async function onUngroupMember(memberId: number) {
  await ungroupPost(queryClient, memberId)
}
async function onUngroupSelf() {
  await ungroupPost(queryClient, post.value.id)
}
const { 1: one, 2: two, 3: three, 4: four, 5: five } = useMagicKeys()
const activeElement = useActiveElement()
const notUsingInput = computed(() =>
  activeElement.value?.tagName !== 'INPUT'
  && activeElement.value?.tagName !== 'TEXTAREA')

// Number-key scoring is owned by MainSection on gallery routes (the gallery
// and this side panel are mounted together when a single post is selected, so
// without this guard one keypress would fire twice → two undo entries). Only
// handle digits here on the dedicated /post/:postId detail page, where
// MainSection is unmounted.
watchEffect(async () => {
  if (!notUsingInput.value || route.name !== 'post') {
    return
  }
  if (one.value) {
    await onSelectScore(post.value.id, 1)
  }
  if (two.value) {
    await onSelectScore(post.value.id, 2)
  }
  if (three.value) {
    await onSelectScore(post.value.id, 3)
  }
  if (four.value) {
    await onSelectScore(post.value.id, 4)
  }
  if (five.value) {
    await onSelectScore(post.value.id, 5)
  }
})

function isImage(extension: string) {
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(extension)
}

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

const updateCaption = useDebounceFn(async (caption: string | number | null | undefined) => {
  await commitCaption(queryClient, post.value.id, post.value.caption ?? '', String(caption ?? ''))
}, 500)

const updateSource = useDebounceFn(async (source: string | number | null | undefined) => {
  await commitSource(queryClient, post.value.id, post.value.source ?? '', String(source ?? ''))
}, 500)
const groupNameOrder = ['artist', 'copyright', 'character', 'general', 'meta']
function sortByGroup(a: PostHasTagPublic, b: PostHasTagPublic) {
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
const tagSorted = computed(() => {
  return post.value.tags?.toSorted(sortByGroup) ?? []
})
const manualTags = computed(() => tagSorted.value.filter(t => !t.isAuto))
const autoTags = computed(() => tagSorted.value.filter(t => t.isAuto))
function onCopyTags() {
  const tags = tagSorted.value.map(tag => tag.tagInfo.name).join(', ')
  if (tags) {
    navigator.clipboard.writeText(tags)
  }
}

const isCalculatingWaifuScore = ref(false)

async function calculateWaifuScore() {
  if (isCalculatingWaifuScore.value) {
    return
  }

  isCalculatingWaifuScore.value = true
  try {
    await v2GetWaifuScorerOne({
      path: {
        post_id: post.value.id,
      },
    })
    queryClient.invalidateQueries({ queryKey: queryKeys.post(post.value.id) })
  }
  catch (error) {
    handleAPIError(error, t('error.waifuComputeFailed'))
  }
  finally {
    isCalculatingWaifuScore.value = false
  }
}

const SILVA_SCORER = 'silva'
const silvaScore = computed(
  () => post.value.aestheticScores?.find(s => s.scorer === SILVA_SCORER)?.score,
)
const isCalculatingSilvaScore = ref(false)

async function calculateSilvaScore() {
  if (isCalculatingSilvaScore.value) {
    return
  }

  isCalculatingSilvaScore.value = true
  try {
    await v2GetSilvaScorerOne({
      path: {
        post_id: post.value.id,
      },
    })
    queryClient.invalidateQueries({ queryKey: queryKeys.post(post.value.id) })
  }
  catch (error) {
    handleAPIError(error, t('error.silvaComputeFailed'))
  }
  finally {
    isCalculatingSilvaScore.value = false
  }
}

// Shared section-heading style: a small uppercase label with a leading icon,
// applied to every panel section for a consistent editorial rhythm.
const sectionTitleClass
  = 'flex items-center gap-1.5 text-fg-subtle text-[11px] font-semibold uppercase tracking-wider'
</script>

<template>
  <ScrollArea
    class="text-xs h-full overflow-x-hidden overflow-y-auto"
  >
    <!-- px-3: the pane has no padding of its own (the scrollbar hugs its
         edge), so the scrolled content owns the 12px gutter. -->
    <div class="px-3 flex flex-col">
      <!-- Hero: thumbnail + dominant/palette colour band -->
      <div class="pb-4 pt-3 flex flex-col gap-3">
        <div
          v-if="isImage(post.extension)"
          class="flex justify-center"
        >
          <img
            :src="getPostThumbnailURL(post)"
            class="rounded-lg h-40 max-w-full ring-1 ring-border-default shadow-sm object-contain"
            :class="{
              blur: (post?.rating ?? 0) >= 3 && hideNSFW,
            }"
          >
        </div>
        <div
          v-if="post.dominantColor || (post.colors && post.colors.length > 0)"
          class="flex flex-wrap gap-1 items-center justify-center"
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

      <!-- Near-duplicate group: members hidden behind this canonical post -->
      <section
        v-if="post.canonicalPostId != null || groupMembers.length > 0"
        class="py-4"
      >
        <div
          :class="sectionTitleClass"
          class="mb-2"
        >
          <i class="i-tabler-stack-2" />
          <span>{{ $t('post.sameGroup') }}</span>
        </div>

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
              @pointerup="router.push(`/post/${post.canonicalPostId}`)"
            >
              <i class="i-tabler-arrow-up-right" />
              {{ $t('post.viewRepresentative') }}
            </PButton>
            <PButton
              size="sm"
              variant="subtle"
              @pointerup="onUngroupSelf"
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
            class="p-1 rounded bg-surface-2 flex gap-2 items-center"
          >
            <img
              :src="getPostThumbnailURL(m)"
              class="rounded h-12 w-12 cursor-pointer object-cover"
              :class="{ blur: (m.rating ?? 0) >= 3 && hideNSFW }"
              @click="router.push(`/post/${m.id}`)"
            >
            <div class="text-fg-subtle flex-1 tabular-nums">
              {{ m.width }} × {{ m.height }}
            </div>
            <PButton
              size="sm"
              icon
              variant="subtle"
              :title="$t('post.setRepresentative')"
              @pointerup="onMakeCanonical(m.id)"
            >
              <i class="i-tabler-crown" />
            </PButton>
            <PButton
              size="sm"
              icon
              variant="subtle"
              :title="$t('post.removeFromGroup')"
              @pointerup="onUngroupMember(m.id)"
            >
              <i class="i-tabler-unlink" />
            </PButton>
          </div>
        </div>
      </section>

      <!-- Ratings: every quality signal grouped together -->
      <section class="py-4">
        <div
          :class="sectionTitleClass"
          class="mb-2"
        >
          <i class="i-tabler-star" />
          <span>{{ $t('post.ratings') }}</span>
        </div>
        <div
          class="gap-x-3 gap-y-2 grid grid-cols-[auto_1fr] items-center children:break-words odd:children:text-fg-subtle"
        >
          <div>{{ $t('post.ratingLabel') }}</div>
          <div>
            <Rating
              :model-value="post.rating"
              highlight-selected-only
              :count="4"
              :colors="RATING_LEVEL_COLORS"
              :icons="RATING_LEVEL_ICONS"
              @select="(d) => commitRating(queryClient, [post], [post.id], d)"
            />
          </div>
          <div>{{ $t('post.scoreLabel') }}</div>
          <div>
            <Rating
              :model-value="post.score"
              :count="5"
              @select="(d) => onSelectScore(post.id, d)"
            />
          </div>
          <div>{{ $t('post.waifuLabel') }}</div>
          <div>
            <template v-if="post.waifuScore">
              <WaifuScoreLevel :score="post.waifuScore.score" />
            </template>
            <template v-else>
              <PButton
                size="sm"
                variant="subtle"
                :loading="isCalculatingWaifuScore"
                @click="calculateWaifuScore"
              >
                {{ isCalculatingWaifuScore ? $t('common.computing') : $t('common.compute') }}
              </PButton>
            </template>
          </div>
          <div>{{ $t('post.silvaLabel') }}</div>
          <div>
            <template v-if="silvaScore !== undefined">
              <WaifuScoreLevel :score="silvaScore * 10" />
            </template>
            <template v-else>
              <PButton
                size="sm"
                variant="subtle"
                :loading="isCalculatingSilvaScore"
                @click="calculateSilvaScore"
              >
                {{ isCalculatingSilvaScore ? $t('common.computing') : $t('common.compute') }}
              </PButton>
            </template>
          </div>
        </div>
      </section>

      <!-- Annotation history: SILVA multi-dimension events (hidden when empty) -->
      <AnnotationHistory :post-id="post.id" />

      <!-- File info: pure metadata, numbers tabular-aligned -->
      <section class="py-4">
        <div
          :class="sectionTitleClass"
          class="mb-2"
        >
          <i class="i-tabler-file-info" />
          <span>{{ $t('post.fileInfo') }}</span>
        </div>
        <div
          class="gap-x-3 gap-y-2 grid grid-cols-[auto_1fr] children:break-words odd:children:text-fg-subtle"
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
          <template v-if="post.createdAt">
            <div>{{ $t('post.createdAt') }}</div>
            <div class="tabular-nums">
              {{ formatDateTime(post.createdAt) }}
            </div>
          </template>
          <template v-if="post.publishedAt">
            <div>{{ $t('post.publishedAt') }}</div>
            <div class="tabular-nums">
              {{ formatDateTime(post.publishedAt) }}
            </div>
          </template>
        </div>
      </section>

      <!-- Folder breadcrumb -->
      <section class="py-4">
        <div
          :class="sectionTitleClass"
          class="mb-2"
        >
          <i class="i-tabler-folder" />
          <span>{{ $t('post.folder') }}</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <div
            v-if="folders.length === 0"
            class="text-fg-muted flex flex-col h-8 w-full items-center justify-center"
          >
            <div class="op50 flex flex-col items-center">
              <i class="i-tabler-folder-off" />
              <div>
                {{ $t('post.noFolder') }}
              </div>
            </div>
          </div>
          <PButton
            v-for="folder in folders"
            :key="folder.path"
            size="sm"
            @pointerup="$router.push(`/dir/${folder.path}?post_id=${post.id}`); showPostDetail = null"
          >
            {{ folder.name }}
          </PButton>
        </div>
      </section>

      <!-- Tags -->
      <section class="py-4">
        <div class="mb-2 flex items-center justify-between">
          <div :class="sectionTitleClass">
            <i class="i-tabler-tag" />
            <span>{{ $t('post.tags') }}</span>
          </div>
          <!-- xs + negative margin: the affordance stays clickable without
               making this section heading taller than the others. -->
          <PButton
            v-if="post.tags && post.tags.length > 0"
            size="xs"
            icon
            variant="subtle"
            class="-my-1.5"
            @click="onCopyTags"
          >
            <i class="i-tabler-copy" />
          </PButton>
        </div>
        <div
          v-if="manualTags.length > 0"
          class="flex flex-wrap gap-2"
        >
          <!-- PostTag renders the localised display name itself (no slot). -->
          <PostTag
            v-for="tag of manualTags"
            :key="tag.tagInfo.name"
            class="px-1 py-0.5 rounded bg-surface-2 cursor-pointer"
            rounded="lg"
            :data="tag"
            :color="tag.tagInfo.group?.color"
            @pointerup="openTagSelectorWindow()"
          />
          <PTag
            variant="soft"
            tone="primary"
            class="cursor-pointer"
            @pointerup="openTagSelectorWindow()"
          >
            <i class="i-tabler-plus" />
          </PTag>
        </div>
        <div
          v-else
          class="text-fg-muted flex flex-col gap-2"
        >
          <div class="op50 flex flex-col gap-1 items-center">
            <i class="i-tabler-bookmark-off" />
            <div class="text-xs">
              {{ $t('post.noTag') }}
            </div>
          </div>
          <PButton
            size="sm"
            block
            @pointerup="openTagSelectorWindow()"
          >
            <i class="i-tabler-bookmark-plus" />
            {{ $t('post.addTag') }}
          </PButton>
        </div>
      </section>

      <!-- Auto tags -->
      <section
        v-if="autoTags.length > 0"
        class="py-4"
      >
        <div
          :class="sectionTitleClass"
          class="mb-2"
        >
          <i class="i-tabler-sparkles" />
          <span>{{ $t('post.autoTags') }}</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <PostTag
            v-for="tag of autoTags"
            :key="tag.tagInfo.name"
            class="px-1 py-0.5 rounded bg-surface-2 cursor-pointer"
            rounded="lg"
            :data="tag"
            :color="tag.tagInfo.group?.color"
            @pointerup="openTagSelectorWindow()"
          />
        </div>
      </section>

      <!-- Caption -->
      <section class="py-4">
        <div
          :class="sectionTitleClass"
          class="mb-2"
        >
          <i class="i-tabler-blockquote" />
          <span>{{ $t('post.caption') }}</span>
        </div>
        <PInput
          :model-value="post.caption ?? ''"
          size="sm"
          block
          @update:model-value="updateCaption"
        />
      </section>

      <!-- Source -->
      <section class="py-4">
        <div
          :class="sectionTitleClass"
          class="mb-2"
        >
          <i class="i-tabler-link" />
          <span>{{ $t('post.source') }}</span>
        </div>
        <PInput
          :model-value="post.source ?? ''"
          size="sm"
          block
          @update:model-value="updateSource"
        />
      </section>

      <!-- Commands -->
      <section class="py-4">
        <div
          :class="sectionTitleClass"
          class="mb-2"
        >
          <i class="i-tabler-wand" />
          <span>{{ $t('post.command') }}</span>
        </div>
        <div class="flex flex-col gap-2">
          <AutoGenerateTagBtn :post-id="post.id" />
          <AutoGenerateCaptionBtn :post-id="post.id" />
        </div>
      </section>
    </div>
  </ScrollArea>
</template>
