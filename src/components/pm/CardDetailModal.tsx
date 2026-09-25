import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignLeft,
  Check,
  Clock,
  Paperclip,
  Tag,
  X,
  Archive,
  Copy,
  Eye,
  EyeOff,
  Star,
  StarOff,
  CheckSquare,
  Download,
  Trash2,
  ExternalLink,
  FileText,
  Plus,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  ArrowRightLeft,
  MoreHorizontal,
  Image as ImageIcon,
  Circle,
  CheckCircle2,
  Link2,
  UserPlus,
  UserMinus,
  User as UserIcon,
} from "lucide-react";
import type { Attachment, Board, ChecklistItem, Label as LabelT, List as ListT, Profile } from "@/lib/database.types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { useAuth } from "@/lib/auth";
import { useBoardCan } from "@/lib/pm/boardAccess";
import { useToast } from "@/components/ui/Toast";
import { relativeTime, dueStatus } from "@/lib/format";
import { keepFocus, leftComposer } from "@/lib/autosave";
import { useDraft } from "@/lib/drafts";
import { DraftNotice, DraftTag } from "@/components/ui/DraftNotice";
import {
  addComment,
  deleteCard,
  moveCard,
  setCardArchived,
  toggleCardLabel,
  toggleCardMember,
  updateCard,
  type CardDetailBundle,
} from "@/lib/pm/boardApi";
import { supabase } from "@/lib/supabase";
import { CustomFieldsSection } from "@/components/pm/CustomFieldsSection";
import { ColorPickerMenu } from "@/components/pm/ColorPicker";
import { RichEditor } from "@/components/pm/RichEditor";
import { Markdown } from "@/components/pm/Markdown";
import { CardActionPanel, type ActionView } from "@/components/pm/card/CardActionPanel";
import { CommentsFeed, ThreadPanel, type CommentWithAuthor } from "@/components/pm/card/CommentsFeed";
import { CardAiMenu } from "@/components/pm/card/CardAiMenu";
import { useAiStatus } from "@/lib/ai";
import { useCardRealtime } from "@/lib/pm/useBoardRealtime";
import {
  addLinkAttachment,
  deleteAttachment,
  formatSize,
  signedUrlFor,
  uploadCardAttachment,
} from "@/lib/pm/attachmentsApi";
import { isWatching, setSubscription } from "@/lib/pm/notificationsApi";
import { cloneCardIntoList, setCardTemplate } from "@/lib/pm/templatesApi";
import { cn } from "@/lib/cn";
import { cardActivityQuery, cardDetailQuery, cardPlaceholder } from "@/lib/pm/cardQueries";

interface Props {
  cardId: string;
  board: Board;
  boardMembers: Profile[];
  boardLabels: LabelT[];
  boardLists: ListT[];
  onClose: () => void;
}

