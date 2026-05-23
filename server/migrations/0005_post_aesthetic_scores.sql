-- post_aesthetic_scores: generic per-(post, scorer) aesthetic score table.
--
-- The original `post_waifu_scores` table is hard-coded to a single scorer
-- (waifu-scorer-v3). When we wanted to compare it side-by-side with
-- SigLIP-based Aesthetic Predictor V2.5, adding a second hard-coded column
-- or a second hard-coded table would force the same shape change every
-- time we try a new scorer.
--
-- This table is the generic version: one row per (post, scorer), where
-- ``scorer`` is a short identifier like ``'siglip-v2-5'``. ``post_waifu_scores``
-- is intentionally left in place because the existing filter / stats /
-- bucket queries depend on it; the new table accumulates additional
-- scorers and a SELECT can be joined to ``post_waifu_scores`` for the
-- legacy score whenever a unified view is needed.
-- ----------------------------------------------------------------------

CREATE TABLE post_aesthetic_scores (
    post_id  INTEGER NOT NULL,
    scorer   TEXT    NOT NULL,
    score    REAL    NOT NULL,
    PRIMARY KEY (post_id, scorer),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX ix_post_aesthetic_scores_scorer ON post_aesthetic_scores(scorer);
