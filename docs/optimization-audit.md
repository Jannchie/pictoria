# Pictoria 优化空间审查报告

> **状态 (2026-08-14)**: 以下条目已落地并随本报告同批提交:B3(Recently 复合索引, 迁移 0015)、
> B4(embedding 待办 MAX(id) 指纹门控——count 对比方案因孤儿向量否决, 见迁移 0015 注释)、
> B13(恒真三元)、B15(NUL 分隔符改 `\0` 转义)、W1(清空 `ai/__init__`)、W2(matplotlib import)、
> W7(worker 认 `PICTORIA_TARGET_DIR`/`TASKS_DB_PATH`, 与 paths.ts 同锚)、F1(limit 1000→200)、
> H4(git rm 跟踪的 .pyc)、H7(stackdump)。其余条目仍为待办。

- **日期**: 2026-08-14
- **范围**: apps/api、packages/db、apps/web、server/src(worker)、仓库卫生与构建配置
- **方法**: 四个并行子代理逐文件审计(全部结论经阅读源码核实)+ 本报告作者在**真实生产库**(223,063 张图、post_has_tag 1,188 万行、DB 2.18 GB)上对热点查询做了 EXPLAIN QUERY PLAN 与耗时实测
- **总体结论**: 代码质量很高——批量查询、索引设计、延迟加载、事务纪律都很到位,**没有结构性问题**。优化空间集中在少数真实热点(下文的实测数据)+ 一组系统性清理(死代码、陈旧文件、导入时成本)

---

## 1. 实测热点数据

> 实测环境: 真实库 `pictoria.sqlite`(2.18 GB, 223,063 posts), 只读连接, 3 次取最优。

| 查询 / 端点 | 实测耗时 | 评估 |
|---|---|---|
| 帖子列表一页 (1000 条) | **2.5 ms** | ✅ 索引完备 |
| countPosts (全表) | 6.5 ms | ✅ 覆盖索引 |
| tag 计数快路径 | ~0 ms | ✅ 反规范化索引 `ix_tags_post_count` |
| tag 计数过滤路径 | ~0 ms (rating=5 空集) | ✅ |
| 批量取 1000 帖的 tags | 30 ms | ✅ 无 N+1 |
| 批量取 1000 帖的 colors / scores | 2.6 / 1.8 ms | ✅ |
| **底栏聚合 stats** | **299 ms** | ⚠️ 每次筛选变化都触发 (B2) |
| **Recently 视图** | **254 ms** | ⚠️ 临时 B-TREE 排序 (B3) |
| **silva 分档计数 (全库)** | **133 ms** | ⚠️ 每次筛选变化触发 (B2) |
| **目录树聚合 (folderScoreAggregates)** | **1,578 ms** | 🔴 单请求最重成本 (B1) |
| KNN 文搜图 | 1–2 s | 平台约束: vec0 暴力距离扫描 (~1 GB 向量), 无索引可加 |
| 图字节服务 (thumb/original) | — | ✅ 已带 immutable 缓存 + ETag |

**热路径总结**: 读模型(list / detail / search / facets)已经是批量 + 索引感知的;真正的异常点是 ① 目录树端点、② 标注时间线排序、③ 近重复重建事务、④ embedding 待办查询、⑤ 一小撮未缓存/未批量的写路径。

---

## 2. 后端 (apps/api + packages/db)

### 🔴 高优先级

**B1. `GET /v2/folders` 每次请求做同步全盘遍历 + 1.6s 全表聚合, 无缓存**
- 证据: `apps/api/src/routes/folders.ts:118-125` → `walk()`(`folders.ts:50-80`, 同步 `readdirSync` 递归整个图库树) + `folderScoreAggregates`(`packages/db/src/repositories/folders.ts:50-96`, 全表 `GROUP BY file_path` + 两个 aesthetic join, 实测 1.58s)
- 影响: 挂在常驻侧边栏上(删帖/删目录后还会失效重取), 每次请求冻结事件循环数秒; 与 `sync.ts` 已有 mtime 缓存的 `scanLibrary` 遍历重复造轮子
- 修复: 服务端按失效版本缓存; 至少复用 `scanLibrary` 的 mtime 缓存并让出事件循环

