# 重构规划：Litestar → Hono + Drizzle + cairnq worker

> 状态：**已全部完成**（2026-08-13 Litestar 与 Python db 层退役，2026-08-14 分支并入 main）。本文档保留作为决策记录 —— 代码内多处注释引用这里的 §D1/§D2/§4.8 论证与 Phase 6/7 的对拍记录，进度类内容不再更新。
>
> 贯穿全局的一条原则（D1 + D3 的共同结论）：**所有计算在 Python worker，所有数据库写入在 TS，没有例外。**
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

- **pnpm 那句 "Ignored build scripts: better-sqlite3" 是正常的，不要去消除它** —— 13.x 走 prebuildify，不跑 install 脚本照样能用；批准了反而触发注定失败的 node-gyp（详见 §3）。
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

**执行中踩到的三个坑**（2026-08-10）：

1. **`git mv web apps/web` 会 `Permission denied`** —— 前端 dev server 在跑，Windows 下锁住了目录。先停 4778 上的进程（后端 4777 不受影响）。
2. **lockfile 的 importer 路径必须手工改写**：`pnpm-lock.yaml` 从 `web/` 移到根之后，里面的 importer 键还是 `.`，而包现在住在 `apps/web`。pnpm 判定 lockfile 失效 → **全量重新解析 546 个依赖**。把 `importers:` 下的 `  .:` 改成 `  apps/web:` 即可，改完 `--frozen-lockfile` 直接通过、24.8 秒装完（不改的话 15 分钟都跑不完，registry 单请求要 20–26 秒）。
3. **全量重解析会撞上 `trustPolicy: no-downgrade`**：`ERR_PNPM_TRUST_DOWNGRADE  High-risk trust downgrade for "semver@6.3.1"`（经由 `@vitejs/plugin-vue-jsx` → `@babel/core`）。这是既有安全策略在正常工作，**不要为了装上去而删掉它** —— 修好第 2 点，lockfile 有效就不会重新解析，也就不会触发。

### Phase 2 · `packages/db`（3–5 天）

drizzle schema（pull 后人工校对）+ 连接封装 + `PostRepo`/`PostQueryService` 等价物。
验收标准：把 `server/tests/test_post_repo_characterization.py` 逐条翻成 vitest，**指向同一个 fixture 库，两边输出逐字节相同**。

### ~~Phase 3 · Hono 空壳 + 反向代理（1 天）⭐~~ ✅ 已完成 2026-08-10

Hono 占用 4777，Litestar 挪到 4779（`PICTORIA_PORT` 环境变量，缺省仍是 4777 —— 单独跑它行为不变），Hono 未实现的路由全部透传。前端零感知。

**这是整个计划的枢纽**：从这一刻起，70 个端点可以一个一个搬，随时能停在中间状态，任何一个搬砸了就把 proxy 加回来。

**实测验收**（全部对着直连 4779 做对照）：

| 项 | 结果 |
|---|---|
| 契约 diff | ✅ **70 个操作全绿**，穿过代理后 operationId 与结构逐项相同 |
| POST + JSON 体 | ✅ `/v2/posts/count` 两侧同为 `{"count":189334}` |
| 真实图片二进制 | ✅ 65,635 B **逐字节相同**，`image/jpeg` |
| gzip | ✅ 两侧都带 `content-encoding: gzip` + `Vary`，解压后 19,401 B 逐字节相同 |
| 图片不被误压 | ✅ 图片响应无 `content-encoding` |
| 状态码 | ✅ 404 / 404 / 200 三例两侧一致 |
| 写路径 | ✅ `PUT bulk/rating` 经代理 rating 1→4 生效（已还原） |
| 上游不可达 | ✅ 返回 502 + `{status_code, detail, extra}`，不是崩溃 |

**两个实现要点**：

1. **undici 会自动解压 gzip 但留着 `content-encoding` 头** —— 照抄响应头会让浏览器对已解压的数据再解一次，直接乱码。做法是请求侧摘掉 `accept-encoding` 让上游返回 identity，响应侧再把 `content-encoding`/`content-length` 从透传名单里剔除兜底，压缩由 Hono 的 `compress()` 在出口补回来（它按 content-type 白名单过滤，不碰 JPEG/PNG，也会跳过 206）。
2. **响应体直接交出上游的 ReadableStream，不缓冲** —— 原图动辄几十 MB，缓冲会让内存随并发线性上涨。请求体同理，流式转发时 undici 强制要求 `duplex: 'half'`。

