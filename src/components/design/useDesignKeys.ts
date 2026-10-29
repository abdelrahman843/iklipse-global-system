import { useEffect } from "react";
import {
  addImages,
  addNode,
  componentFromSelection,
  copySelection,
  deleteSelection,
  detachSelection,
  duplicateSelection,
  flip,
  frameSelection,
  groupSelection,
  nudge,
  pasteClip,
  reorder,
  selectAll,
  toggle,
  ungroupSelection,
  viewCenter,
  zoomToFit,
  zoomToSelection,
} from "@/lib/design/actions";
import { isVirtual } from "@/lib/design/doc";
import { patchSelection, redo, resolved, select, undo, useDesign, zoomAt, setViewport, type Tool } from "@/lib/design/store";
import { importDesignJson, importSvgText } from "./importers";

// -----------------------------------------------------------------------------
// Design mode keyboard shortcuts (Figma's, where they exist) and clipboard.
// -----------------------------------------------------------------------------

const S = useDesign.getState;
const set = useDesign.setState;

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  h: "hand",
  f: "frame",
  a: "frame",
  r: "rect",
  o: "ellipse",
  l: "line",
  t: "text",
  p: "pen",
  c: "comment",
};

export function useDesignKeys(onError: (msg: string) => void, onHelp: () => void) {
  useEffect(() => {
    const typing = (e: Event) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || S().playing) return;
      const s = S();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && k === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod && (k === "=" || k === "+")) {
        e.preventDefault();
        zoomAt(1.25);
        return;
      }
      if (mod && k === "-") {
        e.preventDefault();
        zoomAt(0.8);
        return;
      }
      if (mod && k === "0") {
        e.preventDefault();
        const c = viewCenter();
        setViewport({ zoom: 1, x: s.screen.w / 2 - c.x, y: s.screen.h / 2 - c.y });
        return;
      }
      if (e.shiftKey && k === "1") return zoomToFit();
      if (e.shiftKey && k === "2") return zoomToSelection();
      if (e.shiftKey && k === "r" && !mod) return set({ showRulers: !s.showRulers });
      if (mod && k === "'") {
        e.preventDefault();
        return set({ showGrid: !s.showGrid });
      }
      if (e.key === "?" || (mod && k === "/")) return onHelp();
      if (e.key === "Escape") {
        if (s.editingPath) return set({ editingPath: null });
        if (s.tool !== "select") return set({ tool: "select" });
        // Up one level, then nothing.
        const first = s.selection[0];
        const parent = first ? resolved().parentOf.get(first) : null;
        return select(parent ? [parent.rid] : []);
      }
      if (e.key === "Enter" && s.selection.length === 1) {
        const r = resolved().byId.get(s.selection[0]!);
        if (r?.type === "text" && s.canEdit) return set({ editingText: r.rid });
        if (r?.children.length) return select(r.children.map((c) => c.rid));
        return;
      }
      if (!s.canEdit) {
        if (!mod && TOOL_KEYS[k] && ["select", "hand", "comment"].includes(TOOL_KEYS[k]!)) set({ tool: TOOL_KEYS[k]! });
        if (mod && k === "c") void copySelection();
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        return deleteSelection();
      }
      if (mod && k === "d") {
        e.preventDefault();
        return duplicateSelection();
      }
      if (mod && k === "c") return void copySelection();
      if (mod && k === "x") return void copySelection(true);
      if (mod && e.altKey && k === "g") {
        e.preventDefault();
        return frameSelection();
      }
      if (mod && e.shiftKey && k === "g") {
        e.preventDefault();
        return ungroupSelection();
      }
      if (mod && k === "g") {
        e.preventDefault();
        return groupSelection();
      }
      if (mod && e.altKey && k === "k") {
        e.preventDefault();
        return componentFromSelection();
      }
      if (mod && e.altKey && k === "b") {
        e.preventDefault();
        return detachSelection();
      }
      if (mod && e.shiftKey && k === "h") {
        e.preventDefault();
        return toggle("visible");
      }
      if (mod && e.shiftKey && k === "l") {
        e.preventDefault();
        return toggle("locked");
      }
      if (e.shiftKey && k === "h" && !mod) return flip("h");
      if (e.shiftKey && k === "v" && !mod) return flip("v");
      if (e.shiftKey && k === "a" && !mod) {
        // Add / remove auto layout.
        const real = s.selection.filter((id) => !isVirtual(id)).map((id) => s.doc.nodes[id]);
        if (real.length && real.every((n) => n && (n.type === "frame" || n.type === "component"))) {
          const on = real.every((n) => n!.layout);
          return patchSelection(on ? "Remove auto layout" : "Add auto layout", (r) =>
            on ? { layout: null } : { layout: { mode: r.w >= r.h ? "horizontal" : "vertical", gap: 10, padding: { t: 10, r: 10, b: 10, l: 10 }, justify: "start", align: "start" }, sizing: { h: "hug", v: "hug" } },
          );
        }
        if (real.length) {
          frameSelection();
          return patchSelection("Add auto layout", (r) => ({ layout: { mode: r.w >= r.h ? "horizontal" : "vertical", gap: 10, padding: { t: 0, r: 0, b: 0, l: 0 }, justify: "start", align: "start" }, sizing: { h: "hug", v: "hug" }, fills: [] }));
        }
        return;
      }
      if (e.key === "]") return reorder(mod ? "front" : "forward");
      if (e.key === "[") return reorder(mod ? "back" : "backward");
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        return nudge(dx, dy);
      }
      if (!mod && !e.altKey) {
        if (e.shiftKey && k === "8") return set({ tool: "star" });
        const tool = TOOL_KEYS[k];
        if (tool && !e.shiftKey) {
          // Opacity shortcuts: 1-0 when something is selected is Figma's; tools win here.
          set({ tool, toolLock: false });
          return;
        }
        if (/^[0-9]$/.test(e.key) && s.selection.length) {
          const v = e.key === "0" ? 1 : Number(e.key) / 10;
          return patchSelection("Opacity", { opacity: v });
        }
      }
    };

    const onPaste = async (e: ClipboardEvent) => {
      if (typing(e) || !S().canEdit || S().playing) return;
      const files = [...(e.clipboardData?.files ?? [])];
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault();
      try {
        if (files.length) {
          const svg = files.filter((f) => f.type === "image/svg+xml");
          for (const f of svg) importSvgText(await f.text(), viewCenter());
          const rest = files.filter((f) => !svg.includes(f));
          if (rest.length) await addImages(rest);
          return;
        }
        if (pasteClip(text || null)) return;
        const t = text.trim();
        if (t.startsWith("<svg") || t.startsWith("<?xml")) return importSvgText(t, viewCenter());
        if (t.startsWith("{") && t.includes('"iklipse-design"')) {
          importDesignJson(t);
          return;
        }
        if (t) {
          // Plain text becomes a text layer.
          const c = viewCenter();
          const n = addNode("text", { x: c.x, y: c.y }, null);
          patchSelection("Paste text", { text: { ...n.text!, content: t.slice(0, 5000) } }, [n.id]);
        }
      } catch (err) {
        onError((err as Error).message);
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [onError, onHelp]);
}