**B2. 筛选联动 = 聚合风暴 (与 F2 是同一件事的两端)**
- 证据: 每次切换筛选条件, 前端并发打出 ~6–8 个聚合请求(stats 299ms + rating/score/waifu/silva/silva_luna 分档各 ~130ms), 全部在**单条同步 better-sqlite3 连接**上排队 → 一次交互卡住 API 事件循环约 0.5–1s
- 修复: 前端给 count 查询加 staleTime / 后端按 filter 签名缓存 / 合并成一个聚合端点

**B3. Recently 视图 254ms 临时排序** ✅ 已落地
- 证据: `ORDER BY last_accessed_at DESC` 命中单列索引 `ix_posts_last_accessed_at`(migration 0003), 但计划器选 `ix_posts_canonical` 过滤 + TEMP B-TREE 排序
- 修复: 一个迁移建复合索引 `(canonical_post_id, last_accessed_at)` → ~5ms

**B4. `listEmbeddingPending` 每 30 秒全量扫 posts + 全量扫 vec0, 永不退出** ✅ 已落地(指纹门控)
- 证据: `packages/db/src/repositories/backfill.ts:341-359` 无 LIMIT、无门控; 其他待办查询(`listWaifuPending`/`listTaggerPending`/`listBasicsPending`)都带 SQL `LIMIT` 或提前退出, 唯独 embedding 循环即使库已全算完也每 30s 物化 ~22 万行 posts + ~22 万 vec0 id
- 修复: 先做 count 对比门控(`count(posts) = count(vec0)` 则直接返回空)

**B5. `replaceAllGroups` 单事务分钟级冻结单写者 + 事件循环**
- 证据: `packages/db/src/repositories/dedup.ts:117-131` 把数万条 UPDATE 放一个事务, 每条还触发 migration 0009 的 `tags.post_count` 触发器(每成员 ≈ 1 + N 条 tag 更新)
- 修复: 分批执行(块间让出事件循环) + 分组完成后一次性重算 `tags.post_count`

### 🟡 中优先级

| # | 问题 | 证据 |
|---|---|---|
| B6 | 标注时间线三张表缺 `created_at` 索引 → 全 UNION 物化 + 全局排序 | `packages/db/src/repositories/annotations.ts:47-59,141-153`; migrations 0011/0013/0014 均未建 |
| B7 | `VACUUM INTO` 快照同步跑在请求线程 (大库 = 分钟级冻结) | `apps/api/src/routes/commands.ts:376-384` |
| B8 | 批量删帖/删目录逐文件同步 `fs.rmSync` | `apps/api/src/post-files.ts:23-31` |
| B9 | `exportVectorMatrix` 主线程同步写 ~1GB | `packages/db/src/repositories/dedup.ts:32-62` |
| B10 | silva 回填期间每批全扫 posts + vec0 | `backfill.ts:38-63`(全算完后有提前退出, 回填中仍每批全扫) |
| B11 | `ensureCanonicalTagGroups` 每批重复 8 条语句 | `backfill.ts:213-226`; 进程级缓存一次即可 |

### 🟢 低优先级

- **B12** OpenAPI 文档每请求重建: `apps/api/src/index.ts:87-102` → 启动时构建一次缓存
- **B13** ✅ 文搜图 `k=1000` 无条件超采: `packages/db/src/queries/post-search.ts:296`(`buildWhere` 恒带 canonical 条件, 所以 `where.length >= 1` 恒真) → 已删除恒真分支, 无条件超采(代价可忽略)
- **B14** search 结果缺 `canonical_post_id`: `post-search.ts:24,87` 用 `SIMPLE_BASE_COLUMNS`(无此列), list 路径用 `SIMPLE_POST_COLUMNS`(有) → 同一行两个端点返回不一致
- **B15** ✅ `sync.ts` 用字面 NUL 字符当 key 分隔符 → 已改为 `\0` 转义序列, 源文件恢复为可 grep 的普通文本(运行时语义不变)
- **B16** 死导出: `SCORERS`(`scorers.ts:78`)、`SIGLIP2_DIM`(`schema.ts:212`)、`Sampler/PairGraph/Block`(`sampling.ts`)、`QueueItemPost`(`annotations.ts:255`)、`notFailedClause`(仅内部+测试)
- **B17** 重复 zod 形状: `TagGroupPublic` ×3(`schemas.ts:12-14`, `routes/tags.ts:13-15`, `routes/tag-writes.ts:27-29`)、`QueueItemPostPublic`+toQueuePost ×2、校验常量 ×2 → 抽公共模块
- **B18** 手写双胞胎: `ORDER_COLUMNS`(`filter-schema.ts:11-15`) vs `ORDERABLE_COLUMNS`(`filters.ts:38-51`)、`walk()` vs `scanLibrary()` → 漂移风险
- **B19** `/v2/statistics` 全表扫描无缓存(`scores.ts:19-35`); 当前前端未调用, 若启用需缓存