### Phase 4 · 端点逐个搬（2–3 周）—— 进行中

顺序（由简到繁、由读到写）：
`statistics(1)` ✅ → `folders(2)` ✅读 → `tags(6)` ✅读 → ~~`images(4)`~~ 见下 → `posts` 读 → `posts` 写 → `annotation-queues(7)` → `annotations(10)` → `commands(11，最后，因为要等 cairnq)`

每搬完一组：删对应 proxy 规则 → 跑 §4.2 的 schema diff → 跑 web vitest。

**已搬 48/70**（数字来自 `pnpm migration:status` 的运行时探测，不是数源码）：

| 组 | 端点 |
|---|---|
| statistics | `GET /v2/statistics` |
| folders | `GET /v2/folders` |
| tags | 读 2 个 + 写 4 个（create / update / delete / batch delete） |
| posts 计数 | 7 个（count / count/{rating,score,extension,waifu,silva,silva-luna}）。**`count/tags` 不在其中** |
| posts 读 | `GET /v2/posts`、`GET /v2/posts/{id}`、`{id}/group`、`POST /v2/posts/search` |
| posts 写 | `score`、`rating`、`caption`、`source`、`touch`、`bulk/score`、`bulk/rating`、`ungroup`、`make-canonical`、tag 增删 2 个 |
| annotations | 10 个（提交 3 + undo + edit + timeline + count + post 历史 + `sample-absolute` / `sample-pairwise`） |
| annotation-queues | 7 个（建队列 2 + 列表 + 取下一批 2 + `generate-absolute` / `generate-pairwise`） |

**剩下 22 个**：

| 阻塞 | 端点 | 何时能解 |
|---|---|---|
| Phase 5/6 的 cairnq worker | `commands` 11 个 | Phase 5 接通 cairnq 之后 |
| ML / 向量链路 | `posts/search/text`、`posts/{id}/similar` | 同上（§4.6 的文本编码走 cairnq） |
| 漏网的一个 | `POST /v2/posts/count/tags` | 无阻塞 —— 只是一直没搬，直到运行时探测把它抓出来 |
| 文件系统 | `posts/upload`、`posts/{id}/rotate`、`posts/delete`、`DELETE /v2/folders/{path}`、`images` 4 个 | 缩略图归属定了之后一起（§D3） |

> **进度数字只信 `pnpm migration:status`。** 它把 70 个端点逐个问一遍，凭代理加的
> `x-pictoria-upstream` 响应头判断归属 —— 那个头只在请求真被转发时出现。数源码里的
> `createRoute` 会漏（有几组路由是循环生成的），我就漏了 `count/tags` 并把 48 报成了 49。
> 探测请求全部无副作用：只读端点直接问，写端点用不存在的 id 或空列表，三个真会干活的
> command 不发请求、靠源码判断。

**七个对拍套件**（`pnpm parity:all` 一次跑全部 + 契约 diff）：

| 脚本 | 覆盖 | 关键设计 |
|---|---|---|
| `endpoint-parity.mjs` | 106 读用例 | 比**解析后**的 JSON 而非字节 —— Python 把 float `3.0` 序列化成 `3.0`，JS 只能产出 `3`，parse 后完全相同。键**顺序**仍然比（hey-api 按声明顺序生成 TS） |
| `write-parity.mjs` | 21 项 | 写不能重放：记原值 → 经 Hono 写 → 读回 → 还原 → 经 Litestar 写 → 读回 → 还原，最后断言数据回到起点 |
| `annotations-parity.mjs` | 21 项 | 提交完整周期后 undo 掉，断言探针会话不留痕 |
| `tag-writes-parity.mjs` | 13 项 | 探针 tag 走完整生命周期。两侧**必须用同一个名字** —— 名字不同会让 post 详情里的 tags 数组排序位置不同，那是测试自身的假差异 |
| `timeline-parity.mjs` | 11 项 | 含真实游标翻页与三种非法游标 |
| `queues-parity.mjs` | 8 项 | 队列 id 是自增的，两轮必然不同 —— 比对时抹掉。清理直接开库（没有删队列的端点） |
| `sampling-parity.mjs` | 83 项 | 采样是**随机**的，同一端点连调两次结果就不同 —— 所以比的是两侧都必须成立的**不变量**（资格、不相交、前缀连通、不重问已判对），直接开库验证而不是信端点自报；错误消息仍逐字比 |

