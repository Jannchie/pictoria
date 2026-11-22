<script setup lang="ts">
import type { PostDetailPublic, PostSimplePublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAPIError } from '@/composables/useAPIError'
import { usePostGroupEvidenceQuery } from '@/composables/usePostGroupEvidenceQuery'
import { usePostGroupQuery } from '@/composables/usePostGroupQuery'
import { hideNSFW, makePostCanonical, markPostsDifferent, ungroupPost } from '@/shared'
import { getPostThumbnailURL } from '@/utils'

// The post detail panel's near-duplicate group section: either the group this
// (hidden) post belongs to, or the hidden members this (canonical) post
// collapses. Renders nothing when the post is in no group.
const props = defineProps<{
  post: PostDetailPublic | PostSimplePublic
}>()

const { t } = useI18n()
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()
const router = useRouter()

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
  await guardGroup(() => markPostsDifferent(queryClient, props.post.id, memberId))
}
async function onUngroupSelf() {
  await guardGroup(() => ungroupPost(queryClient, props.post.id))
}
</script>

<template>
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
</template>
