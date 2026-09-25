import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  Plus,
  X,
  MoreHorizontal,
  Calendar,
  MessageSquare,
  Check,
  ChevronsRightLeft,
  ChevronsLeftRight,
  Circle,
  CheckCircle2,
  Copy,
  ArrowLeftToLine,
  ArrowRightToLine,
  Eye,
  EyeOff,
  ArrowDownUp,
  Lock,
  Globe2,
  PencilLine,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { between } from "@/lib/lexorank";
import { shortDate, dueStatus } from "@/lib/format";
import type { Card as CardT, Label as LabelT, List as ListT, Profile } from "@/lib/database.types";
import {
  fetchBoardBundle,
  createList,
  renameList,
  archiveList,
  setListColor,
  deleteList,
  copyList,
  reorderList,
  createCard,
  updateCard,
  moveCard,
  setCardArchived,
  addBoardMember,
} from "@/lib/pm/boardApi";
import { isWatching, setSubscription } from "@/lib/pm/notificationsApi";
import { BOARD_COLORS, readableText, overlay } from "@/components/pm/ColorPicker";
import { useBoardRealtime } from "@/lib/pm/useBoardRealtime";
import { BoardFilters, DEFAULT_FILTERS, cardMatchesFilters, type BoardFilterState } from "@/components/pm/BoardFilters";
import {
  BoardDock,
  readBoardView,
  saveBoardView,
  viewAllowed,
  type BoardView,
} from "@/components/pm/BoardViewSwitcher";
import { CalendarView } from "@/components/pm/views/CalendarView";
import { TableView } from "@/components/pm/views/TableView";
import { TimelineView } from "@/components/pm/views/TimelineView";
import { DashboardView } from "@/components/pm/views/DashboardView";
import { ArchiveView } from "@/components/pm/views/ArchiveView";
import { cn } from "@/lib/cn";
import { keepFocus, leftComposer } from "@/lib/autosave";
import { useDraft } from "@/lib/drafts";
import { DraftTag } from "@/components/ui/DraftNotice";
import { InboxPanel, useUnreadCount } from "@/components/pm/InboxPanel";
import { prefetchCard } from "@/lib/pm/cardQueries";
import { BoardAccessProvider, useBoardAccess } from "@/lib/pm/boardAccess";
import { BoardShareButton, ShareBoardModal } from "@/components/pm/ShareBoardModal";
import { boardRoleLabel } from "@/lib/permissions";

// The card modal carries the rich editor (TipTap), Markdown and emoji code —
// split it out of the board bundle and warm it up once the board is shown.
const loadCardModal = () => import("@/components/pm/CardDetailModal");
const CardDetailModal = lazy(() => loadCardModal().then((m) => ({ default: m.CardDetailModal })));

