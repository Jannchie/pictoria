# 重构规划：Litestar → Hono + Drizzle + cairnq worker

> 状态：**全部前置实验已完成（2026-08-10）**，方案可行，无阻塞风险。安全网（`scripts/openapi-contract-diff.mjs` + 自测）已就位。待拍板 §2 的四个决策即可开工 Phase 1
> 前提：前端 `web/` 不改（除路径移动），API 契约逐字保持

## 1. 现状盘点

数字复核于 2026-08-10（括号内为 08-09 初稿值，差异来自这期间的 annotation 相关开发）。

| 维度 | 数字 | 备注 |
|---|---|---|
| 后端 Python | 11,544 行 `server/src` (~10,000) | 其中 db 层 ~2,900 行，processors ~1,100 行，server 控制器 ~1,900 行 |
| HTTP 端点 | **70** (72) | posts 29 / annotations 10 / annotation-queues 7 / commands 11 / tags 6 / images 4 / folders 2 / statistics 1 |
| SQL 迁移 | 15 个文件 (14) | `_schema_versions` 里 15 条已应用 |
| pytest | 25 个文件 | 大部分是 db 层 golden-master 特征测试 |
| 前端 | 24,372 行 TS/Vue (22,318) | `src/api/*.gen.ts` 全自动生成 |
| 生产库 | 223,060 posts / 223,060 向量 / 2.2 GB | 21 张表，4 个触发器 |

**必须留在 Python 的东西**（torch / 生态锁定）：

- `ai/siglip_embed.py` — SigLIP 2 图像 + 文本编码（文本编码在 `/posts/search/text` 的**同步请求路径**上，注意 §4.6）
- `ai/waifu_scorer.py` + `ai/clip.py` — CLIP ViT-L/14 backbone
- `ai/silva_scorer.py` — silva / silva_luna 两个蒸馏打分器
- `wdtagger` — 自动标签
- `services/gallery_dl_import.py` — gallery-dl 是 Python CLI
- `tools/colorthief.py` (355 行自定义中位切分) + `skimage.rgb2lab` — 见决策 D3

**可以移到 TS 的东西**：全部 db 访问、全部 HTTP 控制器、`services/dedup.py`（纯 SQL + 矩阵乘）、`services/file_management.py`、`watch.py`、`services/danbooru_import.py`（纯 HTTP+JSON）。

---

## 2. 需要先拍板的四个决策

### D1 · 谁写数据库？（最关键）—— **已定：方案 A，无例外（2026-08-10）**

**方案 A（已选）：worker 只算不写。** cairnq payload 传 `post_id` + 绝对路径，handler 返回结果 JSON，TS 侧统一落库。

- ✅ schema 只有一个 owner（drizzle），Python 侧可以整层删掉 `db/`（~2,900 行）
- ✅ 没有两个进程抢 SQLite 写锁
- ✅ **一条原则贯穿所有 worker，没有"除了 embedding 以外"这种要记住的例外**

~~**方案 A′：A + embedding 例外**~~ —— **否决**。它唯一的理由是"向量 JSON 化太大"，而这个理由建立在一个**错误的数字**上：初稿写"batch 256 就是 3MB"，但代码里 `SIGLIP_EMBED_BATCH_SIZE = 16`（`processors/embedding.py:23`，so400m 在 12GB 显存下 bf16 的实际批量），小 16 倍。实测：

| batch | payload | cairnq 往返 p50 | 折合每条 | 对照：直接写 vec0 |
|---|---|---|---|---|
| **16（真实批量）** | 0.14 MB | **29 ms** | 1.8 ms | 16.7 ms |
| 64 | 0.55 MB | 53 ms | 0.8 ms | 5.1 ms |
| 256（初稿假设） | 2.19 MB | 100 ms | 0.4 ms | 13.6 ms |

真实批量下回传总共 29 ms，其中写库本身就占 16.7 ms —— **纯队列 + JSON 开销约 12 ms**。而这一批的 GPU 编码是秒级（对比：basics 一批 32 张约 10 s）。**开销占比 <3%，用一个永久的架构例外去换它不划算。**

