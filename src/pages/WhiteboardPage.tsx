import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ellipsis,
  Minus,
  Plus,
  Map as MapIcon,
  MessageCircle,
  Search,
  Layers,
  Presentation,
  Vote,
  Cloud,
  CloudOff,
  Check,
  Grid3x3,
  Keyboard,
  Download,
  Link2,
  Settings,
  Trash2,
  Eye,
  Users2,
  Focus,
  Crosshair,
  Megaphone,
} from "lucide-react";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { WbShareModal } from "@/components/wb/WbShareModal";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { useBoardAccess, type BoardAccessValue } from "@/lib/pm/boardAccess";
import { deleteBoard, updateBoard } from "@/lib/pm/boardApi";
import { fetchWbBoard, savePreview, type WbBoard } from "@/lib/wb/api";
import { buildPreview } from "@/lib/wb/preview";
import {
  useWb,
  resetBoard,
  zoomAt,
  zoomToFit,
  animateViewport,
  setViewport,
  viewportFor,
  select,
  deleteItems,
  viewCenter,
  contentBounds,
  type Peer,
} from "@/lib/wb/store";
import { useWhiteboardSync, useBroadcastSelection, summonEveryone, summonListeners } from "@/lib/wb/sync";
import { bringToFront, copySelection, duplicate, frameAround, pasteText, sendToBack, setLocked } from "@/lib/wb/actions";
import { geomBounds } from "@/lib/wb/geometry";
import { Canvas } from "@/components/wb/Canvas";
import { Toolbar } from "@/components/wb/Toolbar";
import { ContextToolbar } from "@/components/wb/ContextToolbar";
import { useWbKeys } from "@/components/wb/useWbKeys";
import { CommentsLayer, CommentsPanel, useOpenCommentCount } from "@/components/wb/comments/CommentsLayer";
import { VotingLayer, VotingPanel, useVotingOpen } from "@/components/wb/voting/Voting";
import { TimerButton } from "@/components/wb/TimerButton";
import { TemplatesPanel } from "@/components/wb/TemplatesPanel";
import { FramesPanel, PresentMode } from "@/components/wb/FramesPanel";
import { SearchPanel } from "@/components/wb/SearchPanel";
import { Minimap } from "@/components/wb/Minimap";
import { WbShortcutsHelp } from "@/components/wb/WbShortcutsHelp";
import { exportPng } from "@/lib/wb/exportImage";

// -----------------------------------------------------------------------------
// One whiteboard (Miro-style). Board membership, roles and sharing are the
// same as Trello boards; the canvas lives in components/wb.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

export function WhiteboardPage() {
  const { boardId = "" } = useParams();
  const access = useBoardAccess(boardId);
  const boardQ = useQuery({ queryKey: ["wb-board", boardId], queryFn: () => fetchWbBoard(boardId), enabled: !!boardId });

  if (boardQ.isLoading || access.loading) return <PageSpinner />;
  if (boardQ.error || !boardQ.data || !access.access)
    return (
      <div className="p-6">
        <EmptyState title="Whiteboard not found" description="It may have been deleted, or you don't have access." />
      </div>
    );
  if (boardQ.data.kind !== "whiteboard") return <Navigate to={`/pm/boards/${boardId}`} replace />;
  return <Whiteboard key={boardId} board={boardQ.data} access={access} />;
}

const VIEW_KEY = (id: string) => `wb-view:${id}`;