---

## 3. Python Worker (server/src)

### 🔴 高优先级

**W1. `ai/__init__.py:1` 顶层 re-export caption 栈** ✅ 已落地
- 证据: `from .make_captions import OpenAIImageAnnotator`; 每个 handler 都 `from ai.<module> import ...` → 导入父包时连带加载 diffusers + openai + rich
- **实测**: `import ai` = 14.4s; `make_captions` 单独 = 9.5s(diffusers 7.1s + openai 1.0s); `from ai.silva_scorer import ...` = 11.2s vs torch 单独 2.9s
- 影响: **每个**首个 GPU 任务白付 ~9.5s + 数百 MB RSS, 而 caption 可能是从不使用的功能; `handlers.py:384` 本来就已延迟导入, 被这个 re-export 击穿
- 修复: 清空 `ai/__init__.py`(grep 验证无任何地方从包根导入它)

**W2. `tools/colors.py:8` 顶层 `import matplotlib` → 生产环境 basics 必崩** ✅ 已落地
- 证据: matplotlib 只在 dev 依赖组(`server/pyproject.toml:42-49`), scikit-image 并不 require 它; `worker/handlers.py:402` 每批 basics 都导入该模块
- 修复: 删 `show_palette` + `__main__`(grep 无调用者)和这行 import

**W3. 全分辨率解码喂 224–384px 模型**
- 证据: `ai/siglip_embed.py:70` 全尺寸打开后处理器才缩到 384; wdtagger 全尺寸 `pil_ensure_rgb`+`pil_pad_square`; waifu 全尺寸解码后 CLIP 才缩到 224; basics 全尺寸解码出 400px 缩略图
- 影响: 4096px 图对 384px 模型是 114× 面积冗余; 16k 图(项目明确支持, `utils.py:28` 关掉 PIL 炸弹上限)≈ 1740×; **embedding 批 16 张 × 16k² 解码 ≈ 12GB 峰值缓冲**
- 修复: 解码前 `Image.draft("RGB", (768,768))`(JPEG 只解所需 DCT 系数)/ `img.thumbnail((768,768))`(PNG); 外部 tagger/waifu 包在 worker 侧先降采样再传 PIL

**W4. `handle_basics` 32 个并发全分辨率解码占满共享默认线程池**
- 证据: `worker/handlers.py:467-473` `asyncio.gather` 32 个 `asyncio.to_thread(_compute_basics)`; GPU handler 的 `to_thread` 也走同一默认 executor(`handlers.py:69,171,208,247,...`)
- 影响: (a) 32 × ~1GB(16k 图)= OOM 风险; (b) basics 占满 32 线程时 GPU 前向排队 → **GPU 空转**
- 修复: 解码信号量(4–8)或专用小 executor

### 🟡 中优先级

| # | 问题 | 证据 |
|---|---|---|
| W5 | `make_captions` 全分辨率 JPEG 标成 `data:image/png`(MIME 错) + `detail:"low"`(OpenAI 反正缩到 512) → 载荷浪费 50–100× | `ai/make_captions.py:20-23,47,49` |
| W6 | `ai/clip.py:17` 硬编码 `device="cuda"` + fp32(唯一无 CPU 兜底、唯一 fp32 模型); bf16 被外部 waifu_scorer 的 fp32 输入阻塞, 需 autocast 包装或上游补丁 | `clip.py:17,22-26`, `waifu_scorer/predict.py:250-251` |
| W7 | ✅ 路径双胞胎: `tasks_db_path`(worker/main.py)vs `tasksDbPath`(paths.ts) → 已落地: main.py 认 `PICTORIA_TARGET_DIR`/`TASKS_DB_PATH`, 相对路径两侧都锚到仓库根, 启动时打印解析结果 | — |
| W8 | `scorers.py` 的 `ScorerSpec` SQL API(buckets/alias/join_sql/score_col/...)在 Python 侧是死代码(只用到 `.name`, `handlers.py:47-50`), 与 `packages/db/src/scorers.ts` 全量重复且无对拍测试; scorer 名单散在**三处**(contracts/tasks.ts:37, scorers.py:104-114, scorers.ts:78-81) | 建议收窄为名单白名单 + 跨语言对拍 fixture |
| W9 | colorthief 全分辨率 `convert("RGBA")` + `sqrt(w*h*10000)` 采样(16k² ≈ 160 万次纯 Python 循环) | `tools/colorthief.py:53`, `tools/colors.py:19-21` → 128px 工作副本 |

