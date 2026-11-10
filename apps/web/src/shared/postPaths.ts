import { formatNumber, i18n } from '@/locale'
import { router } from '@/router'
import { announce } from './announce'
import { showPostDetail } from './state'

interface PostPathParts {
  filePath: string
  fileName: string
  extension: string
}

/**
 * A post's path relative to the library root. A post in the root has an empty
 * `filePath`: joining blindly gave "/name.ext", which reads as an absolute path.
 */
export function postRelativePath(p: PostPathParts): string {
  const file = `${p.fileName}.${p.extension}`
  const folder = postFolder(p)
  return folder === '@' ? file : `${folder}/${file}`
}

/**
 * Copy the posts' relative paths (one per line) and announce the outcome. The
 * one implementation behind the gallery context menu and the multi-select
 * panel's "Copy paths".
 */
export async function copyPostPaths(posts: readonly PostPathParts[]): Promise<void> {
  const t = i18n.global.t
  const paths = posts.map(postRelativePath)
  if (paths.length === 0) {
    return
  }
  try {
    await navigator.clipboard.writeText(paths.join('\n'))
    announce(t('multiSelect.pathsCopied', { n: formatNumber(paths.length) }, paths.length))
  }
  catch {
    announce(t('multiSelect.copyFailed'), 'assertive')
  }
}

/** A post's folder as the `/dir/…` route spells it: the path, or `@` for the root. */
export function postFolder(p: Pick<PostPathParts, 'filePath'>): string {
  return p.filePath && p.filePath !== '.' ? p.filePath : '@'
}

/**
 * "Show in folder": open `folder` (the post's own by default — or an ancestor,
 * from the detail panel's breadcrumb) with the post selected and scrolled to
 * (MainSection's post_id watcher). The folder is shown unfiltered — the active
 * filters could hide the post there — and a fullscreen viewer is closed.
 */
export function revealPost(
  post: { id: number } & Pick<PostPathParts, 'filePath'>,
  folder: string = postFolder(post),
  options: { replace?: boolean } = {},
) {
  showPostDetail.value = null
  const to = { path: `/dir/${folder}`, query: { post_id: String(post.id) } }
  return options.replace ? router.replace(to) : router.push(to)
}
