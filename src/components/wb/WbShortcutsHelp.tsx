import { Fragment } from "react";
import { Modal } from "@/components/ui/Modal";

// Keyboard and mouse shortcuts of the whiteboard (see useWbKeys.ts and Canvas.tsx).

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? "Cmd" : "Ctrl";
const ALT = MAC ? "Option" : "Alt";

/** Each entry: label, then one or more key combos (keys joined by "+"). */
type Row = [string, ...string[]];

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: "Tools",
    rows: [
      ["Select", "V"],
      ["Hand (pan)", "H"],
      ["Sticky note", "N"],
      ["Text", "T"],
      ["Shape", "S"],
      ["Rectangle", "R"],
      ["Circle", "O"],
      ["Connection line", "L"],
      ["Pen", "P"],
      ["Eraser", "E"],
      ["Frame", "F"],
      ["Comment", "C"],
      ["Card", "D"],
    ],
  },
  {
    title: "View",
    rows: [
      ["Pan", "Space+Drag", "Middle mouse+Drag"],
      ["Zoom", "Mouse wheel", `${MOD}+Scroll`],
      ["Zoom in", `${MOD}+=`],
      ["Zoom out", `${MOD}+-`],
      ["Zoom to 100%", `${MOD}+0`],
      ["Zoom to fit", "Shift+1"],
      ["Zoom to selection", "Shift+2"],
      ["Search", `${MOD}+F`],
      ["Keyboard shortcuts", "?", `${MOD}+/`],
    ],
  },
  {
    title: "Edit",
    rows: [
      ["Undo", `${MOD}+Z`],
      ["Redo", `${MOD}+Shift+Z`, `${MOD}+Y`],
      ["Copy", `${MOD}+C`],
      ["Cut", `${MOD}+X`],
      ["Paste", `${MOD}+V`],
      ["Duplicate", `${MOD}+D`],
      ["Select all", `${MOD}+A`],
      ["Delete", "Delete", "Backspace"],
      ["Edit text", "Enter", "Double-click"],
      ["Finish editing", "Esc", `${MOD}+Enter`],
      ["Deselect or back to Select", "Esc"],
    ],
  },
  {
    title: "Arrange",
    rows: [
      ["Move by 1px", "Arrows"],
      ["Move by 10px", "Shift+Arrows"],
      ["Group", `${MOD}+G`],
      ["Ungroup", `${MOD}+Shift+G`],
      ["Lock or unlock", `${MOD}+Shift+L`],
      ["Frame the selection", `${MOD}+${ALT}+F`],
      ["Bring to front", "PgUp"],
      ["Send to back", "PgDn"],
      ["Bring forward", `${MOD}+]`],
      ["Send backward", `${MOD}+[`],
    ],
  },
  {
    title: "Mind map",
    rows: [
      ["Add a child", "Tab"],
      ["Add a sibling", "Shift+Enter"],
    ],
  },
  {
    title: "Slides and docs",
    rows: [
      ["Previous / next slide (slides view, nothing selected)", "PageUp", "PageDown"],
      ["Next slide (presenting)", "Right", "Space"],
      ["Previous slide (presenting)", "Left"],
      ["Speaker notes (presenting)", "N"],
      ["Stop presenting", "Esc"],
      ["Open a doc", "Double-click"],
      ["Link in a doc", `${MOD}+K`],
      ["Close a doc", "Esc"],
    ],
  },
  {
    title: "Mouse",
    rows: [
      ["Add to selection", "Shift+Click"],
      ["Duplicate while dragging", `${ALT}+Drag`],
      ["Keep proportions", "Shift+Resize"],
      ["Rotate in 15° steps", "Shift+Rotate"],
      ["Move without snapping", `${MOD}+Drag`],
      ["Cancel a drag", "Esc"],
    ],
  },
];

function Keys({ combo }: { combo: string }) {
  const parts = combo.split("+");
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-subtle text-xs px-px">+</span>}
          <kbd className="inline-flex items-center justify-center h-6 min-w-6 px-1.5 rounded-md border border-border bg-inset text-xs font-medium text-ink font-sans whitespace-nowrap">
            {k}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}

export function WbShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="xl">
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((sec) => (
          <section key={sec.title} className="min-w-0">
            <h3 className="eyebrow text-xs text-subtle mb-1.5">{sec.title}</h3>
            <ul className="divide-y divide-line">
              {sec.rows.map(([label, ...combos]) => (
                <li key={label} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0 text-sm text-ink">{label}</span>
                  <span className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 shrink-0 max-w-[60%]">
                    {combos.map((c, i) => (
                      <Fragment key={c}>
                        {i > 0 && <span className="text-xs text-subtle">or</span>}
                        <Keys combo={c} />
                      </Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
