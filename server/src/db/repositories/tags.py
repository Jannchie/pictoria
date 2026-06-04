"""TagRepo + TagGroupRepo — async Repositories over tag-related tables."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from db.entities import Tag, TagGroup
from db.helpers import fetch_all_as, fetch_all_dicts, fetch_one_as, sql_placeholders

if TYPE_CHECKING:
    import sqlite3


class TagRepo:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self.cur = cur

    async def get(self, name: str) -> Tag | None:
        def _impl() -> Tag | None:
            self.cur.execute(
                "SELECT name, group_id, created_at, updated_at FROM tags WHERE name = ?",
                [name],
            )
            return fetch_one_as(self.cur, Tag)

        return await asyncio.to_thread(_impl)

    async def list_with_counts(
        self,
        *,
        prev: str | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        """Return [{name, group, count}, ...] for ``TagWithCountPublic``."""

        def _impl() -> list[dict]:
            sql = (
                "SELECT t.name AS name, t.group_id AS group_id, "
                "tg.id AS g_id, tg.name AS g_name, tg.color AS g_color, "
                "count(pht.tag_name) AS count "
                "FROM tags t "
                "LEFT JOIN post_has_tag pht ON pht.tag_name = t.name "
                "LEFT JOIN tag_groups tg ON tg.id = t.group_id "
            )
            params: list = []
            if prev:
                sql += "WHERE t.name > ? "
                params.append(prev)
            sql += "GROUP BY t.name, t.group_id, tg.id, tg.name, tg.color ORDER BY t.name "
            if limit:
                sql += "LIMIT ?"
                params.append(limit)
            self.cur.execute(sql, params)
            rows = fetch_all_dicts(self.cur)
            return [
                {
                    "name": r["name"],
                    "group": (
                        {"id": r["g_id"], "name": r["g_name"], "color": r["g_color"]}
                        if r["g_id"] is not None
                        else None
                    ),
                    "count": r["count"],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_impl)

    async def create(self, name: str, group_id: int | None) -> Tag:
        def _impl() -> Tag:
            self.cur.execute(
                "INSERT INTO tags(name, group_id) VALUES(?, ?) "
                "ON CONFLICT(name) DO NOTHING",
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

        return await asyncio.to_thread(_impl)

    async def update_group(self, name: str, group_id: int | None) -> Tag | None:
        def _impl() -> Tag | None:
            self.cur.execute(
                "UPDATE tags SET group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?",
                [group_id, name],
            )
            self.cur.execute(
                "SELECT name, group_id, created_at, updated_at FROM tags WHERE name = ?",
                [name],
            )
            return fetch_one_as(self.cur, Tag)

        return await asyncio.to_thread(_impl)

    async def delete(self, name: str) -> None:
        def _impl() -> None:
            # post_has_tag.tag_name has ON DELETE CASCADE FK on tags.name,
            # so deleting the tag row cascades the join rows.
            self.cur.execute("DELETE FROM tags WHERE name = ?", [name])

        await asyncio.to_thread(_impl)

    async def delete_many(self, names: list[str]) -> None:
        if not names:
            return

        def _impl() -> None:
            ph = sql_placeholders(names)
            self.cur.execute(f"DELETE FROM tags WHERE name IN ({ph})", names)  # noqa: S608

        await asyncio.to_thread(_impl)

    # ─── Post ↔ tag association ──────────────────────────────────────
    async def add_tag(self, post_id: int, tag_name: str) -> bool:
        """Return True if inserted, False if already existed.

        Collapsed to two statements (down from select + insert + insert):
        the tags-table insert is idempotent (``ON CONFLICT DO NOTHING``),
        and the link-table insert uses ``RETURNING`` so the conflict path
        skips RETURNING — making rowcount/fetchone the existence signal.
        """

        def _impl() -> bool:
            self.cur.execute(
                "INSERT INTO tags(name) VALUES(?) ON CONFLICT DO NOTHING",
                [tag_name],
            )
            self.cur.execute(
                "INSERT INTO post_has_tag(post_id, tag_name, is_auto) "
                "VALUES(?, ?, 0) ON CONFLICT DO NOTHING RETURNING post_id",
                [post_id, tag_name],
            )
            return self.cur.fetchone() is not None

        return await asyncio.to_thread(_impl)

    async def remove_tag(self, post_id: int, tag_name: str) -> bool:
        """Return True if removed, False if didn't exist."""

        def _impl() -> bool:
            self.cur.execute(
                "DELETE FROM post_has_tag WHERE post_id = ? AND tag_name = ? RETURNING post_id",
                [post_id, tag_name],
            )
            return self.cur.fetchone() is not None

        return await asyncio.to_thread(_impl)

    def fetch_tags_by_ids(self, ids: list[int]) -> dict[int, list[dict]]:
        """Batch-fetch tags per post, ordered by canonical group then name.

        Synchronous: called from inside the query layer's ``asyncio.to_thread``
        block. Returns the ``PostHasTagPublic``-shaped dicts the read models use.
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

    async def get(self, group_id: int) -> TagGroup | None:
        def _impl() -> TagGroup | None:
            self.cur.execute(
                "SELECT id, name, parent_id, color, created_at, updated_at "
                "FROM tag_groups WHERE id = ?",
                [group_id],
            )
            return fetch_one_as(self.cur, TagGroup)

        return await asyncio.to_thread(_impl)

    async def list_all(self) -> list[TagGroup]:
        def _impl() -> list[TagGroup]:
            self.cur.execute(
                "SELECT id, name, parent_id, color, created_at, updated_at "
                "FROM tag_groups ORDER BY id",
            )
            return fetch_all_as(self.cur, TagGroup)

        return await asyncio.to_thread(_impl)

    async def ensure(self, name: str, color: str = "#000000") -> TagGroup:
        def _impl() -> TagGroup:
            self.cur.execute(
                "INSERT INTO tag_groups(name, color) VALUES (?, ?) "
                "ON CONFLICT(name) DO NOTHING",
                [name, color],
            )
            self.cur.execute(
                "SELECT id, name, parent_id, color, created_at, updated_at "
                "FROM tag_groups WHERE name = ?",
                [name],
            )
            tg = fetch_one_as(self.cur, TagGroup)
            if tg is None:
                msg = f"TagGroup upsert failed for: {name}"
                raise RuntimeError(msg)
            return tg

        return await asyncio.to_thread(_impl)
