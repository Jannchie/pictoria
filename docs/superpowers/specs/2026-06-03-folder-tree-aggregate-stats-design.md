# 目录树聚合统计(两行版面)

日期:2026-06-03
状态:已批准,实现中

## 目标

侧边栏目录树(`FolderItem.vue`)目前每个目录只显示文件数。为每个目录补一行聚合统计,
让用户在浏览目录时一眼看出该目录的画质/打分概况,并能对比模型分(SILVA)与人工分(Score)。

展示四个指标(文字标签版面,第二行):

```
📁 danbooru                    1,234
   SILVA 6.1  Score 3.4  R 2.3  82%
```

| 指标 | 来源 | 定义 | 范围 | 空值 |
|---|---|---|---|---|
| **SILVA** | `post_aesthetic_scores`(`scorer='silva'`) | 均值,前端 ×10 显示(后端返回原始 0~1) | 0~10 显示 | 无 silva→`—` |
| **Score** | `posts.score` | 均值,**仅统计 `score>0`(已打分)**,排除未打的 0 | 1~5 | 无已打分→`—` |
| **R**(Rating) | `posts.rating` | 均值(G/S/Q/E = 1/2/3/4) | 1~4 | 无 post→`—` |
| **%** | `posts.score` | `score>0` 张数 / 该目录总 post 数 | 0~100% | 无 post→`—` |

### 关键语义

- **均值是递归的**:父目录含所有子孙目录的 post,与现有 `file_count` 的递归口径一致。
- **分母用 DB post 数**(`post_count`),与第一行的文件系统 `file_count` 各自独立;两者可能略有出入(缩略图、非图片文件等),`file_count` 保持不动。
- **Score 排除未打分的 0**,否则会被大量 0 拉低、失去意义;覆盖率由独立的 `%`(`scored_ratio`)表达。
- Rating 在生产数据里恒为 1~4(全覆盖),按全部 post 取均值,不排除。

## 架构

单请求方案:扩展现有 `GET /v2/folders` 接口,响应里直接带上每个目录的聚合字段。
前端 `useFoldersQuery` 本就拉这一次,树与统计天然一致,每次请求都是最新的(重标/重跑 silva 后立即反映)。

### 后端

1. **聚合查询** — `db/queries/post_query.py::PostQueryService.folder_score_aggregates()`
   (PostRepo 文档约定:聚合查询归 PostQueryService)。一条 `GROUP BY file_path`:

   ```sql
   SELECT
       p.file_path                                          AS file_path,
       count(*)                                             AS posts,
       sum(CASE WHEN p.score > 0 THEN 1 ELSE 0 END)         AS scored,
       sum(CASE WHEN p.score > 0 THEN p.score ELSE 0 END)   AS score_total,
       sum(p.rating)                                        AS rating_total,
       sum(COALESCE(a.score, 0))                            AS silva_total,
       sum(CASE WHEN a.score IS NOT NULL THEN 1 ELSE 0 END) AS silva_n
   FROM posts p
   LEFT JOIN post_aesthetic_scores a
          ON a.post_id = p.id AND a.scorer = 'silva'
   GROUP BY p.file_path
   ```

   返回 `dict[str, FolderScoreAgg]`(key 为 `file_path`)。`FolderScoreAgg` 为一个含上述
   六个计数/求和字段的 dataclass,带 `add()` 累加方法,既作每目录直属值、又作上卷累加器。
   `post_id` 上有索引,18 万行 <100ms。

2. **响应模型** — `server/folders.py::DirectorySummary` 新增可选字段(snake_case,与 `file_count` 一致):
   `post_count: int = 0`、`silva_avg / score_avg / rating_avg / scored_ratio: float | None = None`。

3. **递归上卷** — `server/folders.py::attach_folder_stats(summary, aggregates) -> FolderScoreAgg`,
   **纯函数**(无 IO):取本节点直属聚合(`aggregates.get(summary.path)`)+ 递归累加各子节点,
   把均值写回 `summary`,返回本子树累加和。`file_path` 与树节点 `path` 精确匹配
   (根节点 `path='.'` ↔ 根目录 post 的 `file_path='.'`)。SILVA 返回原始 0~1 均值。

4. **控制器** — `get_folders` 注入 `post_query: PostQueryService`(依赖键已注册为 `post_query`):
   先 `to_thread(get_directory_summary)` 建树(文件系统),再 `await folder_score_aggregates()`,
   最后 `attach_folder_stats(summary, aggregates)`。`get_directory_summary` 不变,只管 `file_count`。

### 前端

> 注意:侧边栏目录树**实际渲染**的是 `App.vue` 里的 `<TreeList>`(`roku/TreeList.vue`),
> 不是 `components/FolderItem.vue`(后者是未挂载的遗留代码)。改动落在 App.vue 的 slot。

1. **类型** — `api/types.gen.ts` 的 `DirectorySummary` 新增可选字段(手动镜像后端;
   跑 `pnpm genapi` 可从运行中的后端 schema 一致重生)。
2. **`App.vue::convertPathToTree` / `folderTree`** — 给每个 `TreeListItemData`(含 Root)
   挂 `meta = { silvaAvg, scoreAvg, ratingAvg, scoredRatio, postCount }`(`statsOf()`)。
3. **`components/FolderStatsLine.vue`**(新增)— 接收上述 meta,渲染四指标文字标签:
   `SILVA {avg×10}  Score {avg}  R {avg}  %`。各值 1 位小数,空值 `—`,标签 subtle 色、
   数字 mono;SILVA ×10 与 UI 其它处一致。
4. **`App.vue` 的 `#collapse` / `#link` slot** — 把单行 `h-8` RouterLink 改成 `flex-col`:
   第一行保持原样(缩进引导线 + 图标 + 标题 + 计数徽章,固定 `h-8`),`meta.postCount > 0`
   时在下方挂 `<FolderStatsLine>`(对齐到标题下方)。展开箭头改为对齐第一行中心(`top-4`)。
   `postCount === 0` 的目录保持单行。
5. **`FolderSection.vue`**(顶部横向 chip)不改。

## 测试

- **纯上卷函数** `attach_folder_stats`:手搭 DirectorySummary 树 + aggregates dict,
  断言递归均值、加权正确、`scored_ratio`、空目录→`None`、SILVA 原始值。
- **聚合查询** `folder_score_aggregates`:跑在 conftest 的 seeded 临时库上
  (`photos`/`photos/sub`/`art`,silva 在 post 4/5),断言每目录的 posts/scored/各 total。

## 不做(YAGNI)

- 不做统计的独立缓存/独立刷新接口(每请求重算已足够快)。
- 不改顶部横向 chip(`FolderSection.vue`)。
- 不加 Waifu 均值(指标已够,版面有限)。