function Whiteboard({ board, access }: { board: WbBoard; access: BoardAccessValue }) {
  const { user, profile } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [sharing, setSharing] = useState<false | "people" | "settings">(false);
  const [help, setHelp] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; world: { x: number; y: number }; id: string | null } | null>(null);
  const panel = useWb((s) => s.panel);
  const loaded = useWb((s) => s.loaded);
  const presenting = useWb((s) => s.presenting);
  const focusThread = params.get("comment");

  // Fresh store for this board before anything reads it (a layout effect, so
  // no other component is updated mid-render).
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    resetBoard(board.id, user!.id, access.can_edit, access.can_comment);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id]);
  // Viewers and commenters may be barred from copying / exporting (share settings).
  const canCopy = access.can_edit || access.allow_copy !== false;
  useEffect(() => {
    set({ canEdit: access.can_edit, canComment: access.can_comment, canCopy });
    if (!access.can_edit && !["select", "hand", "comment"].includes(S().tool)) set({ tool: "select" });
  }, [access.can_edit, access.can_comment, canCopy]);

  const me = useMemo(
    () => (user && profile ? { id: user.id, name: profile.display_name, avatar: profile.avatar_url } : null),
    [user, profile],
  );
  useWhiteboardSync(board.id, me);
  useBroadcastSelection();

  const onError = useCallback((msg: string) => toast.push({ kind: "error", title: "Couldn't add image", description: msg }), [toast]);
  const onSearch = useCallback(() => set({ panel: "search" }), []);
  const onHelp = useCallback(() => setHelp(true), []);
  useWbKeys({ onSearch, onHelp, onError });

  // First paint: deep link (?item=), else where you left off, else fit everything.
  const placed = useRef(false);
  const screenW = useWb((s) => s.screen.w);
  useEffect(() => {
    // Read the live flag: on the first render `loaded` can still be the previous board's.
    if (!S().loaded || placed.current) return;
    const s = S();
    if (s.screen.w < 2) return;
    placed.current = true;
    const item = params.get("item");
    if (item && s.items[item]) {
      setViewport(viewportFor(geomBounds(s.items[item]!), 120, 1.5));
      select([item]);
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(VIEW_KEY(board.id)) ?? "null") as { cx: number; cy: number; zoom: number } | null;
      if (saved && !focusThread) {
        setViewport({ zoom: saved.zoom, x: s.screen.w / 2 - saved.cx * saved.zoom, y: s.screen.h / 2 - saved.cy * saved.zoom });
        return;
      }
    } catch {
      /* ignore */
    }
    const all = contentBounds(s);
    if (all) setViewport(viewportFor(all, 80, 1));
    else setViewport({ zoom: 1, x: s.screen.w / 2, y: s.screen.h / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, screenW]);

  // Just created (?new=1): an empty board opens on the templates.
  useEffect(() => {
    if (!S().loaded || !params.has("new")) return;
    if (!Object.keys(S().items).length) set({ panel: "templates" });
    params.delete("new");
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Remember the view per board.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = useWb.subscribe((s, p) => {
      if (s.viewport === p.viewport || !placed.current) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const c = viewCenter();
        try {
          localStorage.setItem(VIEW_KEY(board.id), JSON.stringify({ cx: Math.round(c.x), cy: Math.round(c.y), zoom: S().viewport.zoom }));
        } catch {
          /* storage blocked */
        }
      }, 400);
    });
    return () => {
      unsub();
      if (t) clearTimeout(t);
    };
  }, [board.id]);

  // Thumbnail for the whiteboards grid: saved now and then while editing, and on leave.
  useEffect(() => {
    if (!access.can_edit) return;
    let dirtyPreview = false;
    const unsub = useWb.subscribe((s, p) => {
      if (s.items !== p.items && s.loaded && p.loaded) dirtyPreview = true;
    });
    const save = () => {
      if (!dirtyPreview) return;
      dirtyPreview = false;
      const pv = buildPreview(S().items);
      if (pv) void savePreview(board.id, pv);
    };
    const iv = setInterval(save, 45_000);
    return () => {
      unsub();
      clearInterval(iv);
      save();
      qc.invalidateQueries({ queryKey: ["boards"] });
    };
  }, [board.id, access.can_edit, qc]);

  // Following someone: keep my view on theirs.
  useEffect(
    () =>
      useWb.subscribe((s, p) => {
        if (!s.following) return;
        const peer = s.peers[s.following];
        if (!peer?.view || peer === p.peers[s.following] && s.following === p.following) return;
        const v = peer.view;
        setViewport({ zoom: v.zoom, x: s.screen.w / 2 - v.cx * v.zoom, y: s.screen.h / 2 - v.cy * v.zoom });
      }),
    [],
  );

  // "Bring everyone to me".
  useEffect(() => {
    const fn = (from: Peer, v: { cx: number; cy: number; zoom: number }) => {
      const s = S();
      animateViewport({ zoom: v.zoom, x: s.screen.w / 2 - v.cx * v.zoom, y: s.screen.h / 2 - v.cy * v.zoom }, 500);
      toast.push({ kind: "info", title: `${from.name} brought everyone to their view` });
    };
    summonListeners.add(fn);
    return () => {
      summonListeners.delete(fn);
    };
  }, [toast]);

  const doExport = async (ids?: string[]) => {
    try {
      await exportPng({ ids, title: board.title });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't export", description: (e as Error).message });
    }
  };

  const removeBoard = async () => {
    const ok = await confirm({
      title: "Delete whiteboard?",
      message: `"${board.title}" and everything on it will be deleted for everyone. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteBoard(board.id);
      qc.invalidateQueries({ queryKey: ["boards"] });
      nav("/wb", { replace: true });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't delete", description: (e as Error).message });
    }
  };

  const closePanel = () => set({ panel: null });

  if (!ready) return null;
  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      <Canvas onContextMenu={setCtx}>
        <CommentsLayer boardId={board.id} focusThread={focusThread} />
        <VotingLayer boardId={board.id} />
        {!presenting && <ContextToolbar onComment={(id) => commentOn(id)} />}
      </Canvas>

      {!presenting && (
        <>
          <TopLeft
            board={board}
            access={access}
            onShare={() => setSharing("settings")}
            onExport={doExport}
            onDelete={removeBoard}
            onHelp={() => setHelp(true)}
          />
          <TopRight boardId={board.id} onShare={() => setSharing("people")} />
          <Toolbar onTemplates={() => set({ panel: panel === "templates" ? null : "templates" })} />
          <ZoomControls />
          <Minimap />
          {!access.can_edit && (
            // Miro's read-only pill: what you can do here and how to get more.
            <div
              data-wb-ui
              className="absolute z-20 top-[4.25rem] max-md:top-[7.75rem] left-1/2 -translate-x-1/2 max-w-[calc(100%-24px)] flex items-center gap-2 px-3 h-8 rounded-full bg-surface border border-border shadow-pop text-sm animate-slide-down"
              title="Ask an owner or co-owner for edit access"
            >
              {access.can_comment ? <MessageCircle size={14} className="text-accent shrink-0" /> : <Eye size={14} className="text-accent shrink-0" />}
              <span className="text-ink whitespace-nowrap">{access.can_comment ? "You can view and comment" : "View only"}</span>
            </div>
          )}
        </>
      )}

      {panel && !presenting && (
        <aside
          data-wb-ui
          className="absolute z-30 right-3 top-16 bottom-3 w-[340px] max-w-[calc(100%-24px)] bg-surface border border-border rounded-lg shadow-raise flex flex-col overflow-hidden animate-slide-up max-md:bottom-[calc(4.5rem)]"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {panel === "comments" && <CommentsPanel boardId={board.id} onClose={closePanel} />}
          {panel === "voting" && <VotingPanel boardId={board.id} onClose={closePanel} />}
          {panel === "templates" && <TemplatesPanel onClose={closePanel} />}
          {panel === "frames" && <FramesPanel onClose={closePanel} />}
          {panel === "search" && <SearchPanel onClose={closePanel} />}
        </aside>
      )}

      <PresentMode />

      {ctx && <CanvasMenu at={ctx} onClose={() => setCtx(null)} onComment={commentOn} />}

      {sharing && <WbShareModal board={board} access={access} initialTab={sharing} onClose={() => setSharing(false)} />}
      <WbShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );

  function commentOn(id: string) {
    const it = S().items[id];
    if (!it) return;
    set({ draftComment: { x: it.w, y: 0, item_id: id }, openThread: null });
    if (params.has("comment")) {
      params.delete("comment");
      setParams(params, { replace: true });
    }
  }
}

// ------------------------------------------------------------------ top left --
function TopLeft({
  board,
  access,
  onShare,
  onExport,
  onDelete,
  onHelp,
}: {
  board: WbBoard;
  access: BoardAccessValue;
  onShare: () => void;
  onExport: (ids?: string[]) => void;
  onDelete: () => void;
  onHelp: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(board.title);
  useEffect(() => setTitle(board.title), [board.title]);
  const saveState = useWb((s) => s.saveState);
  const showGrid = useWb((s) => s.showGrid);
  const hasSel = useWb((s) => s.selection.length > 0);
  const canCopy = useWb((s) => s.canCopy);

  const rename = async () => {
    setEditing(false);
    const t = title.trim();
    if (!t || t === board.title) return setTitle(board.title);
    try {
      await updateBoard(board.id, { title: t.slice(0, 200) });
      qc.invalidateQueries({ queryKey: ["wb-board", board.id] });
      qc.invalidateQueries({ queryKey: ["boards"] });
    } catch (e) {
      setTitle(board.title);
      toast.push({ kind: "error", title: "Couldn't rename", description: (e as Error).message });
    }
  };

  return (
    <div
      data-wb-ui
      className="absolute z-20 left-3 top-3 h-12 max-w-[calc(100%-24px)] md:max-w-[min(480px,calc(100%-420px))] flex items-center gap-1 pl-1 pr-2 bg-surface border border-border rounded-lg shadow-pop"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Link to="/wb" className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink" title="All whiteboards" aria-label="All whiteboards">
        <ArrowLeft size={17} />
      </Link>
      {editing ? (
        <input
          autoFocus
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setTitle(board.title);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 h-8 px-2 rounded-md border border-accent bg-surface text-ink font-semibold text-base outline-none"
        />
      ) : (
        <button
          className="min-w-0 truncate h-8 px-2 rounded-md text-ink font-semibold text-base hover:bg-inset text-left"
          onClick={() => access.can_edit && setEditing(true)}
          title={access.can_edit ? "Rename" : board.title}
        >
          {board.title}
        </button>
      )}
      <Menu
        trigger={
          <button className="h-8 w-8 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink" aria-label="Board menu" title="Board menu">
            <Ellipsis size={17} />
          </button>
        }
      >
        {(close) => (
          <div className="min-w-[230px]">
            {canCopy && (
              <MenuItem onClick={() => (onExport(), close())}>
                <span className="inline-flex items-center gap-2">
                  <Download size={14} /> Export board as image
                </span>
              </MenuItem>
            )}
            {hasSel && canCopy && (
              <MenuItem onClick={() => (onExport(S().selection), close())}>
                <span className="inline-flex items-center gap-2">
                  <Download size={14} /> Export selection as image
                </span>
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#/wb/${board.id}`).catch(() => undefined);
                toast.push({ kind: "success", title: "Link copied" });
                close();
              }}
            >
              <span className="inline-flex items-center gap-2">
                <Link2 size={14} /> Copy board link
              </span>
            </MenuItem>
            <MenuDivider />
            <MenuItem onClick={() => (set({ showGrid: !showGrid }), close())}>
              <span className="inline-flex items-center gap-2">
                <Grid3x3 size={14} /> {showGrid ? "Hide grid" : "Show grid"}
              </span>
            </MenuItem>
            <MenuItem onClick={() => (onHelp(), close())}>
              <span className="inline-flex items-center gap-2">
                <Keyboard size={14} /> Keyboard shortcuts
              </span>
            </MenuItem>
            {access.access === "admin" && (
              <MenuItem onClick={() => (onShare(), close())}>
                <span className="inline-flex items-center gap-2">
                  <Settings size={14} /> Board settings
                </span>
              </MenuItem>
            )}
            {access.delete_board && (
              <>
                <MenuDivider />
                <MenuItem destructive onClick={() => (onDelete(), close())}>
                  <span className="inline-flex items-center gap-2">
                    <Trash2 size={14} /> Delete whiteboard
                  </span>
                </MenuItem>
              </>
            )}
          </div>
        )}
      </Menu>
      <span
        className={cn("shrink-0 hidden sm:inline-flex items-center gap-1 text-xs pl-1", saveState === "error" ? "text-danger" : "text-subtle")}
        title={
          saveState === "offline"
            ? "Offline: your changes will save when you're back online"
            : saveState === "error"
              ? "A change couldn't be saved and was undone"
              : saveState === "saving"
                ? "Saving"
                : "All changes saved"
        }
      >
        {saveState === "offline" ? <CloudOff size={14} /> : saveState === "saving" ? <Cloud size={14} className="animate-pulse" /> : saveState === "error" ? <CloudOff size={14} /> : <Check size={14} />}
      </span>
    </div>
  );
}

