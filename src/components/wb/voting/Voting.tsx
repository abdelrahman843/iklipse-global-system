import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { CreditCard, Ellipsis, History, Image as ImageIcon, Minus, Plus, Shapes, Trash2, Trophy, Type, Users, Vote, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Toggle } from "@/components/ui/Controls";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { relativeTime, shortDate } from "@/lib/format";
import {
  castVote,
  deleteVoting,
  endVoting,
  fetchMyVotes,
  fetchVoteSessions,
  startVoting,
  voteResults,
  type VoteSession,
} from "@/lib/wb/api";
import { useWb, geomOf, select, worldToScreen, zoomToFit } from "@/lib/wb/store";
import { rotatePoint, type Pt } from "@/lib/wb/geometry";
import { DEFAULT_STICKY, cssColor, str, type ItemType, type Viewport, type WbItem } from "@/lib/wb/types";
import { TYPE_NAMES, itemText } from "@/components/wb/comments/data";

// -----------------------------------------------------------------------------
// Dot voting (Miro's voting session). An editor starts a session; everyone who
// can see the board then spends N votes on stickies, shapes, cards, text and
// images (badges on the items). Totals stay hidden until the session ends,
// then the panel ranks the items and the board shows each one's count.
// Sessions are realtime (sync.ts invalidates ["wb-votes", board]); votes are
// not, so the voter count is polled while a session is open. The database
// enforces one open session per board and each person's vote limit.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

const VOTABLE: ItemType[] = ["sticky", "shape", "card", "text", "image"];
const MAX_VOTES = 20;
const MAX_BADGES = 300;

const votesKey = (b: string) => ["wb-votes", b] as const;
const sessionsKey = (b: string) => ["wb-votes", b, "sessions"] as const;
const mineKey = (b: string, sid: string, uid: string) => ["wb-votes", b, "mine", sid, uid] as const;
const resultsKey = (b: string, sid: string) => ["wb-votes", b, "results", sid] as const;

/** Which closed session's totals are on the board (set by the panel). */
const useVotingUi = create<{ resultsFor: string | null; keep: boolean }>()(() => ({ resultsFor: null, keep: false }));

const sum = (m?: Record<string, number>) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ data --
function useSessions(boardId: string) {
  return useQuery({ queryKey: sessionsKey(boardId), queryFn: () => fetchVoteSessions(boardId), enabled: !!boardId, staleTime: 60_000 });
}

function useMyVotes(boardId: string, session: VoteSession | null) {
  const uid = useAuth().user?.id ?? "";
  const sid = session?.status === "open" ? session.id : "";
  return useQuery({
    queryKey: mineKey(boardId, sid, uid),
    queryFn: () => fetchMyVotes(sid, uid),
    enabled: !!sid && !!uid,
    staleTime: 60_000,
  });
}

function useResults(boardId: string, sessionId: string | null, poll = false) {
  return useQuery({
    queryKey: resultsKey(boardId, sessionId ?? ""),
    queryFn: () => voteResults(sessionId!),
    enabled: !!sessionId,
    refetchInterval: poll ? 5000 : false,
    staleTime: poll ? 0 : 5 * 60_000,
    retry: false,
  });
}

/** Votes still in flight per session:item, so a late reply doesn't undo a newer click. */
const inflight = new Map<string, number>();
const KNOWN_ERRORS = ["No votes left", "One vote per item", "Voting is closed", "Item not found"];

