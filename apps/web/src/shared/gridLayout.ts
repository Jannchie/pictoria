// Gallery masonry geometry, shared by the live Waterfall (MainSection) and the
// loading skeleton (GallerySkeleton) so the placeholder lands on exactly the
// rhythm the real grid will take.
//
// Nothing sits under a thumbnail (PostItem is the image alone), so the one
// gap serves both axes; Waterfall's `yGap` (extra per-item height on top of
// `gap`) is deliberately left unset.

/** Gap between columns and between rows (px). */
export const GRID_GAP = 16
/** Grid padding on every side (px). */
export const GRID_PAD = 12