// ----------------------------------------------------------------- top right --
function TopRight({ boardId, onShare }: { boardId: string; onShare: () => void }) {
  const { profile } = useAuth();
  const panel = useWb((s) => s.panel);
  const peers = useWb((s) => s.peers);
  const following = useWb((s) => s.following);
  const openComments = useOpenCommentCount(boardId);
  const voting = useVotingOpen(boardId);
  // One avatar per person (several tabs share one).
  const people = Object.values(
    Object.values(peers).reduce<Record<string, Peer>>((acc, p) => {
      if (!acc[p.uid]) acc[p.uid] = p;
      return acc;
    }, {}),
  );
  const toggle = (p: NonNullable<typeof panel>) => set({ panel: panel === p ? null : p });
  const iconBtn = (on: boolean) =>
    cn("relative h-9 w-9 shrink-0 grid place-items-center rounded-md transition-colors", on ? "bg-accent-soft text-accent" : "text-muted hover:bg-inset hover:text-ink");

  return (
    <div
      data-wb-ui
      className="absolute z-20 right-3 top-3 h-12 max-md:top-[4.25rem] max-md:left-3 flex items-center gap-1 px-1.5 bg-surface border border-border rounded-lg shadow-pop overflow-x-auto [scrollbar-width:none]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <TimerButton boardId={boardId} />
      <button className={iconBtn(panel === "voting" || voting)} onClick={() => toggle("voting")} title="Voting" aria-label="Voting">
        <Vote size={17} />
        {voting && <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-accent" />}
      </button>
      <button className={iconBtn(panel === "frames")} onClick={() => toggle("frames")} title="Frames and presenting" aria-label="Frames">
        <Layers size={17} />
      </button>
      <button
        className={iconBtn(false)}
        onClick={() => {
          const frames = Object.values(S().items).filter((i) => i.type === "frame");
          if (frames.length) set({ presenting: true, panel: null });
          else set({ panel: "frames" });
        }}
        title="Present"
        aria-label="Present"
      >
        <Presentation size={17} />
      </button>
      <span className="w-px h-6 bg-line mx-0.5 shrink-0" />
      <button className={iconBtn(panel === "comments")} onClick={() => toggle("comments")} title="Comments" aria-label="Comments">
        <MessageCircle size={17} />
        {openComments > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-accent text-white text-[10px] font-semibold grid place-items-center">
            {openComments > 99 ? "99+" : openComments}
          </span>
        )}
      </button>
      <button className={iconBtn(panel === "search")} onClick={() => toggle("search")} title="Search (Ctrl+F)" aria-label="Search">
        <Search size={17} />
      </button>
      <span className="w-px h-6 bg-line mx-0.5 shrink-0" />

      <div className="flex items-center -space-x-1.5 pl-1">
        {people.slice(0, 4).map((p) => (
          <Menu
            key={p.uid}
            align="right"
            trigger={
              <button className="rounded-full" title={p.name} aria-label={p.name}>
                <span className="rounded-full block" style={{ boxShadow: `0 0 0 2px ${p.color}` }}>
                  <Avatar name={p.name} src={p.avatar} size={28} />
                </span>
              </button>
            }
          >
            {(close) => (
              <div className="min-w-[200px]">
                <div className="px-3 py-2 text-sm font-semibold text-ink">{p.name}</div>
                <MenuDivider />
                <MenuItem
                  onClick={() => {
                    const s = S();
                    if (p.view) animateViewport({ zoom: p.view.zoom, x: s.screen.w / 2 - p.view.cx * p.view.zoom, y: s.screen.h / 2 - p.view.cy * p.view.zoom });
                    close();
                  }}
                >
                  <span className="inline-flex items-center gap-2">
                    <Crosshair size={14} /> Go to {p.name.split(" ")[0]}
                  </span>
                </MenuItem>
                <MenuItem onClick={() => (set({ following: following === p.sid ? null : p.sid }), close())}>
                  <span className="inline-flex items-center gap-2">
                    <Focus size={14} /> {following === p.sid ? "Stop following" : `Follow ${p.name.split(" ")[0]}`}
                  </span>
                </MenuItem>
              </div>
            )}
          </Menu>
        ))}
        {people.length > 4 && (
          <span className="h-7 min-w-7 px-1 rounded-full bg-inset text-xs text-ink grid place-items-center ring-2 ring-surface">+{people.length - 4}</span>
        )}
        <Menu
          align="right"
          trigger={
            <button className="rounded-full" title="You" aria-label="You">
              <Avatar name={profile?.display_name ?? "You"} src={profile?.avatar_url} size={28} />
            </button>
          }
        >
          {(close) => (
            <div className="min-w-[220px]">
              <div className="px-3 py-2 text-sm text-ink">
                <div className="font-semibold">{profile?.display_name}</div>
                <div className="text-xs text-subtle">{people.length ? `${people.length} other${people.length === 1 ? "" : "s"} here` : "Only you here right now"}</div>
              </div>
              <MenuDivider />
              <MenuItem disabled={!people.length} onClick={() => (summonEveryone(), close())}>
                <span className="inline-flex items-center gap-2">
                  <Megaphone size={14} /> Bring everyone to me
                </span>
              </MenuItem>
            </div>
          )}
        </Menu>
      </div>

      <Button size="sm" variant="primary" className="ml-1 shrink-0" iconLeft={<Users2 size={15} />} onClick={onShare}>
        <span className="hidden sm:inline">Share</span>
      </Button>
    </div>
  );
}

