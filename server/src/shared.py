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

target_dir = Path()
pictoria_dir = Path()
thumbnails_dir = Path()
should_watch = True
stop_event = threading.Event()


openai_key: None | str = None
caption_annotator: Optional["OpenAIImageAnnotator"] = None


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
