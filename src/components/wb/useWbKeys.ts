import { useEffect } from "react";
import {
  useWb,
  undo,
  redo,
  deleteItems,
  setTool,
  setToolOpts,
  zoomAt,
  zoomToFit,
  animateViewport,
  commit,
  viewCenter,
} from "@/lib/wb/store";
import {
  addChild,
  addSibling,
  bringToFront,
  copySelection,
  cutSelection,
  duplicate,
  frameAround,
  group,
  nudge,
  pasteText,
  pointerWorld,
  selectAll,
  sendToBack,
  setLocked,
  shiftZ,
  ungroup,
  withFrameMembership,
} from "@/lib/wb/actions";
import { TEXT_TYPES, type Tool } from "@/lib/wb/types";
import { makeImage, makeSticky, makeTextBox } from "@/lib/wb/factory";
import { isUploadableImage, sendImage, uploadImage } from "@/lib/wb/api";

// Keyboard shortcuts and clipboard for the whiteboard (Miro's key map where it has one).

const S = useWb.getState;
const set = useWb.setState;

const isTyping = (t: EventTarget | null) =>
  !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

/** A dialog or menu is open (share, confirm, dropdowns): its keys are its own. */
const dialogOpen = () => !!document.querySelector('[aria-modal="true"], [role="menu"]');

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  h: "hand",
  n: "sticky",
  t: "text",
  s: "shape",
  r: "shape",
  o: "shape",
  l: "connector",
  p: "pen",
  e: "eraser",
  f: "frame",
  c: "comment",
  d: "card",
};

/** Insert image files at a point (upload runs in the background). */
export async function insertImages(files: File[], at = pointerWorld() ?? viewCenter(), onError?: (msg: string) => void) {
  const s = S();
  if (!s.boardId || !s.canEdit) return;
  let offset = 0;
  for (const f of files.filter(isUploadableImage).slice(0, 20)) {
    try {
      const { path, nw, nh } = await uploadImage(s.boardId, f);
      const it = makeImage(at.x + offset, at.y + offset, path, nw, nh, f.name);
      commit(withFrameMembership({ [it.id]: it }), { select: [it.id] });
      offset += 30;
      // The bytes go up after the item exists (it shows the local preview meanwhile).
      sendImage(path, f).catch((e: Error) => {
        onError?.(e.message);
        commit({ [it.id]: null }, { history: false });
      });
    } catch (e) {
      onError?.((e as Error).message);
    }
  }
}

export function useWbKeys(opts: { onSearch?: () => void; onHelp?: () => void; onError?: (msg: string) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.defaultPrevented) return;
      if (dialogOpen()) return;
      const s = S();
      if (s.presenting) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const sel = s.selection;

      // ---- always
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
      if (mod && (k === "=" || k === "+")) {
        e.preventDefault();
        zoomAt({ x: s.screen.w / 2, y: s.screen.h / 2 }, s.viewport.zoom * 1.25);
        return;
      }
      if (mod && k === "-") {
        e.preventDefault();
        zoomAt({ x: s.screen.w / 2, y: s.screen.h / 2 }, s.viewport.zoom / 1.25);
        return;
      }
      if (mod && k === "0") {
        e.preventDefault();
        const c = viewCenter();
        animateViewport({ zoom: 1, x: s.screen.w / 2 - c.x, y: s.screen.h / 2 - c.y });
        return;
      }
      if (e.shiftKey && (e.code === "Digit1" || k === "!")) {
        e.preventDefault();
        zoomToFit();
        return;
      }
      if (e.shiftKey && (e.code === "Digit2" || k === "@")) {
        e.preventDefault();
        if (sel.length) zoomToFit(sel);
        return;
      }
      if (mod && k === "f") {
        e.preventDefault();
        opts.onSearch?.();
        return;
      }
      if (mod && k === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (e.key === "?" || (mod && k === "/")) {
        e.preventDefault();
        opts.onHelp?.();
        return;
      }
      if (e.key === "Escape") {
        if (s.draftComment || s.openThread) set({ draftComment: null, openThread: null });
        else if (s.tool !== "select") setTool("select");
        else set({ selection: [], editing: null });
        return;
      }

      if (!s.canEdit) {
        if (!mod && (k === "v" || k === "h")) setTool(TOOL_KEYS[k]!);
        if (!mod && k === "c" && s.canComment) setTool("comment");
        return;
      }

      // ---- editing
      if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
        e.preventDefault();
        deleteItems(sel);
        return;
      }
      if (mod && k === "d") {
        e.preventDefault();
        duplicate();
        return;
      }
      if (mod && k === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroup();
        else group();
        return;
      }
      if (mod && e.shiftKey && k === "l") {
        e.preventDefault();
        setLocked(!sel.every((id) => s.items[id]?.locked));
        return;
      }
      if (mod && e.altKey && k === "f") {
        e.preventDefault();
        frameAround();
        return;
      }
      if (e.key === "PageUp" || (mod && e.key === "]")) {
        e.preventDefault();
        if (e.shiftKey || e.key === "PageUp") bringToFront();
        else shiftZ(1);
        return;
      }
      if (e.key === "PageDown" || (mod && e.key === "[")) {
        e.preventDefault();
        if (e.shiftKey || e.key === "PageDown") sendToBack();
        else shiftZ(-1);
        return;
      }
      if (e.key.startsWith("Arrow") && sel.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
        return;
      }
      if (e.key === "Enter" && sel.length === 1) {
        const it = s.items[sel[0]!];
        if (!it || it.locked) return;
        e.preventDefault();
        if (e.shiftKey) addSibling(it.id);
        else if (TEXT_TYPES.includes(it.type)) set({ editing: { id: it.id, field: "text" } });
        else if (it.type === "frame") set({ editing: { id: it.id, field: "title" } });
        return;
      }
      if (e.key === "Tab" && sel.length === 1) {
        e.preventDefault();
        addChild(sel[0]!);
        return;
      }
      if (!mod && !e.altKey && TOOL_KEYS[k]) {
        e.preventDefault();
        if (k === "r") setToolOpts({ shape: "rect" });
        if (k === "o") setToolOpts({ shape: "ellipse" });
        setTool(TOOL_KEYS[k]!);
      }
    };

    // Clipboard events carry the data without permission prompts.
    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e.target) || dialogOpen() || !S().selection.length || !S().canCopy) return;
      e.preventDefault();
      void copySelection();
    };
    const onCut = (e: ClipboardEvent) => {
      if (isTyping(e.target) || dialogOpen() || !S().selection.length || !S().canEdit) return;
      e.preventDefault();
      void cutSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || dialogOpen() || !S().canEdit) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void insertImages(files, undefined, opts.onError);
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault();
      if (pasteText(text, pointerWorld())) return;
      if (!text.trim()) {
        pasteText(null, pointerWorld());
        return;
      }
      // Plain text: one line becomes a sticky note, more becomes a text box.
      const at = pointerWorld() ?? viewCenter();
      const it =
        text.includes("\n") || text.length > 120
          ? makeTextBox(at.x - 240, at.y, 480, text.slice(0, 5000), 16)
          : makeSticky(at.x, at.y, S().toolOpts.stickyColor, text);
      commit(withFrameMembership({ [it.id]: it }), { select: [it.id] });
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
      window.removeEventListener("paste", onPaste);
    };
  }, [opts.onSearch, opts.onHelp, opts.onError]);
}
