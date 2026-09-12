/**
 * 路由层共享件：唯一的错误体、响应声明的糖，以及 zod 校验失败的翻译。
 *
 * 契约的守卫是 `pnpm contract:check`：它从活的 API 重新生成 `apps/web/src/api`，
 * 生成物有 diff 就失败。所以这里没有"必须逐字复刻"的东西 —— 改了形状，把生成物
 * 一起提交即可。
 */
import type { Context } from 'hono'
import { z } from '@hono/zod-openapi'

/**
 * 所有非 2xx 响应共用的体。`error` 是机器可读的码（`PostNotFoundError`、
 * `ValidationError`…），`detail` 是给人看的一句话，前端的 toast 直接显示它；
 * `issues` 只在 schema 校验失败时出现，逐条指出是哪个字段、错在哪。
 */
export const ErrorBody = z
  .object({
    error: z.string(),
    detail: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('ErrorBody')

export type ErrorStatus = 400 | 404 | 405 | 409 | 422 | 500

const ERROR_DESCRIPTIONS: Record<ErrorStatus, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
}

type ErrorResponses<S extends readonly ErrorStatus[]> = {
  [K in S[number]]: { description: string, content: { 'application/json': { schema: typeof ErrorBody } } }
}

/**
 * 声明一个端点会回的错误状态：`responses: { 200: …, ...errors(400, 404) }`。
 *
 * 声明是有牙齿的：handler 里 `fail(c, 404, …)` 只有在这里列了 404 才通过类型检查，
 * 反过来列了却没有任何路径会回它也只是文档多一条，所以宁可按实际抛的写。
 */
export function errors<const S extends readonly ErrorStatus[]>(...statuses: S): ErrorResponses<S> {
  return Object.fromEntries(
    statuses.map(s => [s, { description: ERROR_DESCRIPTIONS[s], content: { 'application/json': { schema: ErrorBody } } }]),
  ) as ErrorResponses<S>
}

export const OK = 'OK'
export const CREATED = 'Created'

/**
 * 一条错误响应。返回 `c.json(...)` 而不是裸 `Response`，类型才会对上 `errors()`
 * 的声明 —— 声明了 `errors(404)` 的 handler 里 `fail(c, 409, …)` 编译不过。
 *
 * ⚠️ 用了 `errors()` 的 handler，成功路径要写显式状态：`c.json(x, 200)`。
 * 不写的话 TS 会把状态推成所有已声明状态的并集，然后拿 200 的 schema 去对 400 的。
 */
export function fail<S extends ErrorStatus>(c: Context<any, any, any>, status: S, error: string, detail: string) {
  return c.json({ error, detail }, status)
}

/** `fail` 的裸 `Response` 版，给本来就返回裸 `Response`（文件流）的 handler 用。 */
export function errorResponse(status: ErrorStatus, error: string, detail: string): Response {
  return Response.json({ error, detail }, { status })
}

/** 最常见的那一条。文案前端直接显示。 */
export function postNotFound(c: Context<any, any, any>, postId: number) {
  return fail(c, 404, 'PostNotFoundError', `Post with id ${postId} not found.`)
}

/**
 * 把 zod 的校验失败转成 `ErrorBody`。
 *
 * `@hono/zod-openapi` 默认回 `{success:false, error:{name:'ZodError',...}}`，
 * 和别的错误长得不一样，前端就得多认一种。这里挂成 `defaultHook`，让 schema
 * 校验失败和手抛的 400 是同一个形状，只多一个 `issues`。
 */
export function zodErrorHook(result: { success: boolean, error?: z.ZodError }, c: Context<any, any, any>) {
  if (result.success)
    return undefined
  const issues = result.error?.issues ?? []
  const method = c.req.method
  const path = new URL(c.req.url).pathname
  return c.json(
    {
      error: 'ValidationError',
      detail: `Validation failed for ${method} ${path}`,
      issues: issues.map(i => ({ path: i.path.map(String).join('.'), message: i.message })),
    },
    400,
  )
}

/**
 * 布尔查询参数。
 *
 * 不能用 `z.coerce.boolean()`：它把任何非空串都当 true，`?flag=false` 会静默变成
 * true —— 语义反了还不报错。`z.stringbool()` 认 true/false/1/0/yes/no。
 */
export function boolQuery(name: string, dflt: boolean) {
  return z.stringbool().default(dflt)
    .openapi({ param: { name, in: 'query', required: false }, type: 'boolean', default: dflt })
}
