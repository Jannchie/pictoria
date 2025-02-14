<script setup lang="ts">
import { v1CmdAutoTags } from '@/api'
import { } from '@/shared'
import { Btn } from '@roku-ui/vue'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { computed } from 'vue'

const props = defineProps<{
  postId: number
}>()
const id = computed(() => props.postId)

const queryClient = useQueryClient()

const mutation = useMutation({
  mutationFn: () => {
    return v1CmdAutoTags({ path: { post_id: id.value } })
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
  <Btn
    size="sm"
    class="w-full"
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
  </Btn>
</template>
