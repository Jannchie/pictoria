/** 采样里的随机小工具：洗牌、蓄水池、稳定 nSmallest、左右翻转。都不碰 sqlite。 */

/**
 * 等概率决定这一对谁在左。
 *
 * 离开采样器的那一刻，呈现顺序必须与任何有意义的量无关 —— 否则位置和内容混在一起，
 * 事后再也分不开。pairByScoreBand 是 `out.push([a.id, b.id])` 且 `a.score <= b.score`，
 * UI 又恒定把 post_a 画在左边，于是 similar 抽出的对里屏幕左侧系统性站着旧分更低的那张：
 * 实测到 2026-08-20，mean(silva_a − silva_b) = −0.0153，z = −10.5，而想检验标注者有没有
 * 左右偏好，就只能在模型判定几乎相等的子集里做，功效低到既证不出也排除不掉一个 2~3%
 * 的效应（|Δsilva| < 0.005 时 n=784、z=−1.43）。
 *
 * listwise 那边是同一条不变量的另一种形态（sampleGroups 返回前 shuffle 成员）。
 */
export function flipPair([a, b]: [number, number]): [number, number] {
  return Math.random() < 0.5 ? [b, a] : [a, b]
}

/** 原地 Fisher-Yates。 */
export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!]
  }
  return items
}

/**
 * 一趟流式随机取 `n` 个（蓄水池抽样），结果的顺序本身也是随机的。
 *
 * 存在的理由是 listwise 那条路径上池子在内存里而不是在 SQL 里：`shuffle([...map.keys()])`
 * 要为 9.6 万个 id 建一个数组再全洗一遍，只为取头 32 个，而每个窗口都要做一次。蓄水池
 * 是同一个分布，不分配中间数组，也不碰不需要的那部分。
 */
export function reservoir<T>(items: Iterable<T>, n: number): T[] {
  const out: T[] = []
  let seen = 0
  for (const item of items) {
    seen++
    if (out.length < n) {
      out.push(item)
      continue
    }
    const j = Math.floor(Math.random() * seen)
    if (j < n)
      out[j] = item
  }
  return out
}

/** 取 `n` 个 key 最小的元素，平局保持原顺序（≡ Python `heapq.nsmallest`）。 */
export function nSmallest<T>(n: number, items: T[], key: (x: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((x, y) => x.k - y.k || x.i - y.i)
    .slice(0, n)
    .map(x => x.item)
}
