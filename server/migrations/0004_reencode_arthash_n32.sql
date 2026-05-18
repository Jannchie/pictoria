-- Re-encode all arthash values under the new Codec.rect(n=32) codec.
--
-- Background: dropped from RECT/n=64 (~300 B, 65 SVG elements) to RECT/n=32
-- (~180 B, 33 elements) — frontend animation stays smooth at 50+ tiles,
-- and the placeholder reads as a softer mosaic. The byte format differs
-- per n, so old hashes would mis-decode under the new codec.
--
-- Strategy: null out existing arthash values; the basics processor's
-- pending predicate picks every post back up and re-encodes on the next
-- backfill pass.
-- ----------------------------------------------------------------------

UPDATE posts SET arthash = NULL;
