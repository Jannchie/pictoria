-- Rename posts.thumbhash → posts.arthash.
--
-- Background: the placeholder-image hash now uses arthash 0.2.0's
-- Codec.rect(n=64) instead of the V4 thumbhash. The stored byte format
-- is incompatible, so existing values can't be reused.
--
-- Strategy:
--   1. ALTER TABLE … RENAME COLUMN keeps the column shape (TEXT, NULLable)
--      and any default; no data copy needed.
--   2. We don't UPDATE … SET arthash = NULL: leaving stale bytes in place
--      would have the frontend decoder fail loudly. Instead, drop them so
--      the basics-processor pending predicate picks every post back up and
--      re-encodes with the new codec on next sync.
-- ----------------------------------------------------------------------

ALTER TABLE posts RENAME COLUMN thumbhash TO arthash;
UPDATE posts SET arthash = NULL;
