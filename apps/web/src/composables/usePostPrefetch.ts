import type { QueryClient } from '@tanstack/vue-query'
import type { Ref } from 'vue'
import type { PostSimplePublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { toRaw, watch } from 'vue'
import { currentPostList } from '@/shared'
import { postAnnotationsQueryOptions, postGroupEvidenceQueryOptions, postGroupQueryOptions, postQueryOptions, similarPostsQueryOptions } from '@/shared/postQueries'
import { getPostImageURL, getPostThumbnailURL } from '@/utils'

/**
 * 相似图瀑布流首屏大约露出的张数（300px 一列，宽屏四五列、两三行）。只暖这些
 * 缩略图 —— 一百张全拉会和当前这张的原图抢连接。
 */
const SIMILAR_THUMBS_AHEAD = 12

/**
 * 停稳多久才预取数据。按住 ←→ 连翻时中间那些图一闪而过，给它们各发五个请求
 * 纯属浪费，还会把真正停下那张的请求排到后面。原图预载不等 —— 它才是切图时
 * 最长的那一拍。
 */
const SETTLE_DELAY = 150

// 同一 URL 只 new Image 一次：详情页和它上面的全屏查看器同时挂着时两边都会
// 调进来。有上限，免得长时间浏览后无限增长；清空的代价只是一次命中缓存的请求。
const warmedImages = new Set<string>()
const WARMED_LIMIT = 1000

/** 把一张图拉进浏览器缓存（图片响应是 immutable 的，之后 <img> 直接命中）。 */
export function preloadImage(url: string, priority: 'high' | 'low' | 'auto' = 'low') {
  if (warmedImages.has(url)) {
    return
  }
  if (warmedImages.size >= WARMED_LIMIT) {
    warmedImages.clear()
  }
  warmedImages.add(url)
  const img = new Image()
  img.fetchPriority = priority
  img.decoding = 'async'
  img.src = url
}

function warmThumbnails(posts: PostSimplePublic[]) {
  for (const p of posts) {
    preloadImage(getPostThumbnailURL(p))
  }
}

/**
 * 把「打开这张图的详情」会发的请求提前发掉：详情、近重复组 + 组证据、标注
 * 历史、相似图，以及相似图首屏和组成员的缩略图。选项和各自的 useQuery 出自
 * 同一个工厂（shared/postQueries），翻过去时直接命中缓存。预取失败静默 ——
 * 真正翻到那张时 useQuery 会自己再试并报错。
 */
export function prefetchPostData(queryClient: QueryClient, id: number) {
  queryClient.prefetchQuery(postQueryOptions(id))
  queryClient.prefetchQuery(postGroupEvidenceQueryOptions(id))
  queryClient.prefetchQuery(postAnnotationsQueryOptions(id))
  queryClient.fetchQuery(postGroupQueryOptions(id))
    .then(warmThumbnails, () => {})
  queryClient.fetchQuery(similarPostsQueryOptions(id))
    .then(posts => warmThumbnails(posts.slice(0, SIMILAR_THUMBS_AHEAD)), () => {})
}

/** 原图 + 详情请求一起预取：接下来多半要打开这一张。 */
export function prefetchPost(queryClient: QueryClient, post: PostSimplePublic) {
  preloadImage(getPostImageURL(post))
  prefetchPostData(queryClient, post.id)
}

/**
 * 预取当前帖子在 currentPostList 中前后相邻的那两张，使详情页 / 全屏查看器
 * ←→ 切换瞬间完成：
 *
 * - 原图：前后各一张立即预载；再顺着翻页方向多预载一张（连翻时下一拍也已就绪）
 * - 数据：停稳 SETTLE_DELAY 后预取相邻两张的全部详情请求（见 prefetchPostData）
 *
 * `index` 直接用调用方 [[usePostNavigation]] 算好的那个 —— 列表可能有二十多万
 * 条，再扫一遍是白花的。
 */
export function useAdjacentPostPrefetch(index: Readonly<Ref<number>>) {
  const queryClient = useQueryClient()
  let lastIndex = -1

  watch(index, (idx, _, onCleanup) => {
    if (idx === -1) {
      return
    }
    const direction = lastIndex !== -1 && idx < lastIndex ? -1 : 1
    lastIndex = idx

    const list = toRaw(currentPostList.value)
    const neighbors = [list[idx + direction], list[idx - direction]]
      .filter((p): p is PostSimplePublic => p !== undefined)
    for (const [i, p] of neighbors.entries()) preloadImage(getPostImageURL(p), i === 0 ? 'auto' : 'low')
    const ahead = list[idx + direction * 2]
    if (ahead) {
      preloadImage(getPostImageURL(ahead))
    }

    const timer = setTimeout(() => {
      for (const p of neighbors) {
        prefetchPostData(queryClient, p.id)
      }
    }, SETTLE_DELAY)
    onCleanup(() => clearTimeout(timer))
  }, { immediate: true })
}
