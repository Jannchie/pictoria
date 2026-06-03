# 按创作者清单用 gallery-dl 抓取存档设计

**日期**: 2026-06-03
**作者**: Jianqi Pan
**状态**: 草拟，待评审

## 背景与目标

为 Pictoria 增加一条平行于 Danbooru import 的数据来源：用 [gallery-dl](https://github.com/mikf/gallery-dl)
作为「通用多站点 metadata 提取器」，**按创作者清单批量抓取图片存档**（个人存档用途，
不做再分发）。

第一版接入两类站点：

- **Booru 类**（gelbooru / yande.re / konachan）——全公开、无需登录，tag 结构化最规整，
  与现有 Danbooru 五类 canonical tag group 几乎 1:1 对应。
- **Kemono**（kemono.cr）——付费内容镜像，几乎无结构化 tag（靠后续自动 tagger 补），
  可能撞 Cloudflare。

形态沿用现有 `server/scripts/` 风格（独立可执行脚本 + 文本清单），不进 server HTTP API。
可单测的核心逻辑（metadata 解析 / tag 映射 / source 推导）抽到
`src/services/gallery_dl_import.py`，脚本只当 driver。

## 关键决策

1. **subprocess 调 `gallery-dl -j`（dump JSON 到 stdout），metadata 全程在内存，
   零落盘。** 不使用 `--write-metadata`（会在图库每张图旁留 `.json` sidecar 垃圾），
   也不使用 `--download-archive`（会留状态文件）。gallery-dl 在这里**只负责把某
   creator/tag 页的所有条目 metadata 统一吐成 JSON**，文件一个都不写。

2. **图片由脚本根据 metadata 里的直链自己下载**到 `target_dir/<source>/<creator>/`，
   镜像 `DanbooruClient.download_posts` 的并发 + 失败统计 + 跳过已存在。落盘后图库里
   **只有图片，没有任何 json / archive 文件**。

3. **方案 B：解析 metadata 映射原生 tag**到五类 canonical group（复用
   `ensure_canonical_tag_groups_sync`）。Booru 的 tag 已按类别分字段，映射成本最低；
   Kemono 基本无 tag，入库时 tag 留空，靠后续 `sync-metadata` 的自动 tagger 补。

4. **`source` 字段统一原则**：一律「metadata 登记的原始来源」优先，**缺失时才回退**
   到该图站自己的 post 页面。这条**同时修正现有 Danbooru import**（见改动清单 §2）。

5. **去重沿用 Danbooru import 的方式**：DB 的 `(file_path, file_name, extension)`
   唯一约束 + 入库前 existing 预检，在下载前就跳过已入库条目、只下新图。不引入
   gallery-dl 的第二套 archive 状态。

6. **认证 / Cloudflare**：Booru 无需凭据。Kemono 走一个**可选**的
   `gallery-dl.conf`（放 `<target_dir>/.pictoria/`，含 cookies / user-agent），
   `-j` 与下载共用同一份配置；没配就裸抓，**403 / CF 拦截时优雅跳过并提示，不崩**。

7. **职责单一**：脚本只「抓取 + 写 posts/tags」。新图的 embedding / 质量分 /
   自动标签交给既有 `sync-metadata`（或启动 backfill）。脚本默认结束时打印提示让用户
   去跑；给 `--sync` 开关可在跑完自动触发一次。

8. **只入库图片**：复用 `services.danbooru_import.SUPPORTED_IMAGE_EXTS` allow-list，
   非图片（视频 / zip-ugoira / swf）不下载、不入库。

## 数据流

```
creators.txt（每行一个 gallery-dl 能直接吃的 URL）
   │  逐行
   ▼
gallery-dl -j <url>  ──stdout──▶  内存 JSON（该 creator/tag 下全部条目 metadata）
   │
   ├─ 过滤：只留 SUPPORTED_IMAGE_EXTS
   ├─ 去重：按 (file_path, file_name, extension) 查 DB，剔除已入库 → 仅"新条目"
   ▼
下载新条目直链 → target_dir/<source>/<creator>/<filename>.<ext>   （httpx 并发，可带 cookie）
   │
   ▼
入库（复用 danbooru_import 的事务/重试骨架）
   ├─ tags：原生 tag → 五类 canonical group（per-source 适配）
   ├─ source：metadata 原始来源 or 回退站点 post 页
   └─ published_at / rating（有则填）
   │
   ▼
（可选 --sync）触发 sync-metadata 跑 embedding / 评分 / 自动 tag
```

## 清单文件格式（`creators.txt`）

每行一个 gallery-dl 能直接识别的 URL，支持 `#` 注释与空行。混放不同站点无妨，
gallery-dl 按 URL 自动路由 extractor：

```
# Booru 的"作者" = artist tag 搜索
https://gelbooru.com/index.php?page=post&s=list&tags=hews
https://yande.re/post?tags=wlop

# Kemono 的 creator 页
https://kemono.cr/patreon/user/12345
https://kemono.cr/fanbox/user/67890
```

- `creators.txt` 是用户私有数据，**`.gitignore` 掉**，仓库提供 `creators.txt.example`。
- 脚本 `--list <path>` 参数覆盖默认路径（默认 `server/creators.txt`）。

## 改动清单

### 后端

1. **新建 `src/services/gallery_dl_import.py`** —— 核心逻辑，结构上镜像
   `danbooru_import.py`，但来源从 `DanbooruClient` 换成 gallery-dl 的 `-j` 输出：

   - `run_gallery_dl_json(url, *, config_path=None) -> list[dict]`：subprocess 调
     `gallery-dl -j <url>`（带可选 `--config`），解析 stdout 为条目 metadata 列表。
     subprocess 失败 / CF 403 / 非零退出 → 记 warning 返回空列表，**不抛**（让 driver
     继续下一行）。
   - `parse_entry(entry, *, source_site) -> GalleryDLItem | None`：把一个 metadata
     条目规整成内部结构（file_url、filename、extension、tags 按类别、source、
     published_at、rating）。非图片 / 无下载直链 → 返回 None。
   - `build_tag_to_group(item, type_to_group_id) -> dict[str, int]`：per-source 适配——
     - Booru：把 artist / character / copyright / general / meta 各类 tag 字段映射进
       对应 canonical group（镜像 danbooru 的 `_build_tag_to_group`）。
     - Kemono：通常无分类 tag，返回空 dict（后续自动 tagger 补）。
   - `resolve_source(item, *, fallback_url) -> str`：`item.source or fallback_url`
     （空串 / None 都回退）。
   - `download_items(items, save_dir, *, headers=None)`：httpx 并发下载直链，镜像
     `DanbooruClient.download_posts` 的并发数 / 失败统计 / 跳过已存在；`headers`
     用于 Kemono 的 cookie / UA（从配置读）。
   - `import_from_url(url, *, db, type_to_group_id, apply, config_path=None) -> GalleryDLStats`：
     串起「`-j` → 过滤 → DB existing 预检 →（下载 → 入库）」。`apply=False`（dry-run）
     时只跑到 existing 预检为止，返回「将下载 N 张新图」，**不下载、不写库**。
     `apply=True` 时下载 + 入库：**直接复用 `danbooru_import` 的 `_insert_tags_tx` /
     posts+links 事务 + `_run_with_retry`**（都是接 `cursor` 的纯函数），posts 的 INSERT
     语句仿照 `_insert_posts_and_links_tx`，但 `source` 用 `resolve_source(...)`、
     `published_at` 用 metadata 日期。
   - **落盘目录 `<source>/<creator>`**（即 posts 的 `file_path`）由 metadata 推导：
     `<source>` 取 gallery-dl 的 `category`（如 `gelbooru` / `kemono`），`<creator>`
     取 artist tag / user id 类字段（精确字段名见「风险」，随 extractor 不同）。这套
     `<source>/<creator>` 同时是 `download_items` 的 `save_dir` 和 DB 去重 / 入库的
     `file_path`，三处一致。

2. **改 `src/services/danbooru_import.py`** —— `_insert_posts_and_links_tx` 的 source
   值从硬编码改为「登记来源优先，缺失回退」：

   ```python
   d_post.source or f"https://danbooru.donmai.us/posts/{d_post.id}",
   ```

   `DanbooruPost.source`（`danbooru/__init__.py:125`，`str | None`）已存在；danbooru
   对无来源的 post 返回空字符串，`or` 对 `""` 与 `None` 都正确回退。

3. **新建 `scripts/fetch_creators.py`** —— 独立 driver，骨架同
   `clean_non_image_posts.py`（`SERVER_ROOT` / `sys.path` 注入 src、UTF-8 stdout
   reconfigure、自开 SQLite 连接 + `sqlite_vec` + `PRAGMA foreign_keys`、argparse、
   dry-run 默认）：

   - `--list <path>`（默认 `server/creators.txt`）、`--db <path>`、`--config <path>`
     （gallery-dl.conf）、`--apply`（默认 dry-run：只跑 `-j` + 过滤 + 去重，打印每行
     "会下载 N 张新图"，不下载不写库）、`--sync`（跑完调一次 sync-metadata）。
   - 读清单 → `ensure_canonical_tag_groups_sync(cur)` 拿五类 group → 逐 URL 调
     `import_from_url` → **逐行汇总成功 / 跳过 / 失败**，单行异常不影响后续行。

4. **`server/pyproject.toml`** —— `uv add gallery-dl`（进 server venv，subprocess
   以 `uv run gallery-dl ...` 或 venv 内可执行调用）。

5. **`creators.txt.example`** + **`.gitignore`** 追加 `creators.txt` 与
   `gallery-dl.conf`（清单是私有数据、配置含 cookie，均不入库）。

### 测试

6. **新建 `tests/test_gallery_dl_import.py`**（subprocess 与网络全部 mock / 用样本
   JSON fixture，**不真联网**）：

   - `parse_entry` + `build_tag_to_group`：喂真实结构的 booru `-j` 样本，断言映射出
     正确的 post 字段 + 五类 tag→group。
   - Kemono 样本：断言 tag 为空且不报错。
   - `resolve_source`：有 source → 用 source；空串 / None → 用回退 URL。
   - 非图片条目 → 被 `parse_entry` / 过滤剔除。
   - `run_gallery_dl_json` 在 subprocess 非零退出 / 空输出时返回 `[]` 不抛。

7. **Danbooru source 修正的特征测试**：在现有 `test_post_repo_characterization.py`
   或新测试里，插入带 source 与不带 source 的 danbooru post，断言入库后 source
   分别为「登记来源」与「danbooru post 页 URL」。

8. 跑现有 golden-master 套件（`uv run pytest`）确认无回归；`uv run ruff check src`
   通过；`uv run pytest tests/test_gallery_dl_import.py` 全绿。

## 不做的事（YAGNI）

- **不接 Pixiv / Twitter**（需 OAuth / cookie 登录态，本版未选）。
- **不建 DB 订阅 / creator 表**——清单就是一个文本文件，状态全在 DB 既有去重里。
- 不做定时任务 / 后台轮询、不加 UI 触发按钮（独立脚本手动跑）。
- 不在脚本里做近似去重（交给既有 `group-duplicates`）、不做 embedding / 评分
  （交给 `sync-metadata`）。
- 不用 gallery-dl 的 `--write-metadata` / `--download-archive`（避免落盘垃圾）。
- 不对 `source` 做 URL 合法性校验（danbooru 偶有非 URL 文本来源，默认非空即用）。

## 风险与实现期需确认项

- **gallery-dl `-j` 的精确输出结构与 tag 字段名**因 extractor 而异，实现 RED 阶段
  第一步要用**真实样本**确认：
  - 顶层是否带 message-type 包装、还是直接 metadata 数组；
  - Booru 的 tag 字段分类——gelbooru 提供 `tags_artist` / `tags_character` /
    `tags_copyright` / `tags_general` / `tags_metadata`；但 **moebooru（yande.re /
    konachan）的 tag 可能是扁平 `tags` 不分类**，届时这两站只能整批进 general group
    或留待自动 tagger，spec 不强求第一版分得很细。
- **Kemono 直链下载可能也需要 cookie / Referer**（不止列表页过 CF）。`download_items`
  的 `headers` 即为此预留；第一版若裸下失败，提示用户在 `gallery-dl.conf` 配 cookie。
- gallery-dl 是较大的依赖；以 subprocess 隔离，不 import 其 Python API（API 不稳）。
- 入库复用 danbooru 事务函数，需保证 worker-thread-local cursor 语义一致（脚本是
  单线程独立进程，不存在 danbooru import 那种并发请求争用，反而更简单）。
