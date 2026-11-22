#!/usr/bin/env python3
"""
S3 Compatible Upload Script
使用 S3 兼容 API 上传文件到 Backblaze B2 存储
"""

import os
import sys
import time
import argparse
from pathlib import Path
from typing import List
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

# 确保 BASE_DIR 以 / 结尾
if BASE_DIR and not BASE_DIR.endswith("/"):
    BASE_DIR += "/"

# 图库里进程私有的目录：两个 sqlite（API 一直开着，逐字节拷出来的是不一致的文件）、
# 缩略图、gallery-dl.conf（含 cookies）。和 rclone / awscli 脚本一样永远不进同步，
# 见 scripts/README.md。数据库用 server/scripts/backup_db.py 备份。
PRIVATE_DIR = ".pictoria"


def is_private(relative_parts) -> bool:
    """相对路径的任意一段是 `.pictoria` 就算私有。"""
    return PRIVATE_DIR in relative_parts



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


def get_local_files(local_path: Path, incremental: bool = False) -> List[Path]:
    """获取要上传的本地文件列表"""
    marker_file = Path(".s3_last_sync")
    
    files = []
    
    if incremental:
        if marker_file.exists():
            last_sync = marker_file.stat().st_mtime
            print(f"🔄 Incremental upload - finding files newer than {time.ctime(last_sync)}")
            
            for file_path in local_path.rglob("*"):
                if file_path.is_file() and file_path.stat().st_mtime > last_sync:
                    files.append(file_path)
        else:
            print("🔄 First time incremental upload - uploading all files")
            files = [f for f in local_path.rglob("*") if f.is_file()]
    else:
        print("📁 Full upload - scanning all files")
        files = [f for f in local_path.rglob("*") if f.is_file()]
    
    return [f for f in files if not is_private(f.relative_to(local_path).parts)]


def upload_file(s3_client, local_path: Path, s3_key: str) -> bool:
    """上传单个文件"""
    try:
        file_size = local_path.stat().st_size
        print(f"📤 Uploading: {s3_key} ({format_size(file_size)})")
        
        # 上传文件
        s3_client.upload_file(
            str(local_path),
            BUCKET_NAME,
            s3_key,
            ExtraArgs={'ContentType': 'application/octet-stream'}
        )
        
        print(f"✅ Uploaded: {s3_key}")
        return True
        
    except ClientError as e:
        print(f"❌ Failed to upload {s3_key}: {e}")
        return False
    except Exception as e:
        print(f"❌ Error uploading {s3_key}: {str(e)}")
        return False


def file_exists_and_same_size(s3_client, s3_key: str, local_size: int) -> bool:
    """检查远程文件是否存在且大小相同"""
    try:
        response = s3_client.head_object(Bucket=BUCKET_NAME, Key=s3_key)
        remote_size = response['ContentLength']
        return remote_size == local_size
    except ClientError as e:
        if e.response['Error']['Code'] == '404':
            return False
        print(f"⚠️ Error checking {s3_key}: {e}")
        return False


def upload_files(s3_client, local_path: Path, base_dir: str, incremental: bool = False, skip_existing: bool = True) -> None:
    """上传文件"""
    files = get_local_files(local_path, incremental)
    
    if not files:
        print("📭 No files to upload")
        return
    
    print(f"📊 Found {len(files)} files to upload")
    
    success_count = 0
    skipped_count = 0
    total_size = 0
    
    for i, file_path in enumerate(files, 1):
        # 计算相对路径和 S3 key
        relative_path = file_path.relative_to(local_path)
        s3_key = base_dir + str(relative_path).replace(os.sep, '/')
        file_size = file_path.stat().st_size
        
        # 检查是否跳过已存在的文件
        if skip_existing and file_exists_and_same_size(s3_client, s3_key, file_size):
            print(f"⏭️  Skipping (same size): {s3_key}")
            skipped_count += 1
            continue
        
        if upload_file(s3_client, file_path, s3_key):
            success_count += 1
            total_size += file_size
        
        if i % 10 == 0:
            print(f"📈 Progress: {i}/{len(files)} files processed")
    
    # 更新同步标记
    if incremental or success_count > 0:
        Path(".s3_last_sync").touch()
    
    print(f"\n🎉 Upload completed!")
    print(f"📊 Summary: {success_count} uploaded, {skipped_count} skipped, {len(files)} total")
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
        for page in pages:
            if 'Contents' in page:
                for obj in page['Contents']:
                    total_files += 1
                    key = obj['Key']
                    size = obj['Size']
                    modified = obj['LastModified'].strftime('%Y-%m-%d %H:%M:%S')
                    
                    # 移除前缀显示相对路径
                    relative_key = key.replace(base_dir, "", 1)
                    
                    print(f"{relative_key:<50} {format_size(size):<10} {modified}")
        
        print(f"\nTotal files: {total_files}")
        
    except ClientError as e:
        print(f"❌ Error listing files: {e}")


def main():
    parser = argparse.ArgumentParser(description="Upload files to S3-compatible storage (Backblaze B2)")
    parser.add_argument("local_path", nargs="?", default=None,
                       help="Local directory to upload")
    parser.add_argument("--full", action="store_true", 
                       help="Full upload (default is incremental)")
    parser.add_argument("--base-dir", "-b", type=str, default=BASE_DIR,
                       help=f"S3 base directory (default: {BASE_DIR})")
    parser.add_argument("--force", "-f", action="store_true",
                       help="Force upload even if file exists with same size")
    parser.add_argument("--list", action="store_true",
                       help="List remote files instead of uploading")
    
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
    if args.local_path is None and not args.list:
        print("❌ Error: Please specify a local directory to upload")
        print("\n📝 Usage examples:")
        print("  python scripts/upload_to_s3.py ./web")
        print("  python scripts/upload_to_s3.py ./dist --full")
        print("  python scripts/upload_to_s3.py --list")
        sys.exit(1)
    
    if args.local_path:
        local_path = Path(args.local_path)
        if not local_path.exists():
            print(f"❌ Error: Local path does not exist: {local_path}")
            sys.exit(1)
    
    try:
        # 创建 S3 客户端
        s3_client = create_s3_client()
        
        # 测试连接
        print("🔐 Testing S3 connection...")
        s3_client.head_bucket(Bucket=BUCKET_NAME)
        print("✅ S3 connection successful")
        
        if args.list:
            list_remote_files(s3_client, args.base_dir)
        else:
            # 上传文件（默认增量上传）
            is_incremental = not args.full  # 默认增量，除非指定 --full
            upload_files(
                s3_client, 
                local_path, 
                args.base_dir, 
                is_incremental,
                not args.force
            )
        
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