import { baseURL } from '@/shared'

export function getPostImageURL(post: { filePath: string, fileName: string, extension: string, md5: string }) {
  return `${baseURL}/v2/images/original/${post.filePath}/${post.fileName}.${post.extension}?md5=${post.md5}`
}

export function getPostThumbnailURL(post: { filePath: string, fileName: string, extension: string, md5: string }) {
  return `${baseURL}/v2/images/thumbnails/${post.filePath}/${post.fileName}.${post.extension}?md5=${post.md5}`
}

export { default as highlightDirective } from './highlight'
