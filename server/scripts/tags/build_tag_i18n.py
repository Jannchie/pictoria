"""Build data/tag.<lang>.json from the curated tree + danbooru_metadata name maps.

Three sources, lowest to highest priority (later wins on conflicts):

1. GPT-era fallback: the existing table's entries (legacy space-form keys
   normalised to underscores) — mostly characters/artists translated by GPT.
2. danbooru-tags-tree (https://github.com/Jannchie/danbooru-tags-tree,
   data/source/danbooru_tag_tree_v3.multilingual.yaml) — a curated tree of
   ~22k general danbooru tags with en/ja/zh-CN names.
3. danbooru_metadata name maps (--name-maps DIR pointing at its
   data/outputs/translations) — {tag: {en, ja, ko, zh_hans, zh_hant}} for
   copyright/character/artist tags, synthesised from danbooru wiki
   other_names + artist aliases with OpenCC CJK cross-fill. These are
   sourced from danbooru itself, so they beat both fallbacks.

For *artists* the name maps are authoritative for every tag they know, not
just the translated ones: a known artist with no name in this language gets
no entry at all (the UI falls back to the raw tag name). Artist handles have
no "correct" translation, so the GPT-era literal guesses are fabrications —
"cutesexyrobutts" must display as-is, not as "可爱性感的机器人屁股".

Characters/copyrights are different: they *do* have established localized
names that GPT mostly got right ("lum" -> 拉姆, "kurosawa_ruby" -> 黑泽露比),
and a missing wiki other_name is usually incomplete data rather than
evidence no localized name exists. Their legacy entries stay as fallback;
the name maps still override whatever they do cover.

Output keys use the DB's underscore form ("green_eyes"), matching what
``services.tag_i18n.translate_tag`` looks up.

Run from server/:
    uv run --with pyyaml python scripts/tags/build_tag_i18n.py \
        [--tree path/to/tree.yaml] [--name-maps E:/danbooru_metadata/data/outputs/translations]
(downloads the tree YAML when --tree is not given)
"""

from __future__ import annotations

import argparse
import json
import pathlib
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
# our table file suffix -> name_map language key
NAME_MAP_LANGS = {"zh-Hans": "zh_hans", "ja": "ja"}
# The synthesised final products of danbooru_metadata's build_name_map.py
# (the *_names.json / *_official.json files there are its raw inputs).
NAME_MAP_FILES = ("copyright_name_map.json", "character_name_map.json", "artist_name_map.json")
# Categories whose known-but-untranslated tags purge the legacy fallback
# (see module docstring: artist handles have no correct translation to fall
# back to; character/copyright names usually do).
AUTHORITY_FILES = ("artist_name_map.json",)


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


def load_name_maps(dir_path: pathlib.Path) -> tuple[dict[str, dict[str, str]], set[str]]:
    """Union of the three name maps plus the authority key set.

    Returns ``({tag_name: {lang_key: display_name}}, authority_keys)``; tag
    keys are already in the DB's underscore form. Loaded once for all output
    languages. ``authority_keys`` holds the tags from AUTHORITY_FILES whose
    legacy fallback entries must be dropped even when untranslated.
    """
    out: dict[str, dict[str, str]] = {}
    authority: set[str] = set()
    for fname in NAME_MAP_FILES:
        path = dir_path / fname
        if not path.is_file():
            print(f"  {fname}: missing, skipped")
            continue
        m = json.loads(path.read_text(encoding="utf-8"))
        out.update(m)
        if fname in AUTHORITY_FILES:
            authority.update(m)
        print(f"  {fname}: {len(m)} tags")
    return out, authority


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree", help="local tree YAML (downloaded when omitted)")
    parser.add_argument(
        "--name-maps",
        type=pathlib.Path,
        help="danbooru_metadata data/outputs/translations dir (highest-priority source)",
    )
    args = parser.parse_args()

    tree = load_tree(args.tree)
    print(f"tree tags: {len(tree)}")

    name_maps: dict[str, dict[str, str]] = {}
    authority_keys: set[str] = set()
    if args.name_maps:
        name_maps, authority_keys = load_name_maps(args.name_maps)

    for tree_lang, suffix in LANGS.items():
        out_path = DATA_DIR / f"tag.{suffix}.json"
        table: dict[str, str] = {}

        # 1. GPT-era fallback: reuse the existing table's entries (legacy
        # space-form keys normalised to underscores) — except tags in the
        # authority set (artists). For those, no name-map name in this
        # language means the raw tag name *is* the display name, not
        # whatever the GPT batch fabricated for an untranslatable handle.
        if out_path.exists():
            old = json.loads(out_path.read_text(encoding="utf-8"))
            legacy = {k.replace(" ", "_"): v for k, v in old.items()}
            table.update({k: v for k, v in legacy.items() if k not in authority_keys})
            print(
                f"{out_path.name}: kept {len(table)} legacy entries as fallback "
                f"(purged {len(legacy) - len(table)} known-artist machine guesses)",
            )

        # 2. The curated tree wins over legacy.
        tree_entries = {name: v[tree_lang] for name, v in tree.items() if v.get(tree_lang)}
        table.update(tree_entries)

        # 3. danbooru_metadata name maps win over everything.
        lang_key = NAME_MAP_LANGS[suffix]
        map_entries = {tag: v[lang_key] for tag, v in name_maps.items() if v.get(lang_key)}
        table.update(map_entries)

        out_path.write_text(
            json.dumps(table, ensure_ascii=False, indent=0, sort_keys=True),
            encoding="utf-8",
        )
        print(
            f"{out_path.name}: wrote {len(table)} entries "
            f"({len(tree_entries)} from tree, {len(map_entries)} from name maps)",
        )


if __name__ == "__main__":
    main()
