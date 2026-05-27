/**
 * Score / rating bounds, mirroring the backend's single source of truth
 * (`server/src/shared.py`: `MAX_POST_SCORE`, `MAX_POST_RATING`). Keep these in
 * sync with the backend; the API validates against the same limits.
 *
 * Ratings run 0..MAX_POST_RATING (0 = unrated), scores 0..MAX_POST_SCORE
 * (0 = unscored), so a distribution has `MAX_* + 1` buckets.
 */

export const MAX_POST_RATING = 4
export const MAX_POST_SCORE = 5
