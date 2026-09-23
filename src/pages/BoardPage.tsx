import { useMemo, useState } from "react";
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
  Zap,
  Check,
  ChevronsRightLeft,
  ChevronsLeftRight,
  Circle,
  CheckCircle2,
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
  createCard,
  updateCard,
  moveCard,
  setCardArchived,
} from "@/lib/pm/boardApi";
import { BOARD_COLORS, readableText, overlay } from "@/components/pm/ColorPicker";
import { useBoardRealtime } from "@/lib/pm/useBoardRealtime";
import { CardDetailModal } from "@/components/pm/CardDetailModal";
import { BoardFilters, DEFAULT_FILTERS, cardMatchesFilters, type BoardFilterState } from "@/components/pm/BoardFilters";
import { BoardViewSwitcher, type BoardView } from "@/components/pm/BoardViewSwitcher";
import { CalendarView } from "@/components/pm/views/CalendarView";
import { TableView } from "@/components/pm/views/TableView";
import { TimelineView } from "@/components/pm/views/TimelineView";
import { DashboardView } from "@/components/pm/views/DashboardView";
import { ArchiveView } from "@/components/pm/views/ArchiveView";
import { cn } from "@/lib/cn";

export function BoardPage() {
  const { boardId = "", cardId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, user } = useAuth();

  useBoardRealtime(boardId);

  const { data, isLoading, error } = useQuery({
    queryKey: ["board", boardId],
    queryFn: () => fetchBoardBundle(boardId),
    enabled: !!boardId,
  });

  const [dragging, setDragging] = useState<CardT | null>(null);
  const [addingListAt, setAddingListAt] = useState(false);
  const [newListTitle, setNewListTitle] = useState("");
  const [filters, setFilters] = useState<BoardFilterState>(DEFAULT_FILTERS);
  const [view, setView] = useState<BoardView>("board");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

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
      setNewListTitle("");
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


  const archiveCardMut = useMutation({
    mutationFn: (id: string) => setCardArchived(id, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board", boardId] });
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

  if (isLoading) return <PageSpinner />;
  if (error || !data)
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load board"
          description={(error as Error | undefined)?.message ?? "Board not found or access denied."}
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

  return (
    <div className="h-full flex flex-col">
      {/* Board header */}
      <div className="px-3 sm:px-4 md:px-6 py-3 border-b border-border bg-surface shadow-card space-y-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Link to="/pm/boards" className="text-subtle hover:text-ink transition-colors shrink-0" aria-label="Back to boards">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-base sm:text-lg font-semibold text-ink truncate">{data.board.title}</h1>
          <div className="flex-1" />
        </div>
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          <BoardFilters
            filters={filters}
            setFilters={setFilters}
            boardMembers={data.members}
            boardLabels={data.labels}
            currentUserId={user?.id}
          />
          <BoardViewSwitcher value={view} onChange={setView} can={can} />
          {can("pm.view_automation") && (
            <Link to={`/pm/boards/${boardId}/automation`} className="shrink-0">
              <Button variant="secondary" size="sm" iconLeft={<Zap size={14} />}>
                <span className="hidden sm:inline">Automation</span>
                <span className="sm:hidden">Auto</span>
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === "board" && (
          <div className="h-full overflow-x-auto overflow-y-hidden">
            <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
              <div className="flex gap-2 sm:gap-3 items-start p-2 sm:p-4 h-full">
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
                    onToggleComplete={(id, completed) => toggleCompleteMut.mutate({ id, completed })}
                    canEditList={can("pm.edit_list")}
                    canDeleteList={can("pm.archive_list")}
                    canArchiveList={can("pm.archive_list")}
                    canCreateCard={can("pm.create_card")}
                    canArchiveCard={can("pm.archive_card")}
                  />
                ))}

                <div className="w-64 sm:w-72 shrink-0">
                  {addingListAt ? (
                    <div className="rounded-lg border border-border bg-surface p-2 shadow-card">
                      <Input
                        autoFocus
                        value={newListTitle}
                        placeholder="List title"
                        onChange={(e) => setNewListTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newListTitle.trim())
                            createListMut.mutate(newListTitle.trim());
                          if (e.key === "Escape") setAddingListAt(false);
                        }}
                      />
                      <div className="flex items-center gap-1.5 mt-2">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!newListTitle.trim()}
                          onClick={() => newListTitle.trim() && createListMut.mutate(newListTitle.trim())}
                        >
                          Add list
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAddingListAt(false)}>
                          <X size={14} />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    can("pm.create_list") && (
                      <button
                        onClick={() => setAddingListAt(true)}
                        className="w-full h-10 rounded-lg border-2 border-dashed border-rule bg-transparent hover:bg-surface hover:border-ink hover:text-ink text-sm text-muted flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <Plus size={14} /> Add list
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

        {view === "calendar" && (
          <CalendarView
            cards={filteredCards}
            lists={data.lists}
            onOpenCard={(id) => nav(`/pm/boards/${boardId}/cards/${id}`)}
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
            onOpenCard={(id) => nav(`/pm/boards/${boardId}/cards/${id}`)}
          />
        )}
        {view === "timeline" && (
          <TimelineView
            cards={filteredCards}
            onOpenCard={(id) => nav(`/pm/boards/${boardId}/cards/${id}`)}
          />
        )}
        {view === "dashboard" && (
          <DashboardView
            cards={filteredCards}
            lists={data.lists}
            labels={data.labels}
            members={data.members}
            cardLabelsByCard={cardLabelsByCard}
            cardMembersByCard={cardMembersByCard}
          />
        )}
        {view === "archive" && (
          <ArchiveView
            boardId={boardId}
            onOpenCard={(id) => nav(`/pm/boards/${boardId}/cards/${id}`)}
          />
        )}
      </div>

      {cardId && (
        <CardDetailModal
          cardId={cardId}
          board={data.board}
          boardMembers={data.members}
          boardLabels={data.labels}
          boardLists={data.lists}
          onClose={() => nav(`/pm/boards/${boardId}`)}
        />
      )}
    </div>
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
  canEditList: boolean;
  canArchiveList: boolean;
  canDeleteList: boolean;
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
  canEditList,
  canArchiveList,
  canDeleteList,
  canCreateCard,
  canArchiveCard,
}: ColumnProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(list.title);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");
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
            colored ? "" : "bg-bg border-border",
          )}
          style={colored ? { background: list.color as string, borderColor: line } : undefined}
        >
          <button
            onClick={() => setCollapsed(false)}
            title="Expand list"
            aria-label="Expand list"
            className={cn("rounded p-1 transition-colors", colored ? veil : "text-subtle hover:bg-inset hover:text-ink")}
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
          colored ? "" : "bg-bg border-border",
        )}
        style={colored ? { background: list.color as string, borderColor: line } : undefined}
      >
        <div
          className="flex items-center gap-1 px-2 pt-2.5 pb-2 border-b"
          style={colored ? { borderColor: line } : undefined}
        >
          {editing && canEditList ? (
            <Input
              value={title}
              autoFocus
              className="h-8"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (title.trim() && title !== list.title) onRename(title.trim());
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setTitle(list.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              className={cn(
                "flex-1 min-w-0 text-left font-semibold px-1.5 py-1 rounded text-sm transition-colors inline-flex items-center gap-2",
                colored ? veil : "text-ink hover:bg-inset",
              )}
              style={colored ? { color: fg } : undefined}
              onClick={() => canEditList && setEditing(true)}
              disabled={!canEditList}
            >
              <span className="truncate">{list.title}</span>
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
            className={cn("shrink-0 rounded p-1 transition-colors", colored ? veil : "text-subtle hover:bg-inset hover:text-ink")}
            style={colored ? { color: fg } : undefined}
          >
            <ChevronsRightLeft size={15} />
          </button>
          <Menu
            align="right"
            trigger={
              <button
                className={cn(
                  "shrink-0 rounded p-1 transition-colors",
                  colored ? veil : "text-subtle hover:bg-inset hover:text-ink",
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
                  Add card
                </MenuItem>
                {canEditList && (
                  <>
                    <div className="my-1 h-px bg-line" />
                    <div className="px-3 py-1.5">
                      <div className="mb-1.5 text-[10px] font-semibold text-subtle uppercase tracking-[0.4px]">
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
                            className="relative h-6 rounded-md ring-1 ring-black/10 transition-transform hover:scale-105"
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
            className={cn("p-2 border-t", !colored && "border-border")}
            style={colored ? { borderColor: line } : undefined}
          >
            <Textarea
              autoFocus
              rows={2}
              placeholder="Enter a title for this card…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim()) {
                    onAddCard(draft.trim());
                    setDraft("");
                  }
                }
                if (e.key === "Escape") {
                  setComposerOpen(false);
                  setDraft("");
                }
              }}
            />
            <div className="flex items-center gap-1.5 mt-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.trim()}
                onClick={() => {
                  onAddCard(draft.trim());
                  setDraft("");
                }}
              >
                Add card
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setComposerOpen(false)}>
                <X size={14} />
              </Button>
            </div>
          </div>
        ) : (
          canCreateCard && (
            <button
              onClick={() => setComposerOpen(true)}
              className={cn(
                "w-full text-left px-3 py-2.5 text-sm border-t rounded-b-lg flex items-center gap-1.5 transition-colors",
                colored ? veil : "text-muted hover:bg-inset hover:text-ink border-line",
              )}
              style={colored ? { color: fg, borderColor: line } : undefined}
            >
              <Plus size={14} /> Add card
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
        isOver ? "h-14 bg-accent/10 border-2 border-dashed border-accent" : "h-3",
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
        "transition-[transform,box-shadow] duration-150 ease-out",
        "hover:-translate-y-0.5 hover:shadow-pop",
        colored ? "border-black/10" : "border-border bg-surface text-ink",
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
                className="h-2 w-10 rounded-full ring-1 ring-black/5"
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
      <div className="group relative focus:outline-none focus-visible:outline-none" {...attributes} {...listeners}>
        <button className="w-full text-left rounded-md focus:outline-none focus-visible:outline-none" onClick={onOpen}>
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
