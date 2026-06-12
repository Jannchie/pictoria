# Pictoria Design System

A light-wireframe design language. Structure is carried by 1px borders, not by
fills, shadows, or nesting. This document is the contract; `src/styles/tokens.css`
is the single source of truth for the actual values.

## 1. Principles

1. **Borders separate, not fills.** Block boundaries are a 1px border
   (`p-border` / `p-divider`). Reach for a line before reaching for a surface.
2. **Background steps are interaction, not decoration.** A raised surface level
   means "this is hover / selected / pressed". Static blocks stay on their
   parent background.
3. **Shadows are for floating layers only**, and only `shadow-sm` / `shadow-md`.
   `shadow-lg` exists in tokens as a reserved slot — application code must not
   use it (guard-tested in `components/` and `views/`).
4. **No gradients.** Flat fills only.
5. **No nested panels.** Cards do not sit inside cards. Group the inside of a
   floating layer with a `p-divider`, never a second surface level.

## 2. Layering model

One ascending background scale. Each step is a deliberate signal:

| Token           | Role                                                                 |
| --------------- | ------------------------------------------------------------------- |
| `--p-bg`        | Page floor                                                          |
| `--p-surface`   | Floating-layer floor (popover / dialog / menu body)                |
| `--p-surface-1` | Control floor (button / input / interactive row at rest)           |
| `--p-surface-2` | Hover / selected state                                              |
| `--p-surface-3` | **Restricted**: hover-on-a-selected-row, scrollbar thumb, in-control track / pedestal. Never a container background. |

`PSurface` exposes `level` props that map **one step down** the named scale
(it tops out at `--p-surface-2`; `--p-surface-3` has no `PSurface` level):

| `PSurface` level | Background      |
| ---------------- | --------------- |
| `base`           | `--p-bg`        |
| `1` (default)    | `--p-surface`   |
| `2`              | `--p-surface-1` |
| `3`              | `--p-surface-2` |

## 3. Token reference

`src/styles/tokens.css` is the single source of truth. Tokens are grouped below
with one or two representative names per group — read the file for the full set.

| Group           | Representative tokens                                        |
| --------------- | ----------------------------------------------------------- |
| Color           | `--p-primary`, `--p-bg`, `--p-surface-1`, `--p-fg-muted`, `--p-border` |
| Status          | `--p-success`, `--p-warning`, `--p-danger`, `--p-info`      |
| On-status (fg)  | `--p-on-primary`, `--p-on-success`, `--p-on-danger`         |
| Border          | `--p-border`, `--p-border-strong`, `--p-border-subtle`     |
| Radius          | `--p-radius-sm` … `--p-radius-2xl`, `--p-radius-full`       |
| Space           | `--p-space-1` (4px) … `--p-space-12` (48px)                 |
| Control sizing  | `--p-control-h-{xs,sm,md,lg}`, `--p-control-px-*`, `--p-control-gap` |
| Font            | `--p-font-sans`, `--p-font-mono`                            |
| Font size       | `--p-text-2xs` (10px) … `--p-text-4xl`, plus leading / tracking / weight |
| Shadow          | `--p-shadow-sm`, `--p-shadow-md`, `--p-shadow-lg` (reserved) |
| Motion          | `--p-duration-{fast,base,slow}`, `--p-ease`                |
| Z-index         | `--p-z-base` … `--p-z-toast` (see §4)                       |

### RGB-triplet dual track

Every color ships in two forms, by design (see the header comment in
`tokens.css`):

- `--p-xxx-rgb` — a bare `R G B` triplet. The UnoCSS theme wraps it as
  `rgb(var(--p-xxx-rgb))` so `presetWind4`'s `color-mix` opacity utilities
  (`bg-primary/20`, etc.) interpolate alpha correctly.
- `--p-xxx` — the semantic alias `rgb(var(--p-xxx-rgb))`, for direct use in
  scoped `<style>` blocks and inline styles.

Use the triplet path (UnoCSS classes) in templates; use the alias in scoped CSS.

## 4. Elevation & z-index

One ordered scale (`tokens.css`), ascending:

| Token            | Value | Used by                                                      |
| ---------------- | ----- | ------------------------------------------------------------ |
| `--p-z-base`     | 1     | Baseline                                                     |
| `--p-z-overlay`  | 40    | `POverlay` scrim                                             |
| `--p-z-modal`    | 50    | Modal body                                                   |
| `--p-z-popover`  | 55    | `PMenu` dropdown                                             |
| `--p-z-popup`    | 10000 | `PPopover` dropdowns, fullscreen PostDetail, SelectArea box  |
| `--p-z-float`    | 10100 | `PFloatWindow` (e.g. tag-selector window)                    |
| `--p-z-toast`    | 10200 | Toasts + undo snackbar (intentionally topmost)               |

