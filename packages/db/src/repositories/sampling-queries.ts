/**
 * 采样器的取数层 —— sampling.ts 里 Sampler 用到的每一条 SQL 都在这里，策略（窗口怎么开、
 * 谁算已花费、度数怎么记）都不在这里。
 *
 * 分开的理由是两边的变化节奏不同：这里的改动是**性能**（索引、物化、raw/pluck，每条都有
 * 实测数字），那边的改动是**采样语义**。混在一个 1600 行的类里，改一条查询得先读懂整个
 * 策略。函数都只拿 sqlite 和普通参数，返回普通数据。
 */
import { placeholders } from '../sql.js'
import type BetterSqlite3 from 'better-sqlite3'
import { AESTHETIC_SCORES_TABLE, SILVA } from '../scorers.js'
import { FORMAT_TAGS, formatOf } from '../formats.js'
import type { Format } from '../formats.js'
import { existingVectors } from './vectors.js'

/**
 * 重问之前至少要隔多久。
 *
 * 隔太近，量到的是「还记不记得上次点了哪边」，不是判断本身的稳定性。7 天是这条链上
 * 唯一需要的假设，取得保守：对一个 22 万张的库来说，认出某一个**特定组合**并回忆起
 * 当时的判决，一周后基本不可能。存量数据也支持 —— 到 2026-08-20，7 天前判过、只判过
 * 一次、非 skip 的对有 4966 个，池子远大于消耗速度。
 */
const REPEAT_MIN_AGE_DAYS = 7

/**
 * 一条「够格充当重复测量之第一次」的判决。sampleRepeats 用它挑重问对象，
 * isRepeatMeasurement 用它判定刚交上来的这条是不是第二次 —— 同一个定义，两个方向。
 */
const REPEAT_PRIOR = `dimension = ? AND winner != 'skip'`
  + ` AND created_at <= datetime('now', '-${REPEAT_MIN_AGE_DAYS} days')`

/**
 * 刚判完的这一对，之前是不是已经judged过一次（且隔得够久）。
 *
 * 「这条是不是重复测量」是**服务端可推导**的事实，所以不该由客户端报：正常采样绝不
 * 重问已判过的对，所以「该维度上这一无序对已有一条够老的非 skip 判决」⟺ 这次是第二次量。
 * 让客户端保管一个它无法核实的来源标记，等于把迁移 0017 要解决的问题（provenance 一旦
 * 丢了就永远补不回来）原样搬高一层 —— 一个过期的前端构建就能让整批静默记错。
 *
 * 顺带把 random / similar 偶然重问到老对的情况也收进来：那同样是一次可用的重复测量，
 * 冷却期条件已经保证了它可用。
 */
export function isRepeatMeasurement(
  sqlite: BetterSqlite3.Database,
  { a, b, dimension }: { a: number, b: number, dimension: string },
): boolean {
  return sqlite
    .prepare<[string, number, number, number, number], { 1: number }>(
      `SELECT 1 FROM pairwise_annotations WHERE ${REPEAT_PRIOR}`
      + ` AND ((post_a = ? AND post_b = ?) OR (post_a = ? AND post_b = ?)) LIMIT 1`,
    )
    .get(dimension, a, b, b, a) !== undefined
}

/**
 * 候选必须有 embedding（训练时要 join 它）、不能是被隐藏的近重复、不能在任何一个被请求的
 * 维度上已经标注过，也不能待在一个未完成的队列项里。
 *
 * 性能：embedding 检查是 vec0 虚表查询，**不是**便宜的 B-tree 探测 —— 放进 WHERE 会让
 * SQLite 每行 posts 都跑一次（约 10 万次查询，几十秒）。所以采样分两段：先只用普通表谓词
 * 抽一批超量的随机候选，再对这一小批做 vec0 过滤。
 */
const CANDIDATE_WHERE
  = 'p.canonical_post_id IS NULL '
    + 'AND NOT EXISTS (SELECT 1 FROM absolute_queue_items i WHERE i.post_id = p.id AND i.done = 0) '
    + 'AND NOT EXISTS (SELECT 1 FROM absolute_annotations a WHERE a.post_id = p.id AND a.dimension IN ({dims}))'

