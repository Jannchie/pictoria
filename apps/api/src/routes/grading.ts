/**
 * `/v2/grading`：快速打分页。一副混好的牌 + 实时一致度。
 *
 * 选图逻辑和比例在 `@pictoria/db` 的 `repositories/grading.ts`；写分走既有的
 * `PUT /v2/posts/{post_id}/score`（带 `source: 'grade:<reason>'`），这里不另开写入口 ——
 * 分数只有一个真相（`posts.score`），事件也只有一条流（`post_score_events`）。
 */
import { createRoute, z } from '@hono/zod-openapi'
import { ANCHOR_GRADES, GRADING_REASONS, gradingAnchors, gradingStats, postsInOrder } from '@pictoria/db'
import { newRoutes } from '../env.js'
import { OK, errors } from '../openapi.js'
import { QueueItemPostPublic, toQueuePost } from './annotation-shared.js'

const MAX_DECK = 100

const GradingCardPublic = z
  .object({
    post: QueueItemPostPublic,
    reason: z.enum(GRADING_REASONS).describe('Why this picture was drawn. Goes back as `source: grade:<reason>` when scoring it.'),
    previous: z.int().describe('The human grade when drawn; 0 = never graded. The page hides it until the new grade is in.'),
    model: z.int().nullable().describe('The SILVA score as a 1-5 grade; null when unscored.'),
  })
  .openapi('GradingCardPublic')

const AgreementPublic = z
  .object({
    n: z.int(),
    exact: z.number().nullable().describe('Share of grades that landed on the same level; null when n = 0.'),
    far: z.number().nullable().describe('Share that landed two or more levels apart; null when n = 0.'),
  })
  .openapi('AgreementPublic')

const GradingStatsPublic = z
  .object({
    gradedToday: z.int().describe('Grades given on this page in the last 24 hours.'),
    self: AgreementPublic.describe('You vs. your earlier grade, on uniformly drawn re-grades only.'),
    model: AgreementPublic.describe('SILVA vs. you, on never-graded pictures only.'),
  })
  .openapi('GradingStatsPublic')

const GradingAnchorRowPublic = z
  .object({ grade: z.int(), posts: z.array(QueueItemPostPublic) })
  .openapi('GradingAnchorRowPublic')

export const gradingRoutes = newRoutes()

gradingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/grading/deck',
    operationId: 'v2GradingDeck',
    summary: 'GradingDeck',
    description: 'Draw a shuffled deck for blind grading: 80% never-graded pictures (spread evenly over model grades), 10% uniform re-grades, 10% re-grades where the human grade and the model disagree. Pictures graded within the last week, and the anchor pictures, are left out.',
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(MAX_DECK).default(30)
          .openapi({ param: { name: 'limit', in: 'query', required: false }, type: 'integer', default: 30 }),
      }),
    },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(GradingCardPublic) } } },
      ...errors(400),
    },
  }),
  async (c) => {
    // 抽牌要把整库读进内存（真库 0.6–1.6 s），走读线程，别卡住主线程
    const picks = await c.var.reads.sampleGradingDeck(c.req.valid('query').limit)
    const posts = new Map(postsInOrder(c.var.db, picks.map(p => p.postId)).map(p => [p.post_id, p]))
    return c.json(
      picks.flatMap((pick) => {
        const row = posts.get(pick.postId)
        return row ? [{ post: toQueuePost(row), reason: pick.reason, previous: pick.previous, model: pick.model }] : []
      }),
      200,
    )
  },
)

gradingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/grading/stats',
    operationId: 'v2GradingStats',
    summary: 'GradingStats',
    description: 'Agreement measured from the last 30 days of blind grading.',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: GradingStatsPublic } } },
    },
  }),
  c => c.json(gradingStats(c.var.db), 200),
)

gradingRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/grading/anchors',
    operationId: 'v2GradingAnchors',
    summary: 'GradingAnchors',
    description: 'The fixed reference pictures shown beside the grading page, best grade first: for each grade, a few pictures the human grade and the model both place there. Chosen once and kept; a slot is refilled only when its picture stops qualifying.',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: z.array(GradingAnchorRowPublic) } } },
    },
  }),
  (c) => {
    const sqlite = c.var.db
    const anchors = gradingAnchors(sqlite)
    const posts = new Map(postsInOrder(sqlite, anchors.map(a => a.postId)).map(p => [p.post_id, p]))
    return c.json(
      ANCHOR_GRADES.map(grade => ({
        grade,
        posts: anchors.flatMap((a) => {
          const row = a.grade === grade ? posts.get(a.postId) : undefined
          return row ? [toQueuePost(row)] : []
        }),
      })),
      200,
    )
  },
)
