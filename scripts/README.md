# Backblaze B2 同步脚本

这些脚本用于在本地和 Backblaze B2 存储之间同步文件。

## 安装依赖

```bash
pip install -r requirements.txt
```

## 配置

### 方法1：环境变量配置（推荐）

复制环境变量模板并配置：

```bash
cp scripts/.env.example scripts/.env
```

编辑 `.env` 文件：

```bash
S3_ACCESS_KEY="your_application_key_id"
S3_SECRET_KEY="your_application_key" 
S3_BUCKET="your-bucket-name"
S3_BASE_DIR="collections"  # B2 中的目录前缀
S3_ENDPOINT="s3.us-east-005.backblazeb2.com"
```

### 方法2：直接设置环境变量

```bash
export S3_ACCESS_KEY="your_application_key_id"
export S3_SECRET_KEY="your_application_key"
export S3_BUCKET="your-bucket-name"
export S3_BASE_DIR="collections"
```

### 检查配置

```bash
python scripts/load_env.py
```

## 使用方法

### 上传到 B2

```bash
# 增量上传指定目录 - 默认行为
python scripts/upload_to_s3.py ./web
python scripts/upload_to_s3.py ./dist

# 完整上传（上传所有文件）
python scripts/upload_to_s3.py ./web --full

# 强制上传（覆盖相同大小的文件）
python scripts/upload_to_s3.py ./web --force

# 列出远程文件
python scripts/upload_to_s3.py --list

# 指定基础目录
python scripts/upload_to_s3.py ./dist -b "production/"
```

### 从 B2 下载

```bash
# 增量下载到指定目录 - 默认行为
python scripts/download_from_s3.py ./web
python scripts/download_from_s3.py ./backup

# 完整下载（下载所有文件）
python scripts/download_from_s3.py ./web download

# 列出远程文件
python scripts/download_from_s3.py ./web list

# 同步下载（删除本地多余文件）
python scripts/download_from_s3.py ./backup sync

# 指定基础目录
python scripts/download_from_s3.py ./backup incremental -b "collections/"
```

## 在 K8s 中使用

```bash
# 将脚本复制到 Pod
kubectl cp scripts/ pod-name:/tmp/scripts/

# 安装依赖
kubectl exec -it pod-name -- pip install -r /tmp/scripts/requirements.txt

# 设置环境变量
kubectl exec -it pod-name -- sh -c 'export S3_ACCESS_KEY="your_key" && export S3_SECRET_KEY="your_secret" && export S3_BUCKET="pictoria" && export S3_BASE_DIR="collections/" && export S3_ENDPOINT="s3.us-east-005.backblazeb2.com"'

# 在 Pod 内执行下载（默认增量下载）
kubectl exec -it pod-name -- python /tmp/scripts/download_from_s3.py /app/web
```

## 功能特性

- ✅ 增量同步（基于文件修改时间）
- ✅ 智能跳过（相同大小的文件自动跳过）
- ✅ 进度显示和统计信息
- ✅ 错误处理和重试机制
- ✅ 支持大文件和大量文件
- ✅ 保持目录结构

## 定时同步

可以配置定时任务：

```bash
# 每10分钟增量上传（默认行为）
*/10 * * * * cd /path/to/project && python scripts/upload_to_s3.py ./web

# 每小时增量下载（默认行为）
0 * * * * cd /path/to/project && python scripts/download_from_s3.py ./web

# 每日同步（删除本地多余文件）
0 2 * * * cd /path/to/project && python scripts/download_from_s3.py ./web sync
```

## 图库同步不含 `.pictoria/`

`rclone_sync.ps1` / `rclone_sync.sh` / `sync_with_awscli.sh` 一律排除图库里的 `.pictoria/` 目录
（rclone 用 `--exclude ".pictoria/**"`，aws 用 `--exclude ".pictoria/*" --exclude "*/.pictoria/*"`，
传图库根 `images/` 或它的上一级 `server/illustration` 都生效）。那里面是：

- `pictoria.sqlite`（+ `-wal` / `-shm`）—— API 一直开着它，逐字节拷贝得到的是不一致的文件；
  下载方向还会拿远端的旧库盖掉本地的活库；
- `tasks.sqlite`（cairnq 队列，临时状态）、`thumbnails/`（可重建）、`gallery-dl.conf`（含 cookies）。

旧版脚本只排除了 `.*` —— 在 rclone 里它只匹配**文件名**以点开头的文件，`.pictoria/` 下的内容其实
一直在被上传。远端若已有 `collections/images/.pictoria/`，新脚本不会删除它（被排除的路径 sync 不碰），
确认不需要后可手动清掉：`rclone purge b2:pictoria/collections/images/.pictoria`。

## 数据库备份与恢复

数据库单独用 `server/scripts/backup_db.py` 备份：SQLite `VACUUM INTO` 在一个读事务里写出一份
自包含、已压实的副本，API 运行中也能做，不写源库；写完先 `PRAGMA quick_check` 再改名为正式文件。

```bash
cd server
# 快照到库外的目录（不能放在 .pictoria/ 里 —— 那里不进同步）
uv run python scripts/backup_db.py D:/pictoria-backups

# 快照后上传到 rclone 远端，并只保留本地最新 7 份
uv run python scripts/backup_db.py D:/pictoria-backups --upload b2:pictoria/db-backups --keep 7

# 指定源库（默认是 DB_PATH 或 <图库>/.pictoria/pictoria.sqlite）
uv run python scripts/backup_db.py D:/pictoria-backups --db E:/some/other/pictoria.sqlite
```

快照名形如 `pictoria-20261110T120000Z.sqlite`（UTC）。`tasks.sqlite` 不备份：它是队列的临时状态，
启动时会自动新建。

### 恢复

1. 停掉 API 和 worker（`pnpm dev` 里 Ctrl+C；确认没有残留的 `node ... src/index.ts` 进程）。
2. 把现有的库挪开（三个文件一起，`-wal` 里可能有尚未合并的写入，单独留下会和新库错配）：
   ```bash
   cd <图库>/.pictoria
   mkdir -p ../../pictoria-db-old
   mv pictoria.sqlite pictoria.sqlite-wal pictoria.sqlite-shm ../../pictoria-db-old/ 2>/dev/null
   ```
3. 放入快照（远端的先 `rclone copyto b2:pictoria/db-backups/<名字> ./pictoria.sqlite`）：
   ```bash
   cp D:/pictoria-backups/pictoria-<时间>.sqlite <图库>/.pictoria/pictoria.sqlite
   ```
4. 启动 API。启动时会自动补跑快照之后新增的迁移；随后的 sync 会把快照之后才加进磁盘的图片
   重新导入，backfill 会给它们补算向量 / 标签 / 分数。快照之后才做的手工编辑（评分、标签确认等）
   无法恢复。
