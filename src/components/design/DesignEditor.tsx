import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Circle,
  Cloud,
  CloudOff,
  Frame,
  Hand,
  History,
  Image as ImageIcon,
  Keyboard,
  Ellipsis,
  MessageCircle,
  Minus,
  MousePointer2,
  MoveRight,
  PenTool,
  Pentagon,
  Play,
  Redo2,
  Square,
  Star,
  Type,
  Undo2,
  Users2,
  X,
  FileJson,
  FileUp,
  Ruler,
  Grid3x3,
  Download,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { WbShareModal } from "@/components/wb/WbShareModal";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import type { BoardAccessValue } from "@/lib/pm/boardAccess";
import type { WbBoard } from "@/lib/wb/api";
import {
  componentFromSelection,
  copySelection,
  deleteSelection,
  detachSelection,
  duplicateSelection,
  frameSelection,
  groupSelection,
  insertInstance,
  pasteClip,
  reorder,
  toggle,
  ungroupSelection,
  zoomToFit,
  zoomToSelection,
} from "@/lib/design/actions";
import { isVirtual } from "@/lib/design/doc";
import { redo, refreshText, resetDesign, toWorld, undo, useDesign, zoomAt, setViewport, type Tool } from "@/lib/design/store";
import { ensureFonts, familiesIn } from "@/lib/design/fonts";
import { setMeasure } from "@/lib/design/text";
import { useDesignSync } from "@/lib/design/sync";
import { DesignCanvas } from "./DesignCanvas";
import { CommentPins, CommentsPanel, designCommentsKey } from "./DesignComments";
import { Inspector } from "./Inspector";
import { InspectPanel } from "./InspectPanel";
import { LeftSidebar } from "./LeftSidebar";
import { VersionsPanel } from "./VersionsPanel";
import { PrototypePanel } from "./PrototypePanel";
import { exportDesignJson, importDesignJson, importSvgText } from "./importers";
import { SHORTCUTS, useDesignKeys } from "./useDesignKeys";

const PrototypePlayer = lazy(() => import("./PrototypePlayer").then((m) => ({ default: m.PrototypePlayer })));

// -----------------------------------------------------------------------------
// Design mode: the Figma-style editor on a whiteboard board. Top bar, layers /
// assets on the left, canvas in the middle, properties on the right. Board
// membership, roles and sharing are the whiteboard's (WbShareModal).
// -----------------------------------------------------------------------------

const S = useDesign.getState;
const set = useDesign.setState;

