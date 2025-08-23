#!/bin/bash
# rclone 同步脚本

# 配置
REMOTE="b2:pictoria/collections"
DEFAULT_LOCAL="./server/illustration"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查 rclone 是否安装
check_rclone() {
    if ! command -v rclone &> /dev/null; then
        error "rclone is not installed. Please install it first."
        echo "Visit: https://rclone.org/downloads/"
        exit 1
    fi
}

# 检查配置
check_config() {
    if ! rclone listremotes | grep -q "b2:"; then
        error "rclone remote 'b2' not configured."
        echo "Please run: rclone config"
        echo "See setup_rclone.md for detailed instructions."
        exit 1
    fi
}

# 上传同步
upload() {
    local LOCAL_DIR="${1:-$DEFAULT_LOCAL}"
    
    if [ ! -d "$LOCAL_DIR" ]; then
        error "Local directory does not exist: $LOCAL_DIR"
        exit 1
    fi
    
    log "Uploading from $LOCAL_DIR to $REMOTE"
    
    # 显示将要同步的文件
    echo -e "${BLUE}Files to be synced:${NC}"
    rclone sync "$LOCAL_DIR" "$REMOTE" --dry-run --stats-one-line -v
    
    echo ""
    read -p "Continue with sync? (y/N): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rclone sync "$LOCAL_DIR" "$REMOTE" \
            --progress \
            --stats 5s \
            --exclude ".*" \
            --exclude "*.tmp" \
            --exclude "Thumbs.db" \
            --exclude "Desktop.ini"
        
        if [ $? -eq 0 ]; then
            log "Upload completed successfully!"
        else
            error "Upload failed!"
            exit 1
        fi
    else
        warn "Sync cancelled."
    fi
}

# 下载同步
download() {
    local LOCAL_DIR="${1:-$DEFAULT_LOCAL}"
    
    log "Downloading from $REMOTE to $LOCAL_DIR"
    
    # 创建本地目录
    mkdir -p "$LOCAL_DIR"
    
    # 显示将要同步的文件
    echo -e "${BLUE}Files to be synced:${NC}"
    rclone sync "$REMOTE" "$LOCAL_DIR" --dry-run --stats-one-line -v
    
    echo ""
    read -p "Continue with sync? (y/N): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rclone sync "$REMOTE" "$LOCAL_DIR" \
            --progress \
            --stats 5s
        
        if [ $? -eq 0 ]; then
            log "Download completed successfully!"
        else
            error "Download failed!"
            exit 1
        fi
    else
        warn "Sync cancelled."
    fi
}

# 双向同步
bisync() {
    local LOCAL_DIR="${1:-$DEFAULT_LOCAL}"
    
    if [ ! -d "$LOCAL_DIR" ]; then
        error "Local directory does not exist: $LOCAL_DIR"
        exit 1
    fi
    
    log "Bidirectional sync between $LOCAL_DIR and $REMOTE"
    
    # 检查是否第一次运行 bisync
    if [ ! -f ".rclone-bisync-state" ]; then
        warn "First time bisync setup. This will create initial state."
        rclone bisync "$LOCAL_DIR" "$REMOTE" --resync --create-empty-src-dirs
    else
        rclone bisync "$LOCAL_DIR" "$REMOTE" \
            --progress \
            --stats 5s \
            --exclude ".*" \
            --exclude "*.tmp"
    fi
    
    if [ $? -eq 0 ]; then
        log "Bisync completed successfully!"
        touch ".rclone-bisync-state"
    else
        error "Bisync failed!"
        exit 1
    fi
}

# 列出远程文件
list() {
    log "Listing files in $REMOTE"
    rclone ls "$REMOTE" --human-readable
}

# 检查差异
diff() {
    local LOCAL_DIR="${1:-$DEFAULT_LOCAL}"
    
    if [ ! -d "$LOCAL_DIR" ]; then
        error "Local directory does not exist: $LOCAL_DIR"
        exit 1
    fi
    
    log "Checking differences between $LOCAL_DIR and $REMOTE"
    rclone check "$LOCAL_DIR" "$REMOTE" --one-way
}

# 显示帮助
show_help() {
    echo "rclone 同步脚本"
    echo ""
    echo "Usage: $0 [command] [directory]"
    echo ""
    echo "Commands:"
    echo "  upload [dir]   - 上传本地目录到远程（增量同步）"
    echo "  download [dir] - 从远程下载到本地目录（增量同步）"
    echo "  bisync [dir]   - 双向同步（保持本地和远程一致）"
    echo "  list           - 列出远程文件"
    echo "  diff [dir]     - 检查本地和远程的差异"
    echo "  help           - 显示此帮助"
    echo ""
    echo "Examples:"
    echo "  $0 upload ./server/illustration"
    echo "  $0 download ./backup"
    echo "  $0 bisync ./server/illustration"
    echo "  $0 list"
    echo ""
    echo "Default directory: $DEFAULT_LOCAL"
}

# 主函数
main() {
    check_rclone
    check_config
    
    case "${1:-help}" in
        "upload")
            upload "$2"
            ;;
        "download")
            download "$2"
            ;;
        "bisync")
            bisync "$2"
            ;;
        "list")
            list
            ;;
        "diff")
            diff "$2"
            ;;
        "help"|*)
            show_help
            ;;
    esac
}

main "$@"