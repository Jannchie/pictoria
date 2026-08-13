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

/**
 * 两个蒸馏头的名字。**跨进程契约的一部分** —— TS 排活、Python worker 按这个名字
 * 加载权重，两侧对不上的表现是任务提交成功后被 worker 以 `unknown scorer` 拒掉。
 *
 * 放在 contracts 而不是 `packages/db`，是因为需要它的不止数据层：调度循环要遍历，
 * scheduler 要收窄参数类型。Python 侧的对应物是 `server/src/scorers.py` 的 `SCORERS`，
 * 那是这条缝在另一侧的唯一定义。
 */
export const SILVA_SCORERS = ['silva', 'silva_luna'] as const

export type SilvaScorer = typeof SILVA_SCORERS[number]

export interface SilvaPayload {
  /** 哪一个蒸馏头。两个头共用一条代码路径，只有权重不同。 */
  scorer: SilvaScorer
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

export interface EmbeddingPayload {
  items: ImageItem[]
}

export interface EmbeddingResult {
  /** `embedding` 是 base64 的 float32，和 silva 输入用的是同一个编码。 */
  embeddings: Array<{ postId: number, embedding: string }>
  failures: WorkerFailure[]
}

/**
 * SigLIP 2 图像向量 —— 全站唯一的检索向量（图搜图 + 文搜图）。
 *
 * 初稿曾把它列为 §D1 的例外（"向量太大，让 worker 直接写 vec0"），**那条例外已被
 * 推翻**：它建立在错误的批量假设上（以为一批 256，实际 16）。真实批量下队列往返的
 * 纯开销约 12 ms，而这一批的 GPU 编码是秒级 —— 用一个永久的架构例外换 3% 不到的
 * 开销，不划算。所以它和其余 worker 一样：算在 Python，写在 TS。
 */
export const embeddingTask = defineTask<EmbeddingPayload, EmbeddingResult>('embedding')

/** so400m 是比 CLIP-L/14 更大的 ViT，bf16 下 16 张正好放进 12 GB。与 Python 侧同值。 */
export const EMBEDDING_TASK_BATCH = 16

/** `post_process_failures.worker` 里 embedding 用的桶名。注意带表名后缀。 */
export const EMBEDDING_WORKER_KEY = 'embedding:siglip2'

/**
 * 近重复分组的一次全量重算。
 *
 * 它是唯一一个 payload 里不带数据、只带**文件路径**的任务，因为它要的是**全库**
 * 向量：22.3 万条 × 1152 维 float32 = 1.0 GB，base64 之后 1.3 GB —— 塞不进一行
 * JSON。而逐个 KNN 不是备选（170k 行实测约 48 小时），必须一次分块 `X @ X.T`。
 *
 * 于是形状是：TS 把全库向量按 post_id 升序导成一个裸 float32 文件，payload 只带
 * 路径；worker mmap 读它、算、回传**行下标对**；TS 再把下标翻回 post_id、做贪心
 * 分组、落库。文件不是数据库，§D1 仍然成立 —— worker 依旧一行 SQL 都不碰。
 */
export interface DedupPayload {
  /**
   * 裸 float32 矩阵文件的绝对路径，形状 `(count, dim)`，C 序，小端。
   *
   * 必须落在图库根之内 —— worker 用 `_resolve_inside` 挡在外面的路径。
   */
  matrixPath: string
  count: number
  dim: number
  /** 余弦**距离**上限（1 - 相似度）。越小越严。 */
  threshold: number
  /** 一次矩阵乘吃多少行。每块物化一个 `(chunk, count)` 的相似度块。 */
  chunkSize: number
}

export interface DedupResult {
  /**
   * 上三角邻接：`[i, j]` 且 `i < j`，都是**行下标**而不是 post id。
   *
   * 回传下标而不是 id，是因为 worker 手里根本没有 id —— 矩阵文件里只有向量。
   * 翻译由持有 ids 数组的 TS 侧做，这也让 worker 的输出与库完全无关。
   */
  pairs: Array<[number, number]>
}

export const dedupTask = defineTask<DedupPayload, DedupResult>('dedup')

/**
 * 判定"同一张图"的余弦距离上限。与 Python 侧 `DEFAULT_DEDUP_THRESHOLD` 同值。
 *
 * vec0 的 siglip2 表用 cosine，所以完全相同的图约 0，无关的图接近 1。0.01
 * （相似度 ≥ 0.99）能抓住分辨率变体和近似差分，又不至于把"只是画风像"的收进来。
 */
export const DEDUP_THRESHOLD = 0.01

/** 每块 1024 行 —— 即使 N=170k，一个 `(1024, N)` 的块也远在 1 GB 以内。 */
export const DEDUP_CHUNK_SIZE = 1024

/**
 * 交互队列。**和 GPU backfill 队列分开**，由 worker 进程里第二个 `Worker` 实例
 * 伺候，poll 间隔紧得多。
 *
 * 分开不是为了并行 —— 显卡只有一张 —— 而是为了不排队：backfill 一批是秒级的，
 * 而文搜图是**有人正在等**的请求。共用一个队列会让一次搜索卡在某一批 embedding
 * 后面几秒；共用默认的 500 ms poll 则会给每次搜索无端加上半秒（§4.6）。
 */
export const INTERACTIVE_QUEUE = 'gpu-interactive'

export interface TextEmbedPayload {
  prompt: string
}

export interface TextEmbedResult {
  /** base64 float32，1152 维，和图像向量在同一个空间里。 */
  embedding: string
  /** SigLIP 学到的 logit scale（已 exp）。 */
  scale: number
  /** SigLIP 学到的 logit bias。 */
  bias: number
}

/**
 * 文搜图的文本编码。
 *
 * scale / bias 随结果一起回传而不是另开一个任务：它们在模型加载后就是常量，
 * 但拿到它们要碰 torch，而这一侧不能碰 torch。跟车一起走是最便宜的做法。
 */
export const textEmbedTask = defineTask<TextEmbedPayload, TextEmbedResult>('text-embed')

/**
 * IO 队列 —— 不碰 GPU 的活。
 *
 * 缩略图生成属于这里：它是 CPU + 磁盘，和显存毫无关系，塞进 GPU 队列只会让它
 * 排在某个模型批次后面。并发也因此可以大于 1（GPU 队列必须是 1）。
 */
export const IO_QUEUE = 'io'

export interface ThumbnailPayload {
  /** 原图绝对路径。 */
  originalPath: string
  /** 缩略图要写到哪儿（绝对路径，父目录由 worker 建）。 */
  thumbnailPath: string
}

export interface ThumbnailResult {
  /** 生成成功。false 时 `error` 说明原因（多半是原图解不出来）。 */
  ok: boolean
  error?: string
}

/**
 * 缩略图生成。
 *
 * 为什么不在 TS 侧用 sharp：库里现存的 22 万张缩略图全是 PIL 出的，换一个编码器
 * 意味着从此新旧两批缩略图字节不同。放在 worker 里既守住 §D1（算在 Python），又
 * 让 basics worker 之后能直接复用同一段代码。worker 写的是**文件**不是数据库，
 * 和 dedup 的矩阵文件是同一类东西 —— 也就是说，不是例外。
 */
export const thumbnailTask = defineTask<ThumbnailPayload, ThumbnailResult>('thumbnail')

export interface RotatePayload {
  /** 原图绝对路径。**会被就地覆写**。 */
  originalPath: string
  /** 旋转之后要重建的缩略图路径。 */
  thumbnailPath: string
  /** true 顺时针，false 逆时针。 */
  clockwise: boolean
}

export interface RotateResult {
  sha256: string
  size: number
  width: number
  height: number
  arthash: string | null
}

/**
 * 就地旋转一张图，并回报旋转后的那几个描述性字段。
 *
 * 和缩略图一样走 IO 队列：解码、旋转、重编码是 CPU 活。回传的 sha256 是**磁盘上
 * 那串编码后的字节**的哈希（和 `processors/basics.py` 同一个域），不是解码后的
 * 像素缓冲 —— 两者不同，混用会让重复检测悄悄失效。
 */
export const rotateTask = defineTask<RotatePayload, RotateResult>('rotate')

export interface CaptionPayload {
  /** 要描述的图片的绝对路径。 */
  imagePath: string
}

export interface CaptionResult {
  /** OpenAI 没配时是 false，TS 据此返回 MissingConfigError。 */
  configured: boolean
  caption: string
}

/**
 * 用 OpenAI 给一张图写说明文字。
 *
 * 放在 worker 而不是 TS 侧发 HTTP：调用之前要把图重新编码成 JPEG base64
 * （`diffusers.load_image` + PIL），那是实打实的解码/编码；而 API key 存在
 * `<target_dir>/.pictoria/OPENAI_API_KEY`，让它只被一个进程读到也更干净。
 */
export const captionTask = defineTask<CaptionPayload, CaptionResult>('caption')

/** basics 的一条输入：路径，加上"哪几样已经有了"。 */
export interface BasicsItem {
  postId: number
  path: string
  /** 相对图库根的路径 —— worker 据此算出缩略图该写到哪儿。 */
  relPath: string
  hasSha256: boolean
  hasArthash: boolean
  hasColor: boolean
}

export interface BasicsRow {
  postId: number
  /** 只在 `hasSha256` 为 false 时算，否则 null（落库用 COALESCE 保留原值）。 */
  sha256: string | null
  size: number | null
  arthash: string | null
  width: number
  height: number
  /** 调色板，每项是 `(r<<16)|(g<<8)|b`。 */
  colors: number[]
  /** 主色的 CIELAB 三元组，提不出调色板时是 null。 */
  dominantLab: [number, number, number] | null
  /**
   * colorthief 失败时的消息。
   *
   * PIL 解码成功但取不出调色板（退化的纯色图会报 `vbox1 not defined`）时，其余
   * 字段照常落库，只有 `dominant_color` 留 NULL —— 而"dominant_color IS NULL"
   * 正是待办查询的条件之一，不拉黑的话这张图每一轮都会被重选。
   */
  colorError: string | null
}

export interface BasicsPayload {
  items: BasicsItem[]
}

export interface BasicsResult {
  rows: BasicsRow[]
  failures: WorkerFailure[]
}

/**
 * basics：sha256 + arthash + 尺寸 + 调色板 + 主色，外加缩略图。
 *
 * 五样捆在一起是因为它们都搭同一次文件打开 / PIL 解码的便车 —— 拆开就要把同一张
 * 图解码四遍。走 IO 队列：全是 CPU 和磁盘。
 */
export const basicsTask = defineTask<BasicsPayload, BasicsResult>('basics')

/** 与 Python 侧 `BASICS_BATCH_SIZE` 同值。 */
export const BASICS_TASK_BATCH = 32

/** `post_process_failures.worker` 里 basics 用的桶名。 */
export const BASICS_WORKER_KEY = 'basics'

/** 一条准备落库的图片，用 `posts` 表自己的说法表述。 */
export interface NormalizedPostRow {
  filePath: string
  fileName: string
  extension: string
  source: string
  rating: number
  /** ISO 串或 null —— 它要穿过一次 JSON，所以不是 datetime。 */
  publishedAt: string | null
  /** `{tag_name: group_id}`。tag 归哪个组是 schema 知识，由 TS 侧算好传进来。 */
  tags: Record<string, number>
}

export interface DanbooruImportPayload {
  tags: string
  limit: number
  fullScan: boolean
  /**
   * 已经**带 tag** 导入过的 Danbooru post id。
   *
   * 去重过滤器和翻页停止条件都要用它，而 worker 没有库可查，所以必须随 payload 走。
   */
  importedIds: string[]
  /** 落盘目录的绝对路径。 */
  saveDir: string
  /** 相对图库根的目录，写进 `posts.file_path`。 */
  filePathStr: string
  /** 规范 tag 组的 `{类型: group_id}`，按优先级排序。 */
  typeToGroupId: Record<string, number>
}

export interface DanbooruStats {
  total: number
  with_url: number
  filtered: number
  downloaded: number
  skipped: number
  failed: number
  early_stopped: boolean
}

export interface DanbooruImportResult {
  /** 只包含**字节已经落盘**的那些 —— 行不能早于文件存在。 */
  rows: NormalizedPostRow[]
  stats: DanbooruStats
}

/**
 * Danbooru 标签导入。
 *
 * 抓取和下载留在 Python 不是妥协，是同一条规则：那个客户端带着两道调好的限流闸
 * （API 和 CDN 各一道）和一个很微妙的翻页停止条件，重写一遍只会漂移。落库照旧
 * 在 TS —— 于是 §D1 依然成立。
 *
 * 走 IO 队列：全是网络和磁盘，一点显存都不占。
 */
export const danbooruImportTask = defineTask<DanbooruImportPayload, DanbooruImportResult>('danbooru-import')

/**
 * 一次标签列表最多翻多少条。与 Python 侧 `_DEFAULT_LISTING_LIMIT` 同值。
 *
 * 原本是 99999，也就是最多约 500 页串行请求。绝大多数画师标签在第一页就短路了，
 * 但大的版权/角色标签会在一次调用里翻上几分钟 —— 而客户端的读超时是关掉的，
 * 调用方看到的就是卡死。
 */
export const DANBOORU_LISTING_LIMIT = 5000


/** gallery-dl 解析出来的一条待下载项。 */
export interface GalleryDLItem {
  downloadUrl: string
  /** 写进 `posts.file_name`（不含扩展名）。 */
  fileName: string
  extension: string
  source: string
  /** gallery-dl 的 category（yandere / kemono / …）。 */
  category: string
  /** 搜索标签或用户名 —— 它就是目录名。 */
  creator: string
  rating: number
  publishedAt: string | null
  /** `{组名: [tag, ...]}`，还没解析成 group_id。 */
  tagsByCategory: Record<string, string[]>
}

export interface UrlScanPayload {
  url: string
}

export interface UrlScanResult {
  /** gallery-dl 一共吐出多少条（含非图片）。 */
  fetched: number
  /** `<category>/<creator>`。一个 URL 下的所有项共享它，所以就是一个目录。 */
  filePath: string
  items: GalleryDLItem[]
}

/**
 * `gallery-dl -j <url>` —— 只解析，不下载。
 *
 * 和下载分成两个任务是因为中间夹着一次**数据库读**：这个目录下哪些 file_name 已经
 * 有了。worker 没有库，所以它把候选交出来，TS 过滤完再把幸存者送回去下载。
 *
 * gallery-dl 是个 Python 工具，这也是它必须留在 worker 的原因 —— 不是权宜。
 */
export const urlScanTask = defineTask<UrlScanPayload, UrlScanResult>('url-scan')

export interface UrlDownloadPayload {
  items: GalleryDLItem[]
  /** 落盘目录的绝对路径。 */
  saveDir: string
  /** 相对图库根的目录，写进 `posts.file_path`。 */
  filePathStr: string
  typeToGroupId: Record<string, number>
}

export interface UrlDownloadResult {
  /** 只包含字节已经落盘的那些。 */
  rows: NormalizedPostRow[]
  downloaded: number
  failed: number
}

/** 把 TS 判定为"新"的那些项下下来，回传可以落库的行。 */
export const urlDownloadTask = defineTask<UrlDownloadPayload, UrlDownloadResult>('url-download')
