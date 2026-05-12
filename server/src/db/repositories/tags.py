"""TagRepo + TagGroupRepo — async Repositories over tag-related tables."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from db.entities import Tag, TagGroup
from db.helpers import fetch_all_as, fetch_all_dicts, fetch_one_as

if TYPE_CHECKING:
    import duckdb


class TagRepo:
    def __init__(self, cur: duckdb.DuckDBPyConnection) -> None:
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
                "ON CONFLICT (name) DO NOTHING",
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
                "UPDATE tags SET group_id = ?, updated_at = now() WHERE name = ?",
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
            self.cur.execute("DELETE FROM post_has_tag WHERE tag_name = ?", [name])
            self.cur.execute("DELETE FROM tags WHERE name = ?", [name])

        await asyncio.to_thread(_impl)

    async def delete_many(self, names: list[str]) -> None:
        if not names:
            return

        def _impl() -> None:
            ph = ",".join("?" * len(names))
            self.cur.execute(f"DELETE FROM post_has_tag WHERE tag_name IN ({ph})", names)  # noqa: S608
            self.cur.execute(f"DELETE FROM tags WHERE name IN ({ph})", names)  # noqa: S608

        await asyncio.to_thread(_impl)


class TagGroupRepo:
    def __init__(self, cur: duckdb.DuckDBPyConnection) -> None:
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

    async def get_by_name(self, name: str) -> TagGroup | None:
        def _impl() -> TagGroup | None:
            self.cur.execute(
                "SELECT id, name, parent_id, color, created_at, updated_at "
                "FROM tag_groups WHERE name = ?",
                [name],
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
                "ON CONFLICT DO NOTHING",
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
