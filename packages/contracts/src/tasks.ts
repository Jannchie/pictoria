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
