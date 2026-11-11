/**
 * 快速打分页的选图：一副牌里按固定比例混三种图，全部盲打。
 *
 * 比例不是给用户调的旋钮，是训练侧的判断（SILVA，2026-11）：
 *
 * - `new`     80%：还没打过分的图。按模型档位**均摊**而不是按库内分布抽 —— 库里 2 分和 5 分
 *             各只占一成，而模型的错误正是把这两端往中间压，随机抽新图大半落在 3/4 分，
 *             对两端几乎不补数据。
 * - `random`  10%：已打过分的图里均匀抽。它的用处是**监控**：自洽度只能用这一类算。
 * - `suspect` 10%：人工分与模型分差得远的图，差得越远越容易抽中。手滑集中在这里；但只复核
 *             "模型不同意"的那一侧，标签会被一步步拉向模型，所以份额不能大。
 *
 * 重打一共只给两成是量出来的（2026-11-11，首版是 40/30/30）：222 张随机盲重打，与旧分
 * 同档只有 48%（Spearman 0.456），一轮之内标准还漂了半档。在这把尺子变稳之前，大量重打
 * 是在用更吵的读数覆盖旧分；留两成足够把自洽度盯住，等参照图（`gradingAnchors`）把它
 * 拉上来再调回去。
 *
 * 一周内动过分的图不再出现：重打要隔开会话才算独立判断。
 */
import type BetterSqlite3 from 'better-sqlite3'
import { AESTHETIC_SCORES_TABLE, SILVA } from '../scorers.js'

/** 抽中的原因。写分时以 `grade:<reason>` 作为 `post_score_events.source` 回传。 */
export const GRADING_REASONS = ['new', 'random', 'suspect'] as const
export type GradingReason = typeof GRADING_REASONS[number]
/** `PUT /v2/posts/{id}/score` 接受的 `source` 值，从 `GRADING_REASONS` 派生。 */
export type GradingSource = `grade:${GradingReason}`
export const GRADING_SOURCES = GRADING_REASONS.map(r => `grade:${r}`) as [GradingSource, ...GradingSource[]]

export const GRADING_MIX: Record<GradingReason, number> = { new: 0.8, random: 0.1, suspect: 0.1 }
export const RETEST_COOLDOWN_DAYS = 7
/** 人工分与模型连续分差到这个数以内不算分歧：正好是"四舍五入后同档"的半径。 */
const AGREE_RADIUS = 0.5

export interface GradingPick {
  postId: number
  reason: GradingReason
  /** 抽中时的人工分，0 = 没打过。 */
  previous: number
  /** 模型分换算成的档位（1~5），没有模型分时为 null。 */
  model: number | null
}

/**
 * SILVA 的 [0,1] 分 → 1~5 的连续档位。校准后的分数按训练标签分布铺开，所以是线性的。
 * 映射本身在 `SILVA.scale` / `SILVA.offset`，SQL 里同一个式子是 `SILVA.scoreExpr()`。
 */
export function modelGrade(silva: number): number {
  return silva * SILVA.scale + SILVA.offset
}

function roundGrade(silva: number | null): number | null {
  return silva == null ? null : Math.min(5, Math.max(1, Math.round(modelGrade(silva))))
}

interface Candidate { id: number, score: number, silva: number | null }

/** 人工分离模型分多远才算"存疑"，以及存疑的程度：同档半径以内为 0，以外按超出量的平方。 */
function disagreement(c: Candidate): number {
  if (c.silva == null)
    return 0
  const excess = Math.abs(c.score - modelGrade(c.silva)) - AGREE_RADIUS
  return excess > 0 ? excess * excess : 0
}

/** 从 `pool` 里不放回地随机取 `n` 个（会改动 pool：取走的从中移除）。 */
function takeRandom<T>(pool: T[], n: number, rng: () => number): T[] {
  const k = Math.max(0, Math.min(n, pool.length))
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
  }
  return pool.splice(0, k)
}

/** 按权重不放回抽样（Efraimidis–Spirakis：取 `u^(1/w)` 最大的 n 个）。权重 <= 0 的不参与。 */
function takeWeighted(pool: Candidate[], weight: (c: Candidate) => number, n: number, rng: () => number): Candidate[] {
  const keyed: Array<{ c: Candidate, key: number }> = []
  for (const c of pool) {
    const w = weight(c)
    if (w > 0)
      keyed.push({ c, key: rng() ** (1 / w) })
  }
  keyed.sort((a, b) => b.key - a.key)
  return keyed.slice(0, n).map(k => k.c)
}

