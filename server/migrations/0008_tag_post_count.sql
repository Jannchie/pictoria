-- Denormalised per-tag post count, maintained by triggers, to make the tag
-- filter's facet dropdown scale.
--
-- The live "GROUP BY tag_name over post_has_tag" scans the whole association
-- table (~9.4M rows on a 180k-post / 50k-tag library → ~630ms). The dropdown's
-- common case has no other filter active, so a tag's match count is just its
-- global post count — read straight off an indexed column instead of scanning.

ALTER TABLE tags ADD COLUMN post_count INTEGER NOT NULL DEFAULT 0;

-- Backfill from current associations in one grouped pass. Tags with no
-- associations keep the DEFAULT 0 set by ADD COLUMN.
UPDATE tags AS t
SET post_count = s.c
FROM (SELECT tag_name, count(*) AS c FROM post_has_tag GROUP BY tag_name) AS s
WHERE s.tag_name = t.name;

-- Serves "top-N by count, name as tie-break" entirely from the index.
CREATE INDEX ix_tags_post_count ON tags(post_count DESC, name);

-- Keep post_count in sync. AFTER INSERT/DELETE fire for explicit add/remove AND
-- for FK-cascade deletes (post deletion, tag deletion) on this SQLite build,
-- independent of the recursive_triggers setting. There is no in-place update of
-- post_has_tag.tag_name, so no UPDATE trigger is needed.
CREATE TRIGGER trg_post_has_tag_count_ai
AFTER INSERT ON post_has_tag
BEGIN
    UPDATE tags SET post_count = post_count + 1 WHERE name = NEW.tag_name;
END;

CREATE TRIGGER trg_post_has_tag_count_ad
AFTER DELETE ON post_has_tag
BEGIN
    UPDATE tags SET post_count = post_count - 1 WHERE name = OLD.tag_name;
END;
