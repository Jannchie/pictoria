import type { TagCategoryPublic, TagWithCountPublic } from '@/api'
import { useQuery } from '@tanstack/vue-query'
import { computed, toRaw } from 'vue'
import { v2ListTagTree } from '@/api'
import { resolvedLocale } from '@/locale'
import { queryKeys } from '@/shared/queryKeys'

/**
 * danbooru-tags-tree 的语义分类树，接上库里实际有的 tag。
 *
 * 树只覆盖 general 类的 tag，而且只覆盖其中约七成（按 post_count 加权是 99.5%，
 * 漏掉的是长尾）。剩下的——角色名、画师名、版权名，以及没进树的 general——都归到
 * 一个合成的「未分类」顶层里，按 tag 自身的 danbooru type 分子类。不这么做的话
 * 这个页面会静默地少掉三分之二的 tag，而它是**标签管理**页，看不到的 tag 等于
 * 不存在。
 */

/** 合成分类的 path 前缀，不会和上游的真实 path 撞（那些都是 `[a-z_.]+`）。 */
export const UNCATEGORISED = '~uncategorised'

/**
 * 语义树够不着、但 danbooru 的 tag *type* 说得清的那些，各自成一个顶层分类。
 *
 * 画师名、系列名、角色名不是「未分类」—— 它们分类明确，只是分在另一个维度上，
 * 语义树本来就不该收它们（`hatsune_miku` 归不进「服饰」或「构图」）。真正没有
 * 归属的只有 general 里没进树的那部分长尾。
 *
 * `general` 不在这两个列表里：它落到 UNCATEGORISED。
 */
/** 排在语义树之前：先告诉人这是谁画的、什么作品、哪个角色。 */
const LEADING_TYPES = ['artist', 'copyright', 'character'] as const
/** 排在最后：meta 是文件层面的信息，最不影响「这张图画了什么」。 */
const TRAILING_TYPES = ['meta'] as const
const FALLBACK_TYPES = [...LEADING_TYPES, ...TRAILING_TYPES] as const

/**
 * 整体顺序：画师 → 系列名 → 角色名 → 语义树的十一类 → 未分类 → 元信息。
 *
 * 沿用 danbooru 的惯例（也是 PostDetailPanel 里 `groupNameOrder` 一直用的那个），
 * 中间夹着的语义树和「未分类」都是 general 类的 tag，正好落在它原本的位置上。
 */
function orderedFallbacks(leftovers: Map<string, unknown>, leading: boolean) {
  const list = leading ? LEADING_TYPES : TRAILING_TYPES
  return list.filter(type => leftovers.has(type))
}

export interface TagTreeNode {
  path: string
  parent: string | null
  depth: number
  name: string
  /** 直属于这个分类、且库里确实有的 tag，按 post_count 降序。 */
  own: TagWithCountPublic[]
  /** 整棵子树（含自身）里的 tag 数，用于分类行右侧的计数。 */
  total: number
}

export function useTagTreeQuery() {
  return useQuery({
    queryKey: queryKeys.tagTree(),
    queryFn: async () => {
      const resp = await v2ListTagTree({ query: { lang: resolvedLocale.value } })
      if (resp.error) {
        throw resp.error
      }
      return resp.data
    },
    // 分类树是离线生成的静态表，一次会话内不会变。
    staleTime: Number.POSITIVE_INFINITY,
    structuralSharing: false,
  })
}

/**
 * 把分类树和 tag 列表接起来。
 *
 * 返回的顺序就是上游文件的深度优先序 —— 保留它是有意的，重排会打乱上游安排好的
 * 兄弟节点次序（character 下 demographic 先于 depiction）。
 */
export function buildTagTree(
  categories: TagCategoryPublic[],
  tags: TagWithCountPublic[],
  groupLabel: (group: string) => string,
  uncategorisedLabel: string,
): TagTreeNode[] {
  const byName = new Map(tags.map(t => [t.name, t]))

  const treeNodes: TagTreeNode[] = []
  const claimed = new Set<string>()
  for (const c of categories) {
    const own: TagWithCountPublic[] = []
    for (const name of c.tags) {
      const tag = byName.get(name)
      // 树里有、库里没有：上游覆盖 22k 个 tag，本地库不一定都收了。
      if (tag) {
        own.push(tag)
        claimed.add(name)
      }
    }
    own.sort((a, b) => b.count - a.count)
    treeNodes.push({ path: c.path, parent: c.parent, depth: c.depth, name: c.name, own, total: 0 })
  }

  // 树认领不了的，先按 danbooru tag type 分开：有 type 的各自成顶层，剩下的
  // （general 里没进树的长尾）才叫未分类。
  const leftovers = new Map<string, TagWithCountPublic[]>()
  for (const tag of tags) {
    if (claimed.has(tag.name)) {
      continue
    }
    const type = tag.group?.name ?? ''
    const key = (FALLBACK_TYPES as readonly string[]).includes(type) ? type : UNCATEGORISED
    const bucket = leftovers.get(key)
    if (bucket) {
      bucket.push(tag)
    }
    else {
      leftovers.set(key, [tag])
    }
  }
  function fallbackNode(key: string): TagTreeNode {
    const bucket = leftovers.get(key)!
    bucket.sort((a, b) => b.count - a.count)
    return {
      path: key === UNCATEGORISED ? UNCATEGORISED : `${UNCATEGORISED}.${key}`,
      parent: null,
      depth: 0,
      name: key === UNCATEGORISED ? uncategorisedLabel : groupLabel(key),
      own: bucket,
      total: 0,
    }
  }

  const nodes: TagTreeNode[] = [
    ...orderedFallbacks(leftovers, true).map(key => fallbackNode(key)),
    ...treeNodes,
    ...(leftovers.has(UNCATEGORISED) ? [fallbackNode(UNCATEGORISED)] : []),
    ...orderedFallbacks(leftovers, false).map(key => fallbackNode(key)),
  ]

  // 子树计数：深度优先序里子节点总在父节点之后，所以倒着走一遍就能把每个节点的
  // 合计推给它的父节点。
  const byPath = new Map(nodes.map(n => [n.path, n]))
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    node.total += node.own.length
    if (node.parent) {
      const parent = byPath.get(node.parent)
      if (parent) {
        parent.total += node.total
      }
    }
  }

  // 库里一个 tag 都没有的分类不展示：上游覆盖 22k 个 tag，本地不一定都收了，留着
  // 只会是一行点开什么都没有的标题。父节点的 total 含整棵子树，所以父为 0 时子孙
  // 必然也是 0，整棵一起消失，不会留下孤儿。
  return nodes.filter(n => n.total > 0)
}