**`images` 整组暂不搬**，理由是一致性而非难度：

- 四个端点里两个是缩略图，缺失时要**现场生成**（PIL）。按 §D3 的决定，图像处理留在 Python
- 只搬 `original` 会让"服务图片"这件事被两种语言各做一半 —— 正是这次重构想消灭的那类割裂
- 附带两个细节：契约里这些端点的 `content` 用**空串**作 media-type 键（Litestar `File` 响应特有），响应还带 Litestar 计算的 `etag`；照抄要额外功夫，收益却只是省掉一跳本机回环

代理本来就流式转发不缓冲，图片走代理的额外成本只有一次本地 TCP。等"缩略图要不要交给 sharp"单独有结论后，四个端点一起搬。

#### Phase 4 的实操坑（每条都真的踩了）

1. **合并 OpenAPI 文档必须按方法，不能按路径** —— 同一路径下 GET 已搬、POST 还在上游是常态（`/v2/tags` 就是），路径级浅合并会把上游整个 path item 挤掉，POST/DELETE 从文档里凭空消失。
2. **`.openapi({ type: 'integer' })` 会覆盖整个 schema**，不只是 type —— nullable 会被一起弄丢。要写成 `type: ['integer', 'null']`。
3. **目录树根节点的 `name` 是空串**，不是目录名（Python 侧取 `relative_to(target_dir).name`）。
4. **DB 路径要从模块自身位置解析**，不能靠 `process.cwd()` —— `pnpm --filter` 会把 cwd 设成包目录。
5. **同一个 `OpenAPIHono` 实例内按注册顺序匹配**：`/v2/posts/bulk/rating` 会被先注册的 `/v2/posts/{post_id}/rating` 抢走，把 `"bulk"` coerce 成 NaN。字面量路径必须先注册。
6. **zod 的校验失败形状要翻译**：默认是 `{success, error:{name:'ZodError'}}`，Litestar 是 `{status_code, detail, extra:[{message,key,source}]}`，连**措辞**都不同（msgspec 说 `Expected \`int\` <= 5`，zod 说 `Too big: expected number to be <=5`）。前端可能把这句直接显示给用户，所以逐条翻译。
7. **同一个"越界"在不同层被拒，状态码就不同**：`score` 在 msgspec schema 上有边界，校验层拒 → **400**；`rating` 在 query 上没约束，handler 里判断 → **409**。不对称，但这是既有行为，照抄。
8. **响应键序照抄 DTO 声明顺序**，不是 SELECT 列顺序；**日期**要把 SQLite 的空格换成 `T`（Pydantic 的 ISO 8601）；**`PostSimplePublic` 永远带 `matchProb`/`sortValue`**（Pydantic 把未设置的可选字段序列化成 null）。
9. **同一个 400 有两种形状**：手抛的 `ValidationException` 是 `{status_code, detail}`（消息直接进 detail，**没有 extra**）；msgspec 的 schema 校验失败是 `{status_code, detail: "Validation failed for …", extra: [...]}`。前端能分辨，所以两种都要照抄。
10. **动手前先读常量**。我凭印象猜 `VALID_DIMENSIONS`，真实是 `color/finish/composition/overall`；错误消息措辞同理。契约 diff 抓不到这类（它们不进 schema），只有读源码或对拍能抓到。

### ~~Phase 5 · 接入 cairnq（3–5 天）~~ ✅ silva / silva_luna 已接通 2026-08-10

`packages/contracts`（TaskDef + 跨语言向量编解码）、`server/src/worker/`（cairnq worker
进程）、`apps/api/src/scheduler.ts`（挑活）三块落地，两个 SILVA 头走完整条
submit → lease → 结果落库。

**验收**（`pnpm parity:worker`，27 项）：同一批向量，新链路（TS 挑活 → cairnq →
Python worker）和旧路径（Python 进程内直接读库算）算出的分数**逐位相同**；结果顺序
与 payload 一致；空批次不加载 ML 栈；未注册的 scorer 被 worker 拒绝。热态往返
104–816 ms，冷启动（torch + 权重进显存）约 11 s。

#### 四件踩出来的事

