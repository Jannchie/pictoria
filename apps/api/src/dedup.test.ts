/**
 * 两级判定的纯函数部分：分档和汇边。
 *
 * 这两步错了都不会报错，只会让分组静悄悄地不对 —— 分档错一档，整条灰带要么全被
 * 当成同一张（假阳性洪水），要么全被丢掉（功能等于没上）；汇边错了，用户点过的
 * "不是同一张"会在下一次重建里被计算结果盖回去。
 */
import { DEDUP_THRESHOLD, LPIPS_SAME_THRESHOLD } from '@pictoria/contracts'
import { describe, expect, it } from 'vitest'
import { buildEdges, classifyPairs } from './dedup.js'

/** post id 与行下标错开，这样"忘了翻译下标"会被测出来而不是碰巧通过。 */
const IDS = [101, 202, 303, 404]

describe('classifyPairs', () => {
  it('translates row indices into post ids', () => {
    const { accepted } = classifyPairs(IDS, [[0, 2, 0.001]], DEDUP_THRESHOLD)

    expect(accepted).toEqual([{ a: 101, b: 303, strength: expect.any(Number) }])
  })

  it('splits on the threshold, not around it', () => {
    const { accepted, grey } = classifyPairs(
      IDS,
      [[0, 1, DEDUP_THRESHOLD], [2, 3, DEDUP_THRESHOLD + 1e-9]],
      DEDUP_THRESHOLD,
    )

    // 恰好等于阈值的算"直接判同" —— 和 worker 侧 `>= sim_threshold` 的闭区间一致。
    expect(accepted.map(e => [e.a, e.b])).toEqual([[101, 202]])
    expect(grey.map(p => [p.a, p.b])).toEqual([[303, 404]])
  })

  it('orders grey pairs so a and b match the evidence table', () => {
    const { grey } = classifyPairs(IDS, [[3, 0, 0.04]], DEDUP_THRESHOLD)

    expect(grey[0]).toMatchObject({ a: 101, b: 404 })
  })

  it('ranks a closer pair stronger, and any siglip pair above any lpips pair', () => {
    const { accepted } = classifyPairs(IDS, [[0, 1, 0.009], [2, 3, 0.001]], DEDUP_THRESHOLD)

    expect(accepted[1]!.strength).toBeGreaterThan(accepted[0]!.strength)
    // LPIPS 档归一化在 (0, 1]，所以 SigLIP 档必须整体高于 1。
    expect(accepted[0]!.strength).toBeGreaterThan(1)
  })

  it('drops a pair whose index is not in the id array', () => {
    // 只可能是 worker 和这一轮的矩阵对不上；拿 undefined 当 id 写库更糟。
    expect(classifyPairs(IDS, [[0, 99, 0.001]], DEDUP_THRESHOLD).accepted).toEqual([])
  })

  it('drops a pair that arrives without its distance', () => {
    // 契约说距离恒定带着；真缺了只可能是 worker 版本对不上，而"当成 0"就是
    // 把整条灰带判成同一张画。丢掉是唯一安全的方向。
    const { accepted, grey } = classifyPairs(IDS, [[0, 1]], DEDUP_THRESHOLD)

    expect(accepted).toEqual([])
    expect(grey).toEqual([])
  })
})

describe('buildEdges', () => {
  const accepted = [{ a: 101, b: 202, strength: 2 }]
  const grey = [{ a: 303, b: 404, dist: 0.04 }]

  it('turns an arbitrated pair below the threshold into an edge', () => {
    const distances = new Map([['303:404', 0.2]])

    const edges = buildEdges(accepted, grey, distances, [], LPIPS_SAME_THRESHOLD)

    expect(edges.map(e => [e.a, e.b])).toEqual([[101, 202], [303, 404]])
  })

  it('leaves an arbitrated pair above the threshold out', () => {
    const distances = new Map([['303:404', 0.7]])

    expect(buildEdges(accepted, grey, distances, [], LPIPS_SAME_THRESHOLD)).toHaveLength(1)
  })

  it('leaves a pair that was never arbitrated out', () => {
    expect(buildEdges(accepted, grey, new Map(), [], LPIPS_SAME_THRESHOLD)).toHaveLength(1)
  })

  it('drops an edge the user called different, however close it measures', () => {
    const distances = new Map([['303:404', 0.01]])
    const verdicts = [{ postA: 303, postB: 404, verdict: 'different' as const }]

    expect(buildEdges(accepted, grey, distances, verdicts, LPIPS_SAME_THRESHOLD)).toHaveLength(1)
  })

  it('drops a directly-accepted edge the user called different', () => {
    const verdicts = [{ postA: 101, postB: 202, verdict: 'different' as const }]

    expect(buildEdges(accepted, grey, new Map(), verdicts, LPIPS_SAME_THRESHOLD)).toEqual([])
  })

  it('adds a user-merged pair that no measurement ever proposed', () => {
    const verdicts = [{ postA: 700, postB: 800, verdict: 'same' as const }]

    const edges = buildEdges([], [], new Map(), verdicts, LPIPS_SAME_THRESHOLD)

    expect(edges).toEqual([{ a: 700, b: 800, strength: expect.any(Number) }])
    // 用户那一档必须强过任何算出来的边，组大小闸才不会先放弃它。
    expect(edges[0]!.strength).toBeGreaterThan(2)
  })
})