/** 成对资格：canonical（没有被隐藏的近重复）且不在未完成的成对队列项里。两个策略共享。 */
const PAIRWISE_ELIGIBLE
  = 'p.canonical_post_id IS NULL AND NOT EXISTS (SELECT 1 FROM pairwise_queue_items i WHERE (i.post_a = p.id OR i.post_b = p.id) AND i.done = 0)'

/**
 * 与 PAIRWISE_ELIGIBLE 同义，但从**分数行**那侧问，不需要 posts 在场。
 *
 * 两个排除集都小且能走覆盖索引，所以 SQLite 会各物化一次再拿 bloom filter 过滤，
 * 而不是每行回查一次 posts 主键。理由与实测见 SILVA_ELIGIBLE。
 */
const SCORE_ROW_ELIGIBLE
  = 's.post_id NOT IN (SELECT id FROM posts WHERE canonical_post_id IS NOT NULL)'
    + ' AND s.post_id NOT IN (SELECT post_a FROM pairwise_queue_items WHERE done = 0'
    + ' UNION SELECT post_b FROM pairwise_queue_items WHERE done = 0)'

/**
 * 仍值得比较的图片的 `(id, silva 分)`。close 的四条采样查询都是这条语句加个尾巴 —— 一个
 * 分数区间、一个 id 列表 —— 和它们自己的 LIMIT，所以资格子句在这里写一次，而不是把 scorer
 * 名字硬编码四遍。两半都不绑定参数，这正是每个调用方都能直接追加自己的参数而不用记偏移量
 * 的原因。
 *
 * **不 join posts**。它曾经是 `FROM posts p JOIN post_aesthetic_scores s ON s.post_id = p.id`，
 * 而资格判定只需要 posts 的两件事：不是重复图、不在未完成的队列里。代价是每一条 silva 分行
 * 都要回查一次 posts 主键 —— 实测（2026-08-21，22.9 万张库）：单扫分数索引 5ms，加上这个
 * 回查变成 255ms，因为 posts 表有 171MB，22.9 万次随机读把它整个翻了一遍。
 *
 * 改成拿两个**小**排除集做反查：重复图 34,972 个（走覆盖索引 ix_posts_canonical，实测物化
 * 成本 0ms），未完成队列项 8 个。windowSeeds 315ms → 73ms，windowCandidates 220ms → 80ms，
 * 结果集逐行相同（194,153 行，双向差集为 0）。
 *
 * 丢掉 join 不会放进孤儿分数行：post_aesthetic_scores 对 posts 是 ON DELETE CASCADE，而
 * connection.ts 每条连接都开 `PRAGMA foreign_keys = ON`，所以 post 一删分数行就跟着没了
 * （实测孤儿数为 0）。
 *
 * 顺带记一笔试过但**不划算**的：给 post_aesthetic_scores 加 (scorer, score, post_id) 覆盖
 * 索引，windowCandidates 只从 40ms 到 34ms，windowSeeds 毫无变化 —— 不值一次迁移。
 */
const SILVA_ELIGIBLE
  = `SELECT s.post_id AS id, s.score FROM ${AESTHETIC_SCORES_TABLE} s `
    + `WHERE s.scorer = '${SILVA.name}' AND ${SCORE_ROW_ELIGIBLE}`

