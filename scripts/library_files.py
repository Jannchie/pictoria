#!/usr/bin/env python3
"""
图库里哪些文件进同步 —— boto3 脚本（upload_to_s3.py / download_from_s3.py）共用。

图库里进程私有的目录：两个 sqlite（API 一直开着，逐字节拷出来的是不一致的文件）、
缩略图、gallery-dl.conf（含 cookies）。和 rclone / awscli 脚本一样永远不进同步，
见 scripts/README.md。数据库用 server/scripts/backup_db.py 备份。
"""

import os
from pathlib import Path
from typing import Iterable, Iterator

PRIVATE_DIR = ".pictoria"


def is_private(relative_parts: Iterable[str]) -> bool:
    """相对路径的任意一段是 `.pictoria` 就算私有。"""
    return PRIVATE_DIR in relative_parts


def iter_library_files(root: Path) -> Iterator[Path]:
    """`root` 下所有进同步的文件。

    私有目录在遍历时就地剪掉，而不是走完再过滤：`.pictoria/thumbnails` 的文件数和
    图库同量级，逐个 stat 一遍再丢掉是白花的时间。
    """
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != PRIVATE_DIR]
        for name in filenames:
            yield Path(dirpath, name)