/** 新图按模型档位均摊：轮流从每一档里随机拿一张，哪档空了就跳过。没有模型分的图自成一档。 */
function takeStratified(pool: Candidate[], n: number, rng: () => number): Candidate[] {
  const bins = new Map<number, Candidate[]>()
  for (const c of pool) {
    const key = roundGrade(c.silva) ?? 0
    const bin = bins.get(key)
    if (bin)
      bin.push(c)
    else bins.set(key, [c])
  }
  const out: Candidate[] = []
  const live = [...bins.values()]
  while (out.length < n && live.length) {
    for (let i = live.length - 1; i >= 0 && out.length < n; i--) {
      const bin = live[i]!
      out.push(...takeRandom(bin, 1, rng))
      if (!bin.length)
        live.splice(i, 1)
    }
  }
  return out
}

/**
 * 抽一副 `count` 张的牌。只抽组代表（分数属于近重复组），返回顺序已打乱 ——
 * 位置不能泄露"这张是不是存疑的"。某一类不够时由其它类补足。
 */
export function sampleGradingDeck(
  sqlite: BetterSqlite3.Database,
  count: number,
  rng: () => number = Math.random,
): GradingPick[] {
  const recent = new Set(
    sqlite
      .prepare<[], { head: number }>(
        'SELECT DISTINCT COALESCE(p.canonical_post_id, p.id) AS head FROM post_score_events e '
        + `JOIN posts p ON p.id = e.post_id WHERE e.created_at > datetime('now', '-${RETEST_COOLDOWN_DAYS} days')`,
      )
      .all()
      .map(r => r.head),
  )
  const all = sqlite
    .prepare<[], Candidate>(
      `SELECT p.id, p.score, s.score AS silva FROM posts p ${SILVA.joinSql({ alias: 's' })} `
      + 'WHERE p.canonical_post_id IS NULL '
      // 参照图常驻在屏幕上，再抽出来重打就不是盲打了
      + 'AND NOT EXISTS (SELECT 1 FROM grading_anchors a WHERE a.post_id = p.id)',
    )
    .all()
    .filter(c => !recent.has(c.id))
  const graded = all.filter(c => c.score > 0)
  const fresh = all.filter(c => c.score === 0)

  const wantSuspect = Math.round(count * GRADING_MIX.suspect)
  const wantRandom = Math.round(count * GRADING_MIX.random)
  const picks: GradingPick[] = []
  const add = (cs: Candidate[], reason: GradingReason) => {
    for (const c of cs)
      picks.push({ postId: c.id, reason, previous: c.score, model: roundGrade(c.silva) })
  }

  const suspects = takeWeighted(graded, disagreement, wantSuspect, rng)
  add(suspects, 'suspect')
  const taken = new Set(suspects.map(c => c.id))
  const rest = graded.filter(c => !taken.has(c.id))
  // 存疑的不够（比如还没有模型分）时，缺口先由随机重打补
  add(takeRandom(rest, wantRandom + wantSuspect - suspects.length, rng), 'random')
  // 没有模型分的新图只在别无选择时才上：它们凑不成一档，单独成档会让寥寥几张回回被抽中
  const scored = fresh.filter(c => c.silva != null)
  add(takeStratified(scored.length ? scored : fresh, count - picks.length, rng), 'new')
  // 新图也不够（库里全打完了）时，剩下的继续随机重打
  add(takeRandom(rest, count - picks.length, rng), 'random')

  return takeRandom(picks, picks.length, rng)
}

export interface AgreementStats {
  /** 参与统计的打分次数。 */
  n: number
  /** 两次给出同一档的比例；n = 0 时为 null。 */
  exact: number | null
  /** 差了两档及以上的比例；n = 0 时为 null。 */
  far: number | null
}

export interface GradingStats {
  /** 近 24 小时在快速打分页打了多少张。 */
  gradedToday: number
  /** 你 vs 过去的你：随机重打里，新分与旧分的一致度。 */
  self: AgreementStats
  /** 模型 vs 你：新图上，模型档位与你打的分的一致度。 */
  model: AgreementStats
}

function agreement(rows: Array<{ a: number, b: number }>): AgreementStats {
  if (!rows.length)
    return { n: 0, exact: null, far: null }
  return {
    n: rows.length,
    exact: rows.filter(r => r.a === r.b).length / rows.length,
    far: rows.filter(r => Math.abs(r.a - r.b) >= 2).length / rows.length,
  }
}