/**
 * 能给 silva 的联合拟合当**锚**的图：有 silva 分、有人工绝对分、非近重复、不在未完成
 * 的队列里。
 *
 * 和 SILVA_ELIGIBLE 的差别只有一条 `p.score >= 1`，但它值得单独存在，因为多出来的这
 * 条改变了成本模型：silva 侧 `fit_latent.py` 给没有绝对分的成员分配的是一个自由参数
 * （`extra[key] = n_items`），最后 `rank_to_grades` 只写回训练行 —— 而 `export_pairs.py`
 * 又不展开 listwise。所以一个没有绝对分的组员对下游的贡献严格为零，不是"信息量低"。
 * 2026-09-04 实测：导出的 138 组 797 个成员里只有 424 个有分，名义上 1961 个成对约束，
 * 两端都有锚的只有 567 个（29%）。
 *
 * 这里**故意 join posts** —— 正是 SILVA_ELIGIBLE 的注释里实测否决过的那件事，但成本
 * 模型不同：那条子句每个窗口跑一次（+148 ms/窗口），这条每**批**跑一次（95,856 行，
 * 实测 245 ms），之后所有窗口都在内存里切片。而且 `p.score` 只能从 posts 拿。
 *
 * 整批的固定开销因此是 formatSets(~150 ms) + 这条(245 ms)，一次 limit=3 的补充实测
 * 约 1.0 s（改动前约 0.45 s）。这笔钱花得起：一批 3 个组是标注者约 90 秒的工作量。
 * 245 ms 里有 235 ms 是 `p.score >= 1` 那侧的全表扫（posts 上没有 score 索引），所以
 * 如果哪天嫌慢，下一步是一条部分覆盖索引
 * `CREATE INDEX ... ON posts(id) WHERE score >= 1 AND canonical_post_id IS NULL`
 * ——而不是把这条查询拆回每个窗口一次。
 */
const ANCHORED_ELIGIBLE
  = `SELECT s.post_id AS id, s.score AS silva, p.score AS stars FROM ${AESTHETIC_SCORES_TABLE} s`
    + ` JOIN posts p ON p.id = s.post_id`
    + ` WHERE s.scorer = '${SILVA.name}' AND p.score >= 1 AND p.canonical_post_id IS NULL`
    + ` AND s.post_id NOT IN (SELECT post_a FROM pairwise_queue_items WHERE done = 0`
    + ` UNION SELECT post_b FROM pairwise_queue_items WHERE done = 0)`

export interface IdScoreRow { id: number, score: number }

/** anchoredPool 的一行：窗口要 silva 分，形态收口要 format，选种子要人工星级。 */
export interface AnchoredMember { readonly silva: number, readonly format: Format, readonly stars: number }

/**
 * 只保留有 SigLIP2 embedding 的 id，保持抽取顺序。
 *
 * 一次集合查询而不是每个 id 探一次：一次约 1.5 ms，逐个探的写法在
 * `generate-pairwise count=200` 里光是配对开始前就花掉 1.2 s。
 */
export function withEmbedding(sqlite: BetterSqlite3.Database, ids: number[]): number[] {
  const embedded = existingVectors(sqlite, ids)
  return ids.filter(pid => embedded.has(pid))
}

/**
 * 第一段：在普通谓词上随机抽候选；第二段：vec0 过滤。
 *
 * 超量 2 倍 —— 库里 embedding 覆盖率接近全量，一次放大的抽取就够了（不做补抽循环，YAGNI）。
 */
export function drawCandidates(
  sqlite: BetterSqlite3.Database,
  { extraWhere, extraParams, dimensions, n }:
  { extraWhere: string, extraParams: unknown[], dimensions: string[], n: number },
): number[] {
  const where = CANDIDATE_WHERE.replace('{dims}', placeholders(dimensions.length))
  const rows = sqlite
    .prepare<unknown[], { id: number }>(
      `SELECT p.id FROM posts p WHERE ${where} ${extraWhere} ORDER BY RANDOM() LIMIT ?`,
    )
    .all(...dimensions, ...extraParams, n * 2)
  return withEmbedding(sqlite, rows.map(r => r.id)).slice(0, n)
}

/** 成对资格内的随机 `n` 个 id（还没过 embedding 过滤）。random 配对和 similar 的种子都从这里抽。 */
export function randomPairwiseEligible(sqlite: BetterSqlite3.Database, n: number): number[] {
  return sqlite
    .prepare<[number], { id: number }>(
      `SELECT p.id FROM posts p WHERE ${PAIRWISE_ELIGIBLE} ORDER BY RANDOM() LIMIT ?`,
    )
    .all(n)
    .map(r => r.id)
}