// -------------------------------------------------------------------- zoom --
function ZoomControls() {
  const zoom = useWb((s) => s.viewport.zoom);
  const minimap = useWb((s) => s.showMinimap);
  const at = () => ({ x: S().screen.w / 2, y: S().screen.h / 2 });
  const to = (z: number) => {
    const s = S();
    const c = viewCenter();
    animateViewport({ zoom: z, x: s.screen.w / 2 - c.x * z, y: s.screen.h / 2 - c.y * z }, 200);
  };
  const btn = "h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink";
  return (
    <div
      data-wb-ui
      className="absolute z-20 right-3 bottom-3 max-md:bottom-[4.5rem] flex items-center gap-0.5 p-1 bg-surface border border-border rounded-lg shadow-pop"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className={cn(btn, minimap && "bg-accent-soft text-accent")} onClick={() => set({ showMinimap: !minimap })} title="Map" aria-label="Map">
        <MapIcon size={16} />
      </button>
      <button className={cn(btn, "max-sm:hidden")} onClick={() => zoomAt(at(), zoom / 1.25)} title="Zoom out (Ctrl+-)" aria-label="Zoom out">
        <Minus size={16} />
      </button>
      <Menu
        align="right"
        trigger={
          <button className="h-8 min-w-14 px-1 rounded-md text-sm text-ink tabular-nums hover:bg-inset" title="Zoom" aria-label="Zoom level">
            {Math.round(zoom * 100)}%
          </button>
        }
      >
        {(close) => (
          <div className="min-w-[200px]">
            <MenuItem onClick={() => (zoomToFit(), close())}>
              <span className="flex justify-between gap-4 w-full">
                Zoom to fit <span className="text-xs text-subtle">Shift+1</span>
              </span>
            </MenuItem>
            {[0.5, 1, 2].map((z) => (
              <MenuItem key={z} onClick={() => (to(z), close())}>
                <span className="flex justify-between gap-4 w-full">
                  Zoom to {z * 100}% {z === 1 && <span className="text-xs text-subtle">Ctrl+0</span>}
                </span>
              </MenuItem>
            ))}
          </div>
        )}
      </Menu>
      <button className={cn(btn, "max-sm:hidden")} onClick={() => zoomAt(at(), zoom * 1.25)} title="Zoom in (Ctrl+=)" aria-label="Zoom in">
        <Plus size={16} />
      </button>
    </div>
  );
}