### 🟢 低优先级

- **W10** sha256 整文件读入内存(`handlers.py:415`); rotate 重读刚写出的文件(`handlers.py:356`) → 1MB 分块流式 / 直接哈希内存 buffer
- **W11** `shared.py` 的 RichHandler/basicConfig 在 worker 里是死代码(`main.py:52` 已配置根 logger, 只保留噪音 logger 抑制)
- **W12** 死代码: `TAG_GROUP_COLORS`(`wd_tagging.py:19-24`, 无引用)、`DanbooruClient.get_post`(`danbooru/__init__.py:308-312`)、`show_palette`+`__main__`(`colors.py:40-57`)、`make_captions.py:61-66` 硬编码空 key 的 demo; `sqlite-vec` 运行时依赖只被 `server/scripts/*` 维护工具用 → 移 dev 组
- **W13** 小项: `handlers.py:245` 对已 float32 的数组 `.astype(np.float32)` 无操作拷贝; waifu batch==1 双倍前向(外部包, 仅 ladder 兜底路径); `worker/dedup.py:60-64` Python 循环建 pair 列表; io worker 20ms 轮询对 backfill 无意义(`main.py:106`); `importers.py:148` 内联 `root/.pictoria/gallery-dl.conf` 应走 `pictoria_dir()`

**✅ 值得保留的设计(不要动)**: 模型全部进程级 `@cache`(`siglip_embed.py:30,39`, `clip.py:20,35`, `waifu_scorer.py:8`, `silva_scorer.py:60`, `wd_tagging.py:28`)、任务内每图恰好一次解码+一次前向、pictoria 自有的代码全用 `inference_mode`、codec 双胞胎有跨语言 fixture 对拍(`codec.ts` ↔ `codec.py`)、basics 的 hasSha256/hasArthash/hasColor 跳过标记、OOM ladder(batch→4→1)设计、GPU/交互/IO 三 Worker 隔离。

---

## 4. 前端 (apps/web)

### 🔴 高优先级

**F1. 每页拉 1000 条** ✅ 已落地(200, 见 queries.ts 的权衡注释)
- 证据: `apps/web/src/shared/queries.ts:16` `const limit = 1000`; 后端默认才 100 且不设上限(`apps/api/src/routes/post-list.ts:96`); 筛选条件是 queryKey 的一部分 → **每次筛选变化都重取一页 1000 条**(数百 KB ~ 1MB JSON + parse + Vue 响应式转换), 并让所有下游 O(n) 逻辑 ×10
- 修复: 改成 100–200; `getNextPageParam` 已按页长累加, 无限滚动逻辑无需改动

### 🟡 中优先级

| # | 问题 | 证据 |
|---|---|---|
| F2 | facet 计数查询无 staleTime / 无 enabled → 每次筛选切换 6–8 请求风暴(与 B2 联动) | `composables/useFacetFilter.ts:56-59`; 7 个筛选组件挂在 `FilterRow.vue:14-20`; TagFilter 已有弹层门控可作范本 |
| F3 | detail 层查询无 staleTime → 列表→详情→返回 每次重取 detail/similar/group | `usePostQuery.ts:12-28`, `usePostGroupQuery.ts:11-28`, `useSimilarPostsQuery.ts:11-23` |
| F4 | 全项目无 `placeholderData` → 每次筛选变化闪骨架屏, 本可保留旧数据 | 所有 useQuery 均未设置 |
| F5 | `PVirtualScroll` 用位置做 key → Tags 页每滚一帧重挂载全部可见区; `:137` 的 O(n) slice+reduce 可换成 `accumulatedHeights[currentStartIdx]` | `ui/PVirtualScroll.vue:155,137` |
| F6 | `PTreeList` 每次展开/折叠全树重走(且 `subtreeMatches` 递归 ×2) | `ui/PTreeList.vue:242-268,190-212` |
| F7 | 首屏打包: `culori`(仅颜色排序用, ~30KB)和双语目录(另一语言 5–6KB gzip)都在入口 chunk; `axios` 在 `devDependencies` 却被运行时依赖 | `shared/queries.ts:5`, `locale/index.ts:4-5`, `apps/web/package.json:40` |
| F8 | `useAdjacentImagePreload` 每次进图预载 2 张**全尺寸原图** | `composables/useAdjacentImagePreload.ts:20-25` → 先预载缩略图, 空闲(`requestIdleCallback`)再升原图 |

