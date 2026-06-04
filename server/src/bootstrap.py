"""Process startup assembly: CLI args, paths, env-driven config.

Everything here mutates the ``shared`` module-level config exactly once at
boot (``initialize``) — request handlers and workers read ``shared.*`` and
never call back into this module.
"""

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

import shared
from shared import logger

load_dotenv()


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4777)
    parser.add_argument("--target_dir", type=str, default=".")
    parser.add_argument("--openai_key", type=str, default=None)
    return parser.parse_args()


def initialize(target_dir: os.PathLike, openai_key: str | None = None) -> None:
    prepare_paths(Path(target_dir))
    prepare_openai_api(openai_key)
    prepare_s3()
    prepare_feature_flags()
    init_thumbnails_directory()


def prepare_paths(target_path: Path) -> None:
    shared.target_dir = get_target_dir(target_path)
    shared.pictoria_dir = get_pictoria_directory()


def prepare_openai_api(openai_key: str | None) -> None:
    if not shared.pictoria_dir:
        logger.warning("Pictoria directory not set, skipping OpenAI API key setup")
        return
    if shared.pictoria_dir.joinpath("OPENAI_API_KEY").exists():
        with shared.pictoria_dir.joinpath("OPENAI_API_KEY").open() as f:
            shared.openai_key = f.read().strip()
    if openai_key:
        shared.openai_key = openai_key


def prepare_s3() -> None:
    shared.s3_endpoint = os.environ.get("S3_ENDPOINT")
    shared.s3_access_key = os.environ.get("S3_ACCESS_KEY")
    shared.s3_secret_key = os.environ.get("S3_SECRET_KEY")
    shared.s3_bucket = os.environ.get("S3_BUCKET", "pictoria")
    shared.s3_base_dir = os.environ.get("S3_BASE_DIR", "collections")


_TRUTHY = {"1", "true", "yes", "on"}


def prepare_feature_flags() -> None:
    shared.disable_arthash = os.environ.get("DISABLE_ARTHASH", "").lower() in _TRUTHY
    if shared.disable_arthash:
        logger.info("DISABLE_ARTHASH=1: skipping arthash computation in the basics worker")


def get_pictoria_directory():
    pictoria_dir = shared.target_dir / ".pictoria"
    if not pictoria_dir.exists():
        pictoria_dir.mkdir()
        logger.info(f'Created directory "{pictoria_dir}"')
    return pictoria_dir


def validate_path(target_path: Path):
    if not target_path.exists():
        logger.info(f'Error: Path "{target_path}" does not exist')
        sys.exit(1)


def get_target_dir(target_path: Path) -> Path:
    target_dir = target_path.resolve()
    validate_path(target_dir)
    logger.info(f"Target directory: {target_dir}")
    return target_dir


def init_thumbnails_directory():
    shared.thumbnails_dir = shared.pictoria_dir / "thumbnails"
    logger.info(f"Thumbnails directory: {shared.thumbnails_dir}")
    if not shared.thumbnails_dir.exists():
        shared.thumbnails_dir.mkdir()
        logger.info(f'Created directory "{shared.thumbnails_dir}"')
