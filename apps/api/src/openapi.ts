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
export const ValidationError = z.object({
  status_code: z.int(),
  detail: z.string(),
  extra: z.any().openapi({ type: ['null', 'object', 'array'], additionalProperties: {} }).optional(),
})

export const RESP_400 = {
  400: {
    description: 'Bad request syntax or unsupported method',
    content: { 'application/json': { schema: ValidationError } },
  },
} as const

/** Litestar 200 响应固定用这句 description。 */
export const OK = 'Request fulfilled, document follows'
