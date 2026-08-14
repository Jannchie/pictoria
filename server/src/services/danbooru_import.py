"""Download a Danbooru tag search and persist the new posts + their tags.

Lifted out of ``CommandController.download_from_danbooru`` so the HTTP handler
is a thin call: fetch → filter to supported images → skip posts that already
have manual tags → download the files → persist the ones that landed on disk
(tags, then posts+links, each in its own retried transaction). Download precedes
persist on purpose: a post row must not exist before its file, or the sync
reconciler's ``remove_deleted_files`` races the throttled download and deletes
the just-committed post mid-flight (see ``import_danbooru_posts``). The
transaction/retry shape is load-bearing under concurrent imports.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

    from danbooru import DanbooruPost


# How many consecutive listing pages must hold nothing left to import before
# pagination gives up. Pages arrive newest-id-first, so one such page already
# means we're in history; two is cheap insurance against a page that only
# looks settled (e.g. a batch whose files failed to download last run and were
# since deleted upstream).
_SETTLED_PAGE_STREAK = 2


SUPPORTED_IMAGE_EXTS: frozenset[str] = frozenset(
    {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tiff", "tif", "svg"},
)

# Windows forbids these in filename components; Danbooru tags like `re:rin`
# would otherwise fail mkdir on win32.
_FS_ILLEGAL_CHARS: frozenset[str] = frozenset('<>:"/\\|?*')


def _is_importable(post: DanbooruPost) -> bool:
    """Would this listing entry ever produce a file we keep?

    The single definition of what this importer accepts — the ``filtered``
    narrowing and the pagination stopper both go through it. Entries that fail
    it (deleted/banned posts with no ``file_url``, videos, zips) can never be
    imported, so the stopper must not count them as "still pending", or a
    single upstream video would keep a settled page looking unfinished and
    defeat early termination forever.
    """
    return bool(post.file_url) and bool(post.file_ext) and post.file_ext.lower() in SUPPORTED_IMAGE_EXTS


def _is_pending(post: DanbooruPost, imported_ids: set[str]) -> bool:
    """Is this post one we still have to fetch?

    The whole dedup rule in one place. The stopper and the ``to_persist``
    filter must agree on it exactly: a stopper that counts a still-wanted post
    as settled stops paging over posts the importer would have taken.
    """
    return _is_importable(post) and str(post.id) not in imported_ids


def _settled_page_stopper(
    imported_ids: set[str],
    streak: int = _SETTLED_PAGE_STREAK,
) -> Callable[[list[DanbooruPost]], bool]:
    """Build the ``stop_paging`` predicate for ``DanbooruClient.get_posts``.

    A page is *settled* when it holds at least one post we've already imported
    with tags and none that still need importing. ``streak`` settled pages in a
    row ends pagination. Requiring a positive already-imported hit is what
    separates "we've caught up with history" from "this page happens to be all
    videos" — the latter neither advances nor resets the streak.

    Any pending post resets the streak, so gaps (a download that failed last
    run, a bare row awaiting its tags) still get walked past and retried.
    """
    settled_run = 0

    def _stop(page: list[DanbooruPost]) -> bool:
        nonlocal settled_run
        if any(_is_pending(p, imported_ids) for p in page):
            settled_run = 0
            return False
        if any(str(p.id) in imported_ids for p in page):
            settled_run += 1
        return settled_run >= streak

    return _stop


def _build_tag_to_group(d_post: DanbooruPost, type_to_group_id: dict[str, int]) -> dict[str, int]:
    """Collect (tag_name → group_id) from a Danbooru post's tag_string_* fields.

    `type_to_group_id` is ordered by priority; setdefault keeps the first
    (highest-priority) group when a tag appears under multiple types.
    """
    tag_to_group: dict[str, int] = {}
    for t, gid in type_to_group_id.items():
        # str.split() with no args also drops empty entries
        for tag_str in getattr(d_post, f"tag_string_{t}").split():
            tag_to_group.setdefault(tag_str, gid)
    return tag_to_group
