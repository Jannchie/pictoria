/** sampling-random.ts —— 不建库。只钉形状上的契约，分布交给采样器自己的测试。 */
import { expect, it } from 'vitest'
import { flipPair, nSmallest, reservoir, shuffle } from './sampling-random.js'

it('shuffle 原地返回同一个数组，且是原元素的一个排列', () => {
  const items = Array.from({ length: 50 }, (_, i) => i)
  const out = shuffle(items)
  expect(out).toBe(items)
  expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i))
})

it('reservoir 取 min(n, 总数) 个互不相同的输入元素，可以吃生成器', () => {
  function* gen() {
    for (let i = 0; i < 1000; i++) yield i
  }
  const picked = reservoir(gen(), 32)
  expect(picked).toHaveLength(32)
  expect(new Set(picked).size).toBe(32)
  expect(picked.every(x => x >= 0 && x < 1000)).toBe(true)
  expect(reservoir([1, 2, 3], 10).sort()).toEqual([1, 2, 3])
  expect(reservoir([], 5)).toEqual([])
})

it('nSmallest 按 key 升序取前 n 个，平局保持输入顺序（≡ heapq.nsmallest）', () => {
  const items = ['a3', 'b1', 'c2', 'd1', 'e3']
  expect(nSmallest(3, items, s => Number(s[1]))).toEqual(['b1', 'd1', 'c2'])
  expect(nSmallest(10, items, () => 0)).toEqual(items)
})

it('flipPair 只交换左右，不改成员', () => {
  for (let i = 0; i < 20; i++) {
    const out = flipPair([3, 8])
    expect([...out].sort((a, b) => a - b)).toEqual([3, 8])
  }
})
