"""TagRepo + TagGroupRepo — async Repositories over tag-related tables."""

from __future__ import annotations

from typing import TYPE_CHECKING

from db.asyncbridge import in_thread
from db.entities import Tag, TagGroup
from db.helpers import fetch_all_as, fetch_all_dicts, fetch_one_as, sql_placeholders
from services.tag_i18n import translate_tag

if TYPE_CHECKING:
    import sqlite3


class TagRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    @in_thread
    def get(self, name: str) -> Tag | None:
        self.cur.execute(
            "SELECT name, group_id, created_at, updated_at FROM tags WHERE name = ?",
            [name],
        )
        return fetch_one_as(self.cur, Tag)

    @in_thread
    def list_with_counts(
        self,
        *,
        prev: str | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        """Return [{name, group, count}, ...] for ``TagWithCountPublic``.

        ``count`` reads the trigger-maintained ``tags.post_count`` (migration
        0008) instead of GROUP BY-ing the ~9.4M-row ``post_has_tag`` table
        (~630ms per call). That denormalised count covers *canonical* posts
        only — hidden near-duplicate group members are excluded (migration
        0009) — aligning this listing with the tag-filter facet's semantics.
        """
        sql = (
            "SELECT t.name AS name, t.group_id AS group_id, "
            "tg.id AS g_id, tg.name AS g_name, tg.color AS g_color, "
            "t.post_count AS count "
            "FROM tags t "
            "LEFT JOIN tag_groups tg ON tg.id = t.group_id "
        )
        params: list = []
        if prev:
            sql += "WHERE t.name > ? "
            params.append(prev)
        sql += "ORDER BY t.name "
        if limit:
            sql += "LIMIT ?"
            params.append(limit)
        self.cur.execute(sql, params)
        rows = fetch_all_dicts(self.cur)
        return [
            {
                "name": r["name"],
                "group": ({"id": r["g_id"], "name": r["g_name"], "color": r["g_color"]} if r["g_id"] is not None else None),
                "count": r["count"],
            }
            for r in rows
        ]

    @in_thread
    def create(self, name: str, group_id: int | None) -> Tag:
        self.cur.execute(
            "INSERT INTO tags(name, group_id) VALUES(?, ?) ON CONFLICT(name) DO NOTHING",
            [name, group_id],
        )
        self.cur.execute(
            "SELECT name, group_id, created_at, updated_at FROM tags WHERE name = ?",
            [name],
        )
        tag = fetch_one_as(self.cur, Tag)
        if tag is None:
            msg = f"Tag insert failed for: {name}"
            raise RuntimeError(msg)
        return tag

    @in_thread
    def update_group(self, name: str, group_id: int | None) -> Tag | None:
        self.cur.execute(
            "UPDATE tags SET group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?",
            [group_id, name],
        )
        self.cur.execute(
            "SELECT name, group_id, created_at, updated_at FROM tags WHERE name = ?",
            [name],
        )
        return fetch_one_as(self.cur, Tag)

    @in_thread
    def delete(self, name: str) -> None:
        # post_has_tag.tag_name has ON DELETE CASCADE FK on tags.name,
        # so deleting the tag row cascades the join rows.
        self.cur.execute("DELETE FROM tags WHERE name = ?", [name])

    @in_thread
    def delete_many(self, names: list[str]) -> None:
        if not names:
            return
        ph = sql_placeholders(names)
        self.cur.execute(f"DELETE FROM tags WHERE name IN ({ph})", names)  # noqa: S608

    # ─── Post ↔ tag association ──────────────────────────────────────
    @in_thread
    def add_tag(self, post_id: int, tag_name: str) -> bool:
        """Return True if inserted, False if already existed.

        Collapsed to two statements (down from select + insert + insert):
        the tags-table insert is idempotent (``ON CONFLICT DO NOTHING``),
        and the link-table insert uses ``RETURNING`` so the conflict path
        skips RETURNING — making rowcount/fetchone the existence signal.
        """
        self.cur.execute(
            "INSERT INTO tags(name) VALUES(?) ON CONFLICT DO NOTHING",
            [tag_name],
        )
        self.cur.execute(
            "INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES(?, ?, 0) ON CONFLICT DO NOTHING RETURNING post_id",
            [post_id, tag_name],
        )
        return self.cur.fetchone() is not None

    @in_thread
    def remove_tag(self, post_id: int, tag_name: str) -> bool:
        """Return True if removed, False if didn't exist."""
        self.cur.execute(
            "DELETE FROM post_has_tag WHERE post_id = ? AND tag_name = ? RETURNING post_id",
            [post_id, tag_name],
        )
        return self.cur.fetchone() is not None

    def fetch_tags_by_ids(self, ids: list[int], lang: str = "zh-Hans") -> dict[int, list[dict]]:
        """Batch-fetch tags per post, ordered by canonical group then name.

        Synchronous: called from inside the query layer's ``asyncio.to_thread``
        block. Returns the ``PostHasTagPublic``-shaped dicts the read models use.
        ``lang`` picks the ``translated_name`` table (``en`` yields ``None``).
        """
        if not ids:
            return {}
        placeholders = sql_placeholders(ids)
        self.cur.execute(
            f"""
            SELECT pht.post_id AS post_id,
                   pht.is_auto AS is_auto,
                   t.name AS name,
                   t.created_at AS created_at,
                   t.updated_at AS updated_at,
                   tg.id AS group_id,
                   tg.name AS group_name,
                   tg.color AS group_color
            FROM post_has_tag pht
            JOIN tags t ON t.name = pht.tag_name
            LEFT JOIN tag_groups tg ON tg.id = t.group_id
            WHERE pht.post_id IN ({placeholders})
            ORDER BY pht.post_id,
                CASE COALESCE(tg.name, '')
                    WHEN 'artist'    THEN 0
                    WHEN 'copyright' THEN 1
                    WHEN 'character' THEN 2
                    WHEN 'general'   THEN 3
                    WHEN 'meta'      THEN 4
                    ELSE 5
                END,
                t.name
            """,  # noqa: S608
            ids,
        )
        result: dict[int, list[dict]] = {}
        for r in fetch_all_dicts(self.cur):
            result.setdefault(r["post_id"], []).append(
                {
                    "is_auto": bool(r["is_auto"]),
                    "tag_info": {
                        "name": r["name"],
                        "translated_name": translate_tag(r["name"], lang),
                        "created_at": r["created_at"],
                        "updated_at": r["updated_at"],
                        "group": (
                            {
                                "id": r["group_id"],
                                "name": r["group_name"],
                                "color": r["group_color"],
                            }
                            if r["group_id"] is not None
                            else None
                        ),
                    },
                },
            )
        return result


class TagGroupRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    @in_thread
    def get(self, group_id: int) -> TagGroup | None:
        self.cur.execute(
            "SELECT id, name, parent_id, color, created_at, updated_at FROM tag_groups WHERE id = ?",
            [group_id],
        )
        return fetch_one_as(self.cur, TagGroup)

    @in_thread
    def list_all(self) -> list[TagGroup]:
        self.cur.execute(
            "SELECT id, name, parent_id, color, created_at, updated_at FROM tag_groups ORDER BY id",
        )
        return fetch_all_as(self.cur, TagGroup)

    @in_thread
    def ensure(self, name: str, color: str = "#000000") -> TagGroup:
        self.cur.execute(
            "INSERT INTO tag_groups(name, color) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
            [name, color],
        )
        self.cur.execute(
            "SELECT id, name, parent_id, color, created_at, updated_at FROM tag_groups WHERE name = ?",
            [name],
        )
        tg = fetch_one_as(self.cur, TagGroup)
        if tg is None:
            msg = f"TagGroup upsert failed for: {name}"
            raise RuntimeError(msg)
        return tg
