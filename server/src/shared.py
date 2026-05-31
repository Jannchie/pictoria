import json
import logging
import threading
import typing
from pathlib import Path
from typing import Literal, Optional

from PIL import ImageFile
from rich import get_console
from rich.logging import RichHandler

if typing.TYPE_CHECKING:
    from ai import OpenAIImageAnnotator


ImageFile.LOAD_TRUNCATED_IMAGES = True

console = get_console()
logging.basicConfig(
    level=logging.INFO,
    format="%(name)s: %(message)s",
    datefmt="[%X]",
    handlers=[RichHandler(console=console)],
)
# These libraries log every HTTP request / file lock at INFO, which floods the
# console — most visibly huggingface_hub's per-file etag HEAD requests on every
# model load (via httpx). Lift them to WARNING so only real problems surface.
for _noisy in ("httpx", "huggingface_hub", "urllib3", "filelock"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

target_dir = Path()
pictoria_dir = Path()
thumbnails_dir = Path()
should_watch = True
stop_event = threading.Event()

# Set by the Litestar lifespan when the process is shutting down. Long-running
# loops (the backfill workers in particular) poll this between batches and bail
# at the next safe boundary instead of being interrupted mid-DB-write.
shutdown_event = threading.Event()

# Populated once on startup by ``ensure_canonical_tag_groups_sync``. The
# WDTagger backfill path used to call ``tag_groups.ensure(name, color=…)`` for
# every image — that's 4 SQL upserts × every post in the library, all redundant
# because the groups never change after startup. Reading this dict instead
# turns those into in-memory lookups.
canonical_tag_groups: dict[str, int] = {}


openai_key: None | str = None
caption_annotator: Optional["OpenAIImageAnnotator"] = None

# Post scoring / rating bounds. The frontend's <Rating> uses score 0..5
# (six states including zero) and rating 0..4 (four severity tiers). The
# controllers validate against these constants so the bounds live in one
# place — moving the rating count requires updating only here, the
# frontend Rating widget, and any migration touching the column.
MAX_POST_SCORE = 5
MAX_POST_RATING = 4


def get_logger():
    logger = logging.getLogger("pictoria")
    logger.setLevel(logging.INFO)
    return logger


class I18N:
    def __init__(self) -> None:
        self.data = {}

    def t(self, lang: Literal["zh-Hans", "en"], key: str, default: str | None = None) -> str:
        if lang not in self.data:
            try:
                with Path(f"data/tag.{lang}.json").open(encoding="utf-8") as file:
                    self.data[lang] = json.load(file)
            except FileNotFoundError:
                self.data[lang] = {}
        if default == "":
            default = key
        return self.data[lang].get(key, default) or key


i18n = I18N()
logger = get_logger()


s3_access_key = ""
s3_secret_key = ""
s3_endpoint = ""
s3_bucket = "pictoria"
s3_base_dir = "collections"

# When True, the basics worker skips arthash computation and the pending-query
# stops re-selecting posts whose only missing column is arthash. Driven by the
# ``DISABLE_ARTHASH`` env var; flipped on by ``utils.initialize``.
disable_arthash = False
