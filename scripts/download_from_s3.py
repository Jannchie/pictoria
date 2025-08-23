#!/usr/bin/env python3
"""
S3 Compatible Download Script
使用 S3 兼容 API 从 Backblaze B2 存储下载文件
"""

import os
import sys
import time
import argparse
from pathlib import Path
from typing import List, Dict
import boto3
from botocore.exceptions import ClientError, NoCredentialsError

# 加载环境变量
try:
    from load_env import load_env
    load_env()
except ImportError:
    pass

# 从环境变量读取配置
ACCESS_KEY = os.getenv("S3_ACCESS_KEY", "")
SECRET_KEY = os.getenv("S3_SECRET_KEY", "")
BUCKET_NAME = os.getenv("S3_BUCKET", "")
BASE_DIR = os.getenv("S3_BASE_DIR", "collections")
ENDPOINT_URL = os.getenv("S3_ENDPOINT", "")
LOCAL_PATH = "./web"

# 确保 BASE_DIR 以 / 结尾
if BASE_DIR and not BASE_DIR.endswith("/"):
    BASE_DIR += "/"


def create_s3_client():
    """创建 S3 客户端"""
    if not ENDPOINT_URL:
        print("❌ Error: S3_ENDPOINT not configured")
        sys.exit(1)
    
    # 确保 endpoint URL 包含协议
    endpoint = ENDPOINT_URL if ENDPOINT_URL.startswith(('http://', 'https://')) else f"https://{ENDPOINT_URL}"
    
    return boto3.client(
        's3',
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        endpoint_url=endpoint,
        region_name='us-east-1'  # B2 需要一个 region，但实际不使用
    )


def format_size(size_bytes: int) -> str:
    """格式化文件大小"""
    if size_bytes < 1024:
        return f"{size_bytes}B"
    elif size_bytes < 1024**2:
        return f"{size_bytes/1024:.1f}KB"
    elif size_bytes < 1024**3:
        return f"{size_bytes/1024**2:.1f}MB"
    else:
        return f"{size_bytes/1024**3:.1f}GB"


def get_remote_files(s3_client, base_dir: str, incremental: bool = False) -> List[Dict]:
    """获取要下载的远程文件列表"""
    marker_file = Path(".s3_last_download")
    
    # 增量下载的时间截止点
    cutoff_time = None
    if incremental and marker_file.exists():
        cutoff_time = marker_file.stat().st_mtime
        print(f"🔄 Incremental download - files modified after: {time.ctime(cutoff_time)}")
    else:
        print("📋 Full download - downloading all files")
    
    files = []
    
    try:
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=BUCKET_NAME, Prefix=base_dir)
        
        for page in pages:
            if 'Contents' in page:
                for obj in page['Contents']:
                    # 增量下载检查
                    if cutoff_time:
                        obj_modified = obj['LastModified'].timestamp()
                        if obj_modified <= cutoff_time:
                            continue
                    
                    files.append({
                        'key': obj['Key'],
                        'size': obj['Size'],
                        'modified': obj['LastModified']
                    })
    
    except ClientError as e:
        print(f"❌ Error listing files: {e}")
        return []
    
    return files


def download_file(s3_client, s3_key: str, local_path: Path, file_size: int) -> bool:
    """下载单个文件"""
    try:
        # 检查本地文件是否已存在且大小相同
        if local_path.exists() and local_path.stat().st_size == file_size:
            print(f"⏭️  Skipping (same size): {local_path.name}")
            return True
        
        # 创建本地目录
        local_path.parent.mkdir(parents=True, exist_ok=True)
        
        relative_path = s3_key.replace(BASE_DIR, "", 1)
        print(f"📥 Downloading: {relative_path} ({format_size(file_size)})")
        
        # 下载文件
        s3_client.download_file(BUCKET_NAME, s3_key, str(local_path))
        
        # 验证文件大小
        downloaded_size = local_path.stat().st_size
        if downloaded_size == file_size:
            print(f"✅ Downloaded: {relative_path}")
            return True
        else:
            print(f"⚠️  Size mismatch for {relative_path}: expected {file_size}, got {downloaded_size}")
            local_path.unlink()
            return False
            
    except ClientError as e:
        print(f"❌ Error downloading {s3_key}: {e}")
        if local_path.exists():
            local_path.unlink()
        return False
    except Exception as e:
        print(f"❌ Error downloading {s3_key}: {str(e)}")
        if local_path.exists():
            local_path.unlink()
        return False


def download_files(s3_client, local_path: Path, base_dir: str, incremental: bool = False) -> None:
    """下载文件"""
    print(f"📁 Starting download to: {local_path}")
    local_path.mkdir(parents=True, exist_ok=True)
    
    files = get_remote_files(s3_client, base_dir, incremental)
    
    if not files:
        print("📭 No files to download")
        return
    
    print(f"📊 Found {len(files)} files to download")
    
    success_count = 0
    skipped_count = 0
    total_size = 0
    
    for i, file_info in enumerate(files, 1):
        s3_key = file_info['key']
        file_size = file_info['size']
        
        # 计算本地路径
        relative_path = s3_key.replace(base_dir, "", 1) if base_dir else s3_key
        local_file_path = local_path / relative_path
        
        if download_file(s3_client, s3_key, local_file_path, file_size):
            if local_file_path.exists() and local_file_path.stat().st_size == file_size:
                success_count += 1
                total_size += file_size
            else:
                skipped_count += 1
        
        # 显示进度
        if i % 10 == 0:
            print(f"📈 Progress: {i}/{len(files)} files processed")
    
    # 更新下载标记
    if incremental or success_count > 0:
        Path(".s3_last_download").write_text(str(int(time.time())))
    
    print(f"\n🎉 Download completed!")
    print(f"📊 Summary: {success_count} downloaded, {skipped_count} skipped, {len(files)} total")
    print(f"📁 Total size: {format_size(total_size)}")


