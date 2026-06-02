import { baseURL } from '@/shared'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'svg'])

export function isImageExtension(extension: string | null | undefined) {
  if (!extension) {
    return false
  }
  return IMAGE_EXTENSIONS.has(extension.toLowerCase())
}

interface PostImageRef { filePath: string, fileName: string, extension: string, sha256?: string, md5?: string }

function buildPostImageURL(type: 'original' | 'thumbnails', post: PostImageRef) {
  const hash = post.sha256 ?? post.md5
  const query = hash ? `?hash=${hash}` : ''
  return `${baseURL}/v2/images/${type}/${post.filePath}/${post.fileName}.${post.extension}${query}`
}

export function getPostImageURL(post: PostImageRef) {
  return buildPostImageURL('original', post)
}

export function getPostThumbnailURL(post: PostImageRef) {
  return buildPostImageURL('thumbnails', post)
}

export { default as highlightDirective } from './highlight'