export function BoardPage() {
  const { boardId = "", cardId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  // Everything on this page is decided by the caller's board role + board settings.
  const access = useBoardAccess(boardId);
  const can = access.can;
  const [sharing, setSharing] = useState(false);

  useBoardRealtime(boardId);
  useEffect(() => {
    void loadCardModal();
  }, []);

  const { data, isLoading, error } = useQuery({
    queryKey: ["board", boardId],
    queryFn: () => fetchBoardBundle(boardId),
    enabled: !!boardId,
  });

  const [dragging, setDragging] = useState<CardT | null>(null);
  const [addingListAt, setAddingListAt] = useState(false);
  // New-list title is a draft until "Add list"; clicking away keeps it.
  const listDraft = useDraft(`list:${boardId}`);
  const newListTitle = listDraft.value;
  const [filters, setFilters] = useState<BoardFilterState>(DEFAULT_FILTERS);
  const [inboxOpen, setInboxOpen] = useState(false);
  const unread = useUnreadCount();
  const [savedView, setSavedView] = useState<BoardView>(() => readBoardView(boardId));
  useEffect(() => setSavedView(readBoardView(boardId)), [boardId]);
  const view: BoardView = viewAllowed(savedView, can) ? savedView : "board";
  const setView = (v: BoardView) => {
    setSavedView(v);
    saveBoardView(boardId, v);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Observers / viewers get a board that can't be dragged.
  const noSensors = useSensors();

  const joinMut = useMutation({
    mutationFn: () => addBoardMember(boardId, user!.id, "normal"),
    onSuccess: () => {
      toast.push({ kind: "success", title: "You joined the board" });
      qc.invalidateQueries({ queryKey: ["board-access", boardId] });
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      qc.invalidateQueries({ queryKey: ["boards"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't join", description: e.message }),
  });

  const membersById = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const p of data?.members ?? []) m.set(p.id, p);
    return m;
  }, [data]);

  const labelsById = useMemo(() => {
    const m = new Map<string, LabelT>();
    for (const l of data?.labels ?? []) m.set(l.id, l);
    return m;
  }, [data]);

  const cardLabelsByCard = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of data?.cardLabels ?? []) {
      const arr = m.get(r.card_id) ?? [];
      arr.push(r.label_id);
      m.set(r.card_id, arr);
    }
    return m;
  }, [data]);
  const cardMembersByCard = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of data?.cardMembers ?? []) {
      const arr = m.get(r.card_id) ?? [];
      arr.push(r.user_id);
      m.set(r.card_id, arr);
    }
    return m;
  }, [data]);

  const filteredCards = useMemo(() => {
    if (!data) return [];
    return data.cards.filter((c) =>
      cardMatchesFilters({
        filters,
        card: c,
        memberIds: cardMembersByCard.get(c.id) ?? [],
        labelIds: cardLabelsByCard.get(c.id) ?? [],
        currentUserId: user?.id,
      }),
    );
  }, [data, filters, cardMembersByCard, cardLabelsByCard, user?.id]);

  const listsWithCards = useMemo(() => {
    if (!data) return [];
    return data.lists.map((l) => ({
      list: l,
      cards: filteredCards
        .filter((c) => c.list_id === l.id)
        .sort((a, b) => (a.position < b.position ? -1 : 1)),
    }));
  }, [data, filteredCards]);

  const createListMut = useMutation({
    mutationFn: (title: string) => {
      const lastPos = data?.lists.at(-1)?.position ?? null;
      return createList(boardId, title, lastPos);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      listDraft.discard();
      setAddingListAt(false);
      toast.push({ kind: "success", title: "List added" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Add list failed", description: e.message }),
  });

  const createCardMut = useMutation({
    mutationFn: ({ listId, title }: { listId: string; title: string }) => {
      const listCards = data?.cards.filter((c) => c.list_id === listId) ?? [];
      const lastPos = listCards.length ? listCards.map((c) => c.position).sort().at(-1) ?? null : null;
      return createCard(boardId, listId, title, lastPos);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      toast.push({ kind: "success", title: "Card added" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Add card failed", description: e.message }),
  });

  const toggleCompleteMut = useMutation({
    mutationFn: (v: { id: string; completed: boolean }) => updateCard(v.id, { due_completed: v.completed }),
    onMutate: (v) => {
      // Optimistic — flip the flag immediately so the check feels instant.
      qc.setQueryData(["board", boardId], (b: typeof data | undefined) =>
        b ? { ...b, cards: b.cards.map((c) => (c.id === v.id ? { ...c, due_completed: v.completed } : c)) } : b,
      );
    },
    onError: (e: Error) => {
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      toast.push({ kind: "error", title: "Update failed", description: e.message });
    },
  });

  const rescheduleMut = useMutation({
    mutationFn: (v: { id: string; due: string }) => updateCard(v.id, { due_date: v.due }),
    onMutate: (v) => {
      qc.setQueryData(["board", boardId], (b: typeof data | undefined) =>
        b ? { ...b, cards: b.cards.map((c) => (c.id === v.id ? { ...c, due_date: v.due } : c)) } : b,
      );
    },
    onSuccess: () => toast.push({ kind: "success", title: "Due date moved" }),
    onError: (e: Error) => {
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      toast.push({ kind: "error", title: "Reschedule failed", description: e.message });
    },
  });

  const copyListMut = useMutation({
    mutationFn: (l: ListT) => copyList(boardId, l.id, `${l.title} (copy)`, l.position),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      toast.push({ kind: "success", title: "List copied" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Copy failed", description: e.message }),
  });

  function moveListTo(l: ListT, to: "start" | "end") {
    const others = (data?.lists ?? [])
      .filter((x) => x.id !== l.id)
      .sort((a, b) => (a.position < b.position ? -1 : 1));
    const prev = to === "end" ? others.at(-1)?.position ?? null : null;
    const next = to === "start" ? others[0]?.position ?? null : null;
    reorderList(l.id, prev, next)
      .then(() => qc.invalidateQueries({ queryKey: ["board", boardId] }))
      .catch((e: Error) => toast.push({ kind: "error", title: "Move failed", description: e.message }));
  }

  const sortListMut = useMutation({
    mutationFn: async (v: { list: ListT; key: "due" | "name" | "new" }) => {
      const cardsIn = (data?.cards ?? []).filter((c) => c.list_id === v.list.id && !c.is_archived);
      const sorted = [...cardsIn].sort((a, b) => {
        if (v.key === "name") return a.title.localeCompare(b.title);
        if (v.key === "new") return a.created_at < b.created_at ? 1 : -1;
        // due date: dated first (asc), undated last
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date < b.due_date ? -1 : 1;
      });
      let prev: string | null = null;
      for (const c of sorted) {
        const pos = between(prev, null);
        await updateCard(c.id, { position: pos });
        prev = pos;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      toast.push({ kind: "success", title: "List sorted" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Sort failed", description: e.message }),
  });


  const archiveCardMut = useMutation({
    mutationFn: (id: string) => setCardArchived(id, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board", boardId] });
      qc.invalidateQueries({ queryKey: ["archived-cards", boardId] });
      toast.push({ kind: "info", title: "Card archived" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Archive failed", description: e.message }),
  });

  const moveCardMut = useMutation({
    mutationFn: (v: { cardId: string; listId: string; prev: string | null; next: string | null }) =>
      moveCard(v.cardId, v.listId, v.prev, v.next),
    onError: (e: Error) => {
      toast.push({ kind: "error", title: "Move failed", description: e.message });
      qc.invalidateQueries({ queryKey: ["board", boardId] });
    },
  });

  function onDragStart(e: DragStartEvent) {
    const card = data?.cards.find((c) => c.id === e.active.id);
    if (card) setDragging(card);
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over || !data) return;
    const cid = String(active.id);
    const source = data.cards.find((c) => c.id === cid);
    if (!source) return;

    let targetListId = source.list_id;
    let prevPos: string | null = null;
    let nextPos: string | null = null;

    const overId = String(over.id);
    if (overId.startsWith("list:")) {
      targetListId = overId.slice(5);
      const listCards = data.cards
        .filter((c) => c.list_id === targetListId)
        .sort((a, b) => (a.position < b.position ? -1 : 1));
      prevPos = listCards.at(-1)?.position ?? null;
      nextPos = null;
    } else {
      const overCard = data.cards.find((c) => c.id === overId);
      if (!overCard) return;
      targetListId = overCard.list_id;
      const listCards = data.cards
        .filter((c) => c.list_id === targetListId && c.id !== cid)
        .sort((a, b) => (a.position < b.position ? -1 : 1));
      const idx = listCards.findIndex((c) => c.id === overCard.id);
      prevPos = idx > 0 ? listCards[idx - 1]!.position : null;
      nextPos = listCards[idx]?.position ?? null;
    }

    qc.setQueryData(["board", boardId], (b: typeof data | undefined) => {
      if (!b) return b;
      const optimisticPos = between(prevPos, nextPos);
      return {
        ...b,
        cards: b.cards.map((c) =>
          c.id === cid ? { ...c, list_id: targetListId, position: optimisticPos } : c,
        ),
      };
    });

    moveCardMut.mutate({ cardId: cid, listId: targetListId, prev: prevPos, next: nextPos });
  }

  const openCard = (id: string) => nav(`/pm/boards/${boardId}/cards/${id}`);
  const closeInbox = useCallback(() => setInboxOpen(false), []);
  const warmCard = (e: React.SyntheticEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-card-id]")?.dataset.cardId;
    if (id) prefetchCard(qc, id);
  };

  if (isLoading || access.loading) return <PageSpinner />;
  if (error || !data)
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load board"
          description={
            (error as Error | undefined)?.message?.includes("0 rows")
              ? "This board is private or doesn't exist. Ask a board admin to add you."
              : ((error as Error | undefined)?.message ?? "Board not found or access denied.")
          }
          action={
            <Link to="/pm/boards">
              <Button variant="secondary" iconLeft={<ArrowLeft size={14} />}>
                Back to boards
              </Button>
            </Link>
          }
        />
      </div>
    );

  const readOnly = !access.can_edit;

  return (
    <BoardAccessProvider value={access}>
    <div className="relative h-full flex flex-col">
      {/* Board header */}
      <div className="px-3 sm:px-4 md:px-6 py-2.5 border-b border-border bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <Link
              to="/pm/boards"
              className="h-8 w-8 grid place-items-center rounded-md text-muted hover:text-ink hover:bg-inset transition-colors shrink-0"
              aria-label="Back to boards"
            >
              <ArrowLeft size={18} />
            </Link>
            <h1 className="text-base sm:text-lg font-semibold text-ink truncate">{data.board.title}</h1>
            <span
              className="hidden sm:inline-flex items-center gap-1 text-xs text-muted shrink-0"
              title={data.board.visibility === "private" ? "Private — only board members" : "Visible to the workspace"}
            >
              {data.board.visibility === "private" ? <Lock size={13} /> : <Globe2 size={13} />}
            </span>
            {readOnly && access.access && (
              <Badge className="shrink-0">
                <Eye size={11} className="mr-1 inline" />
                {boardRoleLabel(access.access)} · read-only
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            <BoardFilters
              filters={filters}
              setFilters={setFilters}
              boardMembers={data.members}
              boardLabels={data.labels}
              currentUserId={user?.id}
            />
          </div>
          <BoardShareButton members={data.members} onClick={() => setSharing(true)} />
        </div>
      </div>

      {/* Workspace member looking at a board they haven't joined (Trello's join bar). */}
      {access.access === "viewer" && (
        <div className="px-3 sm:px-4 md:px-6 py-2 bg-accent-soft border-b border-accent/20 flex items-center gap-3 text-sm animate-slide-down">
          <Globe2 size={15} className="text-accent shrink-0" />
          <span className="flex-1 min-w-0 text-ink">
            You're viewing a workspace board.{" "}
            <span className="text-muted">
              {data.board.self_join ? "Join to edit cards and get notified." : "Ask a board admin to add you to edit."}
            </span>
          </span>
          {data.board.self_join && (
            <Button size="sm" variant="primary" loading={joinMut.isPending} onClick={() => joinMut.mutate()}>
              Join board
            </Button>
          )}
        </div>
      )}

      {/* Floating bottom dock (Inbox, views drop-up, Archive, Automation) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 sm:bottom-5 z-30 flex justify-center px-3">
        <BoardDock
          value={view}
          onChange={setView}
          can={can}
          inboxOpen={inboxOpen}
          onToggleInbox={() => setInboxOpen((o) => !o)}
          unread={unread}
          automationHref={can("pm.view_automation") ? `/pm/boards/${boardId}/automation` : undefined}
        />
      </div>

      {/* Content — bottom padding keeps the last rows clear of the dock. */}
      <div
        className={cn("relative flex-1 min-h-0 overflow-hidden", view !== "board" && "pb-16 sm:pb-20")}
        // Hovering (or pressing) any card warms its modal data, so the
        // click usually opens straight onto a full card.
        onPointerOver={warmCard}
        onPointerDown={warmCard}
        onFocus={warmCard}
      >
        {inboxOpen && <InboxPanel onClose={closeInbox} />}
        {view === "board" && (
          <div className="h-full overflow-x-auto overflow-y-hidden view-enter">
            <DndContext sensors={can("pm.move_card") ? sensors : noSensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
              <div className="flex gap-2 sm:gap-3 items-start p-2 sm:p-4 pb-20 sm:pb-24 h-full">
                {listsWithCards.map(({ list, cards }) => (
                  <BoardColumn
                    key={list.id}
                    list={list}
                    cards={cards}
                    membersById={membersById}
                    labelsById={labelsById}
                    cardMembersByCard={cardMembersByCard}
                    cardLabelsByCard={cardLabelsByCard}
                    onOpenCard={(id) => nav(`/pm/boards/${boardId}/cards/${id}`)}
                    onArchiveCard={(id) => archiveCardMut.mutate(id)}
                    onAddCard={(title) => createCardMut.mutate({ listId: list.id, title })}
                    onRename={(t) =>
                      renameList(list.id, t).then(() =>
                        qc.invalidateQueries({ queryKey: ["board", boardId] }),
                      )
                    }
                    onArchive={() =>
                      archiveList(list.id).then(() => {
                        qc.invalidateQueries({ queryKey: ["board", boardId] });
                        qc.invalidateQueries({ queryKey: ["archived-lists", boardId] });
                        toast.push({ kind: "info", title: "List archived" });
                      })
                    }
                    onColor={(color) =>
                      setListColor(list.id, color).then(() =>
                        qc.invalidateQueries({ queryKey: ["board", boardId] }),
                      )
                    }
                    onDelete={() =>
                      deleteList(list.id)
                        .then(() => {
                          qc.invalidateQueries({ queryKey: ["board", boardId] });
                          toast.push({ kind: "info", title: "List deleted" });
                        })
                        .catch((e: Error) =>
                          toast.push({ kind: "error", title: "Delete failed", description: e.message }),
                        )
                    }
                    onToggleComplete={(id, completed) =>
                      can("pm.manage_dates") && toggleCompleteMut.mutate({ id, completed })
                    }
                    onCopy={() => copyListMut.mutate(list)}
                    onMove={(to) => moveListTo(list, to)}
                    onSort={(key) => sortListMut.mutate({ list, key })}
                    canEditList={can("pm.edit_list")}
                    canDeleteList={can("pm.archive_list")}
                    canCopyList={can("pm.copy_card") && can("pm.create_list")}
                    canArchiveList={can("pm.archive_list")}
                    canCreateCard={can("pm.create_card")}
                    canArchiveCard={can("pm.archive_card")}
                  />
                ))}

                <div className="w-64 sm:w-72 shrink-0">
                  {addingListAt ? (
                    <div data-composer className="rounded-lg border border-border bg-surface p-2 shadow-card">
                      <Input
                        autoFocus
                        value={newListTitle}
                        placeholder="List title"
                        onChange={(e) => listDraft.set(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newListTitle.trim() && !createListMut.isPending)
                            createListMut.mutate(newListTitle.trim());
                          if (e.key === "Escape") setAddingListAt(false);
                        }}
                        // Clicking away closes the composer; the text stays as a draft.
                        onBlur={(e) => leftComposer(e) && !createListMut.isPending && setAddingListAt(false)}
                      />
                      <div className="flex items-center gap-1.5 mt-2">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!newListTitle.trim()}
                          onMouseDown={keepFocus}
                          onClick={() =>
                            newListTitle.trim() && !createListMut.isPending && createListMut.mutate(newListTitle.trim())
                          }
                        >
                          Add list
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Discard"
                          onMouseDown={keepFocus}
                          onClick={() => {
                            listDraft.discard();
                            setAddingListAt(false);
                          }}
                        >
                          <X size={14} />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    can("pm.create_list") && (
                      <button
                        onClick={() => setAddingListAt(true)}
                        className="w-full h-10 rounded-lg border-2 border-dashed border-rule bg-transparent hover:bg-inset hover:border-rule hover:text-ink text-sm text-muted flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <Plus size={14} /> Add list
                        {listDraft.hasDraft && <DraftTag text={newListTitle} />}
                      </button>
                    )
                  )}
                </div>
              </div>

              <DragOverlay>
                {dragging && (
                  <CardChip
                    card={dragging}
                    labelIds={cardLabelsByCard.get(dragging.id) ?? []}
                    memberIds={cardMembersByCard.get(dragging.id) ?? []}
                    membersById={membersById}
                    labelsById={labelsById}
                    dragging
                  />
                )}
              </DragOverlay>
            </DndContext>
          </div>
        )}

        {view !== "board" && (
          // Keyed so each switch remounts and plays the entrance.
          <div key={view} className="h-full view-enter">
            {view === "calendar" && (
              <CalendarView
                cards={filteredCards}
                lists={data.lists}
                labelsById={labelsById}
                cardLabelsByCard={cardLabelsByCard}
                onOpenCard={openCard}
                onReschedule={can("pm.manage_dates") ? (id, due) => rescheduleMut.mutate({ id, due }) : undefined}
              />
            )}
            {view === "table" && (
              <TableView
                cards={filteredCards}
                lists={data.lists}
                labelsById={labelsById}
                membersById={membersById}
                cardLabelsByCard={cardLabelsByCard}
                cardMembersByCard={cardMembersByCard}
                onOpenCard={openCard}
                onToggleComplete={
                  can("pm.manage_dates") ? (id, completed) => toggleCompleteMut.mutate({ id, completed }) : undefined
                }
              />
            )}
            {view === "timeline" && <TimelineView cards={filteredCards} lists={data.lists} onOpenCard={openCard} />}
            {view === "dashboard" && (
              <DashboardView
                cards={filteredCards}
                lists={data.lists}
                labels={data.labels}
                members={data.members}
                cardLabelsByCard={cardLabelsByCard}
                cardMembersByCard={cardMembersByCard}
                onOpenCard={openCard}
              />
            )}
            {view === "archive" && <ArchiveView boardId={boardId} onOpenCard={openCard} />}
          </div>
        )}
      </div>

      {cardId && (
        <Suspense fallback={<CardModalSkeleton title={data.cards.find((c) => c.id === cardId)?.title} />}>
          <CardDetailModal
            cardId={cardId}
            board={data.board}
            boardMembers={data.members}
            boardLabels={data.labels}
            boardLists={data.lists}
            onClose={() => nav(`/pm/boards/${boardId}`)}
          />
        </Suspense>
      )}

      {sharing && <ShareBoardModal board={data.board} access={access} onClose={() => setSharing(false)} />}
    </div>
    </BoardAccessProvider>
  );
}

// ============================================================ Column ====

interface ColumnProps {
  list: ListT;
  cards: CardT[];
  membersById: Map<string, Profile>;
  labelsById: Map<string, LabelT>;
  cardMembersByCard: Map<string, string[]>;
  cardLabelsByCard: Map<string, string[]>;
  onOpenCard: (id: string) => void;
  onArchiveCard: (id: string) => void;
  onAddCard: (title: string) => void;
  onRename: (t: string) => void;
  onArchive: () => void;
  onColor: (color: string | null) => void;
  onDelete: () => void;
  onToggleComplete: (cardId: string, completed: boolean) => void;
  onCopy: () => void;
  onMove: (to: "start" | "end") => void;
  onSort: (key: "due" | "name" | "new") => void;
  canEditList: boolean;
  canArchiveList: boolean;
  canDeleteList: boolean;
  canCopyList: boolean;
  canCreateCard: boolean;
  canArchiveCard: boolean;
}

function BoardColumn({
  list,
  cards,
  membersById,
  labelsById,
  cardMembersByCard,
  cardLabelsByCard,
  onOpenCard,
  onArchiveCard,
  onAddCard,
  onRename,
  onArchive,
  onColor,
  onDelete,
  onToggleComplete,
  onCopy,
  onMove,
  onSort,
  canEditList,
  canArchiveList,
  canDeleteList,
  canCopyList,
  canCreateCard,
  canArchiveCard,
}: ColumnProps) {
  const [editing, setEditing] = useState(false);
  // List rename + new card text are drafts: only Enter / the button writes.
  const titleDraft = useDraft(`list-title:${list.id}`, list.title);
  const [composerOpen, setComposerOpen] = useState(false);
  const cardDraft = useDraft(`card:${list.id}`);
  const addCard = () => {
    const t = cardDraft.value.trim();
    if (!t) return;
    onAddCard(t);
    cardDraft.discard();
  };
  const saveTitle = () => {
    const t = titleDraft.value.trim();
    setEditing(false);
    if (!t) return titleDraft.discard();
    if (t !== list.title) onRename(t);
    titleDraft.commit();
  };
  const qc = useQueryClient();
  const watchQ = useQuery({ queryKey: ["watch", "list", list.id], queryFn: () => isWatching("list", list.id) });
  const watchMut = useMutation({
    mutationFn: (on: boolean) => setSubscription("list", list.id, on),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watch", "list", list.id] }),
  });
  const colored = !!list.color;
  const [collapsed, setCollapsed] = useState(false);
  const fg = colored ? readableText(list.color as string) : undefined;
  const line = fg ? overlay(fg, 0.16) : undefined; // hairline on a colored surface
  const chip = fg ? overlay(fg, 0.14) : undefined; // count chip / hover veil
  const veil = fg === "#ffffff" ? "hover:bg-white/10" : "hover:bg-black/10";

  // Collapsed — a thin vertical bar showing count + rotated title. Click expands.
  if (collapsed) {
    return (
      <div className="w-11 shrink-0 flex flex-col max-h-full">
        <div
          className={cn(
            "rounded-lg border shadow-card flex flex-col items-center gap-2 py-2 h-full overflow-hidden",
            colored ? "" : "bg-column border-border",
          )}
          style={colored ? { background: list.color as string, borderColor: line } : undefined}
        >
          <button
            onClick={() => setCollapsed(false)}
            title="Expand list"
            aria-label="Expand list"
            className={cn("h-7 w-7 grid place-items-center rounded-md transition-colors", colored ? veil : "text-muted hover:bg-inset hover:text-ink")}
            style={colored ? { color: fg } : undefined}
          >
            <ChevronsLeftRight size={16} />
          </button>
          <span
            className={cn("inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full text-[11px] font-medium", !colored && "bg-inset text-muted")}
            style={colored ? { background: chip, color: fg } : undefined}
          >
            {cards.length}
          </span>
          <button
            onClick={() => setCollapsed(false)}
            className={cn("flex-1 min-h-0 overflow-hidden text-sm font-semibold [writing-mode:vertical-rl] py-1", !colored && "text-ink")}
            style={colored ? { color: fg } : undefined}
            title={list.title}
          >
            <span className="truncate">{list.title}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-64 sm:w-72 shrink-0 flex flex-col max-h-full">
      <div
        className={cn(
          "rounded-lg border shadow-card flex flex-col max-h-full overflow-hidden",
          colored ? "" : "bg-column border-border",
        )}
        style={colored ? { background: list.color as string, borderColor: line } : undefined}
      >
        <div
          className="flex items-center gap-1 px-2 pt-2.5 pb-2 border-b"
          style={colored ? { borderColor: line } : undefined}
        >
          {editing && canEditList ? (
            <Input
              value={titleDraft.value}
              autoFocus
              className="h-8"
              onChange={(e) => titleDraft.set(e.target.value)}
              // Clicking away keeps the new name as a draft (pencil on the title).
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  titleDraft.discard();
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              className={cn(
                "flex-1 min-w-0 text-left font-semibold px-1.5 py-1 rounded-md text-sm transition-colors inline-flex items-center gap-2",
                colored ? veil : "text-ink hover:bg-inset",
              )}
              style={colored ? { color: fg } : undefined}
              onClick={() => canEditList && setEditing(true)}
              disabled={!canEditList}
            >
              <span className="truncate">{list.title}</span>
              {titleDraft.hasDraft && (
                <span
                  title={`Unsaved name: ${titleDraft.value} — click to finish or press Esc to discard`}
                  className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-warn text-[#1c1305] px-1.5 py-px text-[10px] font-bold uppercase tracking-wide shadow-card ring-1 ring-black/10"
                >
                  <PencilLine size={10} /> Draft
                </span>
              )}
              <span
                className={cn("shrink-0 text-[12px] font-medium tabular-nums", !colored && "text-subtle")}
                style={colored ? { color: fg, opacity: 0.75 } : undefined}
              >
                {cards.length}
              </span>
            </button>
          )}
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse list"
            aria-label="Collapse list"
            className={cn("shrink-0 h-7 w-7 grid place-items-center rounded-md transition-colors", colored ? veil : "text-muted hover:bg-inset hover:text-ink")}
            style={colored ? { color: fg } : undefined}
          >
            <ChevronsRightLeft size={15} />
          </button>
          <Menu
            align="right"
            trigger={
              <button
                className={cn(
                  "shrink-0 h-7 w-7 grid place-items-center rounded-md transition-colors",
                  colored ? veil : "text-muted hover:bg-inset hover:text-ink",
                )}
                style={colored ? { color: fg } : undefined}
                aria-label="List actions"
              >
                <MoreHorizontal size={16} />
              </button>
            }
          >
            {(close) => (
              <>
                <MenuItem disabled={!canCreateCard} onClick={() => { setComposerOpen(true); close(); }}>
                  <span className="inline-flex items-center gap-2"><Plus size={14} /> Add card</span>
                </MenuItem>
                {canCopyList && (
                  <MenuItem onClick={() => { onCopy(); close(); }}>
                    <span className="inline-flex items-center gap-2"><Copy size={14} /> Copy list</span>
                  </MenuItem>
                )}
                {canEditList && (
                  <>
                    <MenuItem onClick={() => { onMove("start"); close(); }}>
                      <span className="inline-flex items-center gap-2"><ArrowLeftToLine size={14} /> Move to start</span>
                    </MenuItem>
                    <MenuItem onClick={() => { onMove("end"); close(); }}>
                      <span className="inline-flex items-center gap-2"><ArrowRightToLine size={14} /> Move to end</span>
                    </MenuItem>
                  </>
                )}
                <MenuItem onClick={() => { watchMut.mutate(!(watchQ.data ?? false)); close(); }}>
                  <span className="inline-flex items-center gap-2">
                    {watchQ.data ? <EyeOff size={14} /> : <Eye size={14} />}
                    {watchQ.data ? "Unwatch" : "Watch"}
                  </span>
                </MenuItem>
                {canEditList && (
                  <div className="px-3 py-1.5">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">
                      <ArrowDownUp size={12} /> Sort by
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {([["due", "Due date"], ["name", "Name"], ["new", "Newest"]] as const).map(([k, label]) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => { onSort(k); close(); }}
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-inset hover:text-ink transition-colors"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {canEditList && (
                  <>
                    <div className="my-1 h-px bg-line" />
                    <div className="px-3 py-1.5">
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">
                        List color
                      </div>
                      <div className="grid grid-cols-5 gap-1.5">
                        {BOARD_COLORS.map((c) => (
                          <button
                            key={c.value}
                            type="button"
                            title={c.name}
                            aria-label={c.name}
                            onClick={() => { onColor(c.value); close(); }}
                            className="relative h-6 rounded-md ring-1 ring-border transition-transform hover:scale-105"
                            style={{ background: c.value }}
                          >
                            {list.color === c.value && (
                              <Check size={13} className="absolute inset-0 m-auto" style={{ color: readableText(c.value) }} />
                            )}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => { onColor(null); close(); }}
                        className="mt-1.5 w-full rounded-md border border-border px-2 py-1 text-sm text-muted hover:bg-inset hover:text-ink transition-colors"
                      >
                        No color
                      </button>
                    </div>
                  </>
                )}
                <div className="my-1 h-px bg-line" />
                <MenuItem disabled={!canArchiveList} onClick={() => { onArchive(); close(); }}>
                  Archive this list
                </MenuItem>
                {canDeleteList && (
                  <MenuItem
                    destructive
                    onClick={() => {
                      if (confirm(`Delete list "${list.title}" and all its cards? This can't be undone.`)) onDelete();
                      close();
                    }}
                  >
                    Delete this list
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        </div>

        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div
            className="flex-1 min-h-[8px] px-2 pt-2 pb-2 space-y-1.5 overflow-y-auto"
            data-list-id={list.id}
          >
            {cards.map((c) => (
              <SortableCard
                key={c.id}
                card={c}
                labelIds={cardLabelsByCard.get(c.id) ?? []}
                memberIds={cardMembersByCard.get(c.id) ?? []}
                labelsById={labelsById}
                membersById={membersById}
                onOpen={() => onOpenCard(c.id)}
                onArchive={canArchiveCard ? () => onArchiveCard(c.id) : undefined}
                onToggleComplete={() => onToggleComplete(c.id, !c.due_completed)}
              />
            ))}
            <DropZone id={`list:${list.id}`} />
          </div>
        </SortableContext>

        {composerOpen && canCreateCard ? (
          <div
            data-composer
            className={cn("p-2 border-t", !colored && "border-border")}
            style={colored ? { borderColor: line } : undefined}
          >
            <Textarea
              autoFocus
              rows={2}
              placeholder="Enter a title for this card…"
              value={cardDraft.value}
              onChange={(e) => cardDraft.set(e.target.value)}
              // Clicking away closes the composer; the text stays as a draft.
              onBlur={(e) => leftComposer(e) && setComposerOpen(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  addCard();
                }
                if (e.key === "Escape") setComposerOpen(false);
              }}
            />
            <div className="flex items-center gap-1.5 mt-2">
              <Button size="sm" variant="primary" disabled={!cardDraft.value.trim()} onMouseDown={keepFocus} onClick={addCard}>
                Add card
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Discard"
                onMouseDown={keepFocus}
                onClick={() => {
                  cardDraft.discard();
                  setComposerOpen(false);
                }}
              >
                <X size={14} />
              </Button>
            </div>
          </div>
        ) : (
          canCreateCard && (
            <button
              onClick={() => setComposerOpen(true)}
              className={cn(
                "w-full min-w-0 text-left px-3 py-2.5 text-sm border-t rounded-b-lg flex items-center gap-1.5 transition-colors",
                colored ? veil : "text-muted hover:bg-inset hover:text-ink border-line",
              )}
              style={colored ? { color: fg, borderColor: line } : undefined}
            >
              <Plus size={14} className="shrink-0" /> <span className="whitespace-nowrap">Add card</span>
              {cardDraft.hasDraft && <DraftTag text={cardDraft.value} className="ml-auto" />}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function DropZone({ id }: { id: string }) {
  const { setNodeRef, isOver } = useSortable({ id, data: { droppable: true } });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded transition-all duration-150",
        isOver ? "h-14 bg-accent-soft border-2 border-dashed border-accent" : "h-3",
      )}
      aria-hidden="true"
    />
  );
}

// ============================================================ Card ======

function CardChip({
  card,
  labelIds,
  memberIds,
  labelsById,
  membersById,
  dragging,
  onToggleComplete,
}: {
  card: CardT;
  labelIds: string[];
  memberIds: string[];
  labelsById: Map<string, LabelT>;
  membersById: Map<string, Profile>;
  dragging?: boolean;
  onToggleComplete?: () => void;
}) {
  const status = dueStatus(card.due_date, card.due_completed);
  const colored = !!card.cover_color;
  const fg = colored ? readableText(card.cover_color as string) : undefined;
  return (
    <div
      className={cn(
        "rounded-md border shadow-card px-3 py-2.5 text-sm",
        "transition-[transform,box-shadow,border-color] duration-150 ease-out",
        "hover:-translate-y-0.5 hover:shadow-pop",
        colored ? "border-black/10" : "border-border bg-surface text-ink hover:border-rule",
        dragging && "shadow-raise opacity-95 rotate-1 translate-y-0",
      )}
      style={colored ? { background: card.cover_color as string, color: fg } : undefined}
    >
      {labelIds.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {labelIds.map((id) => {
            const l = labelsById.get(id);
            if (!l) return null;
            return (
              <span
                key={id}
                className="h-2 w-10 rounded-full ring-1 ring-border"
                style={{ background: l.color }}
                title={l.name || undefined}
              />
            );
          })}
        </div>
      )}
      <div className="flex items-start gap-1.5">
        {onToggleComplete && (
          <span
            role="button"
            tabIndex={0}
            aria-label={card.due_completed ? "Mark incomplete" : "Mark complete"}
            title={card.due_completed ? "Mark incomplete" : "Mark complete"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleComplete();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onToggleComplete();
              }
            }}
            className={cn(
              "mt-0.5 shrink-0 cursor-pointer transition-opacity",
              card.due_completed
                ? "text-success"
                : "opacity-0 group-hover:opacity-100 hover:text-success",
            )}
          >
            {card.due_completed ? <CheckCircle2 size={16} /> : <Circle size={16} />}
          </span>
        )}
        <div className={cn("leading-snug font-medium min-w-0", card.due_completed && "line-through opacity-70")}>
          {card.title}
        </div>
      </div>
      {(card.due_date || card.description || memberIds.length > 0) && (
        <div
          className={cn("mt-2 flex items-center justify-between gap-2 text-[11px]", !colored && "text-subtle")}
          style={colored ? { color: fg, opacity: 0.85 } : undefined}
        >
          <div className="flex items-center gap-1.5">
            {card.due_date && (
              <Badge
                tone={
                  status === "overdue"
                    ? "danger"
                    : status === "soon"
                    ? "warn"
                    : status === "completed"
                    ? "success"
                    : "neutral"
                }
                className="text-[10px] font-medium"
              >
                <Calendar size={10} /> {shortDate(card.due_date)}
              </Badge>
            )}
            {card.description && (
              <span className="inline-flex items-center gap-0.5" title="Has description">
                <MessageSquare size={12} />
              </span>
            )}
          </div>
          <div className="flex -space-x-1.5">
            {memberIds.slice(0, 3).map((uid) => {
              const m = membersById.get(uid);
              if (!m) return null;
              return <Avatar key={uid} name={m.display_name} src={m.avatar_url} size={20} />;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Shown for the moment the card modal's code chunk is still arriving, so a
// click always gets an immediate response instead of a blank pause.
function CardModalSkeleton({ title }: { title?: string }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 animate-fade-in flex items-start sm:items-center justify-center p-2 sm:p-4 md:p-6">
      <div className="w-full max-w-6xl rounded-lg border border-border bg-surface shadow-pop p-5 sm:p-6 animate-scale-in">
        <div className="h-6 w-28 rounded bg-inset animate-pulse" />
        <div className="mt-4 text-2xl font-semibold text-ink truncate">
          {title ?? <span className="block h-7 w-2/3 rounded bg-inset animate-pulse" />}
        </div>
        <div className="mt-5 flex gap-2">
          {[64, 72, 64, 80].map((w, i) => (
            <div key={i} className="h-8 rounded-md bg-inset animate-pulse" style={{ width: w }} />
          ))}
        </div>
        <div className="mt-6 space-y-2.5">
          <div className="h-4 w-1/3 rounded bg-inset animate-pulse" />
          <div className="h-20 rounded-md bg-inset animate-pulse" />
        </div>
      </div>
    </div>
  );
}

function SortableCard({
  card,
  labelIds,
  memberIds,
  labelsById,
  membersById,
  onOpen,
  onToggleComplete,
}: {
  card: CardT;
  labelIds: string[];
  memberIds: string[];
  labelsById: Map<string, LabelT>;
  membersById: Map<string, Profile>;
  onOpen: () => void;
  onArchive?: () => void;
  onToggleComplete?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      <div className="group relative rounded-md focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring" {...attributes} {...listeners}>
        <button data-card-id={card.id} className="w-full text-left rounded-md focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring" onClick={onOpen}>
          <CardChip
            card={card}
            labelIds={labelIds}
            memberIds={memberIds}
            labelsById={labelsById}
            membersById={membersById}
            onToggleComplete={onToggleComplete}
          />
        </button>
      </div>
    </div>
  );
}
