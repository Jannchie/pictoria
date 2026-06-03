-- Index posts.updated_at to back the "sort by update time" option.
--
-- updated_at is bumped on every write (score/rating/tag/caption/source/rotate,
-- grouping changes, danbooru re-sync), so exposing it as an ORDER BY column
-- (db/filters.py ORDERABLE_COLUMNS) needs an index to avoid a full-table sort
-- per page on a large library. Mirrors ix_posts_last_accessed_at (migration
-- 0003) which backs the Recently view. A plain single-column index serves both
-- ASC and DESC (SQLite scans it in either direction).
CREATE INDEX ix_posts_updated_at ON posts(updated_at);
