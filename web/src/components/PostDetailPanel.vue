<script setup lang="ts">
import type { PostWithTagPublic } from '@/api'
import { v1UpdatePostCaption, v1UpdatePostRating, v1UpdatePostScore, v1UpdatePostSource } from '@/api'
import { hideNSFW, openTagSelectorWindow, showPostDetail } from '@/shared'
import { getPostThumbnailURL } from '@/utils'
import { colorNumToHex } from '@/utils/color'
import { Btn, ColorSwatch, TextField } from '@roku-ui/vue'
import { useQueryClient } from '@tanstack/vue-query'
import { filesize } from 'filesize'

const props = defineProps<{
  post: PostWithTagPublic
}>()
const queryClient = useQueryClient()

function formatTimestr(t: number | string) {
  return new Date(t).toLocaleString()
}
async function onSelectScore(post_id: number, score: number = 0) {
  await v1UpdatePostScore({
    path: {
      post_id,
    },
    body: {
      score,
    },
  })
  queryClient.invalidateQueries({ queryKey: ['count', 'score'] })
  queryClient.invalidateQueries({ queryKey: ['post', post_id] })
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

const folders = computed(() => {
  const names = post.value.file_path.split('/')
  // 返回一个对象数组，包括 name 和 path 两个字段，name 如上所示，而 path 需要包括父亲目录，使用 / 分隔
  const paths = post.value.file_path.split('/').map((_, i, arr) => arr.slice(0, i + 1).join('/'))
  return names.map((name, i) => ({
    name,
    path: paths[i],
  }))
})

const updateCaption = useDebounceFn(async (caption: any) => {
  await v1UpdatePostCaption({

    path: {
      post_id: post.value.id,
    },
    query: {
      caption,
    },
  })
  queryClient.invalidateQueries({ queryKey: ['post', post.value.id] })
}, 500)

const updateSource = useDebounceFn(async (source: any) => {
  await v1UpdatePostSource({

    path: {
      post_id: post.value.id,
    },
    query: {
      source,
    },
  })
  queryClient.invalidateQueries({ queryKey: ['post', post.value.id] })
}, 500)
</script>

<template>
  <ScrollArea
    class="h-full flex flex-col gap-2 overflow-x-hidden overflow-y-auto text-xs"
  >
    <div
      v-if="isImage(post.extension)"
      class="flex justify-center"
    >
      <div class="overflow-hidden rounded">
        <img
          :src="getPostThumbnailURL(post)"
          class="h-40 overflow-hidden rounded object-contain"
          :class="{
            blur: (post?.rating ?? 0) >= 3 && hideNSFW,
          }"
        >
      </div>
    </div>
    <div class="flex items-center justify-center gap-1">
      <ColorSwatch
        v-for="color in post.colors"
        :key="color.color"
        :color="colorNumToHex(color.color)"
      />
    </div>
    <div>
      <div class="py-2 text-zinc-4 font-black">
        Basic Info
      </div>
      <div
        class="grid grid-cols-2 even:children:text-zinc-4"
      >
        <div>Rating</div>
        <div>
          <Rating
            :model-value="post.rating"
            highlight-selected-only
            :count="4"
            :colors="['green', 'yellow', 'orange', 'red']"
            :icons="['i-tabler-seeding', 'i-tabler-mood-heart', 'i-tabler-eye-off', 'i-tabler-eyeglass-off']"
            @select="async (d) => v1UpdatePostRating({

              path: {
                post_id: post.id,
              },
              body: {
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
        <div v-if="post.size">
          Size
        </div>
        <div v-if="post.size">
          {{ filesize(post.size) }}
        </div>
        <div>Path</div>
        <div>
          {{ post.file_path }}
        </div>
        <div>
          Name
        </div>
        <div>
          {{ post.file_name }}
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
        <div v-if="post.created_at">
          Created At
        </div>
        <div v-if="post.created_at">
          {{ formatTimestr(post.created_at) }}
        </div>
        <div v-if="post.published_at">
          Published At
        </div>
        <div v-if="post.published_at">
          {{ formatTimestr(post.published_at) }}
        </div>
      </div>
    </div>
    <div>
      <div class="py-2 text-zinc-4 font-black">
        Folder
      </div>
      <div class="flex gap-2">
        <div
          v-if="!folders.length"
          class="h-8 w-full flex flex-col items-center justify-center text-surface-dimmed"
        >
          <div class="flex flex-col items-center op50">
            <i class="i-tabler-folder-off" />
            <div>
              No folder
            </div>
          </div>
        </div>
        <Btn
          v-for="folder in folders"
          :key="folder.path"
          size="sm"
          @pointerup="$router.push(`/dir/${folder.path}?post_id=${post.id}`); showPostDetail = null"
        >
          {{ folder.name }}
        </Btn>
      </div>
    </div>
    <div class="flex flex-col gap-1">
      <div
        class="py-2 text-zinc-4 font-black"
      >
        Tags
      </div>
      <div
        v-if="post.tags && post.tags.length"
        class="flex flex-wrap gap-2"
      >
        <PostTag
          v-for="tag of post.tags"
          :key="tag.tag_info.name"
          class="bg-surface-high cursor-pointer rounded px-1 py-0.5"
          rounded="lg"
          :data="tag"
          :color="tag.tag_info.group?.color"
          @pointerup="openTagSelectorWindow()"
        >
          {{ tag.tag_info.name }}
        </PostTag>
        <Tag
          class="bg-surface-high cursor-pointer rounded px-1 py-0.5"
          rounded="lg"
          @pointerup="openTagSelectorWindow()"
        >
          <i class="i-tabler-plus" />
        </Tag>
      </div>
      <div
        v-else
        class="h-14 flex flex-col items-center justify-center text-surface-dimmed"
      >
        <div class="flex flex-col items-center op50">
          <i class="i-tabler-bookmark-off" />
          <div>
            No Tag
          </div>
        </div>
        <Btn
          size="sm"
          class="my-2 w-full flex"
          @pointerup="openTagSelectorWindow()"
        >
          <i class="i-tabler-bookmark-plus" />
          Add Tag
        </Btn>
      </div>
    </div>
    <div>
      <div class="py-2 text-zinc-4 font-black">
        Caption
      </div>
      <div>
        <TextField
          :model-value="post.caption"
          size="sm"
          @update:model-value="updateCaption"
        />
      </div>
    </div>
    <div>
      <div class="py-2 text-zinc-4 font-black">
        Source
      </div>
      <div>
        <TextField
          :model-value="post.source"
          size="sm"
          @update:model-value="updateSource"
        />
      </div>
    </div>
    <div>
      <div class="py-2 text-zinc-4 font-black">
        Command
      </div>
      <div class="flex flex-col gap-2">
        <AutoGenerateTagBtn :post-id="post.id" />
        <AutoGenerateCaptionBtn :post-id="post.id" />
      </div>
    </div>
  </ScrollArea>
</template>
