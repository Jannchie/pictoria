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
import { createTempDb, insertPost, insertVector, tagPost, unitBlob } from '../__fixtures__/testdb.js'
import { resolveFormat } from '../formats.js'
import { AESTHETIC_SCORES_TABLE, SILVA } from '../scorers.js'
import { insertListwise, insertPairwise } from './annotations.js'
import { Sampler } from './sampling.js'

let sqlite: import('better-sqlite3').Database
let cleanup: () => void

/**
 * 一张有 silva 分、有人工绝对分、有 embedding 的合格图。
 *
 * silva 分默认全落在一个 CLOSE_PAIR_MAX_SILVA_DIFF (0.10) 窗口里，于是任何窗口中心都能看见
 * 所有图 —— 这样测的是「谁被征召」，而不是「窗口碰巧罩住了谁」。
 *
 * `graded` 默认 3：sampleGroups 从 2026-09-05 起只从有人工绝对分的图里抽（ANCHORED_ELIGIBLE），
 * 所以 insertPost 的 score=0 默认值会让每一批都抽空。给它一个分不是脚手架的方便，而是这个
 * 采样器的前提条件。
 */
function eligiblePost(
  db: import('better-sqlite3').Database,
  id: number,
  score: number,
  { graded = 3, tags = [] as string[] } = {},
): void {
  insertPost(db, { id, score: graded })
  db
    .prepare(`INSERT INTO ${AESTHETIC_SCORES_TABLE} (post_id, scorer, score) VALUES (?, ?, ?)`)
    .run(id, SILVA.name, score)
  insertVector(db, id, unitBlob(id))
  for (const tag of tags) tagPost(db, id, tag)
}

const IDS = Array.from({ length: 200 }, (_, i) => i + 1)
const REVISITABLE = IDS.slice(0, 20)

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb('sampling-listwise'))
  for (const id of IDS) eligiblePost(sqlite, id, 0.50 + (id % 5) * 0.001)
})

beforeEach(() => {
  sqlite.exec('DELETE FROM pairwise_annotations; DELETE FROM listwise_annotations')
})

afterAll(() => cleanup())