### 🟢 低优先级

- **F9** `/test` 路由(`main.ts:81`)和 `revealInExplorer` 空函数(`App.vue:184-186,364-368`) → 删或 DEV 门控
- **F10** Tags 视图与 TagSelector 的 tag 目录 staleTime 不一致(默认 vs Infinity) + `Tags.vue:23-25` 全量 `{...d}` 拷贝 → 对齐 + 去拷贝
- **F11** 标签编辑后全量失效整个 tag 目录(`shared/mutations.ts:160-167`) → 批处理或延迟失效
- **F12** overlay 组件(CommandPalette / ShortcutHelp / TagSelectorWindow)静态打进入口 chunk → `defineAsyncComponent`
- **F13** 重复 flatten 逻辑: `queries.ts:112-117` `usePosts` vs `MainSection.vue:48-50` 内联实现
- **F14** 每处 mutation 对全部已加载页 O(n) 打补丁(`queries.ts:123-153`, `mutations.ts:183-202`), 被 F1 放大
- **F15** 冗余: `splitpanes.css` 在 App.vue + Home.vue 各 import 一次; `main.ts:95` 注释掉的全局 staleTime 配置

---

## 5. 仓库卫生与构建

### 🔴 高优先级

**H1. `server/venv` 5.2 GB 陈旧残留**
- 证据: `server/venv` 是 2024 年 `python -m venv` 产物(pyvenv.cfg 指向已不存在的 `E:\pictoria-server\venv`, Python 3.12.1); uv 实际使用 `server/.venv`(4.8 GB, uv 0.5.8 / 3.12.6, 与 `.python-version` 一致)
- 修复: 确认后删除, 回收 ~5.2 GB

**H2. `pictoria.duckdb` 2.38 GB 孤儿文件**
- 证据: `server/illustration/images/.pictoria/pictoria.duckdb`, 全仓库**零代码引用**(grep `duckdb` 无命中)
- 修复: 确认无外部分析工具使用后删除

### 🟡 中优先级

- **H3** `pictoria.sqlite-wal` 201 MB(检查点策略); `tasks.sqlite-wal` 4.5 MB
- **H4** ✅ 唯一被 git 跟踪的垃圾: `scripts/__pycache__/load_env.cpython-312.pyc` → 已 `git rm`
- **H5** `server/src/` 下大量退役模块(Litestar 时代 `db/`、`processors/`、`server/`、`services/dedup|file_management|import_persist|intake|s3|tag_i18n|waifu`)的 `__pycache__` 残留(656 KB 总量) → 删除
- **H6** **无 CI**(无 `.github/`); 唯一的契约守卫 `contract:diff` 是手工脚本 → 建议至少挂一个 worker 跑 `pnpm -r test` + `uv run ruff check` + `contract:diff`
- **H7** ✅ `bash.exe.stackdump` ×2(仓库根 + apps/web/src)已存在且被 ignore → 已删
- **H8** 根 `.gitignore` 缺 `.venv`/`.pytest_cache`/`.ruff_cache`(目前靠目录内部自带的 `.gitignore` 兜底, 属隐式覆盖)

### 🟢 低优先级

- **H9** `server/src/pictoria.egg-info`(已由 `*.egg-info` 覆盖) → 清理
- **H10** `server/data/v/0.15.12`(tag.ja.json / tag.zh-Hans.json / tag_group_gt_100.json)= **wd-tagger 标签目录, 是有效数据, 勿删**
- **H11** docs/openapi.baseline.json = 70 个 operationId, 与当前路由一致, 未漂移 ✅

---

## 6. 快速清单(按性价比)

