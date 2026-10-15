/**
 * pair-graph.ts 的纯算法 —— 不建库。
 *
 * 钉住的是采样器赖以成立的几条结构不变量：分量划分是对点集的划分、环让每个成员度数 2、
 * 块内广度优先（每条边都碰到前面出现过的图）、一对只问一次、以及 interleaveWithBridges
 * 发出的**每个前缀都连通**（标注者随时可以停，停下时手里不能是几座孤岛）。
 */
import { describe, expect, it } from 'vitest'
import {
  breadthFirst,
  components,
  connectedBlocks,
  cycleEdges,
  interleaveWithBridges,
  PairGraph,
} from './pair-graph.js'
import type { Block } from './pair-graph.js'

type Edge = [number, number]

function sortedGroups(groups: Map<number, Set<number>>): number[][] {
  return [...groups.values()].map(g => [...g].sort((a, b) => a - b)).sort((x, y) => x[0]! - y[0]!)
}

/** 每条边（第一条除外）都至少碰到一个在它之前出现过的端点。 */
function touchesPrevious(edges: Edge[]): boolean {
  const seen = new Set<number>()
  return edges.every(([a, b], i) => {
    const ok = i === 0 || seen.has(a) || seen.has(b)
    seen.add(a)
    seen.add(b)
    return ok
  })
}

describe('components', () => {
  it('把边表的端点划分成连通分量', () => {
    const groups = components([[1, 2], [3, 4], [2, 5], [6, 7], [7, 3]])
    expect(sortedGroups(groups)).toEqual([[1, 2, 5], [3, 4, 6, 7]])
  })

  it('分量的 key 是它自己的成员（并查集的根）', () => {
    for (const [root, members] of components([[10, 20], [20, 30], [40, 50]]))
      expect(members.has(root)).toBe(true)
  })

  it('空边表 → 没有分量；重复边和反向边不影响划分', () => {
    expect(components([]).size).toBe(0)
    expect(sortedGroups(components([[1, 2], [2, 1], [1, 2]]))).toEqual([[1, 2]])
  })

  it('长链不会因为合并顺序而断开（路径减半仍找到同一个根）', () => {
    const chain: Edge[] = Array.from({ length: 200 }, (_, i) => [i, i + 1])
    const groups = components(chain.reverse())
    expect(groups.size).toBe(1)
    expect([...groups.values()][0]!.size).toBe(201)
  })
})

describe('cycleEdges', () => {
  it('少于两个成员不产生边，两个成员只产生一条（不闭合成重复问题）', () => {
    expect([...cycleEdges([])]).toEqual([])
    expect([...cycleEdges([1])]).toEqual([])
    expect([...cycleEdges([1, 2])]).toEqual([[1, 2]])
  })

  it('m >= 3 个成员 → m 条边、每个成员度数 2、首尾闭合', () => {
    const members = [5, 9, 2, 7, 4, 1]
    const edges = [...cycleEdges(members)]
    expect(edges).toHaveLength(members.length)
    const degree = new Map<number, number>()
    for (const [a, b] of edges) {
      degree.set(a, (degree.get(a) ?? 0) + 1)
      degree.set(b, (degree.get(b) ?? 0) + 1)
    }
    expect([...degree.values()].every(d => d === 2)).toBe(true)
    expect(edges.at(-1)).toEqual([1, 5])
    expect(components(edges).size).toBe(1)
  })

  it('按链序产出：任何前缀都是连通的', () => {
    const edges = [...cycleEdges([1, 2, 3, 4, 5])]
    for (let k = 1; k <= edges.length; k++)
      expect(components(edges.slice(0, k)).size).toBe(1)
  })
})

describe('breadthFirst', () => {
  it('重排一个连通边表，使每条边都碰到前面用过的图，边的多重集不变', () => {
    const edges: Edge[] = [[1, 2], [5, 6], [3, 4], [2, 3], [4, 5]]
    const ordered = breadthFirst(edges)
    expect(ordered[0]).toEqual([1, 2])
    expect(touchesPrevious(ordered)).toBe(true)
    expect([...ordered].sort()).toEqual([...edges].sort())
  })

  it('不连通的输入也不丢边（找不到相接的就按原序取下一条）', () => {
    const edges: Edge[] = [[1, 2], [3, 4]]
    expect(breadthFirst(edges)).toEqual([[1, 2], [3, 4]])
  })
})

describe('connectedBlocks', () => {
  it('完整的环是一块，代表是第一条边的一个端点，score 是窗口中心', () => {
    const edges = [...cycleEdges([1, 2, 3, 4])]
    const blocks = connectedBlocks(edges, 0.42)
    expect(blocks).toHaveLength(1)
    const [blockEdges, [rep, score]] = blocks[0]!
    expect(score).toBe(0.42)
    expect(blockEdges[0]).toContain(rep)
    expect(touchesPrevious(blockEdges)).toBe(true)
  })

  it('环被两条已问过的边切成两段弧 → 两块，各自连通、各有代表', () => {
    // 环 1-2-3-4-5-6-1 去掉 (2,3) 和 (5,6)，剩下 6-1-2 与 3-4-5 两段弧。
    const edges: Edge[] = [[1, 2], [3, 4], [4, 5], [6, 1]]
    const blocks = connectedBlocks(edges, 0.5)
    expect(blocks).toHaveLength(2)
    const memberSets = blocks.map(([es]) => new Set(es.flat()))
    expect(memberSets.map(s => [...s].sort((a, b) => a - b))).toEqual(
      expect.arrayContaining([[1, 2, 6], [3, 4, 5]]),
    )
    for (const [es, [rep]] of blocks) {
      expect(es[0]).toContain(rep)
      expect(touchesPrevious(es)).toBe(true)
      expect(components(es).size).toBe(1)
    }
  })
})