/** 重复测量池：够老、只判过一次、非 skip 的无序对，随机 `count` 个，归一化成 `[lo, hi]`。 */
export function repeatPairPool(sqlite: BetterSqlite3.Database, dimension: string, count: number): Array<[number, number]> {
  return sqlite
    .prepare<[string, number], { lo: number, hi: number }>(
      `SELECT MIN(post_a, post_b) AS lo, MAX(post_a, post_b) AS hi`
      + ` FROM pairwise_annotations WHERE ${REPEAT_PRIOR}`
      + ` GROUP BY lo, hi HAVING COUNT(*) = 1`
      + ` ORDER BY RANDOM() LIMIT ?`,
    )
    .all(dimension, count)
    .map(r => [r.lo, r.hi] as [number, number])
}

/** 这个维度上非 skip 的 listwise 事件（`post_ids` 是 JSON 串，呈现顺序）。 */
export function rankedListwiseRows(
  sqlite: BetterSqlite3.Database,
  dimension: string,
): Array<{ post_ids: string, created_at: string }> {
  return sqlite
    .prepare<[string], { post_ids: string, created_at: string }>(
      `SELECT post_ids, created_at FROM listwise_annotations WHERE dimension = ? AND ranking != '[]'`,
    )
    .all(dimension)
}

/** 重测冷却期的分界时刻，和 `created_at` 同一种文本格式，可直接字符串比较。 */
export function repeatCutoff(sqlite: BetterSqlite3.Database): string {
  return sqlite
    .prepare<[], { cutoff: string }>(`SELECT datetime('now', '-${REPEAT_MIN_AGE_DAYS} days') AS cutoff`)
    .get()!
    .cutoff
}

/** `ids` 里仍然存在的 post。 */
export function existingPostIds(sqlite: BetterSqlite3.Database, ids: number[]): Set<number> {
  return new Set(
    sqlite
      .prepare<number[], { id: number }>(`SELECT id FROM posts WHERE id IN (${placeholders(ids.length)})`)
      .all(...ids)
      .map(r => r.id),
  )
}

/**
 * 每个非 illust 形态的 `post_id` 集合，按 FORMAT_TAGS 的优先级序。
 *
 * 三条 `SELECT DISTINCT post_id ... WHERE tag_name IN (...)`，走
 * `ix_post_has_tag_tag_name`，2026-09-04 在 1209 万行的 post_has_tag 上实测
 * 92 / 43 / 64 ms，一批只付一次。
 *
 * 试过但**不划算**的两条：把形态 CASE 写进窗口查询的 WHERE（逐行 EXISTS，一次窗口
 * 查询 123 ms -> 453 ms），以及物化成 `posts.format` 列（省下这 200 ms，代价是把一条
 * 还在调的分类规则烧进迁移和触发器）。
 */
function formatSets(sqlite: BetterSqlite3.Database): Map<Exclude<Format, 'illust'>, Set<number>> {
  const out = new Map<Exclude<Format, 'illust'>, Set<number>>()
  for (const [format, tags] of FORMAT_TAGS) {
    // pluck：一列的结果不值得为每行造一个对象。三条查询合计从 163 ms 降到 ~90 ms。
    const ids = new Set<number>(
      sqlite
        .prepare<string[], number>(
          `SELECT DISTINCT post_id FROM post_has_tag WHERE tag_name IN (${placeholders(tags.length)})`,
        )
        .pluck()
        .all(...tags),
    )
    out.set(format, ids)
  }
  return out
}

/**
 * 这一批能用的全部有锚图：`post_id -> (silva 分, 形态)`。
 *
 * 整池一次读进内存（2026-09-04 实测 95,856 行、220–250 ms），之后每个窗口就是在内存里
 * 扫一遍浮点数 —— 和 revisitPool 同一个取舍，理由也同一条：窗口是一个分数区间加一个
 * 形态，没有哪个索引能比这更快地回答"落在这个区间、并且是这个形态、并且有绝对分"。
 */
