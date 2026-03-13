import { baseURL } from '@/shared'

export function getPostImageURL(post: { filePath: string, fileName: string, extension: string, sha256?: string, md5?: string }) {
  const hash = post.sha256 ?? post.md5
  const query = hash ? `?hash=${hash}` : ''
  return `${baseURL}/v2/images/original/${post.filePath}/${post.fileName}.${post.extension}${query}`
}

export function getPostThumbnailURL(post: { filePath: string, fileName: string, extension: string, sha256?: string, md5?: string }) {
  const hash = post.sha256 ?? post.md5
  const query = hash ? `?hash=${hash}` : ''
  return `${baseURL}/v2/images/thumbnails/${post.filePath}/${post.fileName}.${post.extension}${query}`
}

export { default as highlightDirective } from './highlight'