| 优先级 | 改什么 | 成本 | 收益 |
|---|---|---|---|
| ★★★ | ✅ 前端 `limit: 1000 → 200` (queries.ts:16) | 1 行 | 每次列表请求载荷/解析/布局 ×5–10 |
| ★★★ | ✅ Recently 复合索引 `(canonical_post_id, last_accessed_at)`(迁移 0015) | 1 个迁移 | 254ms → ~5ms |
| ★★★ | ✅ 清空 `ai/__init__.py` | 1 行 | 首个 GPU 任务 -9.5s, diffusers/openai 出内存 |
| ★★★ | ✅ `tools/colors.py` 删 matplotlib import | 1 行 | 修掉生产 basics 崩溃 |
| ★★☆ | worker 解码预降采样 (`Image.draft`/`thumbnail`) | ~5 行 | 每图 CPU 大头, 批量内存 12GB → 0.1GB |
| ★★☆ | facet 查询加 staleTime + 弹层门控 (useFacetFilter.ts) | ~5 行 | 每次筛选 -6~8 请求 |
| ★★☆ | ✅ `listEmbeddingPending` 门控(MAX(id) 指纹, count 对比被孤儿向量否决) | ~10 行 | 停掉永久 30s 双全扫 |
| ★★☆ | `/v2/folders` 服务端缓存 / 复用 scanLibrary | 中 | 去掉 1.6s+全盘遍历 |
| ★☆☆ | 标注时间线 `(created_at, id)` 索引 ×3 | 1 个迁移 | 时间线分页不再全 UNION 排序 |
| ★☆☆ | 删 `server/venv` + 确认删 `pictoria.duckdb` | 5 分钟 | 回收 ~7.6 GB |
| ★☆☆ | OpenAPI 文档启动时缓存 | ~5 行 | 去掉每请求重建 |
| ★☆☆ | 死代码/死导出清理 (B16/W12/F9) | ~30 行 | 收窄维护面 |

---

## 7. 注意事项

1. **审计期间工作区存在并发修改**: 以下 13 个文件被其他进程/会话持续修改(规范 tag 组 `meta` 补充、DB 目录 mkdir 修复、scheduler/sync 调整等)——本报告作者**未触碰**这些文件:
   `apps/api/src/{dedup,index,paths,tag-i18n,tasks}.ts`、`apps/api/src/routes/{commands,post-list,tags}.ts`、`apps/api/src/{scheduler,sync}.ts`、`packages/db/src/{connection,index}.ts`、`packages/db/src/repositories/backfill.ts`
   报告中的行号以审计时点的工作区状态为准; 落地改动前请先 `git status` / `git diff` 确认。
2. **API client 澄清**: `apps/web/src/api/` 的 flat(`client.gen.ts`/`sdk.gen.ts`/`types.gen.ts`) + `client/` + `core/` 三层是 @hey-api/openapi-ts 的正常分层输出,**全部被使用**(main.ts → client.gen → client/ → core/), 不是重复代码, **不要删**。当前 `pnpm genapi` 脚本(`-c @hey-api/client-axios`)与已生成产物属于同一体系, 重新生成前先确认输出布局一致。
3. 本报告作者在审计期间创建的所有探针脚本已删除, git 工作区只含上述并发修改。
4. KNN 文搜图 1–2s 是 sqlite-vec vec0 暴力距离扫描的平台约束, 无索引可加; 若成为瓶颈, 需引入 ANN 索引方案(超出本次审查范围)。

---

## 8. 数据传输专项审查 (2026-08-14)

> 三个并行代理分别审计 前端↔API、API↔worker(cairnq)、图片/磁盘 三条链路,
> 全部数字为对运行中 API(223,063 张图的生产库)的实测。按跨链路合并排序。

### 🔴 高优先级

**T1. PNG 缩略图沿用原图格式 —— 一页 200 张 ≈ 17.5 MB**
- 库里 27.4%(6.1 万张)是 PNG,其缩略图 avg 243.5 KB(JPG 的 7 倍);全库缩略图加权 avg 89.7 KB。
- 修复: `server/src/utils.py::create_thumbnail` 统一编码 WebP(q80),thumbPath 扩展名改 `.webp`(images.ts / handlers.py / 前端 URL 同改);存量靠"thumbPath 不存在即重生成"天然逐步替换。
- 收益: 一页 17.5 MB → ~4-5 MB(−70%),缩略图盘占 ~19 GB → ~5 GB(推测)。

**T2. `/v2/tags` 全量 6.9 MB(gzip 939 KB, 1.16 s),且 Tags.vue 无 staleTime → 每次窗口聚焦整包重拉**
- 5.6 万行,每行内嵌完整 group 对象;TagSelector 的 `staleTime: Infinity` 是 per-observer 的,救不了 Tags.vue 的 0。
- 修复: ① Tags.vue 补 staleTime(立刻);② 中期加服务端搜索/分页;③ group 内嵌改 groupId 引用(动契约)。

