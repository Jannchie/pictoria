"""Build data/tag-tree.json from danbooru-tags-tree's taxonomy.

Sibling of ``build_tag_i18n.py``, which already reads the same upstream repo --
but only for the ``tag.*`` half of the multilingual file (display names). This
script takes the other half: the *structure*. Two files, both from
https://github.com/Jannchie/danbooru-tags-tree:

1. ``danbooru_tag_tree_v3.yaml`` -- the nested taxonomy. Leaves are arrays of
   danbooru tag names, so it doubles as the tag -> category assignment. Every
   tag appears under exactly one leaf (checked below, not assumed).
2. ``danbooru_tag_tree_v3.multilingual.yaml`` -- flat ``category.<path>`` keys
   with ``en`` / ``ja`` / ``zh-CN`` names for each node.

The taxonomy is *owned upstream* and this import is one-way. That repo's README
records what happened the last time this data round-tripped between three
projects with no owner: `censored` sat there as 已遮挡 long after it was fixed
to 已打码, because a correction reached the other two only by accident. Nothing
here writes back, and nothing here edits the tree locally -- fix it upstream and
re-run.

Traditional Chinese is derived the same way ``build_tag_i18n.py`` derives it:
opencc ``s2tw``, glyphs only. The tree has no zh-Hant column of its own and
these are 888 short category labels, not the 200k reviewed tag names that
justified layering a curated table on top there.

Run from server/:
    uv run --with pyyaml --with opencc python scripts/tags/build_tag_tree.py \
        [--tree PATH] [--multilingual PATH] [--repo DIR]
(downloads both files when neither a path nor --repo is given; --repo defaults
to $DANBOORU_TAG_TREE)
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import urllib.request

import opencc
import yaml

SERVER_ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA_DIR = SERVER_ROOT / "data"
OUTPUT = DATA_DIR / "tag-tree.json"

RAW_BASE = (
    "https://raw.githubusercontent.com/Jannchie/danbooru-tags-tree/main/data/source/"
)
TREE_FILE = "danbooru_tag_tree_v3.yaml"
MULTILINGUAL_FILE = "danbooru_tag_tree_v3.multilingual.yaml"

# Node names carry no language tag of their own in the tree file; the
# multilingual file is keyed with this prefix. Tag names may contain dots, so
# strip the fixed prefix rather than splitting on ".".
CATEGORY_PREFIX = "category."

# tree language code -> our suffix, matching build_tag_i18n.py's LANGS
LANGS = {"en": "en", "ja": "ja", "zh-CN": "zh-Hans"}
DERIVED_LANGS = {"zh-Hant": "zh-Hans"}
DERIVE_CONVERSION = "s2tw"


def _read(path: str | None, filename: str, repo: pathlib.Path | None) -> str:
    if path:
        return pathlib.Path(path).read_text(encoding="utf-8")
    if repo:
        return (repo / "data" / "source" / filename).read_text(encoding="utf-8")
    url = RAW_BASE + filename
    print(f"downloading {url}")
    with urllib.request.urlopen(url) as resp:  # noqa: S310
        return resp.read().decode("utf-8")


def walk_tree(node: object, path: list[str], out: dict[str, list[str]]) -> None:
    """Collect leaf path -> tags, in the file's own (depth-first) order."""
    if isinstance(node, list):
        out[".".join(path)] = [t for t in node if isinstance(t, str)]
        return
    if not isinstance(node, dict):
        return
    for key, value in node.items():
        walk_tree(value, [*path, key], out)