1. **不能拿库里的存量分数当基准。** 第一次对拍 8 条全红，看着像编码错了。二分之后
   发现 Python 旧路径**直算**的结果和新链路逐位相同 —— 对不上的是
   `post_aesthetic_scores` 里的历史值，那是**旧权重**的 head 算的。基准必须是同一时刻
   的旧代码路径（`server/scripts/score_direct.py`），不是查表。
2. **向量必须随 payload 走，用 base64 的原始 float32。** §D1 说 worker 不读库，而 silva
   的输入正是已存的向量。JSON 数字数组体积是 base64 的 **3.4 倍**（1152 维：21 KB vs
   6 KB），而且十进制往返有损 —— 两侧对不齐时表现为分数末位漂移，最难查的那种。批大小
   随之从 256 降到 64：head forward 在这两个批量上都是毫秒级，批大小买不到吞吐，只买到
   payload 体积。
3. **`PICTORIA_SKIP_WORKERS` 是迁移缝。** 一个 worker 搬过去之后，Python 侧的 backfill
   poller 必须停止扫它的 pending，否则两边对同一批数据重复烧 GPU。`WorkerSpec` 为此加了
   稳定的 `key` 字段（`silva` / `basics` / …，与 cairnq 任务名同名），`enabled_workers()`
   按环境变量过滤。`justfile` 的 `server-dev` 已经带上 `silva,silva_luna`。
4. **`pnpm add` 会被 `trustPolicy: no-downgrade` 拦住**（Phase 1 那个 semver@6.3.1 又来了）。
   任何一次 add 都触发全量重解析，于是既有依赖也要重新过信任检查。正解是
   `trustPolicyExclude: ['semver@6.3.1']` —— 精确豁免这一个 (包, 版本)，策略对其余一切
   照旧。**不要**把 trustPolicy 关掉。

> ⚠️ 生产库上 `silva` / `silva_luna` 都已经打满 223,060 条，所以调度器在真机上**没有存量
> 待办可跑** —— "服务起来没报错"证明不了待办查询挑对了东西。那条路径由
> `packages/db/src/repositories/backfill.test.ts`（11 项，跑在迁移建出来的临时库上）覆盖，
> 含"一批里有一条违反外键时整批回滚"。

### Phase 6 · 剩余 worker（1–2 周）—— 进行中

~~`silva_luna`~~ ✅（和 silva 同一条代码路径，随它一起接通）→ ~~`waifu`~~ ✅ → ~~`tagger`~~ ✅ →
~~`embedding`（D1 的例外，直接写向量表）~~ ⚠️ 链路已通、**尚未启用** → `basics`（最后，因为它顺带产缩略图）。

> "embedding 是 D1 的例外"是初稿的说法，**已被 §D1 推翻** —— 那个例外建立在错误的批量
> 假设上。embedding 和其余 worker 一样：算在 Python，写在 TS。对拍（45 项）已证明新链路
> 算出的向量与旧路径**逐字节相同**，`upsertVectors` 的 BigInt rowid 也有回归钉。

#### dedup：唯一一个输入走文件的任务（2026-08-10 已完成）

embedding 一度卡在这里：它带一个后置钩子，一轮写进新向量后要重建近重复分组，切过去
而分组没有对应物就等于悄悄关掉近重复分组。

而 dedup 不能照搬前四个 worker 的形状。它要**全库**向量做一次分块 `X @ X.T`
（170k 行时逐个 KNN 实测要 48 小时，所以只能矩阵乘），22.3 万条向量 base64 是 **1.3 GB**，
塞不进一行 JSON payload。四个选项，只有一个同时满足 D1 和可行性：

| 方案 | 判断 |
|---|---|
| worker 直接读 vec0 | ❌ 破坏 D1，而且这正是"就这一个 worker 例外"的开头 |
| payload 带全部向量 | ❌ 1.3 GB 一行 JSON |
| 分块喂给有状态的 worker | ❌ 把状态放回了 worker 里，比例外更糟 |
| **TS 导出一个临时 float32 文件，payload 带路径** | ✅ 文件不是数据库；worker mmap 读、算、回传**邻接索引对**，TS 做贪心分组和落库 |

最后一条就是实现出来的形状：

* `exportVectorMatrix`（`packages/db/src/repositories/dedup.ts`）按 post_id 升序把全库向量
  写成一个裸 float32 文件，落在 `<target_dir>/.pictoria/` 下 —— 那正好在 worker 的
  `_resolve_inside` 允许的根之内。**升序不只是为了确定性**：贪心分配按行下标升序跑，
  行序即 id 序才能保证簇里最早的 post 拿到 canonical 位。
