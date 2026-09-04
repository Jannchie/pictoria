"""Build data/tag.<lang>.json from a frozen baseline, the curated tree, and danbooru-tag-index.

Three sources, lowest to highest priority (later wins on conflicts), then one
deletion pass:

1. ``legacy/tag.<lang>.json`` -- a frozen snapshot of the table as it stood before
   this script had a real upstream. Mostly the 2024 gpt-4o-mini batch plus the
   artist names that came from an ``artist_name_map.json`` that no longer exists.
   Frozen, and committed, because it cannot be regenerated: the project that
   produced the artist half has since dropped artists at the source.
2. danbooru-tags-tree (https://github.com/Jannchie/danbooru-tags-tree,
   data/source/danbooru_tag_tree_v3.multilingual.yaml) -- ~22k general danbooru
   tags with en/ja/zh-CN. The only source here for *Japanese* general names.
3. danbooru-tag-index's ``display_names.json`` -- {tag: {en, ja, ko, zh_hans,
   zh_hant}} for character and copyright, after that project has applied its
   reviewed name maps, its translated supplement, its rejections and its manual
   corrections. Those names are selected from Danbooru's own alias pool and then
   reviewed, so they beat both fallbacks.

Then: any tag whose slot for this language is present and null is *removed* from
the table. That is a review saying "the name we had is wrong and there is no
replacement" -- `anchovy_(girls_und_panzer)` was carrying a pairing tag as its
character name. Falling back to the English tag name is the better failure, and
an absent key is exactly how `tag-i18n.ts` expresses it. Leaving the key out of
the export instead would not do: sources 1 and 2 would fill the name back in.

Reading the frozen baseline rather than the previous output is what makes this a
function instead of a ratchet. It used to read its own `data/tag.<lang>.json`,
so every value ever written was permanent -- a wrong name could only be pushed
aside by a better one, never dropped, and no run was reproducible from sources.
Deletions in particular were impossible, which is why step 3's nulls need step 4
to mean anything.

Writes `data/tag.<lang>.changes.tsv` next to each table: every add, change and
removal with its source, ordered by post count. Read it before committing; the
first connected run moves several thousand names.

Run from server/:
    uv run --with pyyaml python scripts/tags/build_tag_i18n.py \
        [--tree path/to/tree.yaml] [--tag-index DIR] [--rank-db path/to/danbooru_metadata.db]
(downloads the tree YAML when --tree is not given; --tag-index defaults to the
sibling checkout, or $DANBOORU_TAG_INDEX)
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sqlite3
import urllib.request

import opencc
import yaml

SERVER_ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA_DIR = SERVER_ROOT / "data"
LEGACY_DIR = pathlib.Path(__file__).resolve().parent / "legacy"
TREE_URL = (
    "https://raw.githubusercontent.com/Jannchie/danbooru-tags-tree/main/"
    "data/source/danbooru_tag_tree_v3.multilingual.yaml"
)
# tree language code -> our table file suffix
LANGS = {"zh-CN": "zh-Hans", "ja": "ja"}
# our table file suffix -> display_names language key
DISPLAY_LANGS = {"zh-Hans": "zh_hans", "ja": "ja", "zh-Hant": "zh_hant"}
# Tables with no source of their own, converted from another table instead.
# Traditional Chinese has neither a frozen baseline nor a tree column, and
# danbooru-tag-index only names the 70k tags it reviewed -- against 200k here.
# So the simplified table is converted wholesale and the reviewed traditional
# names, which include the regional titles a converter cannot produce
# (聖火降魔錄 where the mainland says 火焰纹章), are laid over the top.
DERIVED_LANGS = {"zh-Hant": "zh-Hans"}
# s2tw, not s2twp. Both target Taiwan; only s2twp also swaps vocabulary, and it
# reads ordinary words as IT jargon -- a comic's 對話框 becomes a UI 對話方塊,
# 溢出 becomes 溢位, 打開書本 becomes 開啟書本. s2tw is glyphs only: 衆->眾,
# 牀->床, 羣->群, 啓->啟. Taiwanese vocabulary belongs in a reviewed table.
DERIVE_CONVERSION = "s2tw"
DISPLAY_NAMES_FILE = "display_names.json"
# Languages whose upstream names may *replace* a baseline name rather than only
# fill a gap. Chinese qualifies: danbooru-tag-index picks it with an LLM among the
# wiki candidates and then layers a translated supplement, a rejection list and
# hand-checked corrections over that. Japanese has none of those -- build_name_map
# takes the *shortest* alias in the bucket, and the shortest alias for a character
# is routinely a nickname or a shipping tag: 早川アキ loses to アキ姫, and both
# 狛枝凪闘 and 日向創 collapse into 狛日, which is the pairing of the two. That
# same failure is documented in build_name_map's `primary()` -- the fix landed for
# copyright and never reached character. So Japanese fills gaps only, and the
# 2024 baseline keeps the names it already had right.
OVERRIDE_LANGS = {"zh-Hans"}
# Sibling-checkout default, overridable by env. An absolute path belongs in a
# driver script that knows where every repository lives, not in a build step.
DEFAULT_TAG_INDEX = pathlib.Path(
    os.environ.get("DANBOORU_TAG_INDEX", SERVER_ROOT.parent.parent / "danbooru-tag-index"),
)


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


def load_display_names(tag_index: pathlib.Path) -> dict[str, dict[str, str | None]]:
    """Resolved display names from danbooru-tag-index.

    Hard failure when absent. The previous version of this script merged that
    project's raw name maps itself, skipped them with one line of stdout when the
    directory was not there, and shipped months of unreviewed names after those
    files moved to another repository. A silent skip on the highest-priority
    source is not a degraded build, it is a different build that looks like it
    succeeded.
    """
    path = tag_index / "data" / "translations" / DISPLAY_NAMES_FILE
    if not path.is_file():
        message = (
            f"missing {path}\n"
            "Generate it there with:  uv run python scripts/export_display_names.py\n"
            "Point at another checkout with --tag-index or $DANBOORU_TAG_INDEX, "
            "or pass --without-tag-index to build without reviewed names."
        )
        raise SystemExit(message)
    data = json.loads(path.read_text(encoding="utf-8"))
    print(f"{path.name}: {len(data):,} tags")
    return data


def load_ranks(db: pathlib.Path | None) -> dict[str, int]:
    """Post counts, so the change report leads with the names people actually see."""
    if db is None:
        return {}
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        return {name: count or 0 for name, count in con.execute("SELECT name, post_count FROM tags")}
    finally:
        con.close()


def write_report(
    path: pathlib.Path,
    old: dict[str, str],
    new: dict[str, str],
    source: dict[str, str],
    ranks: dict[str, int],
) -> None:
    rows = []
    for tag in set(old) | set(new):
        before, after = old.get(tag), new.get(tag)
        if before == after:
            continue
        kind = "added" if before is None else "removed" if after is None else "changed"
        rows.append((ranks.get(tag, 0), tag, before or "", after or "", kind, source.get(tag, "-")))
    rows.sort(key=lambda row: (-row[0], row[1]))

    lines = ["post_count\ttag\told\tnew\tkind\tsource"]
    lines += ["\t".join((str(count), tag, before, after, kind, src)) for count, tag, before, after, kind, src in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    counts: dict[tuple[str, str], int] = {}
    for _, _, _, _, kind, src in rows:
        counts[(kind, src)] = counts.get((kind, src), 0) + 1
    print(f"  {path.name}: {len(rows):,} changes")
    for (kind, src), n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"    {kind:8} via {src:20} {n:,}")
    for count, tag, before, after, kind, src in rows[:10]:
        print(f"    {count:>9,}  {tag:38} {before or '-':18} -> {after or '(english)':18} [{src}]")


def apply_reviewed(
    table: dict[str, str],
    source: dict[str, str],
    display: dict[str, dict[str, str | None]],
    lang_key: str,
    *,
    override: bool,
) -> tuple[int, int]:
    """Lay danbooru-tag-index's names over the table, then delete its rejections.

    Returns (named, removed). `override` is the OVERRIDE_LANGS decision: replace a
    name that is already there, or only fill a gap.
    """
    named: dict[str, str] = {}
    for tag, slots in display.items():
        value = slots.get(lang_key)
        if value:
            named[tag] = value
    applied = named if override else {t: v for t, v in named.items() if t not in table}
    table.update(applied)
    source.update(dict.fromkeys(applied, "tag-index"))

    removed = 0
    for tag, slots in display.items():
        if lang_key in slots and slots[lang_key] is None and table.pop(tag, None) is not None:
            removed += 1
            source[tag] = "tag-index:rejected"
    return len(named), removed


def build_table(
    suffix: str,
    tree: dict[str, dict[str, str]],
    tree_lang: str,
    display: dict[str, dict[str, str | None]],
) -> tuple[dict[str, str], dict[str, str], str]:
    """Frozen baseline, then the curated tree, then the reviewed names."""
    table: dict[str, str] = {}
    source: dict[str, str] = {}

    legacy_path = LEGACY_DIR / f"tag.{suffix}.json"
    if not legacy_path.is_file():
        message = f"missing frozen baseline {legacy_path}"
        raise SystemExit(message)
    # Legacy keys used the space form; the DB uses underscores.
    legacy = {k.replace(" ", "_"): v for k, v in json.loads(legacy_path.read_text(encoding="utf-8")).items()}
    table.update(legacy)
    source.update(dict.fromkeys(legacy, "legacy"))

    tree_entries = {name: v[tree_lang] for name, v in tree.items() if v.get(tree_lang)}
    table.update(tree_entries)
    source.update(dict.fromkeys(tree_entries, "tree"))

    named, removed = apply_reviewed(table, source, display, DISPLAY_LANGS[suffix], override=suffix in OVERRIDE_LANGS)
    note = f"{len(legacy):,} baseline, {len(tree_entries):,} tree, {named:,} reviewed, {removed} rejected"
    return table, source, note


def derive_table(
    suffix: str,
    base: dict[str, str],
    from_suffix: str,
    display: dict[str, dict[str, str | None]],
) -> tuple[dict[str, str], dict[str, str], str]:
    """Convert another table wholesale, then lay the reviewed names over it."""
    convert = opencc.OpenCC(DERIVE_CONVERSION).convert
    table = {tag: convert(name) for tag, name in base.items()}
    source = dict.fromkeys(table, f"{DERIVE_CONVERSION}({from_suffix})")

    # The base table already had its rejections removed, so the deletion pass here
    # can only ever be a no-op today. Run it anyway: skipping it would make the two
    # tables disagree the day that stops being true.
    named, removed = apply_reviewed(table, source, display, DISPLAY_LANGS[suffix], override=True)
    note = f"{len(table) - named:,} converted from {from_suffix}, {named:,} reviewed, {removed} rejected"
    return table, source, note


def emit(suffix: str, table: dict[str, str], source: dict[str, str], note: str, ranks: dict[str, int]) -> None:
    out_path = DATA_DIR / f"tag.{suffix}.json"
    previous = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    out_path.write_text(json.dumps(table, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
    print(f"{out_path.name}: wrote {len(table):,} entries ({note})")
    write_report(out_path.with_suffix(".changes.tsv"), previous, table, source, ranks)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree", help="local tree YAML (downloaded when omitted)")
    parser.add_argument(
        "--tag-index",
        type=pathlib.Path,
        default=DEFAULT_TAG_INDEX,
        help="danbooru-tag-index checkout (highest-priority source)",
    )
    parser.add_argument(
        "--without-tag-index",
        action="store_true",
        help="build from the frozen baseline and the tree alone",
    )
    parser.add_argument(
        "--rank-db",
        type=pathlib.Path,
        help="danbooru_metadata SQLite, to order the change report by post count",
    )
    args = parser.parse_args()

    tree = load_tree(args.tree)
    print(f"tree tags: {len(tree):,}")
    display = {} if args.without_tag_index else load_display_names(args.tag_index)
    ranks = load_ranks(args.rank_db)

    built: dict[str, dict[str, str]] = {}
    for tree_lang, suffix in LANGS.items():
        table, source, note = build_table(suffix, tree, tree_lang, display)
        built[suffix] = table
        emit(suffix, table, source, note, ranks)

    for suffix, from_suffix in DERIVED_LANGS.items():
        table, source, note = derive_table(suffix, built[from_suffix], from_suffix, display)
        emit(suffix, table, source, note, ranks)


if __name__ == "__main__":
    main()
