"""Process-wide logging setup, plus the one logger everything else imports.

This module used to also hold the mutable globals the Litestar app filled in at
startup — resolved paths, the shutdown event, the canonical tag-group cache, S3
credentials, scoring bounds. All of it went with the HTTP server: the worker
resolves paths through ``worker.handlers.library_root()``, cairnq owns task
lifecycle, and the TS side owns everything that touches the database. What is
left is import-time configuration with no state to initialise.
"""

import logging

from PIL import ImageFile
from rich import get_console
from rich.logging import RichHandler

ImageFile.LOAD_TRUNCATED_IMAGES = True

logging.basicConfig(
    level=logging.INFO,
    format="%(name)s: %(message)s",
    datefmt="[%X]",
    handlers=[RichHandler(console=get_console())],
)
# These libraries log every HTTP request / file lock at INFO, which floods the
# console — most visibly huggingface_hub's per-file etag HEAD requests on every
# model load (via httpx). Lift them to WARNING so only real problems surface.
for _noisy in ("httpx", "huggingface_hub", "urllib3", "filelock"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)


def get_logger():
    logger = logging.getLogger("pictoria")
    logger.setLevel(logging.INFO)
    return logger


logger = get_logger()
