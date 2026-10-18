/**
 * `/v2/danbooru-imports` —— Danbooru 标签导入作业：提交、查一个、列全部。
 *
 * 提交立即回 202，导入在后台跑（`../danbooru-imports.ts`），调用方轮询作业拿进度。
 * 同一个 tags 正在排队或在跑时，重复提交拿回的是**同一个**作业 —— 所以重试是安全的，
 * 永远不会让两个导入抢同一份 CDN 配额。
 */
import { createRoute, z } from '@hono/zod-openapi'
import { DanbooruImportJobSchema as DanbooruImportJob } from '../danbooru-imports.js'
import { newRoutes } from '../env.js'
import { errors, fail, OK, validationError } from '../openapi.js'

const DanbooruImportCreate = z
  .object({
    tags: z.string(),
    // 翻到列表尾部，捡起"我们导完它的 id 邻居之后 Danbooru 才打上这个标签"的那些 post；
    // 默认不开，因为那种情况少见而代价是每次都翻满。
    fullScan: z.boolean().optional(),
  })
  .openapi('DanbooruImportCreate')

const DanbooruImportList = z
  .object({ jobs: z.array(DanbooruImportJob) })
  .openapi('DanbooruImportList')

const jobIdParam = z.string()
  .openapi({ param: { name: 'job_id', in: 'path', required: true } })

export const danbooruImportsRoutes = newRoutes()

danbooruImportsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/v2/danbooru-imports',
    operationId: 'v2CreateDanbooruImport',
    summary: 'CreateDanbooruImport',
    description: 'Queue a Danbooru tag import and return its job at once. Submitting a tag that already has a queued/running job returns that job instead of starting another.',
    request: { body: { required: true, content: { 'application/json': { schema: DanbooruImportCreate } } } },
    responses: {
      202: { description: 'Accepted', content: { 'application/json': { schema: DanbooruImportJob } } },
      ...errors(400),
    },
  }),
  (c) => {
    const body = c.req.valid('json')
    const tags = body.tags.trim()
    if (!tags)
      return validationError('tags must not be empty.')
    return c.json(c.var.danbooruImports.submit(tags, body.fullScan ?? false), 202)
  },
)

danbooruImportsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/danbooru-imports',
    operationId: 'v2ListDanbooruImports',
    summary: 'ListDanbooruImports',
    description: 'Every retained Danbooru import job, most recently created first. In-memory: an API restart empties it.',
    responses: {
      200: { description: OK, content: { 'application/json': { schema: DanbooruImportList } } },
    },
  }),
  c => c.json({ jobs: c.var.danbooruImports.list() }, 200),
)

danbooruImportsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/v2/danbooru-imports/{job_id}',
    operationId: 'v2GetDanbooruImport',
    summary: 'GetDanbooruImport',
    description: 'One Danbooru import job. 404 after an API restart (jobs are in-memory) or once it has aged out; resubmitting is safe.',
    request: { params: z.object({ job_id: jobIdParam }) },
    responses: {
      200: { description: OK, content: { 'application/json': { schema: DanbooruImportJob } } },
      ...errors(404),
    },
  }),
  (c) => {
    const { job_id: jobId } = c.req.valid('param')
    const job = c.var.danbooruImports.get(jobId)
    if (!job)
      return fail(404, 'DanbooruImportNotFoundError', `Danbooru import ${jobId} not found.`)
    return c.json(job, 200)
  },
)
