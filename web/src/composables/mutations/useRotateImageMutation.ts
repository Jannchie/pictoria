import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { v2RotatePostImage } from '@/api'

export function useRotateImageMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ postId, clockwise }: { postId: number, clockwise: boolean }) => {
      await v2RotatePostImage({
        path: {
          post_id: postId,
        },
        query: {
          clockwise,
        },
      })
      return postId
    },
    onSuccess: (postId: number) => {
      queryClient.invalidateQueries({ queryKey: ['post', postId] })
      queryClient.invalidateQueries({ queryKey: ['posts'] })
    },
  })
}