/** 只保留命中搜索的 tag，以及还剩下 tag 的那些分类（计数同步重算）。 */
export function filterTagTree(nodes: TagTreeNode[], match: (tag: TagWithCountPublic) => boolean): TagTreeNode[] {
  const filtered = nodes.map(n => ({ ...n, own: n.own.filter(match), total: 0 }))
  const byPath = new Map(filtered.map(n => [n.path, n]))
  for (let i = filtered.length - 1; i >= 0; i--) {
    const node = filtered[i]
    node.total += node.own.length
    if (node.parent) {
      const parent = byPath.get(node.parent)
      if (parent) {
        parent.total += node.total
      }
    }
  }
  return filtered.filter(n => n.total > 0)
}

/**
 * 可见的节点 —— 一个分类可见，当且仅当它的父分类既可见又展开。
 *
 * 单趟 O(n)：深度优先序保证父节点先于子节点被处理，所以父的可见性算好时子正好用得上。
 */
export function visibleNodes(nodes: TagTreeNode[], expanded: ReadonlySet<string>): TagTreeNode[] {
  const shown = new Map<string, boolean>()
  const out: TagTreeNode[] = []
  for (const node of nodes) {
    const visible = node.parent === null
      ? true
      : (shown.get(node.parent) ?? false) && expanded.has(node.parent)
    shown.set(node.path, visible)
    if (visible) {
      out.push(node)
    }
  }
  return out
}

/** 一个顶层分类，和归到它名下的那些东西。 */
export interface TopCategoryGroup<T> {
  path: string
  name: string
  items: T[]
}

/**
 * 按**顶层**语义分类给一组 tag 分堆。
 *
 * 详情页用：一张图几十个 tag 平铺成一片，眼睛没有着力点。分到「服饰 / 发型 /
 * 表情 / 构图」之下就好读得多。只取顶层（11 个）而不是完整路径——侧栏那点宽度
 * 放不下五层，而且这里要的是扫一眼看清有什么，不是精确定位。
 */
export function useTopCategoryGrouper() {
  const treeQuery = useTagTreeQuery()

  const lookup = computed(() => {
    const categories = toRaw(treeQuery.data.value) ?? []
    /** 顶层 path -> 本地化名，插入序即上游的顶层顺序。 */
    const names = new Map<string, string>()
    /** tag 名 -> 它所属的顶层 path。 */
    const topOf = new Map<string, string>()
    for (const c of categories) {
      if (c.depth === 0) {
        names.set(c.path, c.name)
      }
      const top = c.path.split('.')[0]
      for (const tag of c.tags) {
        topOf.set(tag, top)
      }
    }
    return { names, topOf }
  })

  /**
   * 分堆结果，顺序跟随上游的顶层顺序，其后是 danbooru tag type 的那几堆（画师名、
   * 作品名…），最后才是真正没归属的。空堆不会出现。
   *
   * `typeOf` 拿的是 tag 的 danbooru type：树够不着画师名和作品名，但那不代表它们
   * 没有分类，只是分在另一个维度上。
   */
  return function group<T>(
    items: T[],
    nameOf: (item: T) => string,
    typeOf: (item: T) => string | null | undefined,
    labelOf: (key: string) => string,
  ): TopCategoryGroup<T>[] {
    const { names, topOf } = lookup.value
    const buckets = new Map<string, T[]>()
    for (const item of items) {
      let key = topOf.get(nameOf(item))
      if (key === undefined) {
        const type = typeOf(item) ?? ''
        key = (FALLBACK_TYPES as readonly string[]).includes(type) ? `${UNCATEGORISED}.${type}` : UNCATEGORISED
      }
      const bucket = buckets.get(key)
      if (bucket) {
        bucket.push(item)
      }
      else {
        buckets.set(key, [item])
      }
    }
    const out: TopCategoryGroup<T>[] = []
    const pushType = (type: string) => {
      const bucket = buckets.get(`${UNCATEGORISED}.${type}`)
      if (bucket) {
        out.push({ path: `${UNCATEGORISED}.${type}`, name: labelOf(type), items: bucket })
      }
    }
    // 画师 → 系列名 → 角色名 → 语义树 → 未分类 → 元信息，和标签管理页同一个次序。
    for (const type of LEADING_TYPES) {
      pushType(type)
    }
    for (const [path, name] of names) {
      const bucket = buckets.get(path)
      if (bucket) {
        out.push({ path, name, items: bucket })
      }
    }
    const rest = buckets.get(UNCATEGORISED)
    if (rest) {
      out.push({ path: UNCATEGORISED, name: labelOf(UNCATEGORISED), items: rest })
    }
    for (const type of TRAILING_TYPES) {
      pushType(type)
    }
    return out
  }
}