def collect_nodes(leaves: dict[str, list[str]]) -> list[str]:
    """Every node path, parents included, in depth-first order.

    The tree file only names a node where it appears; a parent that holds
    nothing but children is never written as a key on its own. Walking the leaf
    paths and emitting each prefix the first time it is seen reconstructs the
    interior nodes while keeping the file's order, which is what makes the
    output renderable top to bottom without a sort.
    """
    seen: set[str] = set()
    ordered: list[str] = []
    for leaf in leaves:
        parts = leaf.split(".")
        for depth in range(1, len(parts) + 1):
            path = ".".join(parts[:depth])
            if path not in seen:
                seen.add(path)
                ordered.append(path)
    return ordered


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree", help=f"local {TREE_FILE} (downloaded when omitted)")
    parser.add_argument(
        "--multilingual",
        help=f"local {MULTILINGUAL_FILE} (downloaded when omitted)",
    )
    parser.add_argument(
        "--repo",
        type=pathlib.Path,
        default=(
            pathlib.Path(os.environ["DANBOORU_TAG_TREE"])
            if os.environ.get("DANBOORU_TAG_TREE")
            else None
        ),
        help="danbooru-tags-tree checkout to read both files from",
    )
    args = parser.parse_args()

    tree = yaml.safe_load(_read(args.tree, TREE_FILE, args.repo))
    meta = tree.pop("_meta", {}) or {}
    multilingual = yaml.safe_load(_read(args.multilingual, MULTILINGUAL_FILE, args.repo))

    leaves: dict[str, list[str]] = {}
    walk_tree(tree, [], leaves)

    # One tag, one category. Asserted rather than assumed: the whole point of a
    # single `category` column downstream is that this holds.
    owner: dict[str, str] = {}
    duplicates: list[tuple[str, str, str]] = []
    for path, tags in leaves.items():
        for tag in tags:
            if tag in owner:
                duplicates.append((tag, owner[tag], path))
            else:
                owner[tag] = path
    if duplicates:
        shown = ", ".join(f"{t} ({a} / {b})" for t, a, b in duplicates[:5])
        message = f"{len(duplicates)} tag(s) in more than one category: {shown}"
        raise SystemExit(message)

    names = {
        key[len(CATEGORY_PREFIX) :]: value
        for key, value in multilingual.items()
        if key.startswith(CATEGORY_PREFIX) and isinstance(value, dict)
    }

    convert = opencc.OpenCC(DERIVE_CONVERSION).convert
    nodes = collect_nodes(leaves)
    categories = []
    unnamed = []
    for path in nodes:
        entry = names.get(path, {})
        if not entry:
            unnamed.append(path)
        localized = {
            suffix: entry[tree_lang]
            for tree_lang, suffix in LANGS.items()
            if entry.get(tree_lang)
        }
        # English always resolves: the last path segment is already an English
        # slug, so a missing `en` degrades to a readable label rather than a gap
        # the frontend has to special-case.
        localized.setdefault("en", path.rsplit(".", 1)[-1].replace("_", " "))
        for derived, source in DERIVED_LANGS.items():
            if source in localized:
                localized[derived] = convert(localized[source])
        parent = path.rsplit(".", 1)[0] if "." in path else None
        categories.append(
            {
                "path": path,
                "parent": parent,
                "depth": path.count("."),
                "names": localized,
            }
        )

    payload = {
        "meta": {
            "version": meta.get("version"),
            "source": "https://github.com/Jannchie/danbooru-tags-tree",
            "categories": len(categories),
            "tags": len(owner),
        },
        "categories": categories,
        # Keyed by category, not by tag: 733 paths written once each instead of
        # 22k times. The frontend inverts it when it needs tag -> category.
        "tags": {path: tags for path, tags in leaves.items() if tags},
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    size_mb = OUTPUT.stat().st_size / 1024 / 1024
    print(f"{OUTPUT.relative_to(SERVER_ROOT)}: {size_mb:.2f} MB")
    print(f"categories: {len(categories):,} ({len(leaves):,} leaves)")
    print(f"tags: {len(owner):,}")
    if unnamed:
        print(f"categories with no multilingual entry: {len(unnamed)}")
        for path in unnamed[:10]:
            print(f"  {path}")


if __name__ == "__main__":
    main()
