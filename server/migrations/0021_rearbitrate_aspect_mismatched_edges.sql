-- Forget the LPIPS verdict on grey-band edges whose two sides differ in aspect
-- ratio, so the next dedup rebuild judges them again with alignment.
--
-- Until 2026-10-19 the arbiter stretched both pictures to a 400x400 square
-- before comparing them position by position. For a crop and its uncropped
-- version that misaligns every position, and the distance blows up: among
-- edges at SigLIP distance 0.01-0.02, LPIPS rejected 4% of the aspect-matched
-- ones and 66% of those whose aspect ratios differ by more than 10%. The worker
-- now cuts such pairs down to their shared region first (`ai.lpips.overlap`);
-- on a 40-pair sample 33 fell back under the threshold, every one of them the
-- same picture on inspection.
--
-- `arbitrate` re-sends any grey pair whose `lpips_dist` is NULL, so clearing it
-- is the whole re-arbitration. Scoped on purpose:
--
--   * only rejections (> 0.40, `LPIPS_SAME_THRESHOLD`) -- alignment can only
--     pull a distance down, so an edge already accepted stays accepted;
--   * only SigLIP distance < 0.03 -- ~3.4k edges, minutes of CPU. Wider than
--     that the mismatched pairs are almost all genuinely different pictures
--     (99% rejected even so); new edges there are judged with alignment anyway,
--     and the backlog can be cleared later if this band proves worth it;
--   * never a row the user decided -- their verdict is final.
-- ----------------------------------------------------------------------

UPDATE post_variant_edges
SET lpips_dist = NULL, computed_at = NULL
WHERE user_verdict IS NULL
  AND lpips_dist > 0.40
  AND siglip_dist < 0.03
  AND (post_a, post_b) IN (
    SELECT e.post_a, e.post_b
    FROM post_variant_edges e
    JOIN posts a ON a.id = e.post_a
    JOIN posts b ON b.id = e.post_b
    WHERE a.height > 0 AND b.height > 0 AND a.width > 0 AND b.width > 0
      AND max(
        (a.width * 1.0 / a.height) / (b.width * 1.0 / b.height),
        (b.width * 1.0 / b.height) / (a.width * 1.0 / a.height)
      ) > 1.1
  );