/** 判过一对，让两张图进「已判」集合但度数只有 1 —— 正是重访池最想征召的状态。 */
function judgePair(a: number, b: number, db = sqlite): void {
  insertPairwise(db, {
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

/**
 * 连抽 40 批（每批就是一次真实的 sample-listwise 调用），返回抽到的所有组。
 *
 * `repeatShare: 0` 是必需的：重测席位原样重放历史组，不走窗口/形态/锚点那套约束，
 * 而它按伯努利逐槽抽 —— 混进来就是 5% 概率让下面每一条断言随机翻车。重测通道自己的
 * 行为由本文件末尾那组用例覆盖。
 *
 * `seedMinStars: 1` 同理：生产默认只从 4 星以上抽窗口中心（差距全在高分档），而这里的
 * fixture 每张图都是 graded=3，不放开就一个种子都抽不到。星级筛选自己的行为单独测。
 */
function sampleBatches(db = sqlite, { batches = 40, count = 3, size = 6 } = {}): number[][] {
  const out: number[][] = []
  for (let batch = 0; batch < batches; batch++)
    out.push(...new Sampler(db).sampleGroups({ count, size, dimension: 'overall', repeatShare: 0, seedMinStars: 1 }))
  return out
}

/** 同样 40 批，统计每张图被征召几次。 */
function draftCounts(db = sqlite): Map<number, number> {
  const seen = new Map<number, number>()
  for (const group of sampleBatches(db))
    for (const pid of group) seen.set(pid, (seen.get(pid) ?? 0) + 1)
  return seen
}

it('出场两次之后成员退役，一次不够 —— 一次排序值 2 度而不是 n−1', () => {
  judgePair(1, 2) // 度数 1，未排序前是重访池的头号人选
  expect(draftCounts().get(1) ?? 0).toBeGreaterThan(0) // 前提：它确实会被征召

  // 一次出场 = 每个成员 +LISTWISE_APPEARANCE_DEGREE(2)，与组多大无关：全序的 C(n,2)
  // 条边由 n 个潜变量的一个排列生成，不是 C(n,2) 次独立观测。
  rank([1, 2, 3, 4, 5, 6])
  const after = draftCounts()
  // 1 和 2 已有一条成对边，1+2 = 3 到达 CLOSE_PAIR_DEGREE，退役。
  for (const pid of [1, 2])
    expect(after.get(pid) ?? 0, `post ${pid} 已满度还在被征召`).toBe(0)
  // 3..6 只出场过一次（2 < 3），还欠一次 —— 这正是按 n−1 记账时丢掉的那次重访。
  expect([3, 4, 5, 6].some(pid => (after.get(pid) ?? 0) > 0), '只出场一次的成员应该还能被重访').toBe(true)

  rank([3, 4, 5, 6, 7, 8]) // 第二次出场：3..6 到 4 度
  const final = draftCounts()
  for (const pid of [1, 2, 3, 4, 5, 6])
    expect(final.get(pid) ?? 0, `post ${pid} 出场两次了还在被征召`).toBe(0)
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

// ─── 形态收口与有锚过滤（2026-09-05） ──────────────────────────────
//
// 主库那 200 张是「同一个窗口、同一种形态、全都有绝对分」的理想池，测的是征召逻辑。
// 下面这些测的是采样器**拒绝**什么，所以每个用例铺自己的库：一张图有没有绝对分、是什么
// 形态、silva 分落在哪，正是被测的变量本身。

interface ScenarioPost { id: number, silva?: number, graded?: number, tags?: string[] }

/** 只为一个用例存在的库。 */
function withScenario(label: string, posts: ScenarioPost[], run: (db: import('better-sqlite3').Database) => void): void {
  const { sqlite: db, cleanup: done } = createTempDb(`listwise-${label}`)
  try {
    for (const p of posts)
      eligiblePost(db, p.id, p.silva ?? 0.50, { graded: p.graded ?? 3, tags: p.tags ?? [] })
    run(db)
  }
  finally {
    done()
  }
}

/** 一组成员实际落在哪些形态上 —— 走的是 formats.ts 的同一条规则，不是测试自己的复读。 */
function formatsOf(db: import('better-sqlite3').Database, group: number[]): Set<string> {
  const out = new Set<string>()
  for (const pid of group) {
    const tags = (db.prepare('SELECT tag_name FROM post_has_tag WHERE post_id = ?').all(pid) as Array<{ tag_name: string }>)
      .map(r => r.tag_name)
    out.add(resolveFormat(t => tags.includes(t)))
  }
  return out
}

function silvaOf(db: import('better-sqlite3').Database, pid: number): number {
  return (db.prepare(`SELECT score FROM ${AESTHETIC_SCORES_TABLE} WHERE post_id = ? AND scorer = ?`)
    .get(pid, SILVA.name) as { score: number }).score
}

const COMIC = ['comic']

it('形态优先级只由 FORMAT_TAGS 的数组序决定', () => {
  expect(resolveFormat(t => ['comic', 'monochrome'].includes(t))).toBe('comic')
  expect(resolveFormat(t => t === 'multiple_views')).toBe('sheet')
  expect(resolveFormat(t => t === 'greyscale')).toBe('sketch')
  expect(resolveFormat(() => false)).toBe('illust')
})

it('没有人工绝对分的图永远不入组', () => {
  // 它在 silva 的联合拟合里是个被丢弃的自由参数 —— 贡献严格为零，不是「弱」。
  withScenario(
    'ungraded',
    Array.from({ length: 60 }, (_, i) => i + 1).map(id => ({ id, silva: 0.50 + (id % 5) * 0.001, graded: id % 2 === 1 ? 3 : 0 })),
    (db) => {
      const drafted = draftCounts(db)
      expect(drafted.size, '有分的图仍然照常被抽').toBeGreaterThan(10)
      for (const pid of drafted.keys())
        expect(pid % 2, `post ${pid} 没有绝对分却被征召了`).toBe(1)
    },
  )
})

it('一组只排同一种形态', () => {
  withScenario(
    'pure',
    Array.from({ length: 130 }, (_, i) => i + 1).map(id => ({
      id,
      silva: 0.50 + (id % 5) * 0.001,
      tags: id <= 30 ? COMIC : [],
    })),
    (db) => {
      const groups = sampleBatches(db)
      expect(groups.length).toBeGreaterThan(20)
      for (const group of groups)
        expect(formatsOf(db, group), `混形态的组: ${group}`).toHaveLength(1)
      expect(groups.some(g => formatsOf(db, g).has('comic')), 'comic 组一次都没出现').toBe(true)
    },
  )
})

it('重访席位也守形态 —— 否则六张里有两张能漏进来', () => {
  // CLOSE_REVISIT_MEMBERS = 2 是一组的三分之一。revisitSeeds 不收 admit 的话，
  // 「同形态」就只是普通席位的性质，重访那条路径照样把 comic 塞进 illust 组。
  withScenario(
    'revisit-format',
    Array.from({ length: 130 }, (_, i) => i + 1).map(id => ({
      id,
      silva: 0.50 + (id % 5) * 0.001,
      tags: id <= 20 ? COMIC : [],
    })),
    (db) => {
      judgePair(1, 2, db) // 两张 comic，度数 1，重访池的头号人选
      const groups = sampleBatches(db)
      expect(groups.flat().includes(1), '前提：度数 1 的图确实会被重访征召').toBe(true)
      for (const group of groups)
        expect(formatsOf(db, group), `混形态的组: ${group}`).toHaveLength(1)
    },
  )
})

it('基带凑不齐人就放宽窗口到 LISTWISE_BAND_RELAXED', () => {
  // 8 张 comic：4 张在 0.500、4 张在 0.560。任何中心的 ±0.05 半带只罩得住其中 4 张，
  // 而 ±0.075 两拨都罩得住。
  withScenario(
    'relax-band',
    Array.from({ length: 8 }, (_, i) => ({ id: i + 1, silva: i < 4 ? 0.500 : 0.560, tags: COMIC })),
    (db) => {
      const groups = sampleBatches(db, { count: 1 })
      expect(groups.length).toBeGreaterThan(0)
      for (const group of groups) {
        expect(group, '放宽后应该凑满 6 张').toHaveLength(6)
        const scores = group.map(pid => silvaOf(db, pid))
        expect(Math.max(...scores) - Math.min(...scores)).toBeLessThanOrEqual(0.15 + 1e-9)
      }
    },
  )
})

it('形态池不够就缩组，缩到 LISTWISE_MIN_GROUP 以下就换种子', () => {
  const illust = Array.from({ length: 40 }, (_, i) => ({ id: i + 100, silva: 0.50 + (i % 5) * 0.001 }))
  withScenario(
    'shrink-5',
    [...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, silva: 0.50, tags: COMIC })), ...illust],
    (db) => {
      const comic = sampleBatches(db).filter(g => formatsOf(db, g).has('comic'))
      expect(comic.length, 'comic 组一次都没出现').toBeGreaterThan(0)
      for (const group of comic) expect(group).toHaveLength(5)
    },
  )
  withScenario(
    'shrink-3',
    [...Array.from({ length: 3 }, (_, i) => ({ id: i + 1, silva: 0.50, tags: COMIC })), ...illust],
    (db) => {
      expect(sampleBatches(db).some(g => formatsOf(db, g).has('comic')), '3 张也排了组').toBe(false)
    },
  )
})

it('形态永远不放宽：小池子宁可不产组，也不混进别的形态', () => {
  withScenario(
    'never-mix',
    [
      { id: 1, silva: 0.50, tags: COMIC },
      { id: 2, silva: 0.50, tags: COMIC },
      ...Array.from({ length: 100 }, (_, i) => ({ id: i + 100, silva: 0.50 + (i % 5) * 0.001 })),
    ],
    (db) => {
      const groups = sampleBatches(db)
      for (const group of groups)
        expect(formatsOf(db, group), `混形态的组: ${group}`).toHaveLength(1)
      expect(groups.some(g => g.includes(1) || g.includes(2)), '两张 comic 被塞进了 illust 组').toBe(false)
    },
  )
})

it('全库都没有绝对分时交回空批，而不是抛', () => {
  // generate-listwise 那条 400（"no eligible candidates"）依赖这个返回值。
  withScenario(
    'empty-pool',
    Array.from({ length: 20 }, (_, i) => ({ id: i + 1, silva: 0.50, graded: 0 })),
    (db) => {
      expect(new Sampler(db).sampleGroups({ count: 3, size: 6, dimension: 'overall', repeatShare: 0, seedMinStars: 1 })).toEqual([])
    },
  )
})

/** 直接写一条带 created_at 的 listwise 行 —— 冷却期是这条链上唯一的假设，得能拨钟。 */
function rankAt(members: number[], daysAgo: number, db = sqlite): void {
  insertListwise(db, {
    post_ids: members,
    ranking: members,
    dimension: 'overall',
    rubric_version: 'overall-v1',
    session_id: 's',
  })
  db.prepare(`UPDATE listwise_annotations SET created_at = datetime('now', ?) WHERE id = last_insert_rowid()`)
    .run(`-${daysAgo} days`)
}
const repeats = (count = 5) => new Sampler(sqlite).sampleRepeatGroups({ count })
const asSet = (g: number[]) => [...g].sort((a, b) => a - b).join(',')

it('重测通道：够老的组会被原样重排，成员不变、顺序重洗', () => {
  rankAt([1, 2, 3, 4], 30)
  const got = repeats()
  expect(got).toHaveLength(1)
  expect(asSet(got[0]!)).toBe('1,2,3,4')
})

it('重测通道：太新的组不重排 —— 量到的会是「还记不记得上次」', () => {
  rankAt([1, 2, 3, 4], 1)
  expect(repeats()).toEqual([])
})

it('重测通道：排过两次的组不再重排：它已经是一个重复测量了', () => {
  rankAt([1, 2, 3, 4], 30)
  rankAt([1, 2, 3, 4], 20)
  expect(repeats()).toEqual([])
})

it('重测通道：冷却期看的是每一次，不只是最近那次', () => {
  rankAt([1, 2, 3, 4], 30)
  rankAt([5, 6, 7, 8], 30)
  rankAt([5, 6, 7, 8], 1) // 昨天又排了一次 —— 既超次数也不够老
  expect(repeats().map(asSet)).toEqual(['1,2,3,4'])
})

it('重测通道：批内互不相交 —— 同屏再看同一张图，第二次判断会被第一次锚住', () => {
  rankAt([1, 2, 3, 4], 30)
  rankAt([3, 4, 5, 6], 30) // 与上一组共享 3、4
  const got = repeats()
  expect(got).toHaveLength(1)
})

it('重测通道：成员缺一张就不重排：两次的成对集合对不上，一致率无从算起', () => {
  rankAt([1, 2, 3, 4], 30)
  sqlite.prepare('DELETE FROM posts WHERE id = ?').run(4)
  expect(repeats()).toEqual([])
})

it('种子只从高分档抽 —— 差距全在 3-vs-4 和 4-vs-5，2-vs-3 早就到顶了', () => {
  // fixture 每张图都是 graded=3，所以按生产默认（>=4）一个窗口中心都找不到。
  expect(new Sampler(sqlite).sampleGroups({ count: 3, size: 4, dimension: 'overall', repeatShare: 0 })).toEqual([])

  const promoted = IDS.slice(100, 140)
  const marks = promoted.map(() => '?').join(',')
  sqlite.prepare(`UPDATE posts SET score = 4 WHERE id IN (${marks})`).run(...promoted)
  try {
    // 放开之后立刻抽得到：窗口按 silva 收成员，不受星级约束，所以组内仍会混入 3 星图 ——
    // 那正是要买的 3-vs-4 边界。
    const groups = new Sampler(sqlite).sampleGroups({ count: 3, size: 4, dimension: 'overall', repeatShare: 0 })
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) expect(g).toHaveLength(4)
  }
  finally {
    sqlite.prepare(`UPDATE posts SET score = 3 WHERE id IN (${marks})`).run(...promoted)
  }
})
