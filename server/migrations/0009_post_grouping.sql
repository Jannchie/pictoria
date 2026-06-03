-- Near-duplicate grouping.
--
-- A post may point at a "canonical" representative via canonical_post_id:
--   * canonical_post_id IS NULL  => the post is itself canonical and VISIBLE in
--     listings / search / tag facets.
--   * canonical_post_id = C      => the post is a HIDDEN member of C's group
--     (a lower-resolution copy or a near-duplicate / differential). It is
--     excluded from listings / search / facets by default; only C represents
--     the group. Grouping is always one level deep — a canonical post always
--     has canonical_post_id NULL, members point straight at it (never a chain).
--
-- Non-destructive: every row (including members) is kept, so Danbooru sync
-- de-dup (which keys off posts.file_name = the danbooru id) still short-circuits
-- and never re-downloads a grouped image. See
-- docs/superpowers/specs/2026-06-03-near-duplicate-grouping-design.md.
--
-- ON DELETE SET NULL: deleting a canonical post promotes its members back to
-- standalone (visible) instead of leaving dangling pointers.
ALTER TABLE posts ADD COLUMN canonical_post_id INTEGER
    REFERENCES posts(id) ON DELETE SET NULL;

CREATE INDEX ix_posts_canonical ON posts(canonical_post_id);

-- tags.post_count (the tag-filter facet count, see 0008) must count only
-- *canonical* (visible) posts, since members are hidden from the facet.
--
-- Redefine the post_has_tag count triggers to skip members, and add triggers
-- that shift a tag's count when a post is grouped (NULL -> non-NULL: it leaves
-- the visible set) or ungrouped (non-NULL -> NULL: it rejoins). At migration
-- time every existing post is canonical (canonical_post_id defaults NULL), so
-- the post_count backfilled by 0008 is already correct — no recount needed.
--
-- Post deletion is handled by PostRepo.delete_many, which deletes the
-- post_has_tag rows explicitly *before* the posts row (mirroring how it clears
-- post_vectors_siglip2): that fires trg_post_has_tag_count_ad while the post
-- row is still present, so the WHEN guard below reads the post's real canonical
-- status instead of racing the FK cascade.
DROP TRIGGER IF EXISTS trg_post_has_tag_count_ai;
DROP TRIGGER IF EXISTS trg_post_has_tag_count_ad;

CREATE TRIGGER trg_post_has_tag_count_ai
AFTER INSERT ON post_has_tag
WHEN (SELECT canonical_post_id FROM posts WHERE id = NEW.post_id) IS NULL
BEGIN
    UPDATE tags SET post_count = post_count + 1 WHERE name = NEW.tag_name;
END;

CREATE TRIGGER trg_post_has_tag_count_ad
AFTER DELETE ON post_has_tag
WHEN (SELECT canonical_post_id FROM posts WHERE id = OLD.post_id) IS NULL
BEGIN
    UPDATE tags SET post_count = post_count - 1 WHERE name = OLD.tag_name;
END;

CREATE TRIGGER trg_posts_canonical_grouped
AFTER UPDATE OF canonical_post_id ON posts
WHEN OLD.canonical_post_id IS NULL AND NEW.canonical_post_id IS NOT NULL
BEGIN
    UPDATE tags SET post_count = post_count - 1
    WHERE name IN (SELECT tag_name FROM post_has_tag WHERE post_id = NEW.id);
END;

CREATE TRIGGER trg_posts_canonical_ungrouped
AFTER UPDATE OF canonical_post_id ON posts
WHEN OLD.canonical_post_id IS NOT NULL AND NEW.canonical_post_id IS NULL
BEGIN
    UPDATE tags SET post_count = post_count + 1
    WHERE name IN (SELECT tag_name FROM post_has_tag WHERE post_id = NEW.id);
END;
