# Design mode (UI/UX editor)

Design mode is a Figma-style interface editor added to whiteboards. A whiteboard
board now has two modes, switched from the board's top bar or with `?mode=design`
in its address:

- **Whiteboard**: the existing Miro-style canvas, unchanged.
- **Design**: frames, vector shapes, text, images, auto layout, components,
  styles and tokens, prototyping, comments, versions, export and CSS inspection.

Nothing in the whiteboard changed apart from the mode switch button and the
`?mode=design` branch in `src/pages/WhiteboardPage.tsx`.

## Where things are

| Path | What |
| --- | --- |
| `supabase/migrations/0133_design_mode.sql` | Tables, RLS, RPCs. Additive only. |
| `src/lib/design/types.ts` | Document model and the versioned file format. |
| `src/lib/design/layout.ts` | Resolved tree: instances, styles, tokens, auto layout, constraints. |
| `src/lib/design/text.ts` | Text measuring and line breaking. |
| `src/lib/design/doc.ts` | Pure document operations (group, wrap, clone, components, detach). |
| `src/lib/design/store.ts` | Editor state: transactions, undo / redo, gestures, dirty tracking. |
| `src/lib/design/sync.ts` | Load, save, realtime, versions and comments API. |
| `src/lib/design/actions.ts` | Editor commands (clipboard, align, z-order, pages, images). |
| `src/lib/design/interact.ts` | Hit picking, snapping, marquee, resize maths. |
| `src/lib/design/exporter.ts` | PNG / JPG / SVG / PDF export. |
| `src/lib/design/css.ts` | CSS for developer handoff. |
| `src/lib/design/io.ts` | JSON file import / export, SVG import. |
| `src/components/design/*` | The editor UI, renderer, prototype player. |
| `src/pages/DesignPlayPage.tsx` | Full-screen prototype at `#/wb/<board>/play`. |

## Architecture

**One design document per whiteboard board.** It shares the board's members,
roles (owner, co-owner, editor, commenter, viewer), team access and copy
settings through the existing permission helpers (`visible_board_ids`,
`editable_board_ids`, `can_comment_board`, `is_board_admin`). No new permission
model.

**Own tables, not `wb_item`.** Design layers need nesting, auto layout,
components and overrides; putting them in `wb_item` would have made the
whiteboard draw and export them. The design tables are:

- `design_doc`: pages, colour and text styles, tokens, library list (one row).
- `design_node`: one row per layer (`id, page, parent_id, ord, data`).
- `design_version`: full snapshots, built on the server by `design_snapshot()`,
  newest 100 kept; `design_restore()` saves the current state first.
- `design_comment`: threads pinned to a layer or a page point.

**Saving** works like the whiteboard: changed layers are queued and sent in one
`design_save()` call at a time (about four a second at most), never per pointer
move. Drags and resizes are gestures: they change the screen live and save once
at the end. Network failures retry with backoff while changes stay on screen; a
refused save is dropped and the server state reloaded. Leaving the page flushes.

**Realtime.** Row changes arrive through `postgres_changes`; a client ignores
its own writes (`sid`) and any layer it has unsaved edits on. Cursors,
selections and presence use the board's existing private channel `wb:<board>`
(event `dz`), which the existing RLS already limits to board viewers. Only one
mode is mounted at a time, so the channel isn't joined twice. Concurrent edits
to the same layer resolve last-writer-wins per layer.

**Rendering.** Everything draws from one resolved tree (`layout.ts`) rendered as
SVG by `Render.tsx`. The canvas, the exporters and the prototype player all use
it, so exports match the canvas.

**Auto layout** is computed, not stored: horizontal / vertical / wrap, gap and
row gap, padding, pack start / centre / end / space between, align start /
centre / end / stretch, fixed / hug / fill sizing, absolute children, nesting.
Baseline alignment renders as start.

**Constraints** apply when a frame without auto layout is resized (left, right,
left & right, centre, scale and the vertical equivalents).

**Components.** A component is a frame-like layer; instances render a virtual
copy of it. Instances may override text, fills, strokes, visibility, opacity and
image on any layer inside; every other property follows the main component, so
edits to the main component reach every instance except overridden values.
Component properties: text and boolean (visibility). Variants are not built.
Deleting a component detaches its instances first so they keep their look.

**Undo / redo** records the layers before and after each step (200 steps).
Repeated edits of the same field within 0.8 s merge into one step.

## Prototyping

Interactions on any layer: on click, hover, press, or after a delay; navigate,
open overlay (centre / top / bottom, close on outside click), back, close
overlay, open URL. Transitions: instant, dissolve, slide, push, with duration
and easing ("smart animate" plays as dissolve). The play button opens the player
in the editor; `#/wb/<board>/play?page=<page>&start=<frame>` opens it full
screen for anyone who can see the board.

Public (no account) prototype links are not built yet: the whiteboard's guest
share links (`wb_share_link`) would need a server change to serve design data.

## Export and handoff

- PNG and JPG at 0.5x to 4x, SVG (vectors, images embedded), PDF (one page per
  frame). One layer, several layers, or every top-level frame on the page.
- Inspect tab: sizes, spacing, colours, typography and CSS, each copyable.
- Design file: `.design.json` (`format: "iklipse-design"`, `version: 1`). Imports
  add pages with fresh ids, so a file can be imported into any document.
- SVG import (file, drop or paste) becomes editable layers; unsupported SVG
  features are skipped.

### Figma import

Figma's official route is the REST API (`GET /v1/files/:key`) with a personal
access token or OAuth app. Its node tree maps well onto this model (frames,
groups, rectangles, text, auto layout, components), but it is not built: it
needs a token flow, image fill downloads, and a mapping we haven't verified
against real files. Until then, copy a Figma frame as SVG and paste it here.

## Limits worth knowing

- Text styling is per layer (no mixed styles inside one text layer).
- Rotation of a parent isn't applied to children's selection boxes.
- Boolean operations, masks, and variants aren't built.
- Fonts render with whatever the viewer's browser has (no font upload).
- Layers are saved as whole rows: two people changing the same layer at the
  same moment, the later save wins.

## Deploying

1. Merge to `main` (GitHub Pages deploys the app).
2. Run the "Deploy functions" workflow with target `db` for that commit, so
   migration 0133 is applied. Until then, Design mode shows a "not set up on
   the server yet" message; whiteboards work as before either way.