* worker 的 `handle_dedup` 用 `np.memmap` 读它（不是 `fromfile` —— 数据反正要拷进显存，
  再付一份宿主机全量拷贝买不到任何东西），回传**行下标对**而不是 post id：矩阵文件里根本
  没有 id，翻译由持有 ids 数组的 TS 做。
* `assignFromPairs` 是纯函数，于是"谁当 canonical、组会不会成链"脱离 GPU 就能钉住
  （`dedup.test.ts`，12 项）。
* `replaceAllGroups` 在**一个事务**里清空 + 重设。分开做的话，从清空到写完之间
  （一次 GPU 计算加两万多条 UPDATE）每个成员都会在列表里冒出来。

**验证（2026-08-10）**：

1. `pnpm parity:worker` 加了 4 项 dedup 对拍（总 49 项）。取样必须**含近重复** ——
   否则两条路径都返回空对，比对"通过"而什么也没证明，所以取样是"几个已知分组的全部成员
   + 200 条随机噪声"。导出用的是生产那个函数本身，喂它一个只装了取样向量的临时库。
2. 真库全量重建：22.3 万条向量、1.03 GB 文件、GPU 30.9 秒，**33,726 个成员归入 28,063 个
   canonical**，与旧路径留下的分组指针**逐条相同**（0 条改指向、0 条新增、0 条消失）。

于是 embedding 解锁了。它的后置钩子在 TS 侧是"**待办清空的那一刻**"触发，而不是每一批
之后 —— 一次重建是全库矩阵乘，每 16 张图触发一次等于让 GPU 什么正事都干不成。
Python 侧 `run_all_backfill` 跑完整轮才 fire 一次，"清空即一轮结束"是它的等价物。

`POST /v2/cmd/group-duplicates` 一并搬过来了（49/70）。忙检查用 `isRebuilding()`，
对应 Python 的 `rebuild_lock.locked()`；⚠️ `await getTasks()` 必须排在忙检查**之前**，
否则两个几乎同时到达的请求会双双通过检查，排成两次分钟级的 GPU 白烧。

### ✅ Phase 6 完成：70/70（2026-08-10）

`pnpm migration:status` 运行时探测：**所有端点都在 Hono 上**。Litestar 进程除了端点
之外拿着的三件事也都搬完了 —— 六个 backfill worker（全部走 cairnq）、文件监视 +
定时轮询、近重复重组。

最后一批端点带出来的东西：

| 端点组 | 值得记的 |
|---|---|
| images (4) | etag 必须用 `bigint` stat：`mtimeMs/1000` 掉精度（…2125 vs Python 的 …2122），对不上就是全库图片重下一遍。缩略图现生成走 worker 而不是在 TS 侧换 sharp —— 库里 22 万张是 PIL 出的 |
| posts delete/rotate/upload | rotate 的 `clockwise` 不能用 `z.coerce.boolean()`：它把 `"false"` 当 true。upload 只落盘落库，剩下的交给调度器 |
| cmd 打分三连 + auto-tags | `is_image` 的扩展名集合比 backfill 的 `IMAGE_EXTS` **宽**，auto-tags 的 rating **无条件**覆写而 backfill 只在 0 时写 —— 两处刻意的不对称，照抄不统一 |
| sync-metadata | 扫描必须异步：`readdirSync` 走 22 万文件把事件循环占住 2.5 秒，连自己的 201 都发不出去 |
| Danbooru / URL 导入 | 抓取留在 Python（限流闸和翻页停止条件是那 880 行里最值钱的调优；gallery-dl 本身就是 Python 工具），落库回 TS |

**两个跨语言的对拍新形状**：

* `parity:destructive`（47 项）—— delete / rotate / upload / folder-delete / caption / sync
  没法拿库里现成的数据比，比一次就少一批。脚本自己在 `__parity__/` 下造一次性的图和
  行，两侧各操作一份内容相同的副本，跑完清掉。rotate 尤其需要：JPEG 每转一次重编码
  一次，拿真图来回转会无声劣化用户的库。
* `parity:s3`（4 项）—— 手写的 SigV4 预签名和 minio-py 逐字符比，含空格 / `+` / 非 ASCII
  对象名。签名把时间戳算进去，所以两侧钉同一个 `X-Amz-Date`。

