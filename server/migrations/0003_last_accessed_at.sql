-- last_accessed_at: unified "last interaction" timestamp for the Recently view.
--
-- Updated by:
--   * any mutation that already bumps updated_at (score, rating, caption, ...)
--   * an explicit POST /posts/{id}/touch when the user opens a post for viewing
--
-- Backfilled from updated_at so existing rows have a sensible initial value.
-- ----------------------------------------------------------------------

ALTER TABLE posts ADD COLUMN last_accessed_at TEXT;

UPDATE posts SET last_accessed_at = updated_at WHERE last_accessed_at IS NULL;

CREATE INDEX ix_posts_last_accessed_at ON posts(last_accessed_at);