// -------------------------------------------------------------- right click --
function CanvasMenu({
  at,
  onClose,
  onComment,
}: {
  at: { x: number; y: number; world: { x: number; y: number }; id: string | null };
  onClose: () => void;
  onComment: (id: string) => void;
}) {
  const canEdit = useWb((s) => s.canEdit);
  const canComment = useWb((s) => s.canComment);
  const canCopy = useWb((s) => s.canCopy);
  const sel = useWb((s) => s.selection);
  const locked = useWb((s) => s.selection.length > 0 && s.selection.every((id) => s.items[id]?.locked));
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useEffect(() => {
    const el = ref.current;
    if (el) setPos({ left: Math.min(at.x, window.innerWidth - el.offsetWidth - 8), top: Math.min(at.y, window.innerHeight - el.offsetHeight - 8) });
    const off = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", esc);
    };
  }, [at, onClose]);
  const item = (label: string, fn: () => void, k?: string, danger?: boolean) => (
    <button
      role="menuitem"
      className={cn("flex w-full items-center justify-between gap-6 px-3 py-1.5 text-sm text-left hover:bg-inset", danger ? "text-danger hover:bg-danger/10" : "text-ink")}
      onClick={() => {
        fn();
        onClose();
      }}
    >
      <span>{label}</span>
      {k && <span className="text-xs text-subtle">{k}</span>}
    </button>
  );
  return (
    <div
      ref={ref}
      data-wb-ui
      role="menu"
      className="fixed z-50 min-w-[210px] py-1 bg-surface border border-border rounded-lg shadow-raise animate-menu-in"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
    >
      {canEdit && item("Paste here", () => pasteText(null, at.world), "Ctrl+V")}
      {sel.length > 0 && (
        <>
          {canCopy && item("Copy", () => void copySelection(), "Ctrl+C")}
          {canEdit && !locked && item("Duplicate", () => duplicate(), "Ctrl+D")}
          {canComment && at.id && item("Comment", () => onComment(at.id!), "C")}
          {canEdit && <div className="my-1 h-px bg-line" />}
          {canEdit && !locked && item("Bring to front", () => bringToFront(), "PgUp")}
          {canEdit && !locked && item("Send to back", () => sendToBack(), "PgDn")}
          {canEdit && sel.length > 1 && !locked && item("Create frame", () => frameAround(), "Ctrl+Alt+F")}
          {canEdit && item(locked ? "Unlock" : "Lock", () => setLocked(!locked), "Ctrl+Shift+L")}
          {canEdit && !locked && <div className="my-1 h-px bg-line" />}
          {canEdit && !locked && item("Delete", () => deleteItems(S().selection), "Del", true)}
        </>
      )}
      {!sel.length && item("Zoom to fit", () => zoomToFit(), "Shift+1")}
    </div>
  );
}
