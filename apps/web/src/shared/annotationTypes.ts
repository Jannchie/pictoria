/**
 * 标注维度 / 量表 / 采样策略的取值，从生成的 API 类型上派生 —— 服务端的 zod enum
 * 是唯一真相，这里不重抄一份字面量。
 */
import type { AbsoluteEventIn, ContentFlagIn, GenerateAbsoluteIn, PairwiseEventIn, QueueSummaryPublic } from '@/api'

export type AnnotationDimension = AbsoluteEventIn['dimension']
export type AnnotationScale = AbsoluteEventIn['scale']
export type AbsoluteStrategy = NonNullable<GenerateAbsoluteIn['strategy']>
export type PairwiseStrategy = NonNullable<PairwiseEventIn['strategy']>
export type PairwiseWinner = PairwiseEventIn['winner']
export type ContentFlag = ContentFlagIn['flag']
export type QueueKind = QueueSummaryPublic['kind']

/**
 * Per-dimension copy and icon. Dimensions are shown as guiding questions rather than
 * cold labels, to anchor attention on that dimension's features (anti-halo). Message
 * keys are spelled out literally so the locale guard can check each one.
 */
export interface DimensionMeta {
  labelKey: string
  hintKey: string
  promptKey: string
  questionKey: string
  icon: string
}

export const DIMENSION_META: Record<AnnotationDimension, DimensionMeta> = {
  overall: {
    labelKey: 'annotate.dimension.overall.label',
    hintKey: 'annotate.dimension.overall.hint',
    promptKey: 'annotate.dimension.overall.prompt',
    questionKey: 'annotate.dimension.overall.question',
    icon: 'i-tabler-star',
  },
  color: {
    labelKey: 'annotate.dimension.color.label',
    hintKey: 'annotate.dimension.color.hint',
    promptKey: 'annotate.dimension.color.prompt',
    questionKey: 'annotate.dimension.color.question',
    icon: 'i-tabler-palette',
  },
  finish: {
    labelKey: 'annotate.dimension.finish.label',
    hintKey: 'annotate.dimension.finish.hint',
    promptKey: 'annotate.dimension.finish.prompt',
    questionKey: 'annotate.dimension.finish.question',
    icon: 'i-tabler-brush',
  },
  composition: {
    labelKey: 'annotate.dimension.composition.label',
    hintKey: 'annotate.dimension.composition.hint',
    promptKey: 'annotate.dimension.composition.prompt',
    questionKey: 'annotate.dimension.composition.question',
    icon: 'i-tabler-layout-collage',
  },
}

/** Meta for a dimension string from the server, or undefined for one this build does not know. */
export function dimensionMeta(d: string | null | undefined): DimensionMeta | undefined {
  return d != null && Object.hasOwn(DIMENSION_META, d) ? DIMENSION_META[d as AnnotationDimension] : undefined
}
