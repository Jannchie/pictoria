/**
 * listwise 的排序必须回流进比较图 —— 否则组内排序永远排不空重访池。
 *
 * 2026-08-20 的实测症状：44 个已排的组里 post 8884 出现 11 次、8848 出现 10 次，两者同组
 * 9 次，而它们在比较图里的度数始终是 1。原因是 insertListwise 只写 listwise_annotations，
 * 而 judgedGraph / revisitPool 当时只读 pairwise_annotations，于是「已判但比较不足」的判定
 * 完全看不见排序结果：每组预留给 revisitSeeds 的 CLOSE_REVISIT_MEMBERS 个席位一次次征召同
 * 一批图，排多少次都不会毕业。
 *
 * 这里钉的是那条回流：排过一组之后，成员不再被当成比较不足的图重新征召。
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { createTempDb, insertPost, insertVector, unitBlob } from '../__fixtures__/testdb.js'
import { AESTHETIC_SCORES_TABLE, SILVA } from '../scorers.js'
import { insertListwise, insertPairwise } from './annotations.js'
import { Sampler } from './sampling.js'

let sqlite: import('better-sqlite3').Database
let cleanup: () => void

/**
 * 一张有 silva 分、有 embedding 的合格图。
 *
 * 分数全落在一个 CLOSE_PAIR_MAX_SILVA_DIFF (0.10) 窗口里，于是任何窗口中心都能看见所有图 ——
 * 这样测的是「谁被征召」，而不是「窗口碰巧罩住了谁」。
 */
function eligiblePost(id: number, score: number): void {
  insertPost(sqlite, { id })
  sqlite
    .prepare(`INSERT INTO ${AESTHETIC_SCORES_TABLE} (post_id, scorer, score) VALUES (?, ?, ?)`)
    .run(id, SILVA.name, score)
  insertVector(sqlite, id, unitBlob(id))
}

const IDS = Array.from({ length: 200 }, (_, i) => i + 1)
const REVISITABLE = IDS.slice(0, 20)

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb('sampling-listwise'))
  for (const id of IDS) eligiblePost(id, 0.50 + (id % 5) * 0.001)
})

beforeEach(() => {
  sqlite.exec('DELETE FROM pairwise_annotations; DELETE FROM listwise_annotations')
})

afterAll(() => cleanup())

/** 判过一对，让两张图进「已判」集合但度数只有 1 —— 正是重访池最想征召的状态。 */
function judgePair(a: number, b: number): void {
  insertPairwise(sqlite, {
    post_a: a,
    post_b: b,
    dimension: 'overall',
    winner: 'a',
    rubric_version: 'overall-v1',
    session_id: 's',
  })
}

function rank(members: number[]): void {
  insertListwise(sqlite, {
    post_ids: members,
    ranking: members,
    dimension: 'overall',
    rubric_version: 'overall-v1',
    session_id: 's',
  })
}

/** 连抽 40 批（每批就是一次真实的 sample-listwise 调用），统计每张图被征召几次。 */
function draftCounts(): Map<number, number> {
  const seen = new Map<number, number>()
  for (let batch = 0; batch < 40; batch++)
    for (const group of new Sampler(sqlite).sampleGroups({ count: 3, size: 6, dimension: 'overall' }))
      for (const pid of group) seen.set(pid, (seen.get(pid) ?? 0) + 1)
  return seen
}

it('排过一组之后，成员不再被当成比较不足的图反复征召', () => {
  judgePair(1, 2) // 度数 1，未排序前是重访池的头号人选
  expect(draftCounts().get(1) ?? 0).toBeGreaterThan(0) // 前提：它确实会被征召

  rank([1, 2, 3, 4, 5, 6]) // 一次 6 张的全序 = 每个成员 +5 度，越过 CLOSE_PAIR_DEGREE=3
  const after = draftCounts()
  for (const pid of [1, 2, 3, 4, 5, 6])
    expect(after.get(pid) ?? 0, `post ${pid} 排过了还在被征召`).toBe(0)
})

it('skip 的组算问过但不占度数 —— 成员仍留在重访池里', () => {
  insertListwise(sqlite, {
    post_ids: [1, 2, 3, 4, 5, 6],
    ranking: [], // skip
    dimension: 'overall',
    rubric_version: 'overall-v1',
    session_id: 's',
  })
  const drafted = draftCounts()
  expect([1, 2, 3, 4, 5, 6].some(pid => (drafted.get(pid) ?? 0) > 0)).toBe(true)
})

it('同度数的候选是随机取的，不由扫描序决定', () => {
  // 20 张两两判过一对：全是度数 1，在重访池里完全等价，而每批只有 6 个重访席位。
  // 平局若按 nSmallest 的稳定序决胜，那个序就是 pool 的 Map 插入序 —— 一条没有 ORDER BY
  // 的 SQL 的扫描序，每批都一样 —— 于是永远是排在最前的那 6 张被反复征召，另外 14 张只能
  // 靠普通候选那条路径偶尔露面。这正是 8884/8848 在 44 个组里同框 9 次的成因。
  for (const pid of REVISITABLE) if (pid % 2 === 1) judgePair(pid, pid + 1)
  const drafted = draftCounts()
  const regulars = REVISITABLE.filter(pid => (drafted.get(pid) ?? 0) >= 5)
  // 洗牌后 20 张应该雨露均沾；固定序下只有头 6 张能过这条线。
  expect(regulars.length, `重访池里只有 ${regulars.length} 张被反复征召`).toBeGreaterThan(12)
})

it('资格过滤：重复图与排队中的图不会被抽到', () => {
  // SILVA_ELIGIBLE 在 2026-08-21 从「JOIN posts」改成「拿两个小排除集反查」，把
  // windowSeeds 从 315ms 压到 73ms。语义必须逐行不变，而这两条排除是它全部的语义。
  const dup = 7 // 被判为另一张的近重复
  const queued = 9 // 挂在未完成的 pairwise 队列项上
  sqlite.prepare('UPDATE posts SET canonical_post_id = ? WHERE id = ?').run(8, dup)
  const qid = Number(
    sqlite.prepare("INSERT INTO annotation_queues (name, kind, dimensions, scale) VALUES ('q', 'pairwise', '[\"overall\"]', NULL)")
      .run().lastInsertRowid,
  )
  sqlite
    .prepare('INSERT INTO pairwise_queue_items (queue_id, position, post_a, post_b, done) VALUES (?, 0, ?, ?, 0)')
    .run(qid, queued, 10)
  try {
    const drafted = draftCounts()
    expect(drafted.get(dup) ?? 0, '重复图被抽到了').toBe(0)
    expect(drafted.get(queued) ?? 0, '排队中的图被抽到了').toBe(0)
    expect(drafted.size, '其余图仍然照常被抽').toBeGreaterThan(20)
  }
  finally {
    sqlite.prepare('UPDATE posts SET canonical_post_id = NULL WHERE id = ?').run(dup)
    sqlite.prepare('DELETE FROM pairwise_queue_items WHERE queue_id = ?').run(qid)
    sqlite.prepare('DELETE FROM annotation_queues WHERE id = ?').run(qid)
  }
})
