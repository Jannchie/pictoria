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
