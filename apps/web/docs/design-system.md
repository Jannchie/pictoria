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

### Focus

One keyboard-focus ring for everything. `style.css` sets a global
`:focus-visible { outline: var(--p-focus-ring); outline-offset: 1px }`
(`--p-focus-ring` lives in `tokens.css`). It uses `outline`, not `box-shadow`,
so it never stacks with existing shadows. Exceptions:

- **Inputs** (`PInput`, annotate field) highlight the border instead of drawing
  a ring.
- **`PCheckbox`** focus lands on the `sr-only` input, so the ring is forwarded
  to the visible box (`:focus-visible + .p-checkbox__box`).
- **Virtual-scroll rows** (`PTreeList`, sidebar) use
  `focus-visible:[outline-offset:-2px]` so the ring insets and isn't clipped.
- **Layer containers** (`PPopover` content, `PMenu`, `PFloatWindow`) take
  programmatic focus only as a fallback when they hold nothing focusable; they
  suppress the ring on themselves — their items carry it.

Overlays move focus in and give it back: dialogs trap it (initial focus =
confirm, or Cancel for `danger`); popovers, menus and float windows move it in
without trapping and return it to the trigger / invoker on Escape, Tab-out or
selection. An outside click never steals focus back from what was clicked.

Don't write ad-hoc focus styles on new interactive components — let the global
rule cover them.

### Motion

Floating layers share two transitions, both defined in `style.css` (global, not
scoped, because content Teleports to `<body>`):

- **`p-float`** — fade + 2px rise. Used by `PPopover`, `PTooltip`, `PMenu`, `PDialog`.
  Floating content is positioned with floating-ui using `top`/`left` (not
  `transform`), so the rise transition doesn't fight the placement; it stays
  `visibility: hidden` until the first position is computed.
- **`p-float-fade`** — fade only, for scrims (`POverlay`) that must not shift.

Timing/easing come only from `--p-duration-*` / `--p-ease`. `PDialog` and
`POverlay` are `appear`-only. The reduced-motion fallback is the global rule at
the bottom of `style.css`. New floating components reuse these two classes —
don't hand-roll motion.

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

**Rule:** raw `z-*` values are allowed only at `≤ 10`. Anything higher must
reference a token: `z-[var(--p-z-*)]`. For a component's *internal* stacking,
establish a local stacking context with `isolation: isolate` plus a small local
`z` value (see `PScrollArea`, `PostDetailPanel`) rather than reaching for a big
global number. The `design.test.ts` allowlist is now down to two entries: the
`focus:z-9999` skip link (parked just below `--p-z-popup`) and one comment-only
reference in `PSelectArea`.

## 5. Component inventory

### `src/ui` primitives

