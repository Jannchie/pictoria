# rclone 配置指南

## 1. 安装 rclone

### Windows
```bash
# 使用 Scoop
scoop install rclone

# 或下载二进制文件
curl -O https://downloads.rclone.org/rclone-current-windows-amd64.zip
# 解压并添加到 PATH
```

### Linux/macOS
```bash
curl https://rclone.org/install.sh | sudo bash
```

## 2. 配置 B2 连接

```bash
rclone config
```

按照以下步骤配置：

1. **n** (New remote)
2. **名称**: `b2` (或其他你喜欢的名称)
3. **存储类型**: `4` (Amazon S3 Compliant Storage Providers)
4. **提供商**: `2` (Any other S3 compatible provider)
5. **访问密钥**: `005872bacee5ccb0000000007`
6. **密钥**: `K005wIU3DtFaIrvcjQoqybpntnbawsc`
7. **区域**: `us-east-1`
8. **端点**: `s3.us-east-005.backblazeb2.com`
9. **位置约束**: (留空)
10. **ACL**: `private`
11. 其余选项使用默认值，最后确认配置

## 3. 测试连接

```bash
# 列出桶
rclone lsd b2:

# 列出桶内文件
rclone ls b2:pictoria

# 列出指定目录
rclone ls b2:pictoria/collections
```

## 4. 基本同步命令

```bash
# 上传同步（增量）
rclone sync ./server/illustration b2:pictoria/collections

# 下载同步（增量）
rclone sync b2:pictoria/collections ./server/illustration

# 双向同步
rclone bisync ./server/illustration b2:pictoria/collections

# 查看将要同步的变化（不实际执行）
rclone sync ./server/illustration b2:pictoria/collections --dry-run -v
```