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

/**
 * 无本地化翻译时的展示兜底：把数据库的下划线 tag 名还原成自然英文
 * （green_eyes → green eyes）。筛选 / API 调用仍必须用原始下划线名。
 */
export function naturalizeTagName(name: string): string {
  return name.replaceAll('_', ' ')
}

export { default as highlightDirective } from './highlight'
