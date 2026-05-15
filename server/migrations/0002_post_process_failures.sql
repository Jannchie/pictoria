-- post_process_failures: per-(post, worker) blacklist of one-shot failures.
--
-- Background: each worker's pending predicate is data-shape-driven —
-- `basics` looks for missing sha256/thumbhash/dominant_color, `tagger`
-- looks for no `is_auto=1` row in `post_has_tag`, etc. That picks up
-- any post that fails permanently (PIL UnidentifiedImageError on a
-- corrupted upload, colorthief vbox1 on a single-color image, ...) every
-- single sync, generating warnings and wasted GPU/IO each time.
--
-- This table is a *failure-only* log: when a worker tries a post and
-- either (a) throws a real decode/IO error or (b) runs successfully but
-- produces no usable output (e.g. tagger yields zero auto-tags), it
-- inserts one row here. Pending queries `AND NOT EXISTS` against it, so
-- the post is removed from the pending set forever — one-shot, no retry.
--
-- To force a manual retry, delete the row for that (post_id, worker).
--
-- Note: success is *not* recorded here. The existing data-shape
-- predicates already exclude successful posts (they have the field set,
-- or the dependent row exists), so no backfill is needed when this
-- migration applies — only future failures populate this table.
-- ----------------------------------------------------------------------

CREATE TABLE post_process_failures (
    post_id    INTEGER NOT NULL,
    worker     TEXT    NOT NULL,  -- 'basics' | 'embedding' | 'tagger' | 'waifu'
    error      TEXT    NOT NULL,
    failed_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, worker),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX ix_post_process_failures_worker ON post_process_failures(worker);