**方案 B：worker 继续直连 `pictoria.sqlite` 写各自的表。** 迁移量最小，但等于永久保留两套 schema 真理和两个写者——这正是这次重构想消灭的东西。不推荐。

> **推论**：既然 worker 不写库，payload 里带上绝对路径后它也不需要**读**库（现在 `_process_siglip_embedding_batch` 要 `posts.get_many()` 拿路径）。于是 **Python 侧可以完全不碰 `pictoria.sqlite`** —— `db/` 整层删除，不留残根。这是 A 相对 A′ 的额外收益：A′ 里 Python 仍要保留一个能写 vec0 的连接。

> ⚠️ **实操坑（TS 侧写 vec0）**：`better-sqlite3` 传 JS `number` 给 vec0 的 rowid/主键会被拒（`Only integers are allowed for primary key values`），因为它按 REAL 绑定。**必须传 `BigInt`**（`ins.run(BigInt(id), buf)`），或者干脆不指定 rowid。

### D2 · 谁负责调度？

现在：API 进程内 `_spawn_backfill_poller` + watchdog + `run_all_backfill`（6 个 worker 各自开连接轮询 pending）。

迁移后：

- **pending 扫描留在 TS**（`apps/api` 或独立的 `apps/scheduler`）：文件变更（chokidar 替代 watchdog）或 10 分钟轮询触发 → 每个 worker 的 pending SQL 查出 id → `tasks.submit(worker, {postId}, { key: \`${worker}:${postId}\`, conflict: 'reuse', queue: 'gpu' })`
- **幂等天然解决**：cairnq 的 `key` + `conflict: reuse` 正好替代现在"扫出来的 id 可能被重复入队"的隐忧，也替代 `backfill_lock`
- **GPU 背压**：`queue: 'gpu'` + worker 端 `concurrency: 1` 替代 `processors/gpu_pressure.py`（OOM 时的降 batch 逻辑保留在 handler 内）
- **批处理直接对应**：`@worker.task("tagger", batch=8)` 的 `list[TaskContext]` 语义和现有 `_process_tagger_batch(ids)` 一一对应，`item.fail(..., retryable=False)` 正好替代 `post_process_failures` 黑名单表 —— **这张表可以删掉，失败状态归 cairnq 管**

### D3 · basics / 缩略图移不移到 TS？

`basics` worker 一次 PIL decode 同时算 sha256 + arthash + 尺寸 + 缩略图 + 调色板 + dominant Lab。

- 缩略图 / sha256 / 尺寸 → sharp 完全可以，且能省掉一次 Python 往返
- arthash → npm `arthash@0.2.0` 已经在 web 依赖里（同作者），可用
- **调色板 → 风险点**：`tools/colorthief.py` 是自定义中位切分实现，移植后结果必然和存量 21 万行的 `dominant_color` 不一致，颜色筛选会出现新旧数据割裂

**已定：basics 整体留 Python worker，不拆。** 两个理由，第二个更根本：

1. `tools/colorthief.py` 是 431 行自定义中位切分，移植后结果必然和存量 22.3 万行的 `dominant_color` 不一致，颜色筛选会新旧数据割裂
2. **它会破坏 D1 定下的那条统一原则** —— "所有计算在 Python worker，所有落库在 TS"。basics 拆一半到 TS，就变成"计算分布在两种语言里，按 worker 逐个记忆"，正是这次重构想消灭的那类特例。而计算**全部**移到 TS 是不可能的（torch / wdtagger / gallery-dl 生态锁定），所以"计算全在 Python"是唯一可达的统一形态

缩略图的归属另说：它不是 post 表的一列，而是磁盘产物，谁生成都不影响 schema 真理。等 Phase 6 结束后可以单独评估要不要用 sharp 接管（前置条件已确认满足：库里无 heic/heif）。

> 前置检查已做（2026-08-10）：**库里没有任何 `.heic/.heif` 存量**。实际分布是 jpg 160,926 / png 61,202 / webp 604 / gif 213 / avif 110 / jpeg 5 —— 全部在 sharp prebuilt 的支持范围内（avif 也支持）。`server/images.py` 里那两行 `mimetypes.add_type` 是防御性注册，没有真实数据依赖它。**sharp 的 HEIC 授权问题不构成阻碍。**