**T3. 全局无 staleTime 默认(main.ts:94-95 注释掉了) —— detail/similar/group 在焦点切换与 alt-tab 时反复整页重拉**
- similar 一次 39 KB wire + 453 ms 同步 KNN 占 API 事件循环;画廊 A→B→A 的 detail 立即重取。
- 修复: 恢复全局 `staleTime: 5min`;similar/group 加长或 `refetchOnWindowFocus: false`;正确性由 mutation 后的 invalidate 前缀保证(已具备)。

**T4. cairnq 轮询死时间 —— silva 全库回填 ~1 h 里 GPU 计算只有 ~1 min**
- 每批固定死时间 ≈ 0.35-0.5 s(GPU worker poll 500 ms + client 退避封顶 500 ms);silva 6,968 批 → 40-58 min 纯轮询。
- 修复(合规): ① embedding 任务融合 silva/silva_luna head(向量已在显存,head forward 毫秒级;result 加可选 scores,TS 同事务落库) —— 常态路径 silva 传输与任务全部消失;② backfill `callKeyed` 传 `pollMs` 收紧 + GPU worker poll 500→50-100 ms(空转只是只读探测,零 WAL);③ silva 批量 64→256。
- 收益: 一次全库回填省 1.5-2.5 h 墙钟。

### 🟡 中优先级

- **T5** 图片端点发 ETag 但不认 `If-None-Match`,304 分支缺失(两个代理独立发现;etag 是 stat-based,304 路径零 IO,~10 行) — `images.ts:81-112`
- **T6** 终态任务 24h 保留 × 大 payload = 回填日 tasks.sqlite 峰值 4-5 GB;reuseSucceeded 需要的窗口是分钟级 → purge 缩到 2h(failed 行 purge 前记日志) — `tasks.ts:105-107`
- **T7** 列表页 200 行 152.7 KB(gzip 61.4 KB),其中 arthash 占 gzip 后 ~70%(base64 不可压) → 加 `omit=arthash` 查询参数,前端按 enableArthash 开关带参(additive,契约冲击最小)
- **T8** `/v2/folders` 182 KB,一半是 17 位精度浮点均值 → `ROUND(x,3)`,gzip −45%,一行改动
- **T9** 相邻原图预载无优先级/不可取消(avg 2.46 MB/张,PNG avg 4.45 MB): 只预载导航方向、当前图 onload 后再预载(idle)、大文件只预载缩略图、`fetchPriority='low'` — `useAdjacentImagePreload.ts`(0c055814 把它接进了 lightbox,流量随之翻倍,此项优先级上调)
- **T10** 瀑布流虚拟滚动无 overscan(`rangeExpand ?? 0`),`loading="lazy"` 形同虚设,快速滚动全是 pop-in → `:range-expand="600"` — `MainSection.vue:528-539`

### 🟢 低优先级 / 记录

- **T11** 上传/URL 导入/S3 兜底/gallery-dl 均整读内存(URL 导入无大小上限;gallery-dl 16 并发极端峰值 ~1.5 GB 推测) → 改流式,抄 danbooru 下载器的 `.part` 分块模式(它是模范实现) — 防御性
- **T12** brotli 缺席只对 tags 有意义(−24%);T2 落地后可跳过
- **T13** detail 响应 83% 是 tags(每个带无人消费的时间戳 + 内嵌 group);gzip 后仅 1.9 KB,低优先级
- **T14** dedup 矩阵导出逐行 writeSync(223k 次系统调用);处在 30 min 级流程里,收益 <1%,不做
- **T15** 队列写放大实测无问题(心跳 10s 一拍批量续约,空转轮询全是只读探测,WAL 仅 4.77 MB);tasks.sqlite freelist 99.5% 空页从不回收,在意体积可开 `auto_vacuum=INCREMENTAL`
- **T16** ⚠️ 附带发现: `pictoria.sqlite-wal` 实测 **211 MB**(主库 2.29 GB),远超默认 autocheckpoint ~4 MB 水位 —— 提示长活读游标或 checkpoint 饥饿,值得单独查一次
- cairnq 上游问题(pollWait 每拍 `select *` + 全量 JSON.parse、`client.call` 不透传 maxPollMs、purge 无 per-status retention)已全部在 cairnq 0.7.0/0.8.0 落地并升级完毕(2026-08-15),反馈文档已随之删除
