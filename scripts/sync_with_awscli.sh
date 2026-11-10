#!/bin/bash
# AWS CLI 同步脚本

# B2 配置
# 凭据从环境读，不写进脚本（曾经硬编码在这里 —— 那把 key 已在 git 历史里，需要轮换）。
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID (B2 application key id)}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY (B2 application key)}"
export AWS_DEFAULT_REGION="us-east-1"
ENDPOINT="https://s3.us-east-005.backblazeb2.com"
BUCKET="pictoria"
BASE_DIR="collections"

# 进程私有目录（两个 sqlite、缩略图、gallery-dl.conf）不进同步，见 scripts/README.md。
# aws 的 * 跨 / 匹配；两条分别覆盖"传的就是图库根"和"传的是它的上级"。
PICTORIA_EXCLUDE=(--exclude ".pictoria/*" --exclude "*/.pictoria/*")

# 上传同步
upload() {
    local LOCAL_DIR="$1"
    echo "🔄 Syncing $LOCAL_DIR to s3://$BUCKET/$BASE_DIR/"
    aws s3 sync "$LOCAL_DIR" "s3://$BUCKET/$BASE_DIR/" \
        --endpoint-url "$ENDPOINT" \
        --delete \
        "${PICTORIA_EXCLUDE[@]}" \
        --exclude ".*" \
        --exclude "*.tmp"
}

# 下载同步
download() {
    local LOCAL_DIR="$1"
    echo "🔄 Syncing s3://$BUCKET/$BASE_DIR/ to $LOCAL_DIR"
    aws s3 sync "s3://$BUCKET/$BASE_DIR/" "$LOCAL_DIR" \
        --endpoint-url "$ENDPOINT" \
        --delete \
        "${PICTORIA_EXCLUDE[@]}"
}

# 列出文件
list() {
    echo "📋 Listing files in s3://$BUCKET/$BASE_DIR/"
    aws s3 ls "s3://$BUCKET/$BASE_DIR/" --recursive \
        --endpoint-url "$ENDPOINT"
}

case "$1" in
    "upload")
        upload "${2:-./server/illustration}"
        ;;
    "download") 
        download "${2:-./server/illustration}"
        ;;
    "list")
        list
        ;;
    *)
        echo "Usage: $0 {upload|download|list} [directory]"
        echo "Examples:"
        echo "  $0 upload ./server/illustration"
        echo "  $0 download ./backup"
        echo "  $0 list"
        ;;
esac