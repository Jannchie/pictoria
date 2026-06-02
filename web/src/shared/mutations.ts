export interface IdValue<T> {
  id: number
  value: T
}

/** 把 (id, value) 列表按 value 分组，供批量撤销时按旧值分批发请求。 */
export function groupIdsByValue<T>(entries: IdValue<T>[]): Map<T, number[]> {
  const groups = new Map<T, number[]>()
  for (const { id, value } of entries) {
    const ids = groups.get(value)
    if (ids) {
      ids.push(id)
    }
    else {
      groups.set(value, [id])
    }
  }
  return groups
}

/**
 * 从一批已知 post 中读取每个 id 的旧值；缓存里没有的 id 记入 missingIds
 * （批量"尽力而为"撤销：未加载的 post 旧值不可知，无法还原）。
 */
export function captureOldValues<P extends { id: number }, T>(
  posts: P[],
  ids: number[],
  read: (post: P) => T,
): { captured: IdValue<T>[], missingIds: number[] } {
  const byId = new Map(posts.map(p => [p.id, p]))
  const captured: IdValue<T>[] = []
  const missingIds: number[] = []
  for (const id of ids) {
    const post = byId.get(id)
    if (post) {
      captured.push({ id, value: read(post) })
    }
    else {
      missingIds.push(id)
    }
  }
  return { captured, missingIds }
}