/** 快速打分页的一致度，取近 `days` 天的事件。 */
export function gradingStats(sqlite: BetterSqlite3.Database, days = 30): GradingStats {
  const since = `datetime('now', '-${Math.trunc(days)} days')`
  const self = sqlite
    .prepare<[], { a: number, b: number }>(
      'SELECT score AS a, previous AS b FROM post_score_events '
      + `WHERE source = 'grade:random' AND previous > 0 AND score > 0 AND created_at > ${since}`,
    )
    .all()
  const model = sqlite
    .prepare<[], { a: number, silva: number }>(
      'SELECT e.score AS a, s.score AS silva FROM post_score_events e '
      + `JOIN ${AESTHETIC_SCORES_TABLE} s ON s.post_id = e.post_id AND s.scorer = '${SILVA.name}' `
      + `WHERE e.source = 'grade:new' AND e.score > 0 AND e.created_at > ${since}`,
    )
    .all()
    .map(r => ({ a: r.a, b: roundGrade(r.silva)! }))
  const gradedToday = sqlite
    .prepare('SELECT count(*) FROM post_score_events WHERE source LIKE \'grade:%\' AND created_at > datetime(\'now\', \'-1 day\')')
    .pluck()
    .get() as number
  return { gradedToday, self: agreement(self), model: agreement(model) }
}

export const ANCHOR_GRADES = [5, 4, 3, 2, 1] as const
export const ANCHORS_PER_GRADE = 3
/** 参照图常驻屏幕，只从这些 rating 里选（1 = general，2 = sensitive）。 */
const ANCHOR_RATINGS = '(1, 2)'

export interface GradingAnchor { grade: number, postId: number }

/**
 * 每档的参照图，没有就选、失效就补，其余原地不动（为什么要固定：见 0026_grading_anchors.sql）。
 *
 * 选的是"你和模型都认为它是这一档"的图：人工分等于该档，且模型的连续档位离它最近。
 * 两个评判一致的图最不可能是手滑，也最接近这一档的中心而不是边界。每个目录只出一张 ——
 * 目录基本就是画师，三张同一个画师的图教的是"这个画师"，不是"这一档"。
 */
export function gradingAnchors(sqlite: BetterSqlite3.Database): GradingAnchor[] {
  const stale = sqlite.prepare(
    'DELETE FROM grading_anchors WHERE NOT EXISTS ('
    + 'SELECT 1 FROM posts p WHERE p.id = grading_anchors.post_id '
    + 'AND p.score = grading_anchors.grade AND p.canonical_post_id IS NULL)',
  )
  // 失效的行刚删过，留下的锚点都满足 score = grade，也就都在候选里 —— 按目录去重时
  // 它们自己的目录已在 `folders` 中，不会被选第二次。
  const held = sqlite.prepare<[number], { position: number, post_id: number, file_path: string }>(
    'SELECT a.position, a.post_id, p.file_path FROM grading_anchors a JOIN posts p ON p.id = a.post_id '
    + 'WHERE a.grade = ? ORDER BY a.position',
  )
  const candidates = sqlite.prepare<[number, number], { id: number, file_path: string }>(
    `SELECT p.id, p.file_path FROM posts p `
    + `JOIN ${AESTHETIC_SCORES_TABLE} s ON s.post_id = p.id AND s.scorer = '${SILVA.name}' `
    + `WHERE p.score = ? AND p.canonical_post_id IS NULL AND p.rating IN ${ANCHOR_RATINGS} `
    + `ORDER BY abs(? - (${SILVA.scoreExpr('s')})), p.id LIMIT 500`,
  )
  const insert = sqlite.prepare('INSERT INTO grading_anchors (grade, position, post_id) VALUES (?, ?, ?)')

  const out: GradingAnchor[] = []
  sqlite.transaction(() => {
    stale.run()
    for (const grade of ANCHOR_GRADES) {
      const rows = held.all(grade)
      if (rows.length < ANCHORS_PER_GRADE) {
        const taken = new Set(rows.map(r => r.position))
        const free = Array.from({ length: ANCHORS_PER_GRADE }, (_, i) => i).filter(i => !taken.has(i))
        const folders = new Set(rows.map(r => r.file_path))
        for (const c of candidates.all(grade, grade)) {
          if (!free.length)
            break
          if (folders.has(c.file_path))
            continue
          const position = free.shift()!
          insert.run(grade, position, c.id)
          folders.add(c.file_path)
          rows.push({ position, post_id: c.id, file_path: c.file_path })
        }
        rows.sort((a, b) => a.position - b.position)
      }
      for (const r of rows)
        out.push({ grade, postId: r.post_id })
    }
  })()
  return out
}