export default function DesignEditor({ board, access, onWhiteboard }: { board: WbBoard; access: BoardAccessValue; onWhiteboard: () => void }) {
  const { user, profile } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<false | "people" | "settings">(false);
  const [help, setHelp] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; world: { x: number; y: number } } | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; node: string | null } | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const canCopy = access.can_edit || access.allow_copy !== false;

  useLayoutEffect(() => {
    resetDesign(board.id, access.can_edit, access.can_comment, canCopy);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id]);
  useEffect(() => {
    set({ canEdit: access.can_edit, canComment: access.can_comment, canCopy });
    if (!access.can_edit && !["select", "hand", "comment"].includes(S().tool)) set({ tool: "select" });
  }, [access.can_edit, access.can_comment, canCopy]);

  const me = useMemo(() => (user && profile ? { id: user.id, name: profile.display_name, avatar: profile.avatar_url } : null), [user, profile]);
  const onLoadError = useCallback((e: Error) => {
    const missing = /design_doc|design_node|relation .* does not exist|schema cache/i.test(e.message);
    setLoadError(missing ? "Design mode isn't set up on the server yet (database migration 0133). Ask an admin to deploy it." : e.message);
  }, []);
  const onComments = useCallback(() => qc.invalidateQueries({ queryKey: designCommentsKey(board.id) }), [qc, board.id]);
  useDesignSync(board.id, me, onLoadError, onComments);

  const onError = useCallback((msg: string) => toast.push({ kind: "error", title: "Couldn't do that", description: msg }), [toast]);
  const onHelp = useCallback(() => setHelp(true), []);
  useDesignKeys(onError, onHelp);
  useEffect(() => {
    const fn = (e: Event) => onError((e as CustomEvent<string>).detail);
    window.addEventListener("design-error", fn);
    return () => window.removeEventListener("design-error", fn);
  }, [onError]);

  // First view: fit the page once loaded.
  const loaded = useDesign((s) => s.loaded);
  const screenW = useDesign((s) => s.screen.w);
  const placed = useRef(false);
  useEffect(() => {
    if (!loaded || placed.current || screenW < 2) return;
    placed.current = true;
    if (Object.keys(S().doc.nodes).length) zoomToFit();
    else setViewport({ zoom: 1, x: 120, y: 80 });
  }, [loaded, screenW]);
  const page = useDesign((s) => s.page);
  useEffect(() => {
    if (placed.current) zoomToFit();
  }, [page]);

  // Web fonts used by the document: load them, then measure text again.
  const fontKey = useDesign((s) => (s.loaded ? familiesIn(s.doc).sort().join("|") : ""));
  useEffect(() => {
    if (fontKey) void ensureFonts(fontKey.split("|"), refreshText);
  }, [fontKey]);
  useEffect(() => {
    // Faces fetched later (another weight, an italic) change widths too.
    const onLoaded = () => {
      setMeasure(null);
      refreshText();
    };
    document.fonts.addEventListener("loadingdone", onLoaded);
    return () => document.fonts.removeEventListener("loadingdone", onLoaded);
  }, []);

  const panel = useDesign((s) => s.panel);
  const playing = useDesign((s) => s.playing);
  const tool = useDesign((s) => s.tool);
  useEffect(() => {
    if (tool !== "comment") setDraft(null);
  }, [tool]);

  if (!ready) return null;
  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      <TopBar board={board} onWhiteboard={onWhiteboard} onShare={() => setSharing("people")} onHelp={() => setHelp(true)} />
      <div className="flex-1 flex min-h-0">
        <LeftSidebar />
        <main className="relative flex-1 min-w-0">
          {loadError ? (
            <div className="absolute inset-0 grid place-items-center p-6">
              <div className="max-w-md text-center space-y-2">
                <CloudOff className="mx-auto text-subtle" />
                <p className="text-sm text-ink">{loadError}</p>
                <Button size="sm" onClick={onWhiteboard}>
                  Back to the whiteboard
                </Button>
              </div>
            </div>
          ) : !loaded ? (
            <div className="absolute inset-0 grid place-items-center text-sm text-subtle">Loading design…</div>
          ) : (
            <>
              <DesignCanvas
                onComment={(at) => {
                  if (!access.can_comment) return;
                  setOpenThread(null);
                  setDraft(at);
                }}
                onContextMenu={setCtx}
              />
              <CommentPins boardId={board.id} draft={draft} setDraft={() => setDraft(null)} open={openThread} setOpen={setOpenThread} />
              <ZoomBar />
              {!access.can_edit && (
                <div className="absolute z-10 top-8 left-1/2 -translate-x-1/2 px-3 h-8 rounded-full bg-surface border border-border shadow-pop text-sm text-ink flex items-center">
                  {access.can_comment ? "You can view and comment" : "View only"}
                </div>
              )}
            </>
          )}
        </main>
        <RightSidebar boardId={board.id} panel={panel} onOpenThread={setOpenThread} />
      </div>

      {ctx && <ContextMenu at={ctx} onClose={() => setCtx(null)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {sharing && <WbShareModal board={board} access={access} initialTab={sharing} onClose={() => setSharing(false)} />}
      {playing && (
        <Suspense fallback={null}>
          <PrototypePlayer doc={S().doc} page={page} startId={S().doc.data.pages.find((p) => p.id === page)?.start ?? null} onClose={() => set({ playing: false })} />
        </Suspense>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ top bar --
const TOOLS: { tool: Tool; icon: ReactNode; title: string; edit: boolean }[] = [
  { tool: "select", icon: <MousePointer2 size={16} />, title: "Move (V)", edit: false },
  { tool: "hand", icon: <Hand size={16} />, title: "Hand (H)", edit: false },
  { tool: "frame", icon: <Frame size={16} />, title: "Frame (F)", edit: true },
  { tool: "rect", icon: <Square size={16} />, title: "Rectangle (R)", edit: true },
  { tool: "ellipse", icon: <Circle size={16} />, title: "Ellipse (O)", edit: true },
  { tool: "line", icon: <Minus size={16} />, title: "Line (L)", edit: true },
  { tool: "arrow", icon: <MoveRight size={16} />, title: "Arrow", edit: true },
  { tool: "polygon", icon: <Pentagon size={16} />, title: "Polygon", edit: true },
  { tool: "star", icon: <Star size={16} />, title: "Star (Shift+8)", edit: true },
  { tool: "pen", icon: <PenTool size={16} />, title: "Pen (P)", edit: true },
  { tool: "text", icon: <Type size={16} />, title: "Text (T)", edit: true },
  { tool: "image", icon: <ImageIcon size={16} />, title: "Image", edit: true },
  { tool: "comment", icon: <MessageCircle size={16} />, title: "Comment (C)", edit: false },
];

function TopBar({ board, onWhiteboard, onShare, onHelp }: { board: WbBoard; onWhiteboard: () => void; onShare: () => void; onHelp: () => void }) {
  const toast = useToast();
  const tool = useDesign((s) => s.tool);
  const canEdit = useDesign((s) => s.canEdit);
  const canComment = useDesign((s) => s.canComment);
  const canCopy = useDesign((s) => s.canCopy);
  const saveState = useDesign((s) => s.saveState);
  const pastLen = useDesign((s) => s.past.length);
  const futureLen = useDesign((s) => s.future.length);
  const peers = useDesign((s) => s.peers);
  const panel = useDesign((s) => s.panel);
  const { profile } = useAuth();
  const people = Object.values(Object.values(peers).reduce<Record<string, (typeof peers)[string]>>((acc, p) => ((acc[p.uid] ??= p), acc), {}));
  const fileInput = useRef<HTMLInputElement>(null);

  const btn = (on: boolean) => cn("h-8 w-8 shrink-0 grid place-items-center rounded-md transition-colors", on ? "bg-accent text-white" : "text-muted hover:bg-hover hover:text-ink");

  return (
    <header data-design-ui className="h-12 shrink-0 flex items-center gap-2 px-2 bg-surface border-b border-border" onPointerDown={(e) => e.stopPropagation()}>
      <Link to="/wb" className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-hover hover:text-ink" title="Back to boards" aria-label="Back to boards">
        <ArrowLeft size={17} />
      </Link>
      <span className="text-sm font-semibold text-ink truncate max-w-[180px]" title={board.title}>
        {board.title}
      </span>
      <div className="flex h-8 rounded-md bg-inset p-0.5 text-xs shrink-0" role="tablist" aria-label="Mode">
        <button role="tab" aria-selected={false} className="px-2.5 rounded text-muted hover:text-ink" onClick={onWhiteboard}>
          Whiteboard
        </button>
        <button role="tab" aria-selected className="px-2.5 rounded bg-surface text-ink shadow-sm font-medium">
          Design
        </button>
      </div>
      <Menu
        trigger={
          <button className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-hover hover:text-ink" aria-label="Design menu" title="Design menu">
            <Ellipsis size={17} />
          </button>
        }
      >
        {(close) => (
          <div className="min-w-[240px]">
            {canCopy && (
              <MenuItem onClick={() => (exportDesignJson(board.title), close())}>
                <span className="inline-flex items-center gap-2">
                  <FileJson size={14} /> Export design file (.json)
                </span>
              </MenuItem>
            )}
            {canEdit && (
              <MenuItem onClick={() => (fileInput.current?.click(), close())}>
                <span className="inline-flex items-center gap-2">
                  <FileUp size={14} /> Import design file or SVG
                </span>
              </MenuItem>
            )}
            {canCopy && (
              <MenuItem onClick={() => (set({ rightTab: "design", selection: [] }), close())}>
                <span className="inline-flex items-center gap-2">
                  <Download size={14} /> Export frames (PNG, JPG, SVG, PDF)
                </span>
              </MenuItem>
            )}
            <MenuDivider />
            <MenuItem onClick={() => (set({ showRulers: !S().showRulers }), close())}>
              <span className="inline-flex items-center gap-2">
                <Ruler size={14} /> {S().showRulers ? "Hide rulers" : "Show rulers"}
              </span>
            </MenuItem>
            <MenuItem onClick={() => (set({ showGrid: !S().showGrid }), close())}>
              <span className="inline-flex items-center gap-2">
                <Grid3x3 size={14} /> {S().showGrid ? "Hide pixel grid" : "Show pixel grid"}
              </span>
            </MenuItem>
            <MenuItem onClick={() => (set({ snap: !S().snap }), close())}>
              <span className="inline-flex items-center gap-2">
                <Check size={14} className={S().snap ? "" : "invisible"} /> Snap to objects
              </span>
            </MenuItem>
            <MenuItem onClick={() => (onHelp(), close())}>
              <span className="inline-flex items-center gap-2">
                <Keyboard size={14} /> Keyboard shortcuts
              </span>
            </MenuItem>
          </div>
        )}
      </Menu>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json,.svg,image/svg+xml"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            const text = await f.text();
            if (f.name.endsWith(".svg") || text.trim().startsWith("<")) {
              const s = S();
              importSvgText(text, toWorld({ x: s.screen.w / 2, y: s.screen.h / 2 }));
            } else {
              const n = importDesignJson(text);
              toast.push({ kind: "success", title: "Imported", description: `${n} layers added on new pages.` });
            }
          } catch (err) {
            toast.push({ kind: "error", title: "Couldn't import", description: (err as Error).message });
          }
        }}
      />
      <SaveBadge state={saveState} />

      <div className="flex-1 flex justify-center min-w-0">
        <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {TOOLS.filter((t) => (t.edit ? canEdit : t.tool !== "comment" || canComment)).map((t) => (
            <button
              key={t.tool}
              className={btn(tool === t.tool)}
              title={t.title}
              aria-label={t.title}
              aria-pressed={tool === t.tool}
              onClick={() => set({ tool: t.tool, toolLock: false })}
              onDoubleClick={() => set({ tool: t.tool, toolLock: true })}
            >
              {t.icon}
            </button>
          ))}
          {canEdit && (
            <>
              <span className="w-px h-5 bg-line mx-1" />
              <button className={btn(false)} title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!pastLen} onClick={undo}>
                <Undo2 size={16} className={!pastLen ? "opacity-40" : ""} />
              </button>
              <button className={btn(false)} title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!futureLen} onClick={redo}>
                <Redo2 size={16} className={!futureLen ? "opacity-40" : ""} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center -space-x-1.5">
        {people.slice(0, 4).map((p) => (
          <span key={p.uid} className="rounded-full" title={p.name} style={{ boxShadow: `0 0 0 2px ${p.color}` }}>
            <Avatar name={p.name} src={p.avatar} size={26} />
          </span>
        ))}
        {people.length > 4 && <span className="h-6 min-w-6 px-1 rounded-full bg-inset text-[11px] grid place-items-center">+{people.length - 4}</span>}
        <span className="rounded-full" title="You">
          <Avatar name={profile?.display_name ?? "You"} src={profile?.avatar_url} size={26} />
        </span>
      </div>
      <button className={btn(panel === "comments")} title="Comments" aria-label="Comments" onClick={() => set({ panel: panel === "comments" ? null : "comments" })}>
        <MessageCircle size={16} />
      </button>
      <button className={btn(panel === "versions")} title="Version history" aria-label="Version history" onClick={() => set({ panel: panel === "versions" ? null : "versions" })}>
        <History size={16} />
      </button>
      <button className={btn(false)} title="Present prototype" aria-label="Present prototype" onClick={() => set({ playing: true })}>
        <Play size={16} />
      </button>
      <Button size="sm" variant="primary" className="shrink-0" iconLeft={<Users2 size={15} />} onClick={onShare}>
        <span className="hidden lg:inline">Share</span>
      </Button>
    </header>
  );
}

function SaveBadge({ state }: { state: string }) {
  const title = state === "retrying" ? "Not saved yet: can't reach the server. Trying again" : state === "error" ? "A change couldn't be saved and was undone" : state === "saving" ? "Saving" : "All changes saved";
  return (
    <span className={cn("shrink-0 hidden sm:inline-flex items-center text-xs", state === "error" ? "text-danger" : "text-subtle")} title={title} aria-label={title}>
      {state === "retrying" || state === "error" ? <CloudOff size={14} /> : state === "saving" ? <Cloud size={14} className="animate-pulse" /> : <Check size={14} />}
    </span>
  );
}

function ZoomBar() {
  const zoom = useDesign((s) => s.viewport.zoom);
  return (
    <div data-design-ui className="absolute z-10 right-3 bottom-3 flex items-center gap-0.5 h-8 px-1 bg-surface border border-border rounded-md shadow-pop text-xs" onPointerDown={(e) => e.stopPropagation()}>
      <button className="h-6 w-6 grid place-items-center rounded hover:bg-hover text-muted" title="Zoom out (Ctrl -)" onClick={() => zoomAt(0.8)}>
        −
      </button>
      <Menu
        align="right"
        trigger={
          <button className="h-6 px-1.5 rounded hover:bg-hover text-ink tabular-nums" title="Zoom">
            {Math.round(zoom * 100)}%
          </button>
        }
      >
        {(close) => (
          <div className="min-w-[180px]">
            <MenuItem onClick={() => (zoomToFit(), close())}>Zoom to fit · Shift+1</MenuItem>
            <MenuItem onClick={() => (zoomToSelection(), close())}>Zoom to selection · Shift+2</MenuItem>
            {[0.5, 1, 2].map((z) => (
              <MenuItem
                key={z}
                onClick={() => {
                  zoomAt(z / S().viewport.zoom);
                  close();
                }}
              >
                Zoom to {z * 100}%
              </MenuItem>
            ))}
          </div>
        )}
      </Menu>
      <button className="h-6 w-6 grid place-items-center rounded hover:bg-hover text-muted" title="Zoom in (Ctrl +)" onClick={() => zoomAt(1.25)}>
        +
      </button>
    </div>
  );
}

// ------------------------------------------------------------ right sidebar --
function RightSidebar({ boardId, panel, onOpenThread }: { boardId: string; panel: ReturnType<typeof S>["panel"]; onOpenThread: (id: string) => void }) {
  const tab = useDesign((s) => s.rightTab);
  if (panel === "comments" || panel === "versions")
    return (
      <aside data-design-ui className="w-[272px] shrink-0 bg-surface border-l border-border flex flex-col min-h-0" onPointerDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between h-10 px-3 border-b border-border">
          <span className="text-xs font-semibold text-ink">{panel === "comments" ? "Comments" : "Version history"}</span>
          <button className="h-7 w-7 grid place-items-center rounded hover:bg-hover text-muted" onClick={() => set({ panel: null })} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        {panel === "comments" ? <CommentsPanel boardId={boardId} onOpen={onOpenThread} /> : <VersionsPanel boardId={boardId} />}
      </aside>
    );
  return (
    <aside data-design-ui className="w-[272px] shrink-0 bg-surface border-l border-border flex flex-col min-h-0" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex h-10 border-b border-border px-2 gap-1 items-center">
        {(["design", "prototype", "inspect"] as const).map((t) => (
          <button key={t} className={cn("h-7 px-2.5 rounded text-xs font-medium capitalize", tab === t ? "bg-hover text-ink" : "text-muted hover:text-ink")} onClick={() => set({ rightTab: t })}>
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">{tab === "design" ? <Inspector /> : tab === "prototype" ? <PrototypePanel /> : <InspectPanel />}</div>
    </aside>
  );
}

// ------------------------------------------------------------- context menu --
function ContextMenu({ at, onClose }: { at: { x: number; y: number; world: { x: number; y: number } }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const sel = useDesign((s) => s.selection);
  const canEdit = useDesign((s) => s.canEdit);
  const canCopy = useDesign((s) => s.canCopy);
  const doc = useDesign((s) => s.doc);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useEffect(() => {
    const el = ref.current;
    if (el) setPos({ left: Math.min(at.x, window.innerWidth - el.offsetWidth - 8), top: Math.min(at.y, window.innerHeight - el.offsetHeight - 8) });
    const off = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", esc);
    };
  }, [at, onClose]);
  const real = sel.filter((id) => !isVirtual(id)).map((id) => doc.nodes[id]).filter(Boolean);
  const one = real.length === 1 ? real[0]! : null;
  const item = (label: string, fn: () => void, k?: string, danger?: boolean) => (
    <button
      role="menuitem"
      className={cn("flex w-full items-center justify-between gap-6 px-3 py-1.5 text-sm text-left hover:bg-hover", danger ? "text-danger" : "text-ink")}
      onClick={() => {
        fn();
        onClose();
      }}
    >
      <span>{label}</span>
      {k && <span className="text-xs text-subtle">{k}</span>}
    </button>
  );
  const line = <div className="my-1 h-px bg-line" />;
  return (
    <div ref={ref} data-design-ui role="menu" className="fixed z-50 min-w-[230px] py-1 bg-surface border border-border rounded-md shadow-pop animate-menu-in" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {canEdit && item("Paste here", () => void navigator.clipboard?.readText().then((t) => pasteClip(t, at.world), () => pasteClip(null, at.world)), "Ctrl+V")}
      {sel.length > 0 && (
        <>
          {canCopy && item("Copy", () => void copySelection(), "Ctrl+C")}
          {canEdit && real.length > 0 && (
            <>
              {item("Duplicate", () => duplicateSelection(), "Ctrl+D")}
              {item("Delete", () => deleteSelection(), "Del", true)}
              {line}
              {item("Bring to front", () => reorder("front"), "Ctrl+]")}
              {item("Send to back", () => reorder("back"), "Ctrl+[")}
              {line}
              {item("Group", groupSelection, "Ctrl+G")}
              {item("Frame selection", frameSelection, "Ctrl+Alt+G")}
              {one && (one.type === "group" || one.type === "frame") && item("Ungroup", ungroupSelection, "Ctrl+Shift+G")}
              {one?.type !== "component" && item("Create component", componentFromSelection, "Ctrl+Alt+K")}
              {one?.type === "component" && item("Add instance", () => insertInstance(one.id, { x: at.world.x, y: at.world.y }))}
              {one?.type === "instance" && item("Detach instance", detachSelection, "Ctrl+Alt+B")}
              {line}
              {item(real.every((n) => n!.visible) ? "Hide" : "Show", () => toggle("visible"), "Ctrl+Shift+H")}
              {item(real.every((n) => n!.locked) ? "Unlock" : "Lock", () => toggle("locked"), "Ctrl+Shift+L")}
            </>
          )}
          {item("Zoom to selection", zoomToSelection, "Shift+2")}
        </>
      )}
      {!sel.length && item("Zoom to fit", zoomToFit, "Shift+1")}
    </div>
  );
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg shadow-raise w-full max-w-lg max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-border">
          <h2 className="text-sm font-semibold text-ink">Design mode shortcuts</h2>
          <button className="h-8 w-8 grid place-items-center rounded hover:bg-hover text-muted" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <dl className="p-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-xs text-ink whitespace-nowrap">{k}</dt>
              <dd className="text-muted">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
