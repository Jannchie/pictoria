/**
 * cairnq 任务契约 —— TS 与 Python 两侧共同遵守的那份定义。
 *
 * 名字只在这里出现一次（`defineTask` 的字符串），Python 侧按同名字符串注册 handler；
 * 跨语言边界上走的只有这个名字和 JSON payload，所以这个文件就是两侧唯一的接头。
 *
 * 贯穿全局的原则（见 `docs/refactor-monorepo-hono.md` §D1）：
 *
 *   **所有计算在 Python worker，所有数据库写入在 TS，没有例外。**
 *
 * 于是每个 payload 都必须自带 worker 需要的全部输入（路径、向量），每个 result 都是
 * 纯数据 —— worker 不碰 `pictoria.sqlite`，一行都不读、一行都不写。
 */
import { defineTask } from 'cairnq'

/**
 * GPU 队列。worker 端 `concurrency=1`，替代原来的 `processors/gpu_pressure.py`
 * —— 一次只有一个批次在显存里，排队由 cairnq 负责。
 */
export const GPU_QUEUE = 'gpu'

/** 一条待打分的输入：post 的 id 加上它已存的 SigLIP2 向量（base64 float32）。 */
export interface ScoreItem {
  postId: number
  /** base64 编码的 float32 向量，见 `codec.ts` 里为什么不是 JSON 数组。 */
  embedding: string
}

export interface SilvaPayload {
  /** 哪一个蒸馏头。两个头共用一条代码路径，只有权重不同。 */
  scorer: 'silva' | 'silva_luna'
  items: ScoreItem[]
}

export interface SilvaResult {
  scores: Array<{ postId: number, score: number }>
}

/**
 * SILVA / SILVA-Luna 打分：输入已存的向量，输出 [0,1] 的标量。
 *
 * 第一个接进 cairnq 的 worker，因为它是最简单的一个 —— 不解码图片、不跑 backbone、
 * 不碰文件系统，就是一次 head forward。整条 submit → lease → 结果落库的链路先用它
 * 走通（见 §5 Phase 5）。
 */
export const silvaTask = defineTask<SilvaPayload, SilvaResult>('silva')

/**
 * 一批的大小。
 *
 * Python 侧原来的 `SILVA_BATCH_SIZE` 是 256，因为它从库里直接拿向量，批大小不花钱。
 * 走 cairnq 之后向量要随 payload 走，256 条就是约 1.5 MB 的一行 JSON；64 条是
 * 384 KB，而 head forward 本身在这两个批量上都是毫秒级的矩阵乘 —— 批大小买不到
 * 吞吐，只买到 payload 体积。
 */
export const SILVA_TASK_BATCH = 64

/** 一条待打分的图片：post id 加上磁盘上的绝对路径。 */
export interface ImageItem {
  postId: number
  /** 绝对路径。worker 没有库可查（§D1），所以路径必须随 payload 走。 */
  path: string
}

/** 降级阶梯判定为坏数据的那些 post —— TS 决定这意味着什么。 */
export interface WorkerFailure {
  postId: number
  error: string
}

export interface WaifuPayload {
  items: ImageItem[]
}

export interface WaifuResult {
  scores: Array<{ postId: number, score: number }>
  failures: WorkerFailure[]
}

/**
 * waifu 质量分：CLIP ViT-L/14 backbone + 一个回归头，输入是图片本身。
 *
 * 与 silva 的关键差别在于失败**是**一种正常结果：一张读不出来的图会让整批崩掉，
 * worker 内部的降级阶梯（整批 → 4 张 → 单张）把它隔离出来，作为 `failures` 回传。
 * TS 侧把它写进 `post_process_failures` 一次性拉黑，否则待办查询会永远重选它。
 */
export const waifuTask = defineTask<WaifuPayload, WaifuResult>('waifu')

/**
 * 一批的大小，与 Python 侧的 `WAIFU_BATCH_SIZE` 同值。
 *
 * 这里不像 silva 那样需要缩小 —— payload 里只有路径，32 条也就几 KB。它的上限
 * 是显存，不是队列。
 */
export const WAIFU_TASK_BATCH = 32

/** `post_process_failures.worker` 里 waifu 用的桶名。与 Python 侧同值。 */
export const WAIFU_WORKER_KEY = 'waifu'

/** WDTagger 对一张图的输出。 */
export interface TaggerResult {
  postId: number
  generalTags: string[]
  characterTags: string[]
  /** `general` / `sensitive` / `questionable` / `explicit`，或空串。 */
  rating: string
}

export interface TaggerPayload {
  items: ImageItem[]
}

export interface TaggerBatchResult {
  results: TaggerResult[]
  failures: WorkerFailure[]
}

/**
 * 自动标签（wd-vit-large-tagger-v3）。
 *
 * worker 只把标签**算出来**，标签落进 `tags` / `post_has_tag`、rating 落进 `posts`
 * 都在 TS 侧 —— 这是三个 worker 里落库最复杂的一个，也正因如此它最能说明 §D1 的价值：
 * 一个 tag 该属于哪个组、rating 什么时候能覆盖，这些是 schema 的知识，属于拥有 schema
 * 的那一侧。
 *
 * 空标签响应被 worker 判为失败（而不是成功但没结果）：留着它 `post_has_tag` 一行不写，
 * 待办查询会永远重选这张图，而重跑只会得到同样的空响应。
 */
export const taggerTask = defineTask<TaggerPayload, TaggerBatchResult>('tagger')

/** wd-vit-large 跑在 GPU 上，32 能把一张 30xx 喂饱。与 Python 侧同值。 */
export const TAGGER_TASK_BATCH = 32

/** `post_process_failures.worker` 里 tagger 用的桶名。 */
export const TAGGER_WORKER_KEY = 'tagger'