describe('PairGraph', () => {
  it('claim：自配对和已问过的对（任一方向）返回 null，且不动度数', () => {
    const g = new PairGraph(3)
    expect(g.claim(1, 1)).toBeNull()
    expect(g.claim(1, 2)).toEqual([1, 2])
    expect(g.claim(2, 1)).toBeNull()
    expect(g.claim(1, 2)).toBeNull()
    expect(g.degreeOf(1)).toBe(1)
    expect(g.degreeOf(2)).toBe(1)
    expect(g.emitted.size).toBe(1)
  })

  it('度数达到上限就进 saturated、spent 为真', () => {
    const g = new PairGraph(2)
    g.claim(1, 2)
    expect(g.spent(1)).toBe(false)
    expect(g.saturated().has(1)).toBe(false)
    g.claim(1, 3)
    expect(g.spent(1)).toBe(true)
    expect(g.saturated().has(1)).toBe(true)
    expect(g.saturated().has(2)).toBe(false)
  })

  it('unbounded：决定性判决不足两条是 0；全胜 +1、全败 -1、有胜有负 0', () => {
    const g = new PairGraph(3)
    g.wins.set(1, 1)
    expect(g.unbounded(1)).toBe(0)
    g.wins.set(1, 2)
    expect(g.unbounded(1)).toBe(1)
    g.losses.set(2, 3)
    expect(g.unbounded(2)).toBe(-1)
    g.wins.set(3, 1)
    g.losses.set(3, 1)
    expect(g.unbounded(3)).toBe(0)
    expect(g.unbounded(99)).toBe(0)
  })

  it('mainComponent：emitted 的最大连通分量', () => {
    const g = new PairGraph(10)
    for (const [a, b] of [[1, 2], [2, 3], [3, 4], [10, 11]] as Edge[]) g.claim(a, b)
    expect([...g.mainComponent()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(new PairGraph(1).mainComponent().size).toBe(0)
  })
})

describe('interleaveWithBridges', () => {
  /** 用 graph 把各块的边先 claim 掉 —— 这是 windowBlock 交出块之前的状态。 */
  function claimed(graph: PairGraph, blocks: Block[]): Block[] {
    for (const [edges] of blocks)
      for (const [a, b] of edges) graph.claim(a, b)
    return blocks
  }

  it('每个前缀都连通，块之间恰好 k−1 条桥', () => {
    const graph = new PairGraph(100)
    const blocks = claimed(graph, [
      ...connectedBlocks([...cycleEdges([1, 2, 3, 4])], 0.3),
      ...connectedBlocks([...cycleEdges([11, 12, 13])], 0.1),
      ...connectedBlocks([...cycleEdges([21, 22, 23, 24, 25])], 0.2),
    ])
    const out = interleaveWithBridges(blocks, graph, 100)
    expect(out).toHaveLength(4 + 3 + 5 + 2)
    for (let k = 1; k <= out.length; k++)
      expect(components(out.slice(0, k)).size, `prefix ${k} 断开了`).toBe(1)
  })

  it('无边的锚点块只提供搭桥位置：它本身不出边，但被桥接进来', () => {
    const graph = new PairGraph(100)
    const anchor: Block = [[], [500, 0]]
    const blocks = claimed(graph, [anchor, ...connectedBlocks([...cycleEdges([1, 2, 3])], 0.5)])
    const out = interleaveWithBridges(blocks, graph, 100)
    expect(out).toHaveLength(3 + 1)
    expect(out.flat()).toContain(500)
    for (let k = 1; k <= out.length; k++)
      expect(components(out.slice(0, k)).size).toBe(1)
  })

  it('按 score 升序排块，轮转发牌：第一轮每块出一条', () => {
    const graph = new PairGraph(100)
    const blocks = claimed(graph, [
      ...connectedBlocks([...cycleEdges([1, 2, 3])], 0.9),
      ...connectedBlocks([...cycleEdges([11, 12, 13])], 0.1),
    ])
    const out = interleaveWithBridges(blocks, graph, 100)
    // 0.1 那块先出它的第一条边，然后是桥，然后才是 0.9 那块的第一条边
    expect(out[0]!.every(p => p >= 11)).toBe(true)
    expect(out[1]!.some(p => p >= 11) && out[1]!.some(p => p < 11)).toBe(true)
    expect(out[2]!.every(p => p < 11)).toBe(true)
  })

  it('截断到 count，桥也记进 graph（一对只问一次）', () => {
    const graph = new PairGraph(100)
    const blocks = claimed(graph, [
      ...connectedBlocks([...cycleEdges([1, 2, 3])], 0.1),
      ...connectedBlocks([...cycleEdges([11, 12, 13])], 0.2),
    ])
    const before = graph.emitted.size
    const out = interleaveWithBridges(blocks, graph, 2)
    expect(out).toHaveLength(2)
    expect(graph.emitted.size).toBe(before + 1)
  })
})
