<script setup lang="ts">
import type { PostDetailPublic, PostHasTagPublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { filesize } from 'filesize'
import { v2GetSilvaScorerOne, v2GetWaifuScorerOne, v2UpdatePostCaption, v2UpdatePostRating, v2UpdatePostScore, v2UpdatePostSource } from '@/api'
import { useAPIError } from '@/composables/useAPIError'
import { hideNSFW, openTagSelectorWindow, patchPostsInListCache, queryKeys, showPostDetail } from '@/shared'
import { getPostThumbnailURL } from '@/utils'
import { colorNumToHex, labToRgbaString } from '@/utils/color'

const props = defineProps<{
  post: PostDetailPublic
}>()

const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()

function formatTimestr(t: number | string) {
  return new Date(t).toLocaleString()
}
async function onSelectScore(post_id: number, score: number = 0) {
  await v2UpdatePostScore({
    path: {
      post_id,
    },
    body: {
      score,
    },
  })
  // Patch the list cache so the new score appears immediately without a
  // refetch. Stats/score-count caches still need invalidation — combine them
  // into a single predicate pass over the query cache rather than two scans.
  patchPostsInListCache(queryClient, [post_id], { score })
  queryClient.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey
      if (!Array.isArray(k)) {
        return false
      }
      if (k[0] === 'count' && k[1] === 'score') {
        return true
      }
      if (k[0] === 'posts' && k[1] === 'stats') {
        return true
      }
      return k[0] === 'post' && k[1] === post_id
    },
  })
}
const post = computed(() => props.post)
const { 1: one, 2: two, 3: three, 4: four, 5: five } = useMagicKeys()
const activeElement = useActiveElement()
const notUsingInput = computed(() =>
  activeElement.value?.tagName !== 'INPUT'
  && activeElement.value?.tagName !== 'TEXTAREA')