### D4 · 迁移文件怎么处理？ —— **已实测，结论比初稿更硬（2026-08-10）**

- **不重跑历史**。现有 15 个迁移已经在生产库跑完，`_schema_versions` 保留原样
- ~~drizzle schema 走 `drizzle-kit pull` 从现有库 introspect 作为起点~~ → **放弃 pull，schema.ts 全部手写**。实测 pull 在这个库上三重失败（见 §4.8），且失败方式以静默居多
- 新迁移用 `drizzle-kit generate` 产 SQL —— ✅ **实测通过**：不连库，手写 schema 里的生成列表达式原样正确输出（`GENERATED ALWAYS AS (CASE WHEN height = 0 THEN NULL ELSE (width * 1.0) / height END) VIRTUAL`）
- 执行迁移用 `drizzle-orm/better-sqlite3/migrator` 的 `migrate(db, ...)`，传自己那个**已经 loadExtension 的连接**
- ~~只有 `drizzle-kit push` / `studio` 需要活连接~~ → **`pull` 也在此列**。约定：**任何需要活连接的 drizzle-kit 子命令一律不用**（pull / push / studio），只用 `generate`
- ✅ **运行时侧已验证**：`drizzle(conn)` 包裹一个自己 `vec.load()` 过的 better-sqlite3 连接，普通表读写正常，`sql\`... embedding match ${buf} and k = 10\`` 走 vec0 KNN 也正常（1240 ms，与裸 better-sqlite3 同量级）。**drizzle 不阻碍向量检索。**

---

## 3. 目录结构

```
pictoria/
├── pnpm-workspace.yaml      # packages: apps/*, packages/*
├── package.json             # 只放 scripts + devDeps(eslint/typescript)
├── justfile                 # 更新 dev / genapi
├── apps/
│   ├── web/                 # 原 web/，内容零改动
│   ├── api/                 # 新：Hono + @hono/node-server
│   └── worker/              # 原 server/ 瘦身：ai/ + services/ + cairnq handlers（uv 管理，不进 pnpm workspace）
└── packages/
    ├── db/                  # drizzle schema + 连接(sqlite-vec/WAL/FK) + repositories + migrations/
    └── contracts/           # zod schema + cairnq TaskDef 定义（TS 侧），与 Python 侧 TaskDef 对照
```

- Python 侧照旧 `uv`，`apps/worker/pyproject.toml`。pnpm workspace 不管它，`justfile` 负责把两边串起来
- `web/pnpm-workspace.yaml`（现有的 `shellEmulator: true` / `onlyBuiltDependencies`）上提到根
- ⚠️ **`better-sqlite3` 千万别加进 `onlyBuiltDependencies`** —— 初稿这条建议是反的，实测已证伪：13.x 走 prebuildify（`prebuilds/win32-x64.node` + 运行时选择），**不批准脚本反而开箱即用**；一旦批准，install 脚本会尝试 `node-gyp rebuild`，在没有 MSVC 工具链的机器上必然失败并中断整个 `pnpm install`。sharp 同理（靠 `@img/sharp-win32-x64` optional dep）。pnpm 那句 "Ignored build scripts" 警告在这两个包上**是正常状态，不要去消除它**

---

## 4. 技术风险清单（按严重度）

### 4.1 🟢 sqlite-vec 在 Node 侧能不能用 —— **已验证通过（2026-08-10）**

原本是整个计划的单点风险，四项验证全过，无需改方案。实测环境：Windows 11 / Node 22.15.1 / pnpm 10.11.1 / `better-sqlite3@13.0.3` + `sqlite-vec@0.1.9`，只读打开生产库（223,060 行向量）。

| 验证项 | 结果 |
|---|---|
| Windows 上 `loadExtension` | ✅ SQLite 3.53.4 + vec `v0.1.9`；better-sqlite3 13.x 自带 `win32-x64` prebuild，无需 node-gyp 编译 |
| `MATCH ... k = N` KNN | ✅ 热态 k=10 → **952 ms**，k=100 → **938 ms**；Python 侧同查询 990 / 933 ms —— **两侧延迟持平，返回的 post_id 与 distance 逐位一致** |
| `vec_distance_L2(dominant_color, ?)` 3 维扫描 | ✅ 20 行 / 195–246 ms |
| 向量二进制格式 | ✅ blob 4608 B = 1152×4；`Buffer.from(new Float32Array(f32).buffer)` 与原 blob **逐字节相同**，Python 侧 `serialize_float32` 回环同样相同 |