**Rule:** raw `z-*` values are allowed only at `≤ 10` (sticky headers, the
`z-999` scrollbar, the `focus:z-9999` skip link — these slot below `--p-z-popup`
by design). Anything higher must reference a token: `z-[var(--p-z-*)]`.

## 5. Component inventory

### `src/ui` primitives

| Primitive          | Purpose                              | Key props                                                    |
| ------------------ | ------------------------------------ | ------------------------------------------------------------ |
| `PButton`          | Button                               | `variant` (primary/secondary/ghost/subtle/danger/success/warning/info), `size` (xs/sm/md/lg), `rounded`, `icon`, `block`, `loading`, `active` |
| `PInput`           | Text input                           | `size` (sm/md/lg), `type`, `inputmode`                       |
| `PCheckbox`        | Checkbox                             | bound value                                                  |
| `PSwitch`          | Toggle                               | `size` (sm/md/lg)                                            |
| `PSlider`          | Range slider                         | `size` (sm/md/lg), `color` (primary/secondary/tertiary/error) |
| `PRating`          | Star-style rating row                | `count`, custom icon set                                    |
| `PTag`             | Pill / label                         | `variant` (soft/outline/solid), `tone` (neutral/primary/success/warning/danger/info), `size` (xs/sm/md) |
| `PColorSwatch`     | Color chip                           | `size`, `rounded` (sm/md/lg/full)                           |
| `PListItem`        | Interactive list row                 | `type` (normal/checkbox)                                    |
| `PMenu`            | Context / click menu                 | `items` (label/divider/item roles), `trigger` (contextmenu/click) |
| `PPopover`         | Anchored popover                     | `trigger` (hover/click), `position` (12 placements), `zIndex` (default `var(--p-z-popup)`) |
| `POverlay`         | Scrim                                | scrim props                                                 |
| `PDialog`          | Modal dialog (tracks `openDialogCount`) | `variant` (primary/danger)                               |
| `PFloatWindow`     | Draggable floating window            | position / bounds props                                     |
| `PSurface`         | Surface container                    | `level` (base/1/2/3), `bordered`, `rounded`, `padded`, `shadow` (none/sm/md/lg) |
| `PAspectRatio`     | Aspect-ratio box                     | ratio props                                                 |
| `PScrollArea`      | Custom scroll container              | scroll props                                                |
| `PVirtualScroll`   | Virtualized list                     | `items`, `is`                                               |
| `PSelectArea`      | Drag-select box (exports `Area`)     | `target`                                                    |
| `PTreeList`        | Virtualized tree (sidebar folders)   | typed `TreeListItemData`, `rounded`                         |
| `PToast`           | Single toast                         | toast data                                                  |
| `PToastContainer`  | Toast stack layout                   | `items`                                                     |
| `PLocaleSwitch`    | Language picker                      | (wired to locale state)                                     |
| `PSchemeSwitch`    | Dark/light/auto picker               | (wired to `data-scheme`)                                    |

`src/ui/index.ts` also re-exports `modal.ts` (`openDialogCount`,
`isAnyDialogOpen`) — a shared counter `PDialog` increments on mount so pages can
gate their window-level hotkeys while any dialog is open.

### Mixed-boundary components (stay in `components/`)

These wrap a primitive but bind to global app state, so they are not generic
primitives:

| Component            | Why it stays                                                  |
| -------------------- | ------------------------------------------------------------- |
| `ToastSystem`        | Renders the global toast queue (`shared/toast.ts`) via `PToastContainer`; mounted once in `App.vue` |
| `UndoSnackbar`       | Bound to `shared/undoSnackbar.ts` (`performUndo`/`performRedo`) |
| `TagSelectorWindow`  | Binds a `PFloatWindow` instance into the shared open-window ref |

## 6. Do / Don't

| Do                                                                  | Don't                                              |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Use the `p-popover-panel` shortcut for floating panels (caller supplies width) | Hardcode hex colors — use a `--p-*` token         |
| Reference tokens for every color, radius, space                     | Use raw `z-index > 10` — wrap in `z-[var(--p-z-*)]` |
| Put new reusable primitives in `src/ui` with a `P` prefix + `index.ts` export | Add gradients                                     |
| Size controls in scoped CSS via `--p-control-*`                     | Nest panels / use a second surface level inside a layer |
| Keep shadows on floating layers only (`sm` / `md`)                  | Use `shadow-lg` in `components/` or `views/`      |

## 7. Guard tests

`src/test/design.test.ts` enforces the rules above (lints source, not runtime):

- **No hardcoded hex** — a small allowlist covers genuine data values.
- **No gradients** — `linear-gradient` / `radial-gradient` are rejected.
- **Token z-index** — raw `z-index > 10` must use a `--p-z-*` token.
- **No reserved shadow** — `shadow-lg` is banned in `components/` and `views/`.