export function CardDetailModal({ cardId, board, boardMembers, boardLabels, boardLists, onClose }: Props) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const can = useBoardCan();
  const toast = useToast();

  // Paints immediately from the board's copy of the card; the full bundle
  // (comments, checklists, attachments…) swaps in when it arrives.
  const { data, isLoading, error, isPlaceholderData } = useQuery({
    ...cardDetailQuery(cardId),
    placeholderData: () => cardPlaceholder(qc, board.id, cardId),
  });

  const watching = useQuery({
    queryKey: ["watch", "card", cardId],
    queryFn: () => isWatching("card", cardId),
  });

  const activity = useQuery(cardActivityQuery(cardId));
  const aiStatus = useAiStatus();

  // Title and description edits are drafts until Save/Enter — clicking away
  // or closing the card keeps them, it never writes to the server.
  const titleDraft = useDraft(`title:${cardId}`, data?.card.title ?? "");
  const descDraft = useDraft(`desc:${cardId}`, data?.card.description ?? "");
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  // Which root comment's thread is open in the overlay panel (null = timeline).
  const [threadId, setThreadId] = useState<string | null>(null);

  // Live: comments, reactions, checklists, attachments, fields, activity.
  useCardRealtime(cardId, board.id);

  // Every card write refreshes the card, the board and the activity feed.
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["board", board.id] });
    qc.invalidateQueries({ queryKey: ["activity", cardId] });
  };

  const patchCard = useMutation({
    mutationFn: (patch: Parameters<typeof updateCard>[1]) => updateCard(cardId, patch),
    onMutate: (patch) => {
      // Optimistic: the modal reflects the change immediately.
      qc.setQueryData<CardDetailBundle>(["card", cardId], (b) => (b ? { ...b, card: { ...b.card, ...patch } } : b));
    },
    onSuccess: refreshAll,
    onError: (e: Error) => {
      refreshAll();
      toast.push({ kind: "error", title: "Update failed", description: e.message });
    },
  });

  const toggleMember = useMutation({
    mutationFn: (v: { userId: string; on: boolean }) => toggleCardMember(cardId, v.userId, v.on),
    onSuccess: refreshAll,
    onError: (e: Error) => toast.push({ kind: "error", title: "Update failed", description: e.message }),
  });

  const toggleLabel = useMutation({
    mutationFn: (v: { labelId: string; on: boolean }) => toggleCardLabel(cardId, v.labelId, v.on),
    onSuccess: refreshAll,
    onError: (e: Error) => toast.push({ kind: "error", title: "Update failed", description: e.message }),
  });

  const archive = useMutation({
    mutationFn: () => setCardArchived(cardId, true),
    onSuccess: () => {
      toast.push({ kind: "info", title: "Card archived" });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Archive failed", description: e.message }),
  });

  const remove = useMutation({
    mutationFn: () => deleteCard(cardId),
    onSuccess: () => {
      toast.push({ kind: "info", title: "Card deleted" });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Delete failed", description: e.message }),
  });

  const move = useMutation({
    mutationFn: (v: { listId: string }) => moveCard(cardId, v.listId, null, null),
    onSuccess: () => {
      refreshAll();
      toast.push({ kind: "info", title: "Card moved" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Move failed", description: e.message }),
  });

  const copyCard = useMutation({
    mutationFn: (v: { listId: string }) => cloneCardIntoList(cardId, v.listId, null),
    onSuccess: () => {
      toast.push({ kind: "success", title: "Card copied" });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Copy failed", description: e.message }),
  });

  const toggleTemplate = useMutation({
    mutationFn: (v: boolean) => setCardTemplate(cardId, v),
    onSuccess: refreshAll,
  });

  const toggleWatch = useMutation({
    mutationFn: (v: boolean) => setSubscription("card", cardId, v),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["watch", "card", cardId] });
      toast.push({ kind: "info", title: v ? "Watching this card" : "Stopped watching" });
    },
  });

  const addChecklist = useMutation({
    mutationFn: async (name: string) => {
      const { error } = await supabase.from("checklist").insert({ card_id: cardId, name, position: `p${Date.now()}` });
      if (error) throw error;
    },
    onSuccess: refreshAll,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't add checklist", description: e.message }),
  });

  async function uploadFiles(files: FileList) {
    try {
      for (const f of Array.from(files)) await uploadCardAttachment(cardId, f);
      toast.push({ kind: "success", title: `Attached ${files.length} file${files.length > 1 ? "s" : ""}` });
    } catch (e: unknown) {
      toast.push({ kind: "error", title: "Upload failed", description: e instanceof Error ? e.message : undefined });
    } finally {
      refreshAll();
    }
  }

  async function addLink(url: string, text: string) {
    try {
      await addLinkAttachment(cardId, url, text);
      toast.push({ kind: "success", title: "Link attached" });
      refreshAll();
    } catch (e: unknown) {
      toast.push({ kind: "error", title: "Couldn't attach link", description: e instanceof Error ? e.message : undefined });
    }
  }

  // --------------------------------------------------------- description --
  const saveDesc = useMutation({
    mutationFn: (v: string) => updateCard(cardId, { description: v }),
    onSuccess: refreshAll,
    onError: (e: Error) => {
      refreshAll();
      toast.push({ kind: "error", title: "Save failed", description: e.message });
    },
  });

  // Explicit save only. The draft is dropped once the server has it; on
  // failure it stays so nothing typed is lost.
  const saveDescNow = () => {
    const v = descDraft.value;
    setEditingDesc(false);
    if (!data || v === (data.card.description ?? "")) return descDraft.commit();
    qc.setQueryData<CardDetailBundle>(["card", cardId], (b) => (b ? { ...b, card: { ...b.card, description: v } } : b));
    saveDesc.mutate(v, { onSuccess: descDraft.commit });
  };

  const saveTitleNow = () => {
    const v = titleDraft.value.trim();
    setEditingTitle(false);
    if (!data || !v) return titleDraft.discard();
    if (v === data.card.title) return titleDraft.commit();
    patchCard.mutate({ title: v }, { onSuccess: titleDraft.commit });
  };

  // ------------------------------------------------------------ comments --
  const { roots, repliesByParent } = useMemo(() => {
    const all = data?.comments ?? [];
    const rep = new Map<string, CommentWithAuthor[]>();
    const rts: CommentWithAuthor[] = [];
    for (const c of all) {
      if (c.parent_id) {
        const arr = rep.get(c.parent_id) ?? [];
        arr.push(c);
        rep.set(c.parent_id, arr);
      } else {
        rts.push(c);
      }
    }
    return { roots: rts, repliesByParent: rep };
  }, [data?.comments]);

  const openThreadRoot = threadId ? (data?.comments.find((c) => c.id === threadId) ?? null) : null;

  const labelsById = useMemo(() => new Map(boardLabels.map((l) => [l.id, l])), [boardLabels]);
  const memberById = useMemo(() => new Map(boardMembers.map((m) => [m.id, m])), [boardMembers]);

  // "Last updated" = newest of: the card row itself, any activity, any comment.
  const lastUpdated = useMemo(() => {
    if (!data) return null;
    const stamps = [data.card.updated_at, activity.data?.[0]?.created_at, ...data.comments.map((c) => c.edited_at ?? c.created_at)];
    return stamps.filter(Boolean).sort().at(-1) ?? data.card.created_at;
  }, [data, activity.data]);

  if (isLoading || !data) {
    return (
      <Modal open onClose={onClose} size="2xl" hideClose title={null} fitViewport>
        <div className="flex-1 min-h-[200px] grid place-items-center">
          {error ? <span className="text-sm text-danger">{(error as Error).message}</span> : <Spinner size={20} />}
        </div>
      </Modal>
    );
  }

  const card = data.card;
  const listTitle = boardLists.find((l) => l.id === card.list_id)?.title ?? board.title;
  const isMember = !!user && data.memberIds.includes(user.id);
  const status = dueStatus(card.due_date, card.due_completed);

  const actionMenu = (initial: ActionView, trigger: ReactNode, align: "left" | "right" = "left") => (
    <Menu trigger={trigger} align={align}>
      {(close) => (
        <CardActionPanel
          initial={initial}
          close={close}
          card={card}
          boardId={board.id}
          boardLabels={boardLabels}
          boardMembers={boardMembers}
          labelIds={data.labelIds}
          memberIds={data.memberIds}
          perms={{
            labels: can("pm.manage_labels"),
            members: can("pm.manage_members"),
            dates: can("pm.manage_dates"),
            checklists: can("pm.manage_checklists"),
            attachments: can("pm.manage_attachments"),
            createLabels: can("pm.manage_labels"),
          }}
          onToggleLabel={(id, on) => toggleLabel.mutate({ labelId: id, on })}
          onToggleMember={(uid, on) => toggleMember.mutate({ userId: uid, on })}
          onSaveDates={(v) => patchCard.mutate(v)}
          onRemoveDates={() => patchCard.mutate({ start_date: null, due_date: null })}
          onAddChecklist={(name) => addChecklist.mutate(name)}
          onUploadFiles={(f) => void uploadFiles(f)}
          onAddLink={addLink}
        />
      )}
    </Menu>
  );

  return (
    <Modal open onClose={onClose} size="2xl" hideClose title={null} fitViewport>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Top bar — list (move) · cover · more · close */}
        <div className="flex items-center gap-2 px-4 sm:px-5 py-2.5 border-b border-line shrink-0">
          <Menu
            trigger={
              <button
                type="button"
                disabled={!can("pm.move_card")}
                className="inline-flex items-center gap-1.5 h-8 max-w-[60vw] px-3 rounded-md border border-border bg-inset text-sm font-semibold text-ink hover:border-rule transition-colors disabled:cursor-default"
                title="Move to another list"
              >
                <span className="truncate">{listTitle}</span>
                <ChevronDown size={14} className="shrink-0 text-muted" />
              </button>
            }
          >
            {(close) => (
              <div className="w-64 py-1">
                <div className="px-3 py-1.5 text-xs font-semibold text-subtle">Move to list</div>
                {boardLists.map((l) => (
                  <MenuItem
                    key={l.id}
                    onClick={() => {
                      if (l.id !== card.list_id) move.mutate({ listId: l.id });
                      close();
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <span className="flex-1 truncate">{l.title}</span>
                      {l.id === card.list_id && <Check size={14} className="text-accent" />}
                    </span>
                  </MenuItem>
                ))}
              </div>
            )}
          </Menu>
          {card.is_template && <Badge tone="accent">Template</Badge>}

          <div className="ml-auto flex items-center gap-1">
            {can("pm.edit_card") && (
              <ColorPickerMenu
                value={card.cover_color}
                onChange={(c) => patchCard.mutate({ cover_color: c })}
                trigger={
                  <IconBtn title="Cover">
                    <ImageIcon size={18} />
                  </IconBtn>
                }
              />
            )}
            <Menu
              align="right"
              trigger={
                <IconBtn title="Card actions">
                  <MoreHorizontal size={18} />
                </IconBtn>
              }
            >
              {(close) => (
                <MoreMenu
                  close={close}
                  boardLists={boardLists}
                  isMember={isMember}
                  isTemplate={card.is_template}
                  watching={!!watching.data}
                  can={can}
                  onJoin={() => user && toggleMember.mutate({ userId: user.id, on: !isMember })}
                  onMove={(id) => move.mutate({ listId: id })}
                  onCopy={(id) => copyCard.mutate({ listId: id })}
                  onTemplate={() => toggleTemplate.mutate(!card.is_template)}
                  onWatch={() => toggleWatch.mutate(!watching.data)}
                  onCopyLink={() => {
                    void navigator.clipboard?.writeText(window.location.href).then(
                      () => toast.push({ kind: "success", title: "Link copied" }),
                      () => toast.push({ kind: "error", title: "Couldn't copy link" }),
                    );
                  }}
                  onArchive={() => archive.mutate()}
                  onDelete={() => {
                    if (confirm(`Delete "${card.title}"? This can't be undone.`)) remove.mutate();
                  }}
                />
              )}
            </Menu>
            <IconBtn title="Close" onClick={onClose}>
              <X size={18} />
            </IconBtn>
          </div>
        </div>

        {/* Panes. Mobile: the row scrolls. lg+: each pane scrolls on its own. */}
        <div className="relative flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
          {/* LEFT — title, actions, details, description, fields, checklists, attachments */}
          <div className="min-w-0 lg:w-1/2 lg:min-h-0 lg:overflow-y-auto px-4 sm:px-6 py-5 space-y-6">
            {card.cover_color && <div className="h-2 rounded-full" style={{ background: card.cover_color }} />}

            {/* Title + complete toggle */}
            <div className="flex items-start gap-3">
              <button
                type="button"
                disabled={!can("pm.edit_card")}
                onClick={() => patchCard.mutate({ due_completed: !card.due_completed })}
                title={card.due_completed ? "Mark incomplete" : "Mark complete"}
                aria-label={card.due_completed ? "Mark incomplete" : "Mark complete"}
                className={cn(
                  "mt-1.5 shrink-0 rounded-full transition-colors",
                  card.due_completed ? "text-success" : "text-subtle hover:text-ink",
                )}
              >
                {card.due_completed ? <CheckCircle2 size={24} /> : <Circle size={24} />}
              </button>
              <div className="flex-1 min-w-0">
                {editingTitle && can("pm.edit_card") ? (
                  <div data-composer className="space-y-2">
                    <Input
                      value={titleDraft.value}
                      autoFocus
                      onChange={(e) => titleDraft.set(e.target.value)}
                      // Clicking away keeps the edit as a draft; it isn't saved.
                      onBlur={(e) => leftComposer(e) && setEditingTitle(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          saveTitleNow();
                        }
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          titleDraft.discard();
                          setEditingTitle(false);
                        }
                      }}
                      className="text-2xl font-bold h-11"
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="primary" onMouseDown={keepFocus} onClick={saveTitleNow}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onMouseDown={keepFocus}
                        onClick={() => {
                          titleDraft.discard();
                          setEditingTitle(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className={cn(
                        "w-full text-left text-2xl font-bold leading-tight text-ink hover:bg-inset rounded-md px-1 py-0.5 -mx-1 transition-colors break-words",
                        card.due_completed && "line-through decoration-2 opacity-70",
                      )}
                      onClick={() => can("pm.edit_card") && setEditingTitle(true)}
                    >
                      {card.title}
                    </button>
                    {titleDraft.hasDraft && can("pm.edit_card") && (
                      <DraftNotice onView={() => setEditingTitle(true)} onDiscard={titleDraft.discard} />
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Trello-style action chips */}
            <div className="flex flex-wrap gap-2 pl-9">
              {actionMenu("add", <Chip icon={<Plus size={15} />}>Add</Chip>)}
              {actionMenu("labels", <Chip icon={<Tag size={15} />}>Labels</Chip>)}
              {actionMenu("dates", <Chip icon={<Clock size={15} />}>Dates</Chip>)}
              {actionMenu("checklist", <Chip icon={<CheckSquare size={15} />}>Checklist</Chip>)}
              {actionMenu("members", <Chip icon={<UserPlus size={15} />}>Members</Chip>)}
              {aiStatus.data?.available && (
                <CardAiMenu
                  cardId={cardId}
                  cardTitle={card.title}
                  description={descDraft.value}
                  canEdit={can("pm.edit_card")}
                  canChecklist={can("pm.manage_checklists")}
                  canComment={can("pm.manage_comments")}
                  onUseDescription={(md) => {
                    // Lands as a draft: the user reviews it in the editor and saves.
                    descDraft.set(md);
                    setEditingDesc(true);
                  }}
                  onChecklistAdded={refreshAll}
                  onPostComment={async (md) => {
                    await addComment(cardId, md);
                    refreshAll();
                  }}
                />
              )}
            </div>

            {/* Details — only the blocks that have something in them */}
            <div className="flex flex-wrap gap-x-6 gap-y-4 pl-9">
              {data.memberIds.length > 0 && (
                <Meta label="Members">
                  <div className="flex items-center gap-1">
                    {data.memberIds.map((uid) => {
                      const m = memberById.get(uid);
                      return m ? (
                        <span key={uid} title={m.display_name}>
                          <Avatar name={m.display_name} src={m.avatar_url} size={32} />
                        </span>
                      ) : null;
                    })}
                    {actionMenu(
                      "members",
                      <button type="button" className="grid place-items-center w-8 h-8 rounded-full bg-inset text-muted hover:bg-line hover:text-ink" aria-label="Add member">
                        <Plus size={16} />
                      </button>,
                    )}
                  </div>
                </Meta>
              )}

              {data.labelIds.length > 0 && (
                <Meta label="Labels">
                  <div className="flex flex-wrap items-center gap-1">
                    {data.labelIds.map((id) => {
                      const l = labelsById.get(id);
                      return l ? (
                        <span key={id} className="h-8 min-w-[3rem] px-3 rounded-md inline-flex items-center text-sm font-medium text-white" style={{ background: l.color }}>
                          {l.name || " "}
                        </span>
                      ) : null;
                    })}
                    {actionMenu(
                      "labels",
                      <button type="button" className="grid place-items-center w-8 h-8 rounded-md bg-inset text-muted hover:bg-line hover:text-ink" aria-label="Add label">
                        <Plus size={16} />
                      </button>,
                    )}
                  </div>
                </Meta>
              )}

              {(card.due_date || card.start_date) && (
                <Meta label={card.due_date && card.start_date ? "Dates" : card.due_date ? "Due date" : "Start date"}>
                  {actionMenu(
                    "dates",
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 h-8 px-2.5 rounded-md bg-inset text-sm text-ink hover:bg-line transition-colors"
                    >
                      {card.due_date && (
                        <input
                          type="checkbox"
                          className="accent-accent w-4 h-4"
                          checked={card.due_completed}
                          disabled={!can("pm.manage_dates")}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => patchCard.mutate({ due_completed: !card.due_completed })}
                          aria-label="Complete"
                        />
                      )}
                      <span>{fmtDates(card.start_date, card.due_date)}</span>
                      {card.due_date && status === "completed" && <Badge tone="success">Complete</Badge>}
                      {card.due_date && status === "overdue" && <Badge tone="danger">Overdue</Badge>}
                      {card.due_date && status === "soon" && <Badge tone="warn">Due soon</Badge>}
                      <ChevronDown size={14} className="text-muted" />
                    </button>,
                  )}
                </Meta>
              )}

              {lastUpdated && (
                <Meta label="Last updated">
                  <div className="h-8 px-3 rounded-md bg-inset text-sm text-ink inline-flex items-center" title={new Date(lastUpdated).toLocaleString()}>
                    {relativeTime(lastUpdated)}
                  </div>
                </Meta>
              )}
            </div>

            {/* Description */}
            <section>
              <SectionHeader
                icon={<AlignLeft size={18} />}
                action={
                  card.description && !editingDesc && can("pm.edit_card") ? (
                    <Button variant="secondary" size="sm" onClick={() => setEditingDesc(true)}>
                      Edit
                    </Button>
                  ) : null
                }
              >
                Description
              </SectionHeader>
              <div className="pl-9">
                {!editingDesc && descDraft.hasDraft && can("pm.edit_card") && (
                  <DraftNotice onView={() => setEditingDesc(true)} onDiscard={descDraft.discard} />
                )}
                {editingDesc && can("pm.edit_card") ? (
                  <RichEditor
                    autoFocus
                    value={descDraft.value}
                    onChange={descDraft.set}
                    onSubmit={saveDescNow}
                    // Clicking away closes the editor but keeps the draft.
                    onLeave={() => setEditingDesc(false)}
                    members={boardMembers}
                    onAttachFiles={(f) => void uploadFiles(f)}
                    placeholder="Add a more detailed description…"
                    footer={
                      <div className="flex items-center gap-2">
                        <Button variant="primary" size="sm" onMouseDown={keepFocus} onClick={saveDescNow}>
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onMouseDown={keepFocus}
                          onClick={() => {
                            descDraft.discard();
                            setEditingDesc(false);
                          }}
                        >
                          Cancel
                        </Button>
                        <span className="text-[11px] text-subtle hidden sm:inline">Ctrl+Enter to save</span>
                      </div>
                    }
                  />
                ) : card.description ? (
                  <div
                    className="text-sm text-ink cursor-text"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a")) return;
                      if (can("pm.edit_card")) setEditingDesc(true);
                    }}
                  >
                    <Markdown text={card.description} />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => can("pm.edit_card") && setEditingDesc(true)}
                    className="w-full text-left min-h-[64px] rounded-md border border-rule bg-inset px-3 py-2.5 text-sm text-subtle hover:bg-surface transition-colors"
                  >
                    Add a more detailed description…
                  </button>
                )}
              </div>
            </section>

            {/* Custom fields (renders nothing when the board has none) */}
            <CustomFieldsSection boardId={board.id} cardId={cardId} />

            {data.checklists.length > 0 && <ChecklistsSection cardId={cardId} checklists={data.checklists} items={data.items} />}

            {data.attachments.length > 0 && (
              <AttachmentsSection
                cardId={cardId}
                attachments={data.attachments}
                addButton={
                  can("pm.manage_attachments")
                    ? actionMenu(
                        "attachment",
                        <Button variant="secondary" size="sm">
                          Add
                        </Button>,
                        "right",
                      )
                    : null
                }
              />
            )}
          </div>

          {/* RIGHT — comments and activity, independent scroll on lg+ */}
          <div className="min-w-0 lg:w-1/2 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-line bg-bg/40 px-4 sm:px-5 py-5">
            <CommentsFeed
              cardId={cardId}
              roots={roots}
              repliesByParent={repliesByParent}
              activity={activity.data ?? []}
              activityLoading={activity.isLoading || isPlaceholderData}
              boardLists={boardLists}
              boardMembers={boardMembers}
              reactions={data.reactions}
              onOpenThread={setThreadId}
              onAttachFiles={(f) => void uploadFiles(f)}
            />
          </div>

          {/* Thread overlay — Slack-style panel covering both panes. */}
          {threadId && openThreadRoot && (
            <ThreadPanel
              root={openThreadRoot}
              replies={repliesByParent.get(threadId) ?? []}
              cardId={cardId}
              boardMembers={boardMembers}
              reactions={data.reactions}
              onAttachFiles={(f) => void uploadFiles(f)}
              onBack={() => setThreadId(null)}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

// ============================================================ small bits ==

function fmtDates(start: string | null, due: string | null): string {
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const s = start ? (() => {
    const [y, m, dd] = start.slice(0, 10).split("-").map(Number);
    return day(new Date(y!, (m ?? 1) - 1, dd ?? 1));
  })() : null;
  const d = due
    ? new Date(due).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  return s && d ? `${s} – ${d}` : (d ?? s ?? "");
}

function IconBtn({ children, title, onClick }: { children: ReactNode; title: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid place-items-center w-8 h-8 rounded-md text-muted hover:bg-inset hover:text-ink transition-colors"
    >
      {children}
    </button>
  );
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border bg-surface text-sm font-medium text-muted hover:bg-inset hover:text-ink hover:border-rule transition-colors"
    >
      {icon}
      {children}
    </button>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-subtle">{label}</div>
      {children}
    </div>
  );
}

// Trello's "…" card menu. Move / Copy step into a list chooser inside the same
// menu (nested popovers would close the parent).
function MoreMenu(p: {
  close: () => void;
  boardLists: ListT[];
  isMember: boolean;
  isTemplate: boolean;
  watching: boolean;
  can: ReturnType<typeof useAuth>["can"];
  onJoin: () => void;
  onMove: (listId: string) => void;
  onCopy: (listId: string) => void;
  onTemplate: () => void;
  onWatch: () => void;
  onCopyLink: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [view, setView] = useState<"root" | "move" | "copy">("root");
  const run = (fn: () => void) => () => {
    fn();
    p.close();
  };
  const row = (icon: ReactNode, label: string) => (
    <span className="flex items-center gap-2.5">
      <span className="text-muted">{icon}</span>
      {label}
    </span>
  );

  if (view !== "root") {
    return (
      <div className="w-64 py-1">
        <div className="flex items-center gap-1 px-2 pb-1">
          <button type="button" onClick={() => setView("root")} className="grid place-items-center w-7 h-7 rounded-md text-muted hover:bg-inset" aria-label="Back">
            <ArrowLeft size={15} />
          </button>
          <span className="text-sm font-semibold text-muted">{view === "move" ? "Move card to…" : "Copy card to…"}</span>
        </div>
        {p.boardLists.map((l) => (
          <MenuItem key={l.id} onClick={run(() => (view === "move" ? p.onMove(l.id) : p.onCopy(l.id)))}>
            {l.title}
          </MenuItem>
        ))}
      </div>
    );
  }

  return (
    <div className="w-60 py-1">
      <MenuItem onClick={run(p.onJoin)}>
        {row(p.isMember ? <UserMinus size={15} /> : <UserIcon size={15} />, p.isMember ? "Leave" : "Join")}
      </MenuItem>
      <MenuItem disabled={!p.can("pm.move_card")} onClick={() => setView("move")}>
        <span className="flex items-center justify-between">
          {row(<ArrowRightLeft size={15} />, "Move")}
          <ChevronRight size={14} className="text-subtle" />
        </span>
      </MenuItem>
      <MenuItem disabled={!p.can("pm.copy_card")} onClick={() => setView("copy")}>
        <span className="flex items-center justify-between">
          {row(<Copy size={15} />, "Copy")}
          <ChevronRight size={14} className="text-subtle" />
        </span>
      </MenuItem>
      <MenuItem disabled={!p.can("pm.manage_templates")} onClick={run(p.onTemplate)}>
        {row(p.isTemplate ? <StarOff size={15} /> : <Star size={15} />, p.isTemplate ? "Make regular card" : "Make template")}
      </MenuItem>
      <MenuItem onClick={run(p.onWatch)}>{row(p.watching ? <EyeOff size={15} /> : <Eye size={15} />, p.watching ? "Stop watching" : "Watch")}</MenuItem>
      <MenuItem onClick={run(p.onCopyLink)}>{row(<Link2 size={15} />, "Copy link")}</MenuItem>
      <MenuDivider />
      <MenuItem disabled={!p.can("pm.archive_card")} onClick={run(p.onArchive)}>
        {row(<Archive size={15} />, "Archive")}
      </MenuItem>
      {p.can("pm.delete_card") && (
        <MenuItem destructive onClick={run(p.onDelete)}>
          <span className="flex items-center gap-2.5">
            <Trash2 size={15} />
            Delete
          </span>
        </MenuItem>
      )}
    </div>
  );
}

// ============================================================ Checklists ==

// Each checklist is its own Trello-style block: title, progress bar, items,
// "Add an item". New checklists come from the "Checklist" action popover.
function ChecklistsSection({
  cardId,
  checklists,
  items,
}: {
  cardId: string;
  checklists: CardDetailBundle["checklists"];
  items: ChecklistItem[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useBoardCan();
  const canEdit = can("pm.manage_checklists");

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["activity", cardId] });
  };
  const fail = (e: Error) => toast.push({ kind: "error", title: "Checklist update failed", description: e.message });

  const addItem = useMutation({
    mutationFn: async (v: { checklistId: string; text: string }) => {
      const { error } = await supabase.from("checklist_item").insert({ checklist_id: v.checklistId, text: v.text, position: `p${Date.now()}` });
      if (error) throw error;
    },
    onSuccess: bump,
    onError: fail,
  });

  const toggleItem = useMutation({
    mutationFn: async (v: { id: string; completed: boolean }) => {
      const { error } = await supabase.from("checklist_item").update({ completed: v.completed }).eq("id", v.id);
      if (error) throw error;
    },
    onMutate: (v) =>
      qc.setQueryData<CardDetailBundle>(["card", cardId], (b) =>
        b ? { ...b, items: b.items.map((i) => (i.id === v.id ? { ...i, completed: v.completed } : i)) } : b,
      ),
    onSuccess: bump,
    onError: fail,
  });

  const deleteItem = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("checklist_item").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: bump,
    onError: fail,
  });

  const deleteChecklist = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("checklist").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: bump,
    onError: fail,
  });

  return (
    <>
      {checklists.map((cl) => {
        const clItems = items.filter((i) => i.checklist_id === cl.id).sort((a, b) => (a.position < b.position ? -1 : 1));
        const done = clItems.filter((i) => i.completed).length;
        const pct = clItems.length ? Math.round((done / clItems.length) * 100) : 0;
        return (
          <section key={cl.id}>
            <SectionHeader
              icon={<CheckSquare size={18} />}
              action={
                canEdit ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => confirm(`Delete checklist "${cl.name}"?`) && deleteChecklist.mutate(cl.id)}
                  >
                    Delete
                  </Button>
                ) : null
              }
            >
              {cl.name}
            </SectionHeader>

            <div className="flex items-center gap-3">
              <span className="w-9 text-right text-xs tabular-nums text-subtle">{pct}%</span>
              <div className="flex-1 h-2 rounded-full bg-inset overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all duration-300", pct === 100 ? "bg-success" : "bg-accent")}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            <div className="mt-2 pl-9 space-y-0.5">
              {clItems.map((i) => (
                <div key={i.id} className="group flex items-center gap-2.5 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-inset">
                  <input
                    type="checkbox"
                    className="accent-accent w-4 h-4 shrink-0"
                    disabled={!canEdit}
                    checked={i.completed}
                    onChange={(e) => toggleItem.mutate({ id: i.id, completed: e.target.checked })}
                  />
                  <span className={cn("flex-1 min-w-0 text-sm break-words", i.completed ? "line-through text-subtle" : "text-ink")}>{i.text}</span>
                  {canEdit && (
                    <button
                      className="opacity-0 group-hover:opacity-100 text-subtle hover:text-danger p-0.5"
                      onClick={() => deleteItem.mutate(i.id)}
                      aria-label="Delete item"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {canEdit && (
                <ChecklistItemAdder draftKey={`item:${cl.id}`} onAdd={(text) => addItem.mutate({ checklistId: cl.id, text })} />
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}

// Collapsed "Add an item" button → input. Clicking away keeps the text as a
// draft (shown on the button); only Add / Enter creates the item.
function ChecklistItemAdder({ draftKey, onAdd }: { draftKey: string; onAdd: (text: string) => void }) {
  const draft = useDraft(draftKey);
  const [open, setOpen] = useState(false);
  const submit = () => {
    const v = draft.value.trim();
    if (!v) return;
    onAdd(v);
    draft.discard();
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 h-8 max-w-full px-3 rounded-md bg-inset text-sm text-ink hover:bg-line transition-colors inline-flex items-center gap-1.5"
      >
        Add an item
        {draft.hasDraft && <DraftTag text={draft.value} />}
      </button>
    );
  }
  return (
    <div data-composer className="mt-1 space-y-2">
      <Input
        autoFocus
        placeholder="Add an item"
        value={draft.value}
        onChange={(e) => draft.set(e.target.value)}
        onBlur={(e) => leftComposer(e) && setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onMouseDown={keepFocus} onClick={submit}>
          Add
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onMouseDown={keepFocus}
          onClick={() => {
            draft.discard();
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SectionHeader({ icon, action, children }: { icon?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-2.5 min-h-8">
      <span className="w-6 grid place-items-center text-muted shrink-0">{icon}</span>
      <h3 className="flex-1 min-w-0 text-base font-semibold text-ink truncate">{children}</h3>
      {action}
    </div>
  );
}

// ============================================================ Attachments =

function AttachmentsSection({
  cardId,
  attachments,
  addButton,
}: {
  cardId: string;
  attachments: Attachment[];
  addButton?: ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useBoardCan();

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["activity", cardId] });
  };

  async function open(a: Attachment) {
    const url = await signedUrlFor(a, 120);
    if (!url) {
      toast.push({ kind: "error", title: "Couldn't open file" });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function remove(a: Attachment) {
    if (!confirm(`Delete "${a.name}"?`)) return;
    try {
      await deleteAttachment(a);
      bump();
    } catch (e: unknown) {
      toast.push({
        kind: "error",
        title: "Delete failed",
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  const canManage = can("pm.manage_attachments");

  return (
    <section>
      <SectionHeader icon={<Paperclip size={18} />} action={addButton}>
        Attachments
      </SectionHeader>

      {attachments.length === 0 ? null : (
        <div className="pl-9 space-y-3">
          {(() => {
            const images = attachments.filter(isImageAttachment);
            const files = attachments.filter((a) => !isImageAttachment(a));
            return (
              <>
                {images.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {images.map((a) => (
                      <ImageThumb
                        key={a.id}
                        att={a}
                        canManage={canManage}
                        onOpen={() => open(a)}
                        onDelete={() => remove(a)}
                      />
                    ))}
                  </div>
                )}
                {files.length > 0 && (
                  <ul className="space-y-1.5 text-sm">
                    {files.map((a) => (
                      <FileRow
                        key={a.id}
                        att={a}
                        canManage={canManage}
                        onOpen={() => open(a)}
                        onDelete={() => remove(a)}
                      />
                    ))}
                  </ul>
                )}
              </>
            );
          })()}
        </div>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------
// Image thumbnails — resolve a short-lived signed URL per attachment on
// mount. Trello attachments come as external_url (already public); Supabase
// storage rows need a signed URL because the bucket is private.
// --------------------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)$/i;
function isImageAttachment(a: Attachment): boolean {
  if (a.mime_type && a.mime_type.startsWith("image/")) return true;
  if (a.name && IMAGE_EXT.test(a.name)) return true;
  if (!a.mime_type && a.external_url && IMAGE_EXT.test(a.external_url)) return true;
  return false;
}

// Nice human labels for the popular services people paste in Trello.
const HOST_LABEL: Record<string, string> = {
  "drive.google.com":   "Google Drive",
  "docs.google.com":    "Google Docs",
  "sheets.google.com":  "Google Sheets",
  "slides.google.com":  "Google Slides",
  "miro.com":           "Miro",
  "figma.com":          "Figma",
  "notion.so":          "Notion",
  "www.notion.so":      "Notion",
  "airtable.com":       "Airtable",
  "loom.com":           "Loom",
  "www.loom.com":       "Loom",
  "dropbox.com":        "Dropbox",
  "www.dropbox.com":    "Dropbox",
  "youtube.com":        "YouTube",
  "www.youtube.com":    "YouTube",
  "youtu.be":           "YouTube",
  "github.com":         "GitHub",
  "trello.com":         "Trello",
};

interface ParsedLink {
  host: string;
  label: string;
  path: string;
  favicon: string;
}

function parseLink(url: string): ParsedLink | null {
  // URL() throws on garbage strings — return null so the caller falls back
  // to the plain file row.
  try {
    const u = new URL(url);
    const host = u.host;
    const label = HOST_LABEL[host] ?? host.replace(/^www\./, "");
    const path = (u.pathname + u.search).replace(/\/+$/, "");
    // s2 is Google's public favicon CDN — works even for hosts we don't have
    // a nice label for, and returns a 32px PNG. Cached hard by the browser.
    const favicon = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
    return { host, label, path: path || "/", favicon };
  } catch {
    return null;
  }
}

function FileRow({
  att,
  canManage,
  onOpen,
  onDelete,
}: {
  att: Attachment;
  canManage: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // External-URL attachments (Trello imports, pasted links) get a link-card
  // treatment with favicon + host label + path preview. Local uploads keep
  // the plain filename row.
  const isLink = !att.storage_path && !!att.external_url;
  const link = isLink ? parseLink(att.external_url as string) : null;

  return (
    <li className="group flex items-center gap-3 border border-border rounded-md pl-2.5 pr-1.5 py-2 bg-surface hover:bg-inset hover:border-rule transition-colors">
      {link ? (
        <img
          src={link.favicon}
          alt=""
          width={20}
          height={20}
          className="w-5 h-5 rounded-sm shrink-0"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <span className="grid place-items-center h-7 w-7 rounded-md bg-inset border border-line text-subtle shrink-0">
          <FileText size={14} />
        </span>
      )}

      <button
        className="flex-1 min-w-0 text-left rounded hover:text-accent"
        onClick={onOpen}
        title={link ? att.external_url ?? att.name : att.name}
      >
        {link ? (
          <>
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.3px] text-subtle font-medium">
              <span>{link.label}</span>
              <ExternalLink size={10} />
            </div>
            <div className="text-sm text-ink truncate group-hover:underline">
              {link.path}
            </div>
          </>
        ) : (
          <>
            <div className="text-sm font-medium text-ink truncate group-hover:underline">
              {att.name}
            </div>
            {att.size ? (
              <div className="text-[11px] text-subtle">{formatSize(att.size)}</div>
            ) : null}
          </>
        )}
      </button>

      <div className="flex items-center gap-0.5 shrink-0">
        <button
          className="rounded p-1.5 text-subtle hover:text-ink hover:bg-bg transition-colors"
          onClick={onOpen}
          aria-label={link ? "Open link" : "Download"}
          title={link ? "Open link" : "Download"}
        >
          {link ? <ExternalLink size={14} /> : <Download size={14} />}
        </button>
        {canManage && (
          <button
            className="rounded p-1.5 text-subtle hover:text-danger hover:bg-bg transition-colors"
            onClick={onDelete}
            aria-label="Delete"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

function ImageThumb({
  att,
  canManage,
  onOpen,
  onDelete,
}: {
  att: Attachment;
  canManage: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [url, setUrl] = useState<string | null>(att.storage_path ? null : att.external_url ?? null);

  useEffect(() => {
    let cancelled = false;
    if (!att.storage_path) return; // external_url is already set from initial state
    void (async () => {
      const u = await signedUrlFor(att, 600);
      if (!cancelled) setUrl(u);
    })();
    return () => {
      cancelled = true;
    };
  }, [att]);

  return (
    <div className="group relative rounded-md overflow-hidden border border-border bg-inset aspect-video">
      {url ? (
        <button
          type="button"
          onClick={onOpen}
          className="block w-full h-full hover:opacity-90"
          title={att.name}
        >
          <img
            src={url}
            alt={att.name}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          />
        </button>
      ) : (
        <div className="w-full h-full grid place-items-center">
          <Spinner size={16} />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 px-2 py-1.5 text-[11px] bg-gradient-to-t from-black/80 via-black/40 to-transparent text-white pointer-events-none">
        <span className="truncate font-medium">{att.name}</span>
        {att.size && <span className="text-white/80 tabular-nums">{formatSize(att.size)}</span>}
      </div>
      {canManage && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute top-1.5 right-1.5 rounded-md p-1 bg-surface/90 text-subtle hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity shadow-card"
          aria-label="Delete"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}
