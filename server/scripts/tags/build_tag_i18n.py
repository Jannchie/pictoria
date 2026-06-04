"""Build data/tag.<lang>.json from the danbooru-tags-tree multilingual YAML.

Source: https://github.com/Jannchie/danbooru-tags-tree
(data/source/danbooru_tag_tree_v3.multilingual.yaml) — a curated tree of
~22k general danbooru tags with en/ja/zh-CN names. Character/artist tags are
not in the tree, so for zh-Hans the previous GPT-translated table (the old
data/tag.zh-Hans.json, space-form keys) backfills them: measured against a
170k-post library this lifts post-count-weighted coverage from ~90% to ~98.5%.

Output keys use the DB's underscore form ("green_eyes"), matching what
``services.tag_i18n.translate_tag`` looks up.

Run from server/:
    uv run --with pyyaml python scripts/tags/build_tag_i18n.py [path/to/tree.yaml]
(downloads the YAML when no path is given)
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.request

import yaml

SERVER_ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA_DIR = SERVER_ROOT / "data"
TREE_URL = (
    "https://raw.githubusercontent.com/Jannchie/danbooru-tags-tree/main/"
    "data/source/danbooru_tag_tree_v3.multilingual.yaml"
)
# tree language code -> our table file suffix
LANGS = {"zh-CN": "zh-Hans", "ja": "ja"}


def load_tree(path: str | None) -> dict[str, dict[str, str]]:
    if path:
        text = pathlib.Path(path).read_text(encoding="utf-8")
    else:
        print(f"downloading {TREE_URL}")
        with urllib.request.urlopen(TREE_URL) as resp:  # noqa: S310
            text = resp.read().decode("utf-8")
    data = yaml.safe_load(text)
    # Keys are "tag.<name>" / "category.<path>"; tag names may themselves
    # contain dots, so strip the fixed prefix instead of splitting.
    return {k[4:]: v for k, v in data.items() if k.startswith("tag.") and v}


def main() -> None:
    tree = load_tree(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"tree tags: {len(tree)}")

    for tree_lang, suffix in LANGS.items():
        out_path = DATA_DIR / f"tag.{suffix}.json"
        table: dict[str, str] = {}

        # GPT-era fallback: reuse the existing table's entries (legacy
        # space-form keys normalised to underscores) for tags the curated
        # tree doesn't cover — mostly characters and artists.
        if out_path.exists():
            old = json.loads(out_path.read_text(encoding="utf-8"))
            table.update({k.replace(" ", "_"): v for k, v in old.items()})
            print(f"{out_path.name}: kept {len(table)} legacy entries as fallback")

        tree_entries = {name: v[tree_lang] for name, v in tree.items() if v.get(tree_lang)}
        table.update(tree_entries)  # the curated tree wins on conflicts
        out_path.write_text(
            json.dumps(table, ensure_ascii=False, indent=0, sort_keys=True),
            encoding="utf-8",
        )
        print(f"{out_path.name}: wrote {len(table)} entries ({len(tree_entries)} from tree)")


if __name__ == "__main__":
    main()
