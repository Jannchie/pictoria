/**
 * pictoria.sqlite 的 drizzle schema —— **手写，不是 `drizzle-kit pull` 生成的**。
 *
 * pull 在这个库上三重失败（详见 docs/refactor-monorepo-hono.md §4.8）：vec0 虚表
 * 让它静默返回 0 张表，view 让它直接中止，而生成列的表达式会在第一个右括号处被
 * 截断成语法错误的 SQL 却不报错。所以这里逐列对着 sqlite_master 的 DDL 抄。
 *
 * 改这个文件时记住：server/migrations/ 里的 SQL 才是真理 —— 现有 15 个迁移已经
 * 在生产库跑完，这里只是把那个结果表达成 TypeScript。
 */
import { sql } from 'drizzle-orm'
import {
  blob,
  customType,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

/**
 * sqlite-vec 的 float32 blob。
 *
 * 字节表示和 Python 侧 `sqlite_vec.serialize_float32` 完全一致（小端 float32，
 * 已逐字节对拍）。不引第三方包：社区那个 `@aeriondyseti/drizzle-sqlite-vec` 只有
 * 0.1.0 一个版本、无仓库链接、周下载个位数，而它做的就是下面这几行。
 */
export const float32Blob = customType<{ data: Float32Array, driverData: Buffer }>({
  dataType: () => 'blob',
  fromDriver: v => new Float32Array(v.buffer, v.byteOffset, v.length / 4),
  toDriver: v => Buffer.from(new Float32Array(v).buffer),
})

// ---------------------------------------------------------------- posts

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filePath: text('file_path').notNull().default(''),
  fileName: text('file_name').notNull().default(''),
  extension: text('extension').notNull().default(''),
  fullPath: text('full_path').generatedAlwaysAs(
    sql`(file_path || '/' || file_name || '.' || extension)`,
    { mode: 'virtual' },
  ),
  width: integer('width').notNull().default(0),
  height: integer('height').notNull().default(0),
  aspectRatio: real('aspect_ratio').generatedAlwaysAs(
    sql`(CASE WHEN height = 0 THEN NULL ELSE (width * 1.0) / height END)`,
    { mode: 'virtual' },
  ),
  publishedAt: text('published_at'),
  score: integer('score').notNull().default(0),
  rating: integer('rating').notNull().default(0),
  description: text('description').notNull().default(''),
  meta: text('meta').notNull().default(''),
  sha256: text('sha256').notNull().default(''),
  size: integer('size').notNull().default(0),
  source: text('source').notNull().default(''),
  caption: text('caption').notNull().default(''),
  /** 序列化的 FLOAT[3]（Lab）。没有索引 —— 3 维暴力扫 22 万行是亚毫秒级。 */
  dominantColor: blob('dominant_color'),
  arthash: text('arthash'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  lastAccessedAt: text('last_accessed_at'),
  /** 自引用：近重复分组里指向 canonical 代表（ON DELETE SET NULL）。 */
  canonicalPostId: integer('canonical_post_id'),
})

// ---------------------------------------------------------------- tags

export const tagGroups = sqliteTable('tag_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  parentId: integer('parent_id'),
  color: text('color').notNull().default('#000000'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
})