function useCastVote(boardId: string, session: VoteSession) {
  const qc = useQueryClient();
  const toast = useToast();
  const uid = useAuth().user?.id ?? "";
  return useCallback(
    async (itemId: string, delta: 1 | -1) => {
      const key = mineKey(boardId, session.id, uid);
      const mine = qc.getQueryData<Record<string, number>>(key) ?? {};
      const cur = mine[itemId] ?? 0;
      if (delta === 1 && sum(mine) >= session.votes_per_user) {
        toast.push({ kind: "error", title: "No votes left", description: `You've used all ${session.votes_per_user}. Take one back to vote again.` });
        return;
      }
      if (delta === 1 && session.one_per_item && cur >= 1) {
        toast.push({ kind: "error", title: "One vote per item", description: "This session allows one vote on each item." });
        return;
      }
      if (delta === -1 && cur <= 0) return;

      const put = (m: Record<string, number> | undefined, n: number) => {
        const next = { ...(m ?? {}) };
        if (n > 0) next[itemId] = n;
        else delete next[itemId];
        return next;
      };
      const k = `${session.id}:${itemId}`;
      inflight.set(k, (inflight.get(k) ?? 0) + 1);
      qc.setQueryData<Record<string, number>>(key, (m) => put(m, (m?.[itemId] ?? 0) + delta));
      try {
        const n = await castVote(session.id, itemId, delta);
        if (inflight.get(k) === 1) qc.setQueryData<Record<string, number>>(key, (m) => put(m, n));
      } catch (e) {
        const msg = (e as Error).message;
        const known = KNOWN_ERRORS.find((x) => msg.includes(x));
        toast.push({ kind: "error", title: known ?? "Couldn't vote", description: known ? undefined : msg });
        void qc.invalidateQueries({ queryKey: key });
        if (known === "Voting is closed") void qc.invalidateQueries({ queryKey: votesKey(boardId) });
      } finally {
        const left = (inflight.get(k) ?? 1) - 1;
        if (left > 0) inflight.set(k, left);
        else inflight.delete(k);
      }
    },
    [qc, toast, uid, boardId, session.id, session.votes_per_user, session.one_per_item],
  );
}

/** True while a voting session is open on the board (top bar highlight). */
export function useVotingOpen(boardId: string): boolean {
  return useSessions(boardId).data?.some((s) => s.status === "open") ?? false;
}

// ------------------------------------------------------------ on canvas --
/** Screen point at an item's top-right corner (rotation included). */
function cornerOf(id: string, vp: Viewport): { at: Pt; w: number; h: number } | null {
  const g = geomOf(S(), id);
  if (!g) return null;
  const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
  return { at: worldToScreen(rotatePoint({ x: g.x + g.w, y: g.y }, c, g.rotation), vp), w: g.w * vp.zoom, h: g.h * vp.zoom };
}

/** Too small on screen for buttons: only a count dot on the corner. */
const tiny = (w: number, h: number) => w < 72 || h < 44;

/** Items, re-rendering while they're dragged (here or by others) so badges follow. */
function useFollowItems() {
  useWb((s) => s.live);
  useWb((s) => s.remoteLive);
  return useWb((s) => s.items);
}