两个附带结论：

- **`onlyBuiltDependencies` 是真坑**：pnpm 10 默认拒跑 `better-sqlite3` 的 install 脚本，装完 `node_modules/better-sqlite3/build/` 不存在。根 `package.json` 必须显式列它（§3 已记）。
- **KNN 冷启动约 8 s**：首次查询要把向量数据从 2.2 GB 文件里读进 page cache，之后稳定在 ~950 ms。这不是 Node 的问题（Python 侧同样），但意味着 **API 进程重启后的第一次相似度搜索会明显卡一下** —— 现状已经如此，迁移不会变好也不会变坏；真要治得另开话题（预热查询 / `mmap_size`）。

> spike 脚本未进主干（一次性验证）。要复现：scratchpad 里 `vec-spike/spike.cjs`。

### 4.2 🟢 operationId 必须逐字保持 —— **安全网已就位（2026-08-10）**

前端 24k 行代码调的是 `v2SearchPosts` / `v2GetPostsCount` 这些名字，由 Litestar 的 `default_operation_id_creator` 从 `路径段[0] + handler 名` 拼出。Hono 侧（`@hono/zod-openapi` 的 `operationId`）必须一个不差。

**已落地**：

- `docs/openapi.baseline.json` —— 从运行中的 Litestar dump，**70 个操作 / 66 条路径 / 61 个 schema，全部有 operationId**
- `scripts/openapi-contract-diff.mjs` —— 零依赖 Node 脚本，比对 `(method, path) → operationId` + 参数 + 请求体 + 各状态码响应的 **结构指纹**（`$ref` 递归展开、循环引用有标记；`description`/`title`/`example` 这类文字差异忽略，因为两个框架措辞不可能一致）。差异非空退出码 1

```bash
node scripts/openapi-contract-diff.mjs docs/openapi.baseline.json http://127.0.0.1:4777/schema/openapi.json
```

自测过四类破坏都能抓到：改 operationId、删端点、字段改名、`required` 变化；且验证了纯文字差异不会误报。改一个共享 schema 会正确波及全部 12 个引用它的端点。

#### ⚠️ 命名风格：初稿说反了，而且真相更麻烦

~~字段是 snake_case，zod schema 必须原样输出 snake_case~~ —— **错。实测是 camelCase 与 snake_case 混合，取决于每个模型的基类**：

| 模型定义方式 | 输出 | schema 数 |
|---|---|---|
| 继承 `scheme.py` 的 `DTOBaseModel`（`alias_generator=to_camel`）+ `PydanticPlugin(prefer_alias=True)` | **camelCase** | 17 |
| 裸 `BaseModel` / `@dataclass` / msgspec `Struct` | **snake_case 原样** | 16 |
| 字段都是单词，看不出 | — | 28 |

踩雷点：`PostDetailPublic` 是 `filePath`/`createdAt`（camel），而**被最多端点复用的请求体 `PostFilter` / `PostFilterWithOrder` 是 `order_by`/`only_canonical`（snake）**。同一个请求里两种风格并存。

**好消息：0 个 schema 内部混用**，边界干净地落在 schema 粒度上。

**结论：zod schema 不许套任何全局 casing 策略**（不要 `z.object()` 上挂统一转换，不要 drizzle-zod 的 casing 选项）。逐个 schema 照抄 baseline，由 diff 脚本兜底。这个混合边界是历史偶然，不是设计——但前端已经依赖它，这次重构**不顺手统一它**（统一 = 改前端 = 违背"前端不改"的前提；要统一也是迁移完成之后单独做）。

### 4.3 🟡 cairnq 用独立的 SQLite 文件

cairnq 是 SQLite-first，但**别和 `pictoria.sqlite` 共用一个文件** —— "one SQLite writer at a time"，任务表的高频心跳/lease 续约会和图库的正常写抢锁。用 `.pictoria/tasks.sqlite`。

