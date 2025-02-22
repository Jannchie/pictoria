import type { PostPublic } from '@/api'
import { baseURL } from '@/shared'
import highlightDirective from './highlight'

export { highlightDirective }

export function getPostImageURL(post: PostPublic) {
  return `${baseURL}/v1/images/${post.file_path}/${post.file_name}.${post.extension}?md5=${post.md5}`
}

export function getPostThumbnailURL(post: PostPublic) {
  return `${baseURL}/v1/thumbnails/${post.file_path}/${post.file_name}.${post.extension}?md5=${post.md5}`
}