export function anchoredPool(sqlite: BetterSqlite3.Database): Map<number, AnchoredMember> {
  const sets = formatSets(sqlite)
  const out = new Map<number, AnchoredMember>()
  // raw：9.6 万行各造一个 { id, silva } 对象要 419 ms，拿数组行是 ~250 ms。这条查询
  // 每批只跑一次，但它是这批里最大的一笔固定开销，而 UI 一次只要 3 个组。
  for (const [id, silva, stars] of sqlite.prepare(ANCHORED_ELIGIBLE).raw().all() as Array<[number, number, number]>)
    out.set(id, { silva, format: formatOf(id, sets), stars })
  return out
}

/** `ids` 里过得了成对资格的那些的 `(id, 旧人工分)`。similar 的邻域收口用。 */
export function pairwiseEligibleScores(sqlite: BetterSqlite3.Database, ids: number[]): IdScoreRow[] {
  return sqlite
    .prepare<unknown[], IdScoreRow>(
      `SELECT p.id, p.score FROM posts p WHERE p.id IN (${placeholders(ids.length)}) AND ${PAIRWISE_ELIGIBLE}`,
    )
    .all(...ids)
}

/**
 * 仍值得比较的随机图片的 `(post_id, silva 分)`。它们的分数就是这一批窗口所围绕的中心。
 *
 * 抽自图片本身而不是在 [0, 1] 上均匀抽，于是窗口落在库**实际所在**的地方，而不是分数轴
 * 所在的地方。
 *
 * 每**批**抽一次，不是每个窗口抽一次。`ORDER BY RANDOM()` 无法提前停止：无论返回 1 行还是
 * 32 行，它都要扫遍所有 silva 行并在临时 B 树里排完，在 21.4 万的库上实测约 280 ms。按窗口
 * 算这曾是采样器里最贵的一件事，而且什么也没买到 —— 一次抽取用同样的价钱服务整批的每一个
 * 窗口。
 *
 * 没有任何东西让两个中心保持距离，也不需要：重叠的窗口不会重复花掉同一张图，因为
 * windowCandidates 会过滤这一批的已花费集合。调用方跳过已花费的种子，只是为了让中心来自
 * 一张这批还能用的图，不是为了把区间分开。
 */
export function windowSeeds(sqlite: BetterSqlite3.Database, n: number): IdScoreRow[] {
  return sqlite
    .prepare<[number], IdScoreRow>(`${SILVA_ELIGIBLE} ORDER BY RANDOM() LIMIT ?`)
    .all(n)
}

/** silva 分落在 `[lo, hi]` 的合格图片，随机 `limit` 张的 id。 */
export function silvaInRange(sqlite: BetterSqlite3.Database, lo: number, hi: number, limit: number): number[] {
  return sqlite
    .prepare<[number, number, number], IdScoreRow>(
      `${SILVA_ELIGIBLE} AND s.score BETWEEN ? AND ? ORDER BY RANDOM() LIMIT ?`,
    )
    .all(lo, hi, limit)
    .map(r => r.id)
}

/**
 * 这个维度上露过面的图（pairwise 两端 + listwise 全部成员）里仍合格的 `(id, silva 分)`。
 * 过滤"还想要边"是调用方的事（revisitPool）。
 */
export function judgedSilvaRows(sqlite: BetterSqlite3.Database, dimension: string): IdScoreRow[] {
  return sqlite
    .prepare<[string, string, string], IdScoreRow>(
      `${SILVA_ELIGIBLE} AND s.post_id IN (`
      + ` SELECT post_a FROM pairwise_annotations WHERE dimension = ?`
      + ` UNION SELECT post_b FROM pairwise_annotations WHERE dimension = ?`
      // 排过序的图同样是"已判"。取 post_ids 而不是 ranking：被 skip 的组 ranking 是空的，
      // 但那几张确实露过面，和只判过一次 skip 的 pairwise 图一样有资格回到池子里拿边。
      + ` UNION SELECT CAST(j.value AS INTEGER) FROM listwise_annotations la, json_each(la.post_ids) j`
      + ` WHERE la.dimension = ?)`,
    )
    .all(dimension, dimension, dimension)
}