**cairnq 的 key 有个陷阱**：`key` + `conflict: 'reuse'` 在任务**完成之后**依然有效。
缩略图曾用它去重并发请求，结果缩略图被删再请求，拿回的是上次"已生成"的结论，于是
一直 404。幂等且便宜的任务不要设 key。

**Danbooru 导入的验证方式值得复用**：用一个已存在的标签跑 Hono 这条路（扫 202 条、
新下 3 条、落库），紧接着让 Litestar 复跑同一个标签 —— 它自己的去重查询报
`downloaded=0 / skipped=202 / early_stopped=true`，也就是说旧代码认得新代码写进去的
行和标签。比任何断言都硬。

---

每搬一个：给它写 TaskDef + handler + 调度循环，跑 `pnpm parity:worker` 的同款对拍
（同一批输入，新旧两条路径逐位比对），然后把它的 `key` 加进 `justfile` 的
`PICTORIA_SKIP_WORKERS`。全部搬完之后 `run_all_backfill` / `gpu_pressure` /
`post_process_failures` 的职责一起交给 cairnq。

**waifu 带出来的三件事**（2026-08-10，对拍 36 项）：

1. **handler 必须是 `async`，GPU 调用要 `asyncio.to_thread`。** cairnq 在自己的事件循环上
   跑 handler，而那个循环同时负责续这个任务的租约 —— 一次几秒的同步 forward 把它挡住，
   租约就会过期，任务被判死并交给另一个 worker，而这一个还在算。
2. **降级阶梯搬进了 `worker/ladder.py`。** 原来的 `processors/common.py` 在模块级 import
   `FailureRepo`，worker 用它就等于把 `db` 层拖了进来。失败现在作为**数据**回传，由 TS
   决定它意味着什么 —— 这才是 §D1 想要的形状。
3. **payload 里的路径是输入，要校验。** 它穿过一个数据库跨进程，所以 handler 用
   `_resolve_inside` 挡在图库根之外的路径（和 `server/images.py` 一样的理由）。对拍里
   钉了三条：逃逸被拒、文件不存在是**丢弃**而不是拉黑（它不是坏数据，它是没了）、
   待办查询拼出来的路径真实存在。

> 参考实现（`server/scripts/worker_direct.py`）的 stdout 会被 WaifuScorer 的 rich 日志
> 污染 —— 它把加载进度打在 stdout 上，正好混进要输出的 JSON 里。脚本因此先把
> `sys.stdout` 换成 stderr，只留一个私有句柄写结果。

**tagger 是落库最复杂的一个**（对拍 41 项，数据层 27 项单测），也最能说明 §D1 的价值：
worker 只回传标签名和 rating 字符串，而"这个标签属于哪个组"、"rating 能不能覆盖已有值"
是 schema 的知识，留在拥有 schema 的那一侧。三条规则各有单测钉住：

* 已经归过组的标签**不被**模型的猜测改组（`CASE WHEN tags.group_id IS NULL`）；
* rating 只在原值为 0 时写 —— 人工评过的不被模型覆盖；
* 落库后要**复查**：`post_has_tag` 是 `ON CONFLICT DO NOTHING`，当 tagger 产出的每个标签
  都已作为手工标签存在时（Danbooru 导入的图很常见），一行 `is_auto = 1` 都建不出来，
  待办查询下一轮又会选中它。这些 id 要一起拉黑，因为重跑只会得到同样被遮住的结果。

### Phase 7 · 清理

已做：

* **删 proxy** —— 70/70 之后它没有可透传的东西了。删掉才露出三处一直被它藏着的差异
  （未匹配路径的 404 形状、`/v2/posts/` 的结尾斜杠、`DELETE /v2/folders/` 该是 405）。
* **删 justfile** —— 它最后只剩三条 dev 命令加两条对拍辅助，而 pnpm workspace 本来
  就有 script 机制。全部搬进根 `package.json`：`pnpm dev`（三个进程 + `trap 'kill 0'`）、
  `dev:api` / `dev:worker` / `dev:web` / `dev:api-quiet` / `ref:litestar`。
  这依赖 pnpm 的 `script-shell` 是 POSIX shell —— 它是（msys bash），根脚本要保持
  POSIX 兼容。

### 退役前的最后一次全量对拍（2026-08-13）