另外 cairnq 明确说"不自动删任何东西"，要加定期 `purge(older_than_ms=7d)`。

### 4.4 🟡 依赖 0.x 自研库

cairnq **v0.6.0**（初稿时 0.5.0，一天内已跳一个 minor —— 这正是要封装的理由）。npm 与 PyPI 两侧都在，双语言前提成立。TS 侧的 `defineTask` 定义集中放 `packages/contracts`，Python 侧 `TaskDef` 一一对应，中间加一层薄封装，避免 cairnq API 变动时要改 20 处。

### 4.5 🟡 长任务的状态从内存搬到队列

`import-from-url` 现在把状态挂在 `app.state.url_import_status`（重启即丢），`sync-metadata` / `group-duplicates` 用 asyncio.Lock 去重。全部换成 cairnq：`submit` + `getByKey` 查状态 + `ctx.progress()` 报进度。**这是这次重构顺手拿到的实打实的收益**，不只是换语言。

### 4.6 🟢 文本搜索的同步依赖 —— **已实测，选 (a)（2026-08-10）**

`/posts/search/text` 要先跑 SigLIP 文本编码器（Python）再做 KNN（TS）。实测了 TS `call()` → Python worker → 结果回传的**纯队列开销**（handler 直接返回 1152 维假向量，不含真实编码时间）：

| 配置 | p50 | p95 | 结论 |
|---|---|---|---|
| **默认**（worker `poll_interval_ms=500` / client `queuePollIntervalMs=250`） | **626 ms** | 644 ms | ❌ 交互式搜索不可接受 |
| **调优**（worker 20 ms / client `pollMs: 10`） | **26 ms** | 37 ms | ✅ 可接受 |
| 调优（worker 20 ms / client `pollMs: 5`） | 25 ms | 40 ms | 再降 poll 已无收益 |

**结论：选 (a)，不需要退到 (b) 的小 HTTP endpoint。** 26 ms 队列开销相对 SigLIP 文本塔本身的推理时间可以忽略。1152 维 float 数组（JSON 化 ~13 KB）跨语言往返正确无损。

⚠️ **但默认参数是陷阱** —— 直接用默认值会得到 626 ms，慢 24 倍。文本编码这条同步路径必须显式配 `poll_interval_ms` / `pollMs`；后台 backfill 那些任务反而应该保持默认的 500 ms，避免无谓空转查询。**两类任务用两个 Worker 实例、两套 poll 配置。**

### 4.7 🟢 其余逐项

| 项 | 应对 |
|---|---|
| 生成列 `full_path` / `aspect_ratio` | drizzle 有 `.generatedAlwaysAs(sql\`...\`, { mode: 'virtual' })` |
| 触发器（库里共 **4 个**：`trg_post_has_tag_count_ai/_ad` 维护 `tags.post_count`，`trg_posts_canonical_grouped/_ungrouped` 维护分组） | drizzle schema 全都表达不了，放手写 migration |
| 图片响应 + `immutable` 缓存头 + Range | `@hono/node-server` 的 `serveStatic`，或手写 `createReadStream`；`_resolve_inside` 的路径逃逸校验要原样移植（安全相关） |
| multipart 上传 | Hono 内置 `c.req.parseBody` |
| gzip 压缩 | `hono/compress` |
| 25 个 pytest | db 层特征测试随 db 层翻译到 vitest（**先让新 TS 实现和旧 Python 实现对着同一个测试库跑，比对输出**）；`ai/` 和 import 相关的留 pytest |
| Windows 原生模块 | better-sqlite3 / sharp 都有 prebuilt，但注意 Node 版本与 ABI |

### 4.8 🟡 `drizzle-kit pull` 在这个库上不可用 —— **已实测（2026-08-10）**

对生产库的 schema-only 副本跑 pull，**三重失败，且以静默居多**：

