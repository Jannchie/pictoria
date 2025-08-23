#!/usr/bin/env python3
"""
Environment Variable Loader
从 .env 文件加载环境变量的工具
"""

import os
from pathlib import Path


def load_env(env_file: str = ".env") -> None:
    """从 .env 文件加载环境变量"""
    env_path = Path(__file__).parent / env_file
    
    if not env_path.exists():
        print(f"⚠️ Environment file not found: {env_path}")
        print("💡 Please copy .env.example to .env and configure your credentials")
        return
    
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            
            # 跳过空行和注释
            if not line or line.startswith('#'):
                continue
            
            # 解析 KEY=VALUE 格式
            if '=' in line:
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                
                # 设置环境变量
                os.environ[key] = value
    
    print(f"✅ Loaded environment variables from: {env_path}")


def show_config() -> None:
    """显示当前配置"""
    print("📋 Current B2 Configuration:")
    print(f"  S3_ACCESS_KEY: {os.getenv('S3_ACCESS_KEY', 'NOT SET')}")
    print(f"  S3_SECRET_KEY: {'***' if os.getenv('S3_SECRET_KEY') else 'NOT SET'}")
    print(f"  S3_BUCKET: {os.getenv('S3_BUCKET', 'NOT SET')}")
    print(f"  S3_BASE_DIR: {os.getenv('S3_BASE_DIR', 'NOT SET')}")
    print(f"  S3_ENDPOINT: {os.getenv('S3_ENDPOINT', 'NOT SET')}")


if __name__ == "__main__":
    load_env()
    show_config()