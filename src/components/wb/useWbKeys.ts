import { useEffect } from "react";
import { useWb, undo, redo, deleteItems, setTool, setToolOpts, zoomAt, zoomToFit, animateViewport, commit, mergeItem, viewCenter } from "@/lib/wb/store";
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
import { TEXT_TYPES, str, type Tool } from "@/lib/wb/types";
import { makeEmbed, makeImage, makeSticky, makeTextBox, makeVideo } from "@/lib/wb/factory";
import { asLink } from "@/lib/wb/embed";
import { isUploadableImage, isUploadableVideo, sendImage, uploadImage, uploadVideo } from "@/lib/wb/api";

// Keyboard shortcuts and clipboard for the whiteboard: Miro's own key map,
// separate from Trello's board shortcuts (BoardPage). As in Miro, typing with
// one sticky / shape / text / card selected writes into it instead of
// switching tools.

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

/** The one selected item typing would write into (note, shape, text, card). */
function textTarget(s: ReturnType<typeof S>) {
  const one = s.selection.length === 1 ? s.items[s.selection[0]!] : undefined;
  return one && !one.locked && s.canEdit && TEXT_TYPES.includes(one.type) ? one : null;
}

/** Insert image and video files at a point (uploads run in the background). */
export async function insertImages(files: File[], at = pointerWorld() ?? viewCenter(), onError?: (msg: string) => void) {
  const s = S();
  if (!s.boardId || !s.canEdit) return;
  const list = files.filter((f) => isUploadableImage(f) || isUploadableVideo(f)).slice(0, 20);
  if (list.length < files.length) onError?.("Only images (PNG, JPEG, GIF, WebP) and videos (MP4, WebM, MOV) can go on a board.");
  let offset = 0;
  for (const f of list) {
    try {
      const video = isUploadableVideo(f);
      const { path, nw, nh } = video ? await uploadVideo(s.boardId, f) : await uploadImage(s.boardId, f);
      const it = video ? makeVideo(at.x + offset, at.y + offset, path, nw, nh, f.name) : makeImage(at.x + offset, at.y + offset, path, nw, nh, f.name);
      commit(withFrameMembership({ [it.id]: it }), { select: [it.id] });
      offset += 30;
      // The bytes go up after the item exists (it shows the local file meanwhile).
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
      if (e.shiftKey && !mod && (e.code === "Digit1" || k === "!") && !textTarget(s)) {
        e.preventDefault();
        zoomToFit();
        return;
      }
      if (e.shiftKey && !mod && (e.code === "Digit2" || k === "@") && !textTarget(s)) {
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
      if (e.key === "F1" || (e.key === "?" && !textTarget(s)) || (mod && k === "/")) {
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
        if (!mod && !e.altKey && (k === "v" || k === "h")) setTool(TOOL_KEYS[k]!);
        if (!mod && !e.altKey && k === "c" && s.canComment) setTool("comment");
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
      // With nothing selected, PageUp / PageDown move between slides (slides view).
      if ((e.key === "PageUp" || (mod && e.key === "]")) && sel.length) {
        e.preventDefault();
        if (e.shiftKey || e.key === "PageUp") bringToFront();
        else shiftZ(1);
        return;
      }
      if ((e.key === "PageDown" || (mod && e.key === "[")) && sel.length) {
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
      const one = sel.length === 1 ? s.items[sel[0]!] : undefined;
      if (one && !one.locked && e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) addSibling(one.id);
        else if (TEXT_TYPES.includes(one.type)) set({ editing: { id: one.id, field: "text" } });
        else if (one.type === "frame") set({ editing: { id: one.id, field: "title" } });
        return;
      }
      if (one && !one.locked && e.key === "Tab") {
        e.preventDefault();
        addChild(one.id);
        return;
      }
      // Like Miro: with a note / shape / text / card selected, typing writes
      // into it; otherwise single letters pick tools.
      const target = textTarget(s);
      if (target && !mod && !e.altKey && e.key.length === 1 && e.key !== " ") {
        e.preventDefault();
        const field = target.type === "card" ? "title" : "text";
        const text = str(target.data[field]) + e.key;
        commit({ [target.id]: mergeItem(target, { data: { [field]: text } }) }, { key: `text:${target.id}` });
        set({ editing: { id: target.id, field: "text" } });
        return;
      }
      if (!mod && !e.altKey && !e.shiftKey && TOOL_KEYS[k]) {
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
      // A link becomes an embed (videos and posts play on the board) or a link
      // card; one line of text a sticky note, more a text box.
      const slot = S().selection.length === 1 ? S().items[S().selection[0]!] : undefined;
      if (slot?.type === "embed" && !slot.locked && !str(slot.data.url) && asLink(text)) {
        commit({ [slot.id]: mergeItem(slot, { data: { url: text.trim() } }) });
        return;
      }
      const at = pointerWorld() ?? viewCenter();
      const it = asLink(text)
        ? makeEmbed(at.x, at.y, text.trim())
        : text.includes("\n") || text.length > 120
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
