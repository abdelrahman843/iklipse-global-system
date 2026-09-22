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
  createCard,
  moveCard,
  setCardArchived,
} from "@/lib/pm/boardApi";
import { useBoardRealtime } from "@/lib/pm/useBoardRealtime";
import { CardDetailModal } from "@/components/pm/CardDetailModal";
import { BoardFilters, DEFAULT_FILTERS, cardMatchesFilters, type BoardFilterState } from "@/components/pm/BoardFilters";
import { BoardViewSwitcher, type BoardView } from "@/components/pm/BoardViewSwitcher";
import { CalendarView } from "@/components/pm/views/CalendarView";
import { TableView } from "@/components/pm/views/TableView";
import { TimelineView } from "@/components/pm/views/TimelineView";
import { DashboardView } from "@/components/pm/views/DashboardView";
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
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Add list failed", description: e.message }),
  });

  const createCardMut = useMutation({
    mutationFn: ({ listId, title }: { listId: string; title: string }) => {
      const listCards = data?.cards.filter((c) => c.list_id === listId) ?? [];
      const lastPos = listCards.length ? listCards.map((c) => c.position).sort().at(-1) ?? null : null;
      return createCard(boardId, listId, title, lastPos);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", boardId] }),
    onError: (e: Error) => toast.push({ kind: "error", title: "Add card failed", description: e.message }),
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
      <div className="flex items-center gap-3 px-4 md:px-6 py-3 border-b border-border bg-white">
        <Link to="/pm/boards" className="text-subtle hover:text-ink" aria-label="Back to boards">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-lg font-semibold text-ink truncate">{data.board.title}</h1>
        <div className="flex -space-x-1.5 ml-2">
          {data.members.slice(0, 6).map((m) => (
            <Avatar key={m.id} name={m.display_name} src={m.avatar_url} size={24} />
          ))}
          {data.members.length > 6 && (
            <span className="inline-flex items-center justify-center rounded-full ring-2 ring-white bg-surface text-xs w-6 h-6 text-muted">
              +{data.members.length - 6}
            </span>
          )}
        </div>
        <div className="flex-1" />
        <BoardFilters
          filters={filters}
          setFilters={setFilters}
          boardMembers={data.members}
          boardLabels={data.labels}
          currentUserId={user?.id}
        />
        <BoardViewSwitcher value={view} onChange={setView} can={can} />
        {can("pm.view_automation") && (
          <Link to={`/pm/boards/${boardId}/automation`}>
            <Button variant="secondary" size="sm" iconLeft={<Zap size={14} />}>
              Automation
            </Button>
          </Link>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === "board" && (
          <div className="h-full overflow-x-auto overflow-y-hidden">
            <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
              <div className="flex gap-3 items-start p-4 h-full">
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
                      archiveList(list.id).then(() =>
                        qc.invalidateQueries({ queryKey: ["board", boardId] }),
                      )
                    }
                    canEditList={can("pm.edit_list")}
                    canArchiveList={can("pm.archive_list")}
                    canCreateCard={can("pm.create_card")}
                    canArchiveCard={can("pm.archive_card")}
                  />
                ))}

                <div className="w-72 shrink-0">
                  {addingListAt ? (
                    <div className="rounded-lg border border-border bg-white p-2 shadow-card">
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
                        className="w-full h-10 rounded-lg border border-dashed border-border bg-surface/40 hover:bg-surface text-sm text-muted flex items-center justify-center gap-1.5"
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
  canEditList: boolean;
  canArchiveList: boolean;
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
  canEditList,
  canArchiveList,
  canCreateCard,
  canArchiveCard,
}: ColumnProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(list.title);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <div className="w-72 shrink-0 flex flex-col max-h-full">
      <div className="rounded-lg bg-surface border border-border shadow-card flex flex-col max-h-full">
        <div className="flex items-center gap-1 p-2">
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
              className="flex-1 text-left font-semibold text-ink px-1.5 py-1 rounded hover:bg-white/60 text-sm"
              onClick={() => canEditList && setEditing(true)}
              disabled={!canEditList}
            >
              {list.title} <span className="ml-1 text-xs text-subtle font-normal">{cards.length}</span>
            </button>
          )}
          <Menu
            align="right"
            trigger={
              <button className="rounded p-1 text-subtle hover:bg-white/70" aria-label="List actions">
                <MoreHorizontal size={16} />
              </button>
            }
          >
            {(close) => (
              <>
                <MenuItem disabled={!canCreateCard} onClick={() => { setComposerOpen(true); close(); }}>
                  Add card
                </MenuItem>
                <MenuItem disabled={!canArchiveList} destructive onClick={() => { onArchive(); close(); }}>
                  Archive this list
                </MenuItem>
              </>
            )}
          </Menu>
        </div>

        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div
            className="flex-1 min-h-[8px] px-2 pb-2 space-y-1.5 overflow-y-auto"
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
              />
            ))}
            <DropZone id={`list:${list.id}`} />
          </div>
        </SortableContext>

        {composerOpen && canCreateCard ? (
          <div className="p-2 border-t border-border">
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
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-white/60 border-t border-border rounded-b-lg flex items-center gap-1.5"
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
      className={cn("h-3 rounded", isOver && "bg-accent/10")}
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
}: {
  card: CardT;
  labelIds: string[];
  memberIds: string[];
  labelsById: Map<string, LabelT>;
  membersById: Map<string, Profile>;
  dragging?: boolean;
}) {
  const status = dueStatus(card.due_date, card.due_completed);
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-white shadow-card px-2.5 py-2 text-sm text-ink",
        "transition-[transform,box-shadow,border-color] duration-150 ease-out",
        "hover:-translate-y-0.5 hover:shadow-pop hover:border-rule",
        dragging && "shadow-pop opacity-90 translate-y-0",
      )}
    >
      {card.cover_color && (
        <div className="h-1.5 rounded mb-1.5" style={{ background: card.cover_color }} />
      )}
      {labelIds.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {labelIds.map((id) => {
            const l = labelsById.get(id);
            if (!l) return null;
            return (
              <span
                key={id}
                className="h-1.5 w-9 rounded-full"
                style={{ background: l.color }}
                title={l.name || undefined}
              />
            );
          })}
        </div>
      )}
      <div className="leading-snug">{card.title}</div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-subtle">
        <div className="flex items-center gap-2">
          {card.due_date && (
            <Badge
              tone={
                status === "overdue" ? "danger" : status === "soon" ? "warn" : status === "completed" ? "success" : "neutral"
              }
              className="text-[10px]"
            >
              <Calendar size={10} /> {shortDate(card.due_date)}
            </Badge>
          )}
          {card.description && <MessageSquare size={12} />}
        </div>
        <div className="flex -space-x-1.5">
          {memberIds.slice(0, 3).map((uid) => {
            const m = membersById.get(uid);
            if (!m) return null;
            return <Avatar key={uid} name={m.display_name} src={m.avatar_url} size={20} />;
          })}
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
}: {
  card: CardT;
  labelIds: string[];
  memberIds: string[];
  labelsById: Map<string, LabelT>;
  membersById: Map<string, Profile>;
  onOpen: () => void;
  onArchive?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      <div className="group relative" {...attributes} {...listeners}>
        <button className="w-full text-left" onClick={onOpen}>
          <CardChip
            card={card}
            labelIds={labelIds}
            memberIds={memberIds}
            labelsById={labelsById}
            membersById={membersById}
          />
        </button>
      </div>
    </div>
  );
}
