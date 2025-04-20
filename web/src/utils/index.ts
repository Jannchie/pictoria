import { baseURL } from '@/shared'
import highlightDirective from './highlight'

export { highlightDirective }

export function getPostImageURL(post: { filePath: string, fileName: string, extension: string, md5: string }) {
  return `${baseURL}/v2/images/original/${post.filePath}/${post.fileName}.${post.extension}?md5=${post.md5}`
}

export function getPostThumbnailURL(post: { filePath: string, fileName: string, extension: string, md5: string }) {
  return `${baseURL}/v2/images/thumbnails/${post.filePath}/${post.fileName}.${post.extension}?md5=${post.md5}`
}