| 触发物 | 表现 |
|---|---|
| `post_vectors_siglip2`（vec0 虚表） | **整库静默失败**：`0 tables fetched`，无产物、无报错。同库里的普通表也一并丢失 —— drizzle-kit 自己开连接，没有任何注入 `loadExtension` 的口子（`extensionsFilters` 只认 `'postgis'`） |
| `annotation_timeline`（view） | `Could not process view`，非零退出，无产物 |
| `aspect_ratio`（生成列） | **最阴险**：drop 掉前两者后 pull 能跑完，但表达式在**第一个右括号处被截断** —— 真实定义 `(CASE WHEN height = 0 THEN NULL ELSE (width * 1.0) / height END)` 产出为 `CASE WHEN height = 0 THEN NULL ELSE (width * 1.0`，括号不闭合，是语法错误的 SQL 却不报错 |
| 4 个触发器 | 完全不出现在产物里（预期内） |

**决定：放弃 pull，`packages/db/schema.ts` 全部手写。** 15 张用户表 / 91 列，手写工作量可控；反正 pull 产物也要逐列校对，而校对一份"看起来对、实际截断"的产物比手写更容易漏。

**向量列不需要第三方包。** 社区确实有 [`@aeriondyseti/drizzle-sqlite-vec`](https://www.npmjs.com/package/@aeriondyseti/drizzle-sqlite-vec)，但只有 0.1.0 一个版本、2025-11 后未更新、周下载 7、无仓库链接 —— 不引入。官方 `customType` 十行搞定，已实测双向可用：

```ts
const f32blob = customType<{ data: Float32Array; driverData: Buffer }>({
  dataType: () => 'blob',
  fromDriver: (v) => new Float32Array(v.buffer, v.byteOffset, v.length / 4),
  toDriver: (v) => Buffer.from(new Float32Array(v).buffer),  // ≡ Python serialize_float32
})
```

读出来直接是 `Float32Array(1152)`，`mapToDriverValue()` 出来的 Buffer 喂给 `embedding match ? and k = N` KNN 正常（1310 ms）。vec0 虚表本身仍走手写 migration。

### 4.9 🟢 Hono 能否逐字复刻 Litestar 契约 —— **已证明（2026-08-10）**

用 `@hono/zod-openapi@1.5.2` + `zod@4.4.3` 真的写了 3 个代表性端点（`GET /v2/statistics` 数组响应、`POST /v2/posts/count` snake_case 请求体、`GET /v2/posts/{post_id}` 路径参数 + 27 字段 4 层嵌套的 camelCase 响应），三重验收：

| 验收项 | 结果 |
|---|---|
| `openapi-contract-diff.mjs` | **结构差异 0 / operationId 改名 0**（另 67 个未实现属预期） |
| hey-api 生成的 `types.gen.ts` | **10/10 类型逐字相同**（含 `PostDetailPublic` 全量与 4 个嵌套组件） |
| hey-api 生成的 `sdk.gen.ts` | **3/3 函数体逐字相同** |

唯一残留差异是 **JSDoc 注释**（`description` 我没照抄）—— 不影响类型检查与运行时，但会让前端悬停提示变空，建议照抄。

**工作量实测**：3 个端点（含最复杂的那个响应）≈ 130 行 zod。按此外推，70 个端点的 schema 定义在 1,500–2,500 行量级。

#### Phase 4 实操清单（每条都是踩出来的）

1. **`operationId` 必须手写**，`createRoute` 不会自动生成 Litestar 那套 `路径段 + handler 名` 的拼法
2. **400 响应做成共享常量**：Litestar 给 **63/70** 个端点自动挂了同一个 `ValidationException`（`status_code`/`detail`/`extra`），Hono 无等价机制，得逐个 `...RESP_400` 挂上，漏一个 diff 就报
3. **`description` 照抄**，否则前端 JSDoc 全空
4. **字段声明顺序照抄** —— zod 里 `{color, order}` 和 `{order, color}` 产出的 TS 文本不同（类型等价但 diff 会红）
5. **别在已注册组件上 `.nullable()`** —— `WaifuScorePublic.nullable()` 会污染**组件本身**，生成 `export type WaifuScorePublic = {...} | null`。要在引用处可空就写 `z.union([WaifuScorePublic, z.null()])`
6. **路径参数**：运行时需要 `z.coerce.number()`（路径段永远是 string），但 coerce 会让 schema 变成 `type:["integer","null"]` 且 `required:false` —— 用 `.openapi({ param: { required: true }, type: 'integer' })` 强制覆盖
7. **casing 逐 schema 照抄**，见 §4.2

---

## 5. 分阶段路线（strangler，全程可回滚）

### ~~Phase 0 · Spike（半天）~~ ✅ 已完成 2026-08-10

§4.1 四项 + §D3 的 HEIC 前置检查全部通过，实际耗时远低于半天。**结论：方案可行，形状不用改，下一步是 Phase 1。**

### Phase 1 · Monorepo 骨架（1 天）

`web/` → `apps/web/`，建根 workspace，`pnpm i && pnpm build && pnpm test && pnpm lint` 全绿。**一行业务代码不改**，单独一个 commit。

### Phase 2 · `packages/db`（3–5 天）

drizzle schema（pull 后人工校对）+ 连接封装 + `PostRepo`/`PostQueryService` 等价物。
验收标准：把 `server/tests/test_post_repo_characterization.py` 逐条翻成 vitest，**指向同一个 fixture 库，两边输出逐字节相同**。

### Phase 3 · Hono 空壳 + 反向代理（1 天）⭐

Hono 占用 4777，Litestar 挪到 4779，Hono 未实现的路由全部透传给 Litestar。前端零感知。

**这是整个计划的枢纽**：从这一刻起，72 个端点可以一个一个搬，随时能停在中间状态，任何一个搬砸了就把 proxy 加回来。

### Phase 4 · 端点逐个搬（2–3 周）

顺序（由简到繁、由读到写）：
`statistics(1)` → `folders(2)` → `tags(6)` → `images(4)` → `posts` 读(8) → `posts` 写(17) → `annotation-queues(8)` → `annotations(10)` → `commands(11，最后，因为要等 cairnq)`

每搬完一组：删对应 proxy 规则 → 跑 §4.2 的 schema diff → 跑 web vitest。

### Phase 5 · 接入 cairnq（3–5 天）

先只接 **silva**（最简单：输入是已有向量，输出一个标量，不碰 GPU、不碰文件），把 submit → lease → progress → 结果落库整条链路跑通并观察一周。

### Phase 6 · 剩余 worker（1–2 周）

`silva_luna` → `waifu` → `tagger` → `embedding`（D1 的例外，直接写向量表）→ `basics`（最后，因为它顺带产缩略图）。
同时把 `run_all_backfill` / `gpu_pressure` / `post_process_failures` 的职责交给 cairnq。

### Phase 7 · 清理（2–3 天）

删 Litestar、删 Python `db/` 层、删 proxy；`apps/worker` 只剩 `ai/` + `services/(danbooru, gallery_dl)` + cairnq handlers；更新 `justfile` / `CLAUDE.md` / `README`。

**总量粗估**：TS 侧新增 6,000–8,000 行；日历时间 5–7 周（按业余时间会更长）。

---

## 6. 我的建议

1. ~~今天就做 Phase 0 的 spike~~ ✅ 已做完，通过。**现在最大的技术未知已经消除，剩下的都是工作量而非风险。**
2. **下一个动作是 §4.2 的 schema diff 脚本，而不是 Phase 1 的目录搬迁。** 理由：它是"前端不变"这个承诺的唯一保证，且现在就能写、能立刻对着 Litestar 跑出 baseline；目录搬迁做得再早也不产生任何验证能力
3. **Phase 3 的反向代理不要省**。70 个端点一次性切换，出问题时没有二分定位的手段
4. ~~D1 选 A′~~ → **D1 选 A、D3 选 basics 留 Python**，两者服从同一条原则：

> **所有计算在 Python worker，所有数据库写入在 TS，没有例外。**

   A′ 那个"embedding 除外"是基于错误批量假设的伪优化（见 §D1 实测）。守住这条原则的回报是：`pictoria.sqlite` 只有一个写者、schema 只有一个 owner、Python 侧 `db/` 层（~2,900 行）整层消失、以后新增 worker 时不需要查"这个该谁写库"。

## 7. 这份文档的存续

初稿写于 2026-08-09，**一直是未跟踪文件，随后从工作区丢失**，2026-08-10 从会话记录中恢复。**这次请把它提交进 git** —— 一份没进版本库的重构计划，其寿命取决于有没有人手滑。