| Primitive          | Purpose                              | Key props                                                    |
| ------------------ | ------------------------------------ | ------------------------------------------------------------ |
| `PButton`          | Button                               | `variant` (primary/secondary/ghost/subtle/danger/success/warning/info), `size` (xs/sm/md/lg), `rounded`, `icon`, `block`, `loading`, `active` (visual only), `pressed` (toggle button → `aria-pressed`; leave undefined for a plain button) |
| `PInput`           | Text input                           | `size` (sm/md/lg), `variant` (default/plain), `type`, `inputmode`, `ariaLabel` / `ariaLabelledby` / `ariaDescribedby`, `invalid` (→ `aria-invalid` + danger border), `block` |
| `PCheckbox`        | Checkbox                             | bound value, `label`, `indeterminate` (dash glyph, `aria-checked="mixed"`; caller-owned), `presentational` (visual only inside a row that is itself the checkbox/option), `ariaLabel` / `ariaLabelledby` |
| `PSwitch`          | Toggle                               | `size` (sm/md/lg)                                            |
| `PSlider`          | Range slider (`role=slider`, arrows / Home / End / PageUp / PageDown) | `size` (sm/md/lg), `color` (primary/secondary/tertiary/error), `ariaLabel` / `ariaLabelledby`, `ariaValuetext`, `disabled` |
| `PRating`          | Star-style rating row (radio group, roving focus) | `count`, custom icon set, `ariaLabel`, `mixed` (multi-selection with differing values: no star drawn, group described as mixed), `readonly`, `disabled` |
| `PTag`             | Pill / label                         | `variant` (soft/outline/solid), `tone` (neutral/primary/success/warning/danger/info), `size` (xs/sm/md) |
| `PColorSwatch`     | Color chip                           | `size`, `rounded` (sm/md/lg/full), `label` (accessible name; decorative without it) |
| `PListItem`        | Interactive list row                 | `type` (normal/checkbox), `role` (option/menuitem… → focusable), `focusable` (false when the parent owns tabindex), `current` (→ `aria-current`), `as` (div/button/a), `to` (RouterLink row, `aria-current="page"` while active) |
| `PEmpty`           | Empty state (no border / card)       | `icon`; default slot = text (caller passes `$t`), `action` slot |
| `PEdgeNavRail`     | Edge prev/next rail over an image    | `side` (left/right), `shown` (pair with `useEdgeProximity`), `label` (accessible name of the button) |
| `PMenu`            | Context / click menu (APG menu): right click at the cursor, Shift+F10 / ContextMenu key at the focused element; roving focus, typeahead, label rows → `role=group`; Escape / Tab close and return focus | `data` (label/divider/item roles, `disabled` → `aria-disabled`, still focusable), `trigger` (contextmenu/click), `ariaLabel`; emits `select` |
| `PPopover`         | Anchored non-modal popover, teleported + floating-ui (flip/shift). Trigger = first focusable in the default slot, wired with `aria-haspopup/expanded/controls`; toggles on `click`; focus moves in on open; Escape / inside close return focus to the trigger; Tab past the end closes and continues after the trigger | `v-model`, `position` (12 floating-ui placements), `zIndex` (default `var(--p-z-popup)`), `offset`, `overlay`, `popupRole` (dialog/menu/listbox), `ariaLabel`; `trigger="hover"` = legacy alias for `PTooltip` |
| `PTooltip`         | Tooltip (hover after 400 ms, keyboard focus immediately; hoverable; Escape hides; never takes focus; `aria-describedby` on the trigger) | `content` or `#content` slot, `position`, `openDelay`, `closeDelay`, `disabled`, `as` |
| `POverlay`         | Purely visual scrim, teleported to `<body>` (so the modal inside it can inert the page) | `opacity`, `inline` (render in place — loses inert) |
| `PDialog`          | Modal dialog: `modal` layer (Escape → `cancel`, page inert when wrapped in `POverlay`), focus trap + return, `aria-labelledby`/`aria-describedby`; `danger` → `role=alertdialog` with Cancel focused first; Enter confirms only from non-interactive content | `title`, `confirmLabel`, `cancelLabel`, `variant` (primary/danger), `#header` / `#footer` slots |
| `PFloatWindow`     | Non-modal draggable floating window: opens at the cursor, or below the focused element after a key press; Escape always closes, outside click closes unless pinned; focus in on open, back on close; drag from `[data-drag-handle]` (whole window if none) | `v-model`, `pinned` (provided as `'pinned'`), `role` (default dialog), `ariaLabel`, `safeMargin`; exposes `toggle()` |
| `PSurface`         | Surface container                    | `level` (base/1/2/3), `bordered`, `rounded`, `padded`, `shadow` (none/sm/md/lg) |
| `PAspectRatio`     | Aspect-ratio box                     | ratio props                                                 |
| `PScrollArea`      | Custom scroll container              | scroll props, `focusable` + `ariaLabel` (a Tab stop for text regions with nothing focusable inside, so the keyboard can scroll them) |
| `PVirtualScroll`   | Virtualized list                     | `items`, `is`                                               |
| `PSelectArea`      | Drag-select box (exports `Area`)     | `target`                                                    |
| `PTreeList`        | Virtualized tree (sidebar folders)   | typed `TreeListItemData`, `rounded`                         |
| `PToast`           | Notification card (toast + snackbar) — the card is its own live region | `message`, `icon`, `iconColor`, `closeable`, `fluid` (hug content instead of the fixed 384px), `tone` (info/success/warning/error; `error` → `role=alert`, else `role=status`), `#action` slot. A caller that announces through `announce()` instead passes `role="none"` (UndoSnackbar) so each message is read once |
| `PToastContainer`  | Toast stack layout                   | `items`                                                     |
| `PLocaleSwitch`    | Language picker                      | (wired to locale state)                                     |
| `PSchemeSwitch`    | Dark/light/auto picker               | (wired to `data-scheme`)                                    |

