<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { computed } from 'vue'
import { v2AutoTags } from '@/api'

const props = defineProps<{
  postId: number
}>()
const id = computed(() => props.postId)

const queryClient = useQueryClient()

const mutation = useMutation({
  mutationFn: () => {
    return v2AutoTags({ path: { post_id: id.value } })
  },
  onSuccess: () => {
    queryClient.invalidateQueries({
      queryKey: ['post', id],
    })
  },
})

async function onAutoTag() {
  mutation.mutate()
}
</script>

<template>
  <PButton
    size="sm"
    block
    @pointerdown="onAutoTag"
  >
    <i
      v-if="mutation.status.value === 'pending'"
      class="i-svg-spinners-90-ring-with-bg"
    />
    <i
      v-else
      class="i-tabler-photo-pentagon"
    />
    <div class="w-full overflow-hidden text-ellipsis text-nowrap">
      Auto Generate Tag
    </div>
  </PButton>
</template>