export const SHORTCUTS: [string, string][] = [
  ["V", "Move / select"],
  ["H / Space", "Hand (pan)"],
  ["F / A", "Frame"],
  ["R", "Rectangle"],
  ["O", "Ellipse"],
  ["L", "Line"],
  ["Shift+8", "Star"],
  ["P", "Pen"],
  ["T", "Text"],
  ["C", "Comment"],
  ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"],
  ["Ctrl+C / X / V", "Copy / cut / paste"],
  ["Ctrl+D", "Duplicate"],
  ["Alt+drag", "Duplicate while moving"],
  ["Delete", "Delete"],
  ["Ctrl+G / Ctrl+Shift+G", "Group / ungroup"],
  ["Ctrl+Alt+G", "Frame selection"],
  ["Shift+A", "Auto layout"],
  ["Ctrl+Alt+K", "Create component"],
  ["Ctrl+Alt+B", "Detach instance"],
  ["Ctrl+Shift+H / L", "Hide / lock"],
  ["[ / ]", "Send backward / bring forward"],
  ["Ctrl+[ / Ctrl+]", "Send to back / bring to front"],
  ["Arrows (+Shift)", "Nudge 1px (10px)"],
  ["Enter / Esc", "Select children / parent"],
  ["Double-click", "Enter group, edit text or path"],
  ["Ctrl+click", "Select deep layer"],
  ["Shift+1 / Shift+2", "Zoom to fit / selection"],
  ["Ctrl+0 / + / -", "Zoom 100% / in / out"],
  ["Shift+R", "Rulers"],
  ["Ctrl+'", "Pixel grid"],
  ["1 … 0", "Opacity 10% … 100%"],
];