export const tags = sqliteTable('tags', {
  name: text('name').primaryKey(),
  groupId: integer('group_id').references(() => tagGroups.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 由 post_has_tag 上的 AFTER INSERT/DELETE 触发器维护（migration 0008）。 */
  postCount: integer('post_count').notNull().default(0),
})

export const postHasTag = sqliteTable('post_has_tag', {
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  tagName: text('tag_name').notNull().references(() => tags.name, { onDelete: 'cascade' }),
  /** SQLite 没有 BOOLEAN，这里就是 0/1。 */
  isAuto: integer('is_auto').notNull().default(0),
}, t => [primaryKey({ columns: [t.postId, t.tagName] })])

// ---------------------------------------------------------------- 分数 / 颜色

export const postWaifuScores = sqliteTable('post_waifu_scores', {
  postId: integer('post_id').primaryKey().references(() => posts.id, { onDelete: 'cascade' }),
  score: real('score').notNull().default(0),
})

export const postAestheticScores = sqliteTable('post_aesthetic_scores', {
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  scorer: text('scorer').notNull(),
  score: real('score').notNull(),
}, t => [primaryKey({ columns: [t.postId, t.scorer] })])

export const postHasColor = sqliteTable('post_has_color', {
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
  color: integer('color').notNull(),
}, t => [primaryKey({ columns: [t.postId, t.order] })])

export const postProcessFailures = sqliteTable('post_process_failures', {
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  /** 'basics' | 'embedding' | 'tagger' | 'waifu' | ... */
  worker: text('worker').notNull(),
  error: text('error').notNull(),
  failedAt: text('failed_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, t => [primaryKey({ columns: [t.postId, t.worker] })])

// ---------------------------------------------------------------- 标注

export const annotationQueues = sqliteTable('annotation_queues', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  /** SQL 侧有 CHECK (kind IN ('absolute','pairwise'))。 */
  kind: text('kind').$type<'absolute' | 'pairwise'>().notNull(),
  /** dimension key 的 JSON 数组。 */
  dimensions: text('dimensions').notNull(),
  /** absolute 队列用；pairwise 为 NULL。 */
  scale: integer('scale'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const absoluteAnnotations = sqliteTable('absolute_annotations', {
  id: integer('id').primaryKey(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  postId: integer('post_id').notNull(),
  dimension: text('dimension').notNull(),
  /** SQL 侧有 CHECK (scale IN (2,3,5))。 */
  scale: integer('scale').notNull(),
  value: integer('value').notNull(),
  rubricVersion: text('rubric_version').notNull(),
  sessionId: text('session_id').notNull(),
  elapsedMs: integer('elapsed_ms'),
  editedAt: text('edited_at'),
})

export const pairwiseAnnotations = sqliteTable('pairwise_annotations', {
  id: integer('id').primaryKey(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  postA: integer('post_a').notNull(),
  /** SQL 侧有 CHECK (post_b != post_a)。 */
  postB: integer('post_b').notNull(),
  dimension: text('dimension').notNull(),
  /** SQL 侧有 CHECK (winner IN ('a','b','tie','skip'))。 */
  winner: text('winner').$type<'a' | 'b' | 'tie' | 'skip'>().notNull(),
  rubricVersion: text('rubric_version').notNull(),
  sessionId: text('session_id').notNull(),
  elapsedMs: integer('elapsed_ms'),
  editedAt: text('edited_at'),
})

export const absoluteQueueItems = sqliteTable('absolute_queue_items', {
  queueId: integer('queue_id').notNull().references(() => annotationQueues.id),
  position: integer('position').notNull(),
  postId: integer('post_id').notNull(),
  done: integer('done').notNull().default(0),
}, t => [primaryKey({ columns: [t.queueId, t.position] })])

export const pairwiseQueueItems = sqliteTable('pairwise_queue_items', {
  queueId: integer('queue_id').notNull().references(() => annotationQueues.id),
  position: integer('position').notNull(),
  postA: integer('post_a').notNull(),
  postB: integer('post_b').notNull(),
  done: integer('done').notNull().default(0),
}, t => [primaryKey({ columns: [t.queueId, t.position] })])

export const contentFlagEvents = sqliteTable('content_flag_events', {
  id: integer('id').primaryKey(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  postId: integer('post_id').notNull(),
  /** SQL 侧有 CHECK (flag IN ('love','hate','none'))。 */
  flag: text('flag').$type<'love' | 'hate' | 'none'>().notNull(),
  sessionId: text('session_id').notNull(),
})

// ---------------------------------------------------------------- 内部 / 虚表

export const schemaVersions = sqliteTable('_schema_versions', {
  version: text('version').primaryKey(),
  appliedAt: text('applied_at').notNull().default(sql`CURRENT_TIMESTAMP`),
})

/**
 * `post_vectors_siglip2` 是 vec0 虚表：drizzle 表达不了 `CREATE VIRTUAL TABLE`，
 * 建表永远走手写 migration。这里只提供一个有类型的读写句柄。
 *
 * ⚠️ 写入时 rowid / 主键必须传 `BigInt` —— better-sqlite3 会把 JS number 按 REAL
 * 绑定，vec0 以 `Only integers are allowed for primary key values` 拒绝。
 */
export const postVectorsSiglip2 = sqliteTable('post_vectors_siglip2', {
  postId: integer('post_id').primaryKey(),
  embedding: float32Blob('embedding'),
})

/** SigLIP 2 so400m 的输出维度。 */
export const SIGLIP2_DIM = 1152

/** Lab dominant color 的维度。 */
export const DOMINANT_COLOR_DIM = 3