/** Vote badges on items while a session is open / results after it closes (inside the canvas). */
export function VotingLayer({ boardId }: { boardId: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const sessions = useSessions(boardId).data;
  const open = sessions?.find((s) => s.status === "open") ?? null;
  const resultsFor = useVotingUi((s) => s.resultsFor);
  const panel = useWb((s) => s.panel);
  const presenting = useWb((s) => s.presenting);
  const shown = !open && resultsFor ? sessions?.find((s) => s.id === resultsFor && s.status === "closed") ?? null : null;

  // Let people know when someone else starts or ends a session.
  const prev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!sessions) return;
    const cur = open?.id ?? null;
    const was = prev.current;
    prev.current = cur;
    if (was === undefined || was === cur || S().panel === "voting") return;
    if (open && open.created_by !== user?.id) {
      toast.push({ kind: "info", title: "Voting started", description: open.title, actionLabel: "Open", onAction: () => set({ panel: "voting" }) });
    } else if (!cur && was && sessions.some((s) => s.id === was)) {
      toast.push({
        kind: "info",
        title: "Voting ended",
        actionLabel: "See results",
        onAction: () => {
          useVotingUi.setState({ resultsFor: was });
          set({ panel: "voting" });
        },
      });
    }
  }, [sessions, open, user?.id, toast]);

  // Results of a session that was deleted.
  useEffect(() => {
    if (resultsFor && sessions && !sessions.some((s) => s.id === resultsFor)) useVotingUi.setState({ resultsFor: null });
  }, [resultsFor, sessions]);

  if (presenting) return null;
  return (
    <>
      {open && <VoteBadges boardId={boardId} session={open} />}
      {shown && <ResultBadges boardId={boardId} session={shown} />}
      {shown && panel !== "voting" && (
        <div
          data-wb-ui
          className="absolute z-20 left-1/2 -translate-x-1/2 md:bottom-3 max-md:top-[7.75rem] max-w-[calc(100%-24px)] flex items-center gap-1 h-11 pl-3 pr-1 bg-surface border border-border rounded-lg shadow-pop text-sm animate-slide-up"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Trophy size={15} className="text-accent shrink-0" />
          <button type="button" className="min-w-0 truncate h-9 px-1 text-ink font-medium hover:underline" onClick={() => set({ panel: "voting" })}>
            Results: {shown.title}
          </button>
          <button
            type="button"
            className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink"
            onClick={() => useVotingUi.setState({ resultsFor: null })}
            title="Hide results"
            aria-label="Hide results"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}

function VoteBadges({ boardId, session }: { boardId: string; session: VoteSession }) {
  const mine = useMyVotes(boardId, session).data;
  const vote = useCastVote(boardId, session);
  const vp = useWb((s) => s.viewport);
  const screen = useWb((s) => s.screen);
  const items = useFollowItems();
  const list = useMemo(() => Object.values(items).filter((it) => VOTABLE.includes(it.type)), [items]);

  const out: JSX.Element[] = [];
  for (const it of list) {
    const c = cornerOf(it.id, vp);
    if (!c || c.at.x < -80 || c.at.y < -40 || c.at.x > screen.w + 40 || c.at.y > screen.h + 40) continue;
    const n = mine?.[it.id] ?? 0;
    const small = tiny(c.w, c.h);
    if (small && !n) continue;
    out.push(<VoteBadge key={it.id} at={c.at} n={n} small={small} onVote={(d) => void vote(it.id, d)} />);
    if (out.length >= MAX_BADGES) break;
  }
  return <>{out}</>;
}

function VoteBadge({ at, n, small, onVote }: { at: Pt; n: number; small: boolean; onVote: (d: 1 | -1) => void }) {
  const btn = "h-7 w-7 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9 grid place-items-center rounded-full transition-colors";
  if (small) {
    return (
      <span
        className="absolute z-[9] -translate-x-1/2 -translate-y-1/2 min-w-6 h-6 px-1.5 rounded-full bg-accent text-white text-xs font-semibold tabular-nums grid place-items-center shadow-pop pointer-events-none"
        style={{ left: at.x, top: at.y }}
        title={plural(n, "vote", "votes")}
      >
        {n}
      </span>
    );
  }
  return (
    // Just inside the corner, clear of the resize handle.
    <div
      data-wb-ui
      className="absolute z-[9] -translate-x-full pointer-events-auto animate-fade-in"
      style={{ left: at.x - 6, top: at.y + 6 }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {n === 0 ? (
        <button
          type="button"
          className={cn(btn, "bg-surface border border-border shadow-pop text-muted hover:text-accent hover:border-accent")}
          onClick={() => onVote(1)}
          title="Vote"
          aria-label="Vote"
        >
          <Plus size={15} />
        </button>
      ) : (
        <div className="flex items-center rounded-full bg-accent text-white shadow-pop">
          <button type="button" className={cn(btn, "hover:bg-accent-hover")} onClick={() => onVote(-1)} title="Take back a vote" aria-label="Take back a vote">
            <Minus size={14} />
          </button>
          <span className="min-w-4 text-center text-sm font-semibold tabular-nums" aria-label={plural(n, "vote", "votes")}>
            {n}
          </span>
          <button type="button" className={cn(btn, "hover:bg-accent-hover")} onClick={() => onVote(1)} title="Add a vote" aria-label="Add a vote">
            <Plus size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function ResultBadges({ boardId, session }: { boardId: string; session: VoteSession }) {
  const res = useResults(boardId, session.id).data;
  const vp = useWb((s) => s.viewport);
  const screen = useWb((s) => s.screen);
  useFollowItems();
  const totals = res?.items ?? {};
  const max = Math.max(0, ...Object.values(totals).map(Number));

  const out: JSX.Element[] = [];
  for (const [id, raw] of Object.entries(totals)) {
    const total = Number(raw);
    const c = total > 0 ? cornerOf(id, vp) : null;
    if (!c || c.at.x < -80 || c.at.y < -40 || c.at.x > screen.w + 40 || c.at.y > screen.h + 40) continue;
    const small = tiny(c.w, c.h);
    out.push(
      <span
        key={id}
        className={cn(
          "absolute z-[9] inline-flex items-center gap-1 h-7 px-2.5 rounded-full bg-accent text-white text-sm font-semibold tabular-nums shadow-pop pointer-events-none animate-fade-in",
          small ? "-translate-x-1/2 -translate-y-1/2" : "-translate-x-full",
        )}
        style={small ? { left: c.at.x, top: c.at.y } : { left: c.at.x - 6, top: c.at.y + 6 }}
        title={plural(total, "vote", "votes")}
      >
        {total === max ? <Trophy size={13} /> : <Vote size={13} />}
        {total}
      </span>,
    );
    if (out.length >= MAX_BADGES) break;
  }
  return <>{out}</>;
}

// ------------------------------------------------------------------ panel --
/** Right-side panel: start / end voting, votes left, results. */
export function VotingPanel({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const canEdit = useWb((s) => s.canEdit);
  const q = useSessions(boardId);
  const sessions = q.data ?? [];
  const open = sessions.find((s) => s.status === "open") ?? null;
  const openId = open?.id ?? null;
  const closed = sessions.filter((s) => s.status === "closed");
  const [viewing, setViewing] = useState<string | null>(() => useVotingUi.getState().resultsFor);
  const [creating, setCreating] = useState(false);
  const shown = open ? null : closed.find((s) => s.id === viewing) ?? closed[0] ?? null;

  // A new session: show its results (not an older pick) when it ends.
  useEffect(() => {
    if (openId) {
      setViewing(null);
      setCreating(false);
    }
  }, [openId]);

  // The board shows the totals of whatever the panel shows.
  useEffect(() => {
    useVotingUi.setState({ resultsFor: shown?.id ?? null });
  }, [shown?.id]);
  useEffect(
    () => () => {
      const ui = useVotingUi.getState();
      useVotingUi.setState({ resultsFor: ui.keep ? ui.resultsFor : null, keep: false });
    },
    [],
  );

  return (
    <>
      <div className="flex items-center gap-2 h-12 pl-4 pr-1.5 border-b border-line shrink-0">
        <h2 className="flex-1 min-w-0 truncate text-base font-semibold text-ink">Voting</h2>
        <button type="button" onClick={onClose} className="h-9 w-9 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink" title="Close" aria-label="Close">
          <X size={17} />
        </button>
      </div>
      <div data-wb-scroll className="flex-1 overflow-auto overscroll-contain p-4 space-y-6">
        {q.isLoading ? (
          <div className="py-12 grid place-items-center text-subtle">
            <Spinner size={20} />
          </div>
        ) : open ? (
          <OpenSession boardId={boardId} session={open} canEdit={canEdit} />
        ) : (
          <>
            {shown && <Results boardId={boardId} session={shown} canEdit={canEdit} />}
            {canEdit &&
              (shown && !creating ? (
                <Button className="w-full" iconLeft={<Vote size={15} />} onClick={() => setCreating(true)}>
                  New voting session
                </Button>
              ) : (
                <StartForm boardId={boardId} intro={!shown} onCancel={shown ? () => setCreating(false) : undefined} />
              ))}
            {!canEdit && !shown && (
              <div className="py-10 text-center">
                <div className="mx-auto mb-3 grid place-items-center h-11 w-11 rounded-full bg-inset border border-line text-muted">
                  <Vote size={18} />
                </div>
                <div className="text-sm font-semibold text-ink">No voting yet</div>
                <p className="mt-1 text-sm text-muted">A board editor can start a voting session.</p>
              </div>
            )}
            {closed.length > 1 && (
              <section>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-subtle">
                  <History size={13} /> Past sessions
                </h3>
                <ul className="space-y-0.5">
                  {closed.slice(0, 10).map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setViewing(s.id)}
                        className={cn(
                          "w-full flex items-center gap-2 min-h-9 px-2.5 rounded-md text-left text-sm transition-colors",
                          s.id === shown?.id ? "bg-accent-soft text-accent font-medium" : "text-ink hover:bg-inset",
                        )}
                      >
                        <span className="flex-1 min-w-0 truncate">{s.title}</span>
                        <span className="shrink-0 text-xs text-subtle">{shortDate(s.closed_at ?? s.created_at)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function StartForm({ boardId, intro, onCancel }: { boardId: string; intro: boolean; onCancel?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [votes, setVotes] = useState(3);
  const [onePerItem, setOnePerItem] = useState(false);
  const [busy, setBusy] = useState(false);
  const step = "h-9 w-9 shrink-0 grid place-items-center rounded-md border border-border bg-surface text-muted hover:bg-inset hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed";

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await startVoting(boardId, title.trim().slice(0, 200) || "Voting", Math.min(MAX_VOTES, Math.max(1, votes)), onePerItem);
      await qc.invalidateQueries({ queryKey: votesKey(boardId) });
    } catch (err) {
      const msg = (err as Error).message;
      toast.push({
        kind: "error",
        title: "Couldn't start voting",
        description: /duplicate|unique/i.test(msg) ? "A voting session is already running on this board." : msg,
      });
      void qc.invalidateQueries({ queryKey: votesKey(boardId) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={start} className="space-y-4">
      {intro ? (
        <div>
          <h3 className="text-base font-semibold text-ink">Start a voting session</h3>
          <p className="mt-1 text-sm text-muted">
            Everyone gets a few votes to put on sticky notes, shapes, cards, text and images. Totals show when you end the session.
          </p>
        </div>
      ) : (
        <h3 className="text-base font-semibold text-ink">New voting session</h3>
      )}
      <div>
        <Label htmlFor="wb-vote-title">Title</Label>
        <Input id="wb-vote-title" value={title} maxLength={200} placeholder="What are we voting on?" onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="wb-vote-count">Votes per person</Label>
        <div className="flex items-center gap-1.5">
          <button type="button" className={step} disabled={votes <= 1} onClick={() => setVotes((v) => Math.max(1, v - 1))} aria-label="Fewer votes">
            <Minus size={15} />
          </button>
          <div className="w-16">
            <Input
              id="wb-vote-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_VOTES}
              value={votes}
              className="text-center tabular-nums"
              onChange={(e) => setVotes(Math.min(MAX_VOTES, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
            />
          </div>
          <button type="button" className={step} disabled={votes >= MAX_VOTES} onClick={() => setVotes((v) => Math.min(MAX_VOTES, v + 1))} aria-label="More votes">
            <Plus size={15} />
          </button>
        </div>
      </div>
      <Toggle checked={onePerItem} onChange={setOnePerItem} label="One vote per item" hint="Nobody can put two votes on the same item." />
      <div className="flex gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" className="flex-1" loading={busy} iconLeft={<Vote size={15} />}>
          Start voting
        </Button>
      </div>
    </form>
  );
}

function OpenSession({ boardId, session, canEdit }: { boardId: string; session: VoteSession; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const mine = useMyVotes(boardId, session).data;
  const voters = useResults(boardId, session.id, true).data?.voters ?? 0;
  const used = sum(mine);
  const left = Math.max(0, session.votes_per_user - used);
  const [ending, setEnding] = useState(false);

  const end = async () => {
    const ok = await confirm({
      title: "End voting?",
      message: "Everyone will see the results. A session can't be reopened once it ends.",
      confirmLabel: "End voting",
    });
    if (!ok) return;
    setEnding(true);
    try {
      await endVoting(session.id);
      await qc.invalidateQueries({ queryKey: votesKey(boardId) });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't end voting", description: (e as Error).message });
    } finally {
      setEnding(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-center gap-1.5 text-xs font-medium text-accent">
          <span className="h-2 w-2 rounded-full bg-accent animate-pulse" /> Voting in progress
        </div>
        <h3 className="mt-1 text-lg font-semibold text-ink [overflow-wrap:anywhere]">{session.title}</h3>
        <p className="text-xs text-subtle">Started {relativeTime(session.created_at)}</p>
      </div>

      <div className="rounded-lg border border-line bg-inset p-3">
        <div className="text-base font-semibold text-ink">
          {left ? `You have ${plural(left, "vote", "votes")} left` : "You've used all your votes"}
        </div>
        <div className="mt-2 flex flex-wrap gap-1" aria-hidden>
          {Array.from({ length: session.votes_per_user }, (_, i) => (
            <span key={i} className={cn("h-2.5 w-2.5 rounded-full", i < used ? "bg-accent" : "bg-surface border border-border")} />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {plural(session.votes_per_user, "vote", "votes")} per person{session.one_per_item ? ", one per item" : ""}
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm text-muted">
        <Users size={15} className="shrink-0" />
        {voters ? `${plural(voters, "person has", "people have")} voted` : "Nobody has voted yet"}
      </div>
      <p className="text-xs text-subtle">Use the + on an item to vote. Totals stay hidden until voting ends.</p>

      {canEdit && (
        <Button variant="primary" className="w-full" loading={ending} onClick={end}>
          End voting
        </Button>
      )}
    </section>
  );
}

function Results({ boardId, session, canEdit }: { boardId: string; session: VoteSession; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const res = useResults(boardId, session.id);
  const items = useWb((s) => s.items);

  const rows = useMemo(() => {
    const list = Object.entries(res.data?.items ?? {})
      .map(([id, total]) => ({ id, total: Number(total), it: items[id] ?? null }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
    // Ties share a place.
    let rank = 0;
    return list.map((r, i) => {
      if (i === 0 || r.total !== list[i - 1]!.total) rank = i + 1;
      return { ...r, rank };
    });
  }, [res.data, items]);
  const max = rows[0]?.total ?? 1;

  const jump = (id: string) => {
    select([id]);
    zoomToFit([id]);
    // On phones the panel covers the board: get it out of the way, keep the totals.
    if (window.innerWidth < 640) {
      useVotingUi.setState({ keep: true });
      set({ panel: null });
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Delete voting session?",
      message: `The results of "${session.title}" will be deleted for everyone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteVoting(session.id);
      await qc.invalidateQueries({ queryKey: votesKey(boardId) });
      toast.push({ kind: "success", title: "Voting session deleted" });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't delete session", description: (e as Error).message });
    }
  };

  return (
    <section>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-subtle">
            <Trophy size={13} /> Results
          </div>
          <h3 className="mt-0.5 text-lg font-semibold text-ink [overflow-wrap:anywhere]">{session.title}</h3>
          <p className="text-xs text-subtle">
            Ended {relativeTime(session.closed_at ?? session.created_at)}
            {res.data ? `, ${plural(res.data.voters, "person", "people")} voted` : ""}
          </p>
        </div>
        {canEdit && (
          <Menu
            align="right"
            trigger={
              <button type="button" className="h-9 w-9 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink" title="More" aria-label="Session actions">
                <Ellipsis size={17} />
              </button>
            }
          >
            {(close) => (
              <div className="min-w-[190px]">
                <MenuItem destructive onClick={() => (void remove(), close())}>
                  <span className="inline-flex items-center gap-2">
                    <Trash2 size={14} /> Delete session
                  </span>
                </MenuItem>
              </div>
            )}
          </Menu>
        )}
      </div>

      {res.isLoading ? (
        <div className="py-8 grid place-items-center text-subtle">
          <Spinner size={18} />
        </div>
      ) : rows.length ? (
        <ol className="mt-3 space-y-1">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={!r.it}
                onClick={() => jump(r.id)}
                className="relative w-full flex items-center gap-2.5 min-h-10 px-2.5 py-2 rounded-md text-left overflow-hidden hover:bg-inset disabled:hover:bg-transparent disabled:cursor-default transition-colors"
                title={r.it ? "Show on board" : undefined}
              >
                <span className="absolute inset-y-0 left-0 rounded-md bg-accent-soft" style={{ width: `${(r.total / max) * 100}%` }} aria-hidden />
                <span className="relative w-5 shrink-0 text-sm font-semibold text-muted tabular-nums">{r.rank}</span>
                <ItemGlyph it={r.it} />
                <span className={cn("relative flex-1 min-w-0 truncate text-sm", r.it ? "text-ink" : "text-subtle italic")}>
                  {r.it ? itemText(r.it) || TYPE_NAMES[r.it.type] : "Deleted item"}
                </span>
                <span className="relative shrink-0 text-sm font-semibold text-ink tabular-nums">{r.total}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-muted">No votes were cast.</p>
      )}
    </section>
  );
}

function ItemGlyph({ it }: { it: WbItem | null }) {
  if (!it) return <span className="relative h-4 w-4 shrink-0 rounded-sm border border-line bg-inset" />;
  if (it.type === "sticky") {
    return <span className="relative h-4 w-4 shrink-0 rounded-sm ring-1 ring-border" style={{ background: cssColor(str(it.data.fill, DEFAULT_STICKY)) }} />;
  }
  const Icon = it.type === "shape" ? Shapes : it.type === "text" ? Type : it.type === "card" ? CreditCard : ImageIcon;
  return <Icon size={15} className="relative shrink-0 text-muted" />;
}
