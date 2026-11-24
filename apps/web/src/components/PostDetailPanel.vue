<script setup lang="ts">
import type { PostDetailPublic, PostSimplePublic } from '@/api'
import type { ScorerKind } from '@/shared'
import { useQueryClient } from '@tanstack/vue-query'
import { filesize } from 'filesize'
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAPIError } from '@/composables/useAPIError'
import { useInFlight } from '@/composables/useInFlight'
import { useScoreHotkeys } from '@/composables/useKeyScope'
import { formatDateTime, resolvedLocale } from '@/locale'
import { commitRating, commitScore, computeScore, hideNSFW, RATING_LEVEL_COLORS, RATING_LEVEL_ICONS, ratingLevelNames, ratingName } from '@/shared'
import { revealPost } from '@/shared/postPaths'
import { getPostThumbnailURL, isImageExtension } from '@/utils'
import { colorNumToHex, labToRgbaString } from '@/utils/color'
import PostGroupSection from './post-detail/PostGroupSection.vue'
import PostTagsSection from './post-detail/PostTagsSection.vue'
import PostTextFields from './post-detail/PostTextFields.vue'

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
const post = computed(() => props.post)
// `tags` is detail-only: the discriminant between the two shapes.
const detail = computed(() => 'tags' in props.post ? props.post : undefined)

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

// Ids so each control group is named by its visible title.
const uid = useId()
const ratingLabelId = `${uid}-rating`
const scoreLabelId = `${uid}-score`

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
      <PostGroupSection :post="post" />

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
              {{ filesize(post.size, { locale: resolvedLocale }) }}
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
      <PostTagsSection :post-id="post.id" :detail="detail" />

      <!-- Caption / source -->
      <PostTextFields :post-id="post.id" :detail="detail" />

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