watchEffect(async () => {
  if (!notUsingInput.value) {
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

const updateCaption = useDebounceFn(async (caption: any) => {
  await v2UpdatePostCaption({

    path: {
      post_id: post.value.id,
    },
    query: {
      caption,
    },
  })
  queryClient.invalidateQueries({ queryKey: queryKeys.post(post.value.id) })
}, 500)

const updateSource = useDebounceFn(async (source: any) => {
  await v2UpdatePostSource({

    path: {
      post_id: post.value.id,
    },
    query: {
      source,
    },
  })
  queryClient.invalidateQueries({ queryKey: queryKeys.post(post.value.id) })
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
    handleAPIError(error, 'Failed to calculate waifu score')
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
    handleAPIError(error, 'Failed to calculate SILVA score')
  }
  finally {
    isCalculatingSilvaScore.value = false
  }
}
</script>

<template>
  <ScrollArea
    class="text-xs flex flex-col gap-2 h-full overflow-x-hidden overflow-y-auto"
  >
    <div
      v-if="isImage(post.extension)"
      class="flex justify-center"
    >
      <div class="rounded overflow-hidden">
        <img
          :src="getPostThumbnailURL(post)"
          class="rounded h-40 overflow-hidden object-contain"
          :class="{
            blur: (post?.rating ?? 0) >= 3 && hideNSFW,
          }"
        >
      </div>
    </div>
    <div class="flex gap-1 items-center justify-center">
      <PColorSwatch
        v-if="post.dominantColor"
        class="mr-2"
        :size="32"
        bordered
        :color="labToRgbaString(post.dominantColor[0], post.dominantColor[1], post.dominantColor[2]) ?? '#000000'"
      />
      <PColorSwatch
        v-for="color in post.colors"
        :key="color.color"
        :color="colorNumToHex(color.color)"
      />
    </div>
    <div>
      <div class="text-fg font-semibold py-2">
        Basic Info
      </div>
      <div
        class="gap-x-3 gap-y-1.5 grid grid-cols-[auto_1fr] children:break-words odd:children:text-fg-subtle"
      >
        <div>Rating</div>
        <div>
          <Rating
            :model-value="post.rating"
            highlight-selected-only
            :count="4"
            :colors="['green', 'yellow', 'orange', 'red']"
            :icons="['i-tabler-seeding', 'i-tabler-mood-heart', 'i-tabler-eye-off', 'i-tabler-eyeglass-off']"
            @select="async (d) => v2UpdatePostRating({
              path: {
                post_id: post.id,
              },
              query: {
                rating: d,
              },
            })"
          />
        </div>
        <div>
          Score
        </div>
        <div>
          <Rating
            :model-value="post.score"
            :count="5"
            @select="(d) => onSelectScore(post.id, d)"
          />
        </div>
        <div v-if="post.size > 0">
          Size
        </div>
        <div v-if="post.size > 0">
          {{ filesize(post.size) }}
        </div>
        <div>Path</div>
        <div>
          {{ post.filePath }}
        </div>
        <div>
          Name
        </div>
        <div>
          {{ post.fileName }}
        </div>
        <div>
          Dimension
        </div>
        <div>
          {{ post.width }} x {{ post.height }}
        </div>
        <div>
          Format
        </div>
        <div class="uppercase">
          {{ post.extension }}
        </div>
        <div v-if="post.createdAt">
          Created At
        </div>
        <div v-if="post.createdAt">
          {{ formatTimestr(post.createdAt) }}
        </div>
        <div v-if="post.publishedAt">
          Published At
        </div>
        <div v-if="post.publishedAt">
          {{ formatTimestr(post.publishedAt) }}
        </div>
        <div>
          Waifu Score
        </div>
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
              {{ isCalculatingWaifuScore ? 'Computing...' : 'Compute' }}
            </PButton>
          </template>
        </div>
        <div>
          SILVA Score
        </div>
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
              {{ isCalculatingSilvaScore ? 'Computing...' : 'Compute' }}
            </PButton>
          </template>
        </div>
      </div>
    </div>
    <div>
      <div class="text-fg font-semibold py-2">
        Folder
      </div>
      <div class="flex gap-2">
        <div
          v-if="folders.length === 0"
          class="text-fg-muted flex flex-col h-8 w-full items-center justify-center"
        >
          <div class="op50 flex flex-col items-center">
            <i class="i-tabler-folder-off" />
            <div>
              No folder
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
    </div>
    <div class="flex flex-col gap-1">
      <div
        class="text-fg font-black py-2 flex gap-2 items-center"
      >
        <span>Tags</span>
        <PButton
          v-if="post.tags && post.tags.length > 0"
          size="sm"
          icon
          variant="subtle"
          @click="onCopyTags"
        >
          <i class="i-tabler-copy" />
        </PButton>
      </div>
      <div
        v-if="manualTags.length > 0"
        class="flex flex-wrap gap-2"
      >
        <PostTag
          v-for="tag of manualTags"
          :key="tag.tagInfo.name"
          class="px-1 py-0.5 rounded bg-surface-2 cursor-pointer"
          rounded="lg"
          :data="tag"
          :color="tag.tagInfo.group?.color"
          @pointerup="openTagSelectorWindow()"
        >
          {{ tag.tagInfo.name }}
        </PostTag>
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
        class="text-fg-muted py-2 flex flex-col gap-2"
      >
        <div class="op50 flex flex-col gap-1 items-center">
          <i class="i-tabler-bookmark-off" />
          <div class="text-xs">
            No Tag
          </div>
        </div>
        <PButton
          size="sm"
          block
          @pointerup="openTagSelectorWindow()"
        >
          <i class="i-tabler-bookmark-plus" />
          Add Tag
        </PButton>
      </div>
    </div>
    <div
      v-if="autoTags.length > 0"
      class="flex flex-col gap-1"
    >
      <div
        class="text-fg font-black py-2 flex gap-2 items-center"
      >
        <i class="i-tabler-sparkles text-fg-muted" />
        <span>Auto Tags</span>
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
        >
          {{ tag.tagInfo.name }}
        </PostTag>
      </div>
    </div>
    <div>
      <div class="text-fg font-semibold py-2">
        Caption
      </div>
      <div>
        <PInput
          :model-value="post.caption ?? ''"
          size="sm"
          class="w-full"
          @update:model-value="updateCaption"
        />
      </div>
    </div>
    <div>
      <div class="text-fg font-semibold py-2">
        Source
      </div>
      <div>
        <PInput
          :model-value="post.source ?? ''"
          size="sm"
          class="w-full"
          @update:model-value="updateSource"
        />
      </div>
    </div>
    <div>
      <div class="text-fg font-semibold py-2">
        Command
      </div>
      <div class="flex flex-col gap-2">
        <AutoGenerateTagBtn :post-id="post.id" />
        <AutoGenerateCaptionBtn :post-id="post.id" />
      </div>
    </div>
  </ScrollArea>
</template>