删 Litestar 挡在前面的从来不是代码而是**验证**：12 个对拍套件全部拿它当基准，删了
就一起失效。所以退役的第一步是把预言机还在时的结论**记下来**——下面这份是最后一次
全绿运行，之后再没有任何机制能重新得出它。

环境：Litestar 4779（`PICTORIA_SKIP_WORKERS` 全禁）、Hono 4780
（`PICTORIA_SCHEDULER=0`）、cairnq worker 六队列在线、库 223,063 个文件对账一致。

| 套件 | 项数 | 覆盖 |
| --- | --- | --- |
| `parity` | 146 | 142 个端点用例 + 4 项 CORS |
| `contract:diff` | 70 | operationId 与请求/响应结构逐项相同 |
| `parity:write` | 21 | 写路径（每步还原） |
| `parity:annotations` | 21 | 标注提交/撤销 |
| `parity:tags` | 13 | tag 写 |
| `parity:queues` | 8 | 标注队列 |
| `parity:sampling` | 83 | 四个采样端点的不变量 |
| `parity:images` | 20 | 头 + 字节 |
| `parity:timeline` | 11 | 游标翻页与错误路径 |
| `parity:commands` | 21 | 即时命令 |
| `parity:s3` | 4 | 预签名 URL 与 minio-py 逐字符相同 |
| `parity:destructive` | 47 | delete / rotate / delete-folder（沙箱样本） |
| `parity:worker` | 54 | 新链路与旧路径逐位相同 |

顺带证伪了一个一直没人验证的假设：`/schema/openapi.json` 里"抓上游 schema 再按方法
合并"那 25 行是**纯死重**。把 `PICTORIA_UPSTREAM` 指向死端口起一个实例，本地那份
自己就是 70 个操作、与 baseline 逐项相同。合并唯一的实际效果是在 `ref:litestar`
跑着时用上游组件补上本地缺的那些，也就是**掩盖** `contract:diff` 本该报出来的缺口。
随本次退役一并删除。

### 端点延迟：Hono vs Litestar（2026-08-13，退役当天补测）

12 套对拍比的是**响应内容**，从来没比过耗时。这个数字在 Litestar 删掉之后才补——
从 `git worktree` 拉出退役前的那个 commit 跑起来测的，所以以后想复现同样可行。

方法：只打只读 GET；每个用例先预热 5 轮丢弃（vec0 KNN 首次要把 2.2 GB 向量读进
page cache，约 8 秒，那一次测的是磁盘不是语言），然后 30 轮 **A/B 交替**并每轮换
先后手——先把一侧打完再打另一侧会把机器状态漂移全记到后一侧头上。两侧同一个库、
同一个 Python 解释器，backfill 全部禁用。Litestar 的 uvicorn access log 关掉了
（开着约 +1 ms/请求，见下）。

