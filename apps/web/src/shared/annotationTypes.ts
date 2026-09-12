/**
 * 标注维度 / 量表 / 采样策略的取值，从生成的 API 类型上派生 —— 服务端的 zod enum
 * 是唯一真相，这里不重抄一份字面量。
 */
import type { AbsoluteEventIn, GenerateAbsoluteIn, PairwiseEventIn } from '@/api'

export type AnnotationDimension = AbsoluteEventIn['dimension']
export type AnnotationScale = AbsoluteEventIn['scale']
export type AbsoluteStrategy = NonNullable<GenerateAbsoluteIn['strategy']>
export type PairwiseStrategy = NonNullable<PairwiseEventIn['strategy']>