`src/ui/index.ts` also re-exports `modal.ts` (`isAnyDialogOpen`, an alias of
the layer stack's `hasModalLayer`) so pages can gate their window-level hotkeys
while any dialog is open. Every modal registers `useLayer({ modal: true })`;
there is no manual dialog counter any more.

**Modal layering.** A modal is `<POverlay>` (scrim, teleported to `<body>`)
wrapping `<PDialog>` (the `modal: true` layer). Because the scrim subtree is a
direct `<body>` child, the layer stack can set `inert` on `#app` and every
other body child while the dialog is on top; Escape reaches only the top
layer. Keep scrim click-to-dismiss at the call site (`@click.self`).

#### Icon-only buttons

A button whose whole content is one icon uses `<PButton icon>`:

- **Square by construction.** `icon` swaps the horizontal padding for a fixed
  `inline-size` equal to the size class's height (22 / 28 / 36 / 44 px), so the
  hit target is exactly square at every size. Don't add `w-*`/`h-*` or padding
  utilities at the call site.
- **The glyph is sized by the button** (14 / 16 / 20 / 24 px, driven off
  `font-size` since iconify glyphs are `1em`). Don't put `h-3.5 w-3.5` on the
  `<i>`.
- **Lightest variant by default.** With no `variant`, an icon button is `ghost`
  — transparent until hovered — because there is no label to justify a filled
  box. Pass `variant` explicitly only when the button is part of a filled
  composite (e.g. the sort reset button, welded to a `subtle` main button).
- **Always named.** No visible text means `aria-label` (or `title`) is
  mandatory, through `$t` like every other string.

### Mixed-boundary components (stay in `components/`)

These wrap a primitive but bind to global app state, so they are not generic
primitives:

| Component            | Why it stays                                                  |
| -------------------- | ------------------------------------------------------------- |
| `ToastSystem`        | Renders the global toast queue (`shared/toast.ts`) via `PToastContainer`; mounted once in `App.vue` |
| `UndoSnackbar`       | Bound to `shared/undoSnackbar.ts` (`performUndo`/`performRedo`); renders a `fluid` `PToast` pinned bottom-centre, with undo/redo in its `#action` slot — same card as the top toast queue, different corner |
| `TagSelectorWindow`  | Binds a `PFloatWindow` instance into the shared open-window ref |

## 6. Do / Don't

| Do                                                                  | Don't                                              |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| Use the `p-popover-panel` shortcut for floating panels (caller supplies width) | Hardcode hex colors — use a `--p-*` token         |
| Reference tokens for every color, radius, space                     | Use raw `z-index > 10` — wrap in `z-[var(--p-z-*)]` |
| Put new reusable primitives in `src/ui` with a `P` prefix + `index.ts` export | Add gradients                                     |
| Size controls in scoped CSS via `--p-control-*`                     | Nest panels / use a second surface level inside a layer |
| Keep shadows on floating layers only (`sm` / `md`)                  | Use `shadow-lg` in `components/` or `views/`      |
| Let `<PButton icon>` size itself — square box, button-sized glyph    | Give an icon-only button a filled variant or a call-site `w-*`/`h-*` |
| Separate detail-panel groups with `p-divider`; render numbers with `tabular-nums` | Lean on bare spacing alone to group metadata rows |

## 7. Guard tests

`src/test/design.test.ts` enforces the rules above (lints source, not runtime):

- **No hardcoded hex** — a small allowlist covers genuine data values.
- **No gradients** — `linear-gradient` / `radial-gradient` are rejected.
- **Token z-index** — raw `z-index > 10` must use a `--p-z-*` token.
- **No reserved shadow** — `shadow-lg` is banned in `components/` and `views/`.

## 8. Keyboard & a11y infrastructure

Shared plumbing every keyboard interaction builds on. Three rules:

1. **Every floating layer registers on the layer stack** (`useLayer` from
   `@/shared/layers`) — dialogs, overlays, popovers, menus, float windows.
2. **Global hotkeys go through `useHotkey`** (or `handleHotkey` inside an
   existing listener) — never a bare `onKeyStroke` / `window.addEventListener`.
3. **Never bind window Escape directly.** Escape belongs to the layer stack
   while anything is open; a page-level Escape hotkey via `useHotkey('Escape', …)`
   only ever sees the key when no layer is on top.

| Module | What it gives you |
| ------ | ----------------- |
| `utils/keyboard.ts` | `isTypingTarget` / `isWidgetTarget` / `isValueWidgetTarget`; `parseShortcut`, `matchesShortcut` (exact modifiers, `Mod` = ⌘ on Mac / Ctrl elsewhere), `formatShortcut` / `shortcutKeys` for `<kbd>` hints. |
| `composables/useHotkey.ts` | `useHotkey(shortcut, handler, { when, allowInTyping, allowInWidgets, preventDefault, repeat, ignore, target })`. Stands down on handled / IME-composing events, in text fields, and on widgets that own their keys (buttons, sliders, menu items, grid cells…) unless allowed. |
| `shared/layers.ts` | The layer stack. One capture-phase Escape listener calls the **top** layer's `onEscape` and swallows the key; one capture-phase pointerdown listener drives the top layer's `onPointerDownOutside` (`inside()` = e.g. the trigger). `modal` layers feed `isAnyDialogOpen` and make every other `<body>` child `inert` (teleport to body to get this; `data-layer-keep-active` opts an element out; `data-layer-escape-passthrough` lets Escape through to a widget). |
| `composables/useFocusTrap.ts` | `useFocusTrap(container, active, opts)` for modals: initial focus (`initialFocus` → `[data-autofocus]` → first tabbable → container), Tab cycling, focus return. `useFocusReturn(active, { container })` for non-modal popovers. Focus is not returned if the user already moved it elsewhere on purpose. |
| `utils/focus.ts` | `getFocusable`, `focusFirst`, `focusElement`. |
| `composables/useRovingFocus.ts` | Roving tabindex for composite widgets (radio group, toolbar, menu, listbox, tabs): one Tab stop, arrows / Home / End / PageUp / PageDown / typeahead move focus, disabled items skipped, RTL-aware. |
| `composables/useTypeahead.ts` | `matchTypeahead` (pure) + `useTypeahead` buffer + `isTypeaheadKey`. |
| `shared/announce.ts` | `announce(message, 'polite' \| 'assertive')` through persistent live regions. Messages go through i18n. |

`useRovingIndex.ts` stays for index-based (non-DOM-focus) cruising such as
TagSelector's hover index.

### Keyboard model

The user-facing key map lives in one place: **`src/shared/shortcuts.ts`**.
Groups (global, gallery grid, post page, viewer, folder tree, palette / tag
editor, annotation) × entries `{ keys, descKey }`, with `keys` in the
`utils/keyboard` grammar (`'Mod+Shift+B'`). The `?` sheet
(`components/ShortcutHelp.vue`) and the command palette's hints render from it,
and the plain `useHotkey` / `handleHotkey` bindings (App.vue's global keys, the
grid, undo / redo) import their keys from it — change the entry, and binding
and documentation move together. Widget-internal keys (tree, listboxes,
splitters, sortable cards) are implemented by their components and only
*listed* in the catalogue; update the entry when you change one.
`src/test/shortcuts.test.ts` checks every entry parses and every `descKey`
exists.

How keys are distributed:

- **One Tab stop per region / composite.** Skip link → folder tree → gallery
  grid → detail panel; F6 / Shift+F6 cycles the three regions. Inside a
  composite the arrows move (roving tabindex, or `aria-activedescendant` for
  the grid and comboboxes).
- **Widgets own their keys.** A focused button, slider, radio, tree row or
  grid keeps Enter / Space / arrows; page hotkeys stand down there
  (`useHotkey` default). Letter and `Mod+…` hotkeys that no widget uses opt in
  with `allowInWidgets`.
- **Escape closes exactly one thing** — the top layer. Page-level Escape
  (clear selection, back, leave a session) only runs when no layer is open.
- **Context menus** open with Shift+F10 / the Menu key, anchored to the
  focused element — or to its `aria-activedescendant` item (the grid cursor).
- **Focus never falls to `<body>`.** Closing a layer returns focus to its
  invoker; a panel that swaps its own content under focus (multi-select
  delete, "select only") sends focus to the gallery grid
  (`focusGalleryGrid()` in `composables/useGalleryGrid.ts`).