| 端点 | Hono p50 | Litestar p50 | 比值 | Hono p95 | Litestar p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/v2/folders` | 311.8 | 309.1 | **0.99×** | 331.3 | 330.7 |
| `/v2/statistics` | 54.9 | 63.4 | 1.16× | 62.4 | 74.2 |
| `/v2/posts/{id}/similar` (vec0 KNN) | 303.1 | 487.2 | 1.61× | 328.0 | 518.4 |
| `/v2/annotations/pairwise/count` | 2.5 | 4.1 | 1.67× | 3.0 | 5.1 |
| `/v2/posts/{id}/group` | 0.8 | 1.7 | 2.09× | 1.1 | 2.4 |
| `/v2/annotations/timeline?limit=50` | 4.1 | 8.5 | 2.09× | 5.7 | 9.8 |
| `/v2/posts/{id}` | 1.5 | 3.3 | 2.11× | 2.1 | 4.3 |
| `/v2/annotation-queues` | 1.5 | 3.2 | 2.16× | 1.9 | 3.8 |
| `/v2/tags/groups` | 0.8 | 1.8 | 2.19× | 1.0 | 2.0 |
| `/v2/posts?limit=50` | 11.4 | 31.5 | 2.76× | 14.9 | 88.2 |
| `/v2/posts?limit=50&rating&score` | 11.2 | 31.0 | 2.78× | 11.9 | 77.7 |
| `/v2/posts?limit=50&tags=1girl` | 11.1 | 31.5 | 2.84× | 13.0 | 83.1 |
| `/v2/posts?limit=200` | 38.6 | 169.8 | 4.40× | 45.5 | 193.1 |
| `/v2/tags` | 159.2 | 1039.8 | **6.53×** | 169.1 | 1067.8 |

几何平均 **2.25×**。

**这推翻了迁移期的一个假设。** §4.1 的 spike 测出向量层两侧持平（KNN 952 vs 990 ms），
于是一直默认"端点层也会被 SQLite 主导，语言开销看不出来"。看不出来的只是**向量层**。

规律很干净，两条：

* **活在 SQLite 里干 → 持平。** `/v2/folders` 是 0.99×——它 300 ms 全花在走 2.2 万个
  目录的 `readdir` 上，两种语言都只是在等文件系统。`/v2/statistics` 1.16×，聚合查询
  在引擎里算完只回几行。
* **活在语言里按行干 → 差 2–7 倍，且随行数放大。** 同一个端点 `limit=50` 是 2.76×、
  `limit=200` 是 4.40×；`/v2/tags` 要把几千行各自构造成 Pydantic entity，6.53×。单行
  端点稳定在 2.1–2.2×，那是每请求的固定开销（ASGI + DI + `asyncio.to_thread` 的线程
  跳转 + 序列化）。

**p95 的差距比 p50 更值得看。** 列表端点上 Litestar 的 p95 炸到 78–88 ms 而 p50 只有
31 ms（2.8 倍的尾巴），Hono 是 11 → 13 ms（1.2 倍）。这是 GC 与线程池调度的抖动，
瀑布流滚动时用户感觉到的正是这个尾巴，不是中位数。

附带测到的一件事：uvicorn 的 access log（经 `rich` 渲染）约 **1 ms/请求**——小端点上
`/v2/posts/{id}/group` 从 2.7 降到 1.7 ms。生产配置里它是开着的，所以用户实际体验到
的差距比上表还大一点。

### `server/` 保留清单

删完之后 `server/src` 是 **26 个文件 / 3,130 行**（含 4 个包标记 `__init__.py`）：

```
worker/{main,handlers,importers,dedup,codec,ladder}.py
ai/{siglip_embed,silva_scorer,waifu_scorer,clip,make_captions,hf_loader,torch_runtime}.py
services/{danbooru_import,gallery_dl_import,wd_tagging}.py
danbooru/  tools/{colors,colorthief}.py  utils.py  shared.py  scorers.py
```

清单是按运行时 import 闭包算的（AST 遍历，**排除 `if TYPE_CHECKING:` 块，并处理
相对 import**）。两个坑值得记下来，因为都会让"照清单删"直接起不来：

* 早先那份手写清单漏了 `shared.py`（`utils.py` / `wd_tagging.py` /
  `danbooru_import.py` / `gallery_dl_import.py` 都是模块级 `import shared`）和
  `db/scorers.py`（`ai/silva_scorer.py` 要两个 `ScorerSpec`；它是常量注册表不是
  数据访问，所以移到了 `src/scorers.py`）。
* 第一版闭包脚本只处理绝对 import，于是把 `tools/colorthief.py` 判成了孤儿 ——
  它是被 `tools/colors.py` 的 `from .colorthief import ColorThief` 相对引用的。
  431 行自定义中位切分，删了颜色筛选就没了。

⚠️ **两个没有调用者的写库路径也在这次一并剪掉**：`import_persist.persist_posts_with_tags`
（`INSERT INTO posts` / `post_has_tag`）和 `wd_tagging` 的 6 个持久化函数。worker
从不调用它们——调用者只有 Litestar 时代的编排函数。留着就是树里有个没人调的**第二
写者**，直接违反"所有数据库写入在 TS"。连同调用者一起剪掉后，`server/src` 的 SQL
写入归零。

⚠️ **但 `server/scripts/` 下还有三个直接写库的一次性维护脚本**
（`calculate_color.py` 的 `UPDATE posts`、两个 `clean_*.py` 的 `DELETE FROM posts`），
它们走裸 `sqlite3` 而从不 import `db/`，所以在"什么还 import db/"这条筛选线下完全
隐形。它们既是第二写者，也会留下孤儿原图/缩略图（文件删除的知识现在住在
`apps/api/src/post-files.ts`）。**未处理** —— 要么删掉（活分别由 basics backfill 和
`DELETE /v2/posts` 承担），要么用 ruff 的 `flake8-tidy-imports.banned-api` 禁掉
`sqlite3` 并给只读脚本开白名单，让这条不变式由 `ruff check` 回答而不是由注释回答。

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