def list_remote_files(s3_client, base_dir: str) -> None:
    """列出远程文件"""
    print(f"📋 Listing files in S3 bucket: {BUCKET_NAME}")
    
    try:
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=BUCKET_NAME, Prefix=base_dir)
        
        print(f"{'File Name':<50} {'Size':<10} {'Modified'}")
        print("-" * 80)
        
        total_files = 0
        total_size = 0
        
        for page in pages:
            if 'Contents' in page:
                for obj in page['Contents']:
                    total_files += 1
                    key = obj['Key']
                    size = obj['Size']
                    modified = obj['LastModified'].strftime('%Y-%m-%d %H:%M:%S')
                    total_size += size
                    
                    # 移除前缀显示相对路径
                    relative_key = key.replace(base_dir, "", 1)
                    
                    print(f"{relative_key:<50} {format_size(size):<10} {modified}")
        
        print(f"\nTotal files: {total_files}")
        print(f"Total size: {format_size(total_size)}")
        
    except ClientError as e:
        print(f"❌ Error listing files: {e}")


def sync_from_remote(s3_client, local_path: Path, base_dir: str) -> None:
    """从远程同步，删除本地多余的文件"""
    print("🔄 Syncing from remote (will delete local files not in remote)...")
    
    # 获取远程文件列表
    remote_files = set()
    try:
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=BUCKET_NAME, Prefix=base_dir)
        
        for page in pages:
            if 'Contents' in page:
                for obj in page['Contents']:
                    key = obj['Key']
                    relative_key = key.replace(base_dir, "", 1)
                    remote_files.add(relative_key)
    except ClientError as e:
        print(f"❌ Error listing remote files: {e}")
        return
    
    # 查找本地多余的文件
    local_files = set()
    if local_path.exists():
        for file_path in local_path.rglob("*"):
            if file_path.is_file():
                relative_path = str(file_path.relative_to(local_path)).replace(os.sep, '/')
                local_files.add(relative_path)
    
    # 删除本地多余的文件
    extra_files = local_files - remote_files
    if extra_files:
        print(f"🗑️ Deleting {len(extra_files)} local files not in remote:")
        for relative_path in extra_files:
            local_file = local_path / relative_path
            if local_file.exists():
                local_file.unlink()
                print(f"  Deleted: {relative_path}")
    
    # 下载远程文件
    download_files(s3_client, local_path, base_dir, incremental=False)


def main():
    parser = argparse.ArgumentParser(description="Download files from S3-compatible storage (Backblaze B2)")
    parser.add_argument("local_path", nargs="?", default=None,
                       help="Local directory to download to")
    parser.add_argument("command", nargs="?", default="incremental", 
                       choices=["download", "incremental", "list", "sync"],
                       help="Command to execute (default: incremental)")
    parser.add_argument("--base-dir", "-b", type=str, default=BASE_DIR,
                       help=f"S3 base directory (default: {BASE_DIR})")
    
    args = parser.parse_args()
    
    # 检查配置
    if not ACCESS_KEY or not SECRET_KEY or not BUCKET_NAME:
        print("❌ Error: Missing S3 credentials. Please set environment variables:")
        print("  S3_ACCESS_KEY")
        print("  S3_SECRET_KEY")
        print("  S3_BUCKET")
        print("  S3_ENDPOINT")
        print("\n💡 You can create a .env file with these variables (see .env.example)")
        sys.exit(1)
    
    # 检查路径参数
    if args.local_path is None:
        print("❌ Error: Please specify a local directory for download")
        print("\n📝 Usage examples:")
        print("  python scripts/download_from_s3.py ./web")
        print("  python scripts/download_from_s3.py ./backup download")
        print("  python scripts/download_from_s3.py ./web list")
        print("  python scripts/download_from_s3.py ./backup sync")
        sys.exit(1)
    
    local_path = Path(args.local_path)
    
    try:
        # 创建 S3 客户端
        s3_client = create_s3_client()
        
        # 测试连接
        print("🔐 Testing S3 connection...")
        s3_client.head_bucket(Bucket=BUCKET_NAME)
        print("✅ S3 connection successful")
        
        # 执行命令
        if args.command == "download":
            download_files(s3_client, local_path, args.base_dir, incremental=False)
        elif args.command == "incremental":
            download_files(s3_client, local_path, args.base_dir, incremental=True)
        elif args.command == "list":
            list_remote_files(s3_client, args.base_dir)
        elif args.command == "sync":
            sync_from_remote(s3_client, local_path, args.base_dir)
        
    except NoCredentialsError:
        print("❌ Error: Invalid S3 credentials")
        sys.exit(1)
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchBucket':
            print(f"❌ Error: Bucket '{BUCKET_NAME}' not found")
        else:
            print(f"❌ S3 Error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()