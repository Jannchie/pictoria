# rclone 同步脚本 (PowerShell 版本)

param(
    [Parameter(Position=0)]
    [ValidateSet("upload", "download", "bisync", "list", "diff", "help")]
    [string]$Command = "help",
    
    [Parameter(Position=1)]
    [string]$Directory = ".\server\illustration"
)

# 配置
$REMOTE = "b2:pictoria/collections"
$DEFAULT_LOCAL = ".\server\illustration"

# 颜色输出函数
function Write-Info($message) {
    Write-Host "[INFO] $message" -ForegroundColor Green
}

function Write-Warn($message) {
    Write-Host "[WARN] $message" -ForegroundColor Yellow
}

function Write-Error($message) {
    Write-Host "[ERROR] $message" -ForegroundColor Red
}

# 检查 rclone 是否安装
function Test-RcloneInstalled {
    try {
        $null = Get-Command rclone -ErrorAction Stop
        return $true
    }
    catch {
        Write-Error "rclone is not installed. Please install it first."
        Write-Host "Visit: https://rclone.org/downloads/"
        exit 1
    }
}

# 检查配置
function Test-RcloneConfig {
    $remotes = rclone listremotes
    if ($remotes -notcontains "b2:") {
        Write-Error "rclone remote 'b2' not configured."
        Write-Host "Please run: rclone config"
        Write-Host "See setup_rclone.md for detailed instructions."
        exit 1
    }
}

# 上传同步
function Invoke-Upload {
    param($LocalDir)
    
    if (-not $LocalDir) { $LocalDir = $DEFAULT_LOCAL }
    
    if (-not (Test-Path $LocalDir)) {
        Write-Error "Local directory does not exist: $LocalDir"
        exit 1
    }
    
    Write-Info "Uploading from $LocalDir to $REMOTE"
    
    # 显示将要同步的文件
    Write-Host "Files to be synced:" -ForegroundColor Blue
    rclone sync $LocalDir $REMOTE --dry-run --stats-one-line -v
    
    $confirm = Read-Host "`nContinue with sync? (y/N)"
    
    if ($confirm -match "^[Yy]$") {
        rclone sync $LocalDir $REMOTE `
            --progress `
            --stats 5s `
            --exclude ".*" `
            --exclude "*.tmp" `
            --exclude "Thumbs.db" `
            --exclude "Desktop.ini"
        
        if ($LASTEXITCODE -eq 0) {
            Write-Info "Upload completed successfully!"
        } else {
            Write-Error "Upload failed!"
            exit 1
        }
    } else {
        Write-Warn "Sync cancelled."
    }
}

# 下载同步
function Invoke-Download {
    param($LocalDir)
    
    if (-not $LocalDir) { $LocalDir = $DEFAULT_LOCAL }
    
    Write-Info "Downloading from $REMOTE to $LocalDir"
    
    # 创建本地目录
    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    
    # 显示将要同步的文件
    Write-Host "Files to be synced:" -ForegroundColor Blue
    rclone sync $REMOTE $LocalDir --dry-run --stats-one-line -v
    
    $confirm = Read-Host "`nContinue with sync? (y/N)"
    
    if ($confirm -match "^[Yy]$") {
        rclone sync $REMOTE $LocalDir `
            --progress `
            --stats 5s
        
        if ($LASTEXITCODE -eq 0) {
            Write-Info "Download completed successfully!"
        } else {
            Write-Error "Download failed!"
            exit 1
        }
    } else {
        Write-Warn "Sync cancelled."
    }
}

# 双向同步
function Invoke-Bisync {
    param($LocalDir)
    
    if (-not $LocalDir) { $LocalDir = $DEFAULT_LOCAL }
    
    if (-not (Test-Path $LocalDir)) {
        Write-Error "Local directory does not exist: $LocalDir"
        exit 1
    }
    
    Write-Info "Bidirectional sync between $LocalDir and $REMOTE"
    
    # 检查是否第一次运行 bisync
    if (-not (Test-Path ".rclone-bisync-state")) {
        Write-Warn "First time bisync setup. This will create initial state."
        rclone bisync $LocalDir $REMOTE --resync --create-empty-src-dirs
    } else {
        rclone bisync $LocalDir $REMOTE `
            --progress `
            --stats 5s `
            --exclude ".*" `
            --exclude "*.tmp"
    }
    
    if ($LASTEXITCODE -eq 0) {
        Write-Info "Bisync completed successfully!"
        New-Item -ItemType File -Path ".rclone-bisync-state" -Force | Out-Null
    } else {
        Write-Error "Bisync failed!"
        exit 1
    }
}

# 列出远程文件
function Invoke-List {
    Write-Info "Listing files in $REMOTE"
    rclone ls $REMOTE --human-readable
}

# 检查差异
function Invoke-Diff {
    param($LocalDir)
    
    if (-not $LocalDir) { $LocalDir = $DEFAULT_LOCAL }
    
    if (-not (Test-Path $LocalDir)) {
        Write-Error "Local directory does not exist: $LocalDir"
        exit 1
    }
    
    Write-Info "Checking differences between $LocalDir and $REMOTE"
    rclone check $LocalDir $REMOTE --one-way
}

# 显示帮助
function Show-Help {
    Write-Host "rclone 同步脚本 (PowerShell 版本)"
    Write-Host ""
    Write-Host "Usage: .\rclone_sync.ps1 [command] [directory]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  upload [dir]   - 上传本地目录到远程（增量同步）"
    Write-Host "  download [dir] - 从远程下载到本地目录（增量同步）"
    Write-Host "  bisync [dir]   - 双向同步（保持本地和远程一致）"
    Write-Host "  list           - 列出远程文件"
    Write-Host "  diff [dir]     - 检查本地和远程的差异"
    Write-Host "  help           - 显示此帮助"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\rclone_sync.ps1 upload .\server\illustration"
    Write-Host "  .\rclone_sync.ps1 download .\backup"
    Write-Host "  .\rclone_sync.ps1 bisync .\server\illustration"
    Write-Host "  .\rclone_sync.ps1 list"
    Write-Host ""
    Write-Host "Default directory: $DEFAULT_LOCAL"
}

# 主函数
Test-RcloneInstalled
Test-RcloneConfig

switch ($Command) {
    "upload" { Invoke-Upload $Directory }
    "download" { Invoke-Download $Directory }
    "bisync" { Invoke-Bisync $Directory }
    "list" { Invoke-List }
    "diff" { Invoke-Diff $Directory }
    default { Show-Help }
}