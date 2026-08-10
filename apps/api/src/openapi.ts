/**
 * 与 Litestar 契约对齐所需的共享件。
 *
 * `docs/openapi.baseline.json` 是真理，`scripts/openapi-contract-diff.mjs` 是裁判。
 * 这里放的是 baseline 里反复出现、必须逐字复刻的东西。
 */
import { z } from '@hono/zod-openapi'

/**
 * Litestar 给 70 个端点里的 63 个自动挂了同一个 400。Hono 没有等价机制，只能
 * 做成常量逐个端点显式挂上 —— 漏一个 contract-diff 就会报。
 */
export const ValidationError = z
  .object({
    status_code: z.int(),
    detail: z.string(),
    extra: z.any().openapi({ type: ['null', 'object', 'array'], additionalProperties: {} }).optional(),
  })
  // schema 自身的 description（不是响应的），hey-api 把它转成类型上的 JSDoc。
  .describe('Validation Exception')

export const RESP_400 = {
  400: {
    description: 'Bad request syntax or unsupported method',
    content: { 'application/json': { schema: ValidationError } },
  },
} as const

/** Litestar 200 响应固定用这句 description。 */
export const OK = 'Request fulfilled, document follows'

/**
 * 把 zod 的校验失败转成 Litestar 的 400 形状。
 *
 * `@hono/zod-openapi` 默认返回 `{success:false, error:{name:'ZodError',...}}`，
 * 而 Litestar 返回 `{status_code, detail, extra:[{message,key,source}]}`。前端
 * 的错误处理认后者，所以这里逐字段翻译。
 */
/** 把一条 zod issue 翻成 msgspec 的措辞。 */
function msgspecMessage(i: any): string {
  const t = i.origin ?? i.expected
  if (i.code === 'too_big')
    return `Expected \`${t === 'number' ? 'int' : t}\` <= ${i.maximum}`
  if (i.code === 'too_small')
    return `Expected \`${t === 'number' ? 'int' : t}\` >= ${i.minimum}`
  if (i.code === 'invalid_type')
    return `Expected \`${i.expected === 'number' ? 'int' : i.expected}\``
  return i.message
}

export function zodErrorHook(result: any, c: any) {
  if (result.success)
    return undefined
  const issues = result.error?.issues ?? []
  const method = c.req.method
  const path = new URL(c.req.url).pathname
  return c.json(
    {
      status_code: 400,
      detail: `Validation failed for ${method} ${path}`,
      extra: issues.map((i: any) => ({
        // 措辞对齐 msgspec：`Expected \`int\` <= 5`，不是 zod 的
        // `Too big: expected number to be <=5`。前端可能把这句直接显示给用户。
        message: msgspecMessage(i),
        key: Array.isArray(i.path) ? i.path[i.path.length - 1] : undefined,
        // zod 不区分 body/query/path，Litestar 区分；这里给 body 作为最常见来源。
        source: 'body',
      })),
    },
    400,
  )
}

/**
 * Litestar 手抛的 `ValidationException` → 400。
 *
 * ⚠️ 形状和 **schema 校验失败**不同：手抛的把消息直接放进 `detail` 且**没有 `extra`**，
 * 而 msgspec 的 schema 校验失败是 `{detail: "Validation failed for …", extra: [...]}`。
 * 同一个状态码，两种形状，前端分得出来。
 */
export function validationError(c: any, message: string) {
  return c.json({ status_code: 400, detail: message }, 400)
}

/**
 * Python `repr()` 的等价物，只覆盖错误消息里真正出现的那几种值。
 *
 * 消息文本是契约的一部分（前端会直接显示），而 Python 侧写的是 `f"...: {value!r}"` ——
 * 字符串带单引号、列表是 `['a', 'b']`。JS 的模板插值会把列表变成 `a,b`，不一样。
 */
export function pyRepr(value: unknown): string {
  if (typeof value === 'string')
    return `'${value}'`
  if (Array.isArray(value))
    return `[${value.map(v => pyRepr(v)).join(', ')}]`
  return String(value)
}