/** `ids` 里有合格 silva 分的，随机 `n` 张。锚点从这里抽。 */
export function silvaEligibleAmong(sqlite: BetterSqlite3.Database, ids: number[], n: number): IdScoreRow[] {
  return sqlite
    .prepare<unknown[], IdScoreRow>(
      `${SILVA_ELIGIBLE} AND s.post_id IN (${placeholders(ids.length)}) ORDER BY RANDOM() LIMIT ?`,
    )
    .all(...ids, n)
}

/** SILVA 分落在 `window` 里的一张合格图片，没有则 `null`。 */
export function partnerInWindow(sqlite: BetterSqlite3.Database, window: [number, number]): number | null {
  const row = sqlite
    .prepare<[number, number], IdScoreRow>(
      `${SILVA_ELIGIBLE} AND s.score BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 1`,
    )
    .get(...window)
  return row ? Number(row.id) : null
}

export interface ComparisonEdge {
  a: number
  b: number
  /** `'a' | 'b' | 'tie' | 'skip'`。listwise 展开出的边只会是 `'a'`（ranking 下标小的赢）。 */
  winner: string
  source: 'pairwise' | 'listwise'
}

/**
 * 这个维度上**全部**的成对比较证据 —— 两张事件表合成一条流。
 *
 * 一组 n 张的 listwise 全序就是 C(n,2) 条边（迁移 0016 写的「排序结果在训练侧分解为对」，
 * 采样侧同理）。展开只发生在读侧：两张按形态分开的 append-only 事件表，写侧不该冗余。
 *
 * 之所以是一个导出函数而不是留在 judgedGraph 方法体里：「已经收集到多少比较」现在有
 * 不止一个消费者。judgedGraph 是第一个，annotations.ts 的 countPairwise 是第二个（它至今
 * 只数 pairwise 行，所以排一组 6 张会给采样图 +15 条边而顶栏纹丝不动），而 0014 注释里
 * 提到的训练导出 scripts/export_annotations.py 已经不在仓里、迟早要重新出现，那会是第三个。
 * 每个消费者各抄一遍这段双重循环，是这段逻辑唯一会出错的方式。
 *
 * 不展开的代价是实测过的：到 2026-08-20，44 个已排的组里 post 8884 出现了 11 次、8848
 * 出现 10 次，两者同组 9 次；它们在比较图里的度数却始终是 1，因为排序没有产生任何
 * pairwise 行，于是 revisitSeeds 每次都把这两张当「比较不足」重新征召，谁都排不空。
 */
export function* comparisonEdges(
  sqlite: BetterSqlite3.Database,
  dimension: string,
): Generator<ComparisonEdge> {
  for (const row of sqlite
    .prepare<[string], { post_a: number, post_b: number, winner: string }>(
      'SELECT post_a, post_b, winner FROM pairwise_annotations WHERE dimension = ?',
    )
    .all(dimension))
    yield { a: row.post_a, b: row.post_b, winner: row.winner, source: 'pairwise' }

  for (const row of sqlite
    .prepare<[string], { post_ids: string, ranking: string }>(
      'SELECT post_ids, ranking FROM listwise_annotations WHERE dimension = ?',
    )
    .all(dimension)) {
    // 空 ranking = skip，与 pairwise 的 skip 同义：整组算问过（成员两两不再重问），但没
    // 产生任何排序信息。members 因此取 post_ids 而不是 ranking，winner 统一表达成 'skip'。
    const ranking = JSON.parse(row.ranking) as number[]
    const members = ranking.length ? ranking : (JSON.parse(row.post_ids) as number[])
    const winner = ranking.length ? 'a' : 'skip'
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        yield { a: members[i]!, b: members[j]!, winner, source: 'listwise' }
  }
}
