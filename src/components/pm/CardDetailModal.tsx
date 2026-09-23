import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignLeft,
  Check,
  Clock,
  Paperclip,
  Tag,
  Users,
  X,
  Archive,
  MessageSquare,
  ArrowRightLeft,
  Copy,
  Eye,
  EyeOff,
  Star,
  StarOff,
  Activity as ActivityIcon,
  CheckSquare,
  Upload,
  Download,
  Trash2,
  ExternalLink,
  FileText,
  Palette,
} from "lucide-react";
import type {
  Activity as ActivityT,
  Attachment,
  Board,
  ChecklistItem,
  Label as LabelT,
  List as ListT,
  Profile,
} from "@/lib/database.types";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { relativeTime, shortDate, dueStatus } from "@/lib/format";
import {
  addComment,
  fetchCardDetail,
  moveCard,
  setCardArchived,
  toggleCardLabel,
  toggleCardMember,
  updateCard,
} from "@/lib/pm/boardApi";
import { supabase } from "@/lib/supabase";
import { CustomFieldsSection } from "@/components/pm/CustomFieldsSection";
import { RichText } from "@/components/pm/RichText";
import { ColorPickerMenu } from "@/components/pm/ColorPicker";
import {
  deleteAttachment,
  formatSize,
  signedUrlFor,
  uploadCardAttachment,
} from "@/lib/pm/attachmentsApi";
import { isWatching, setSubscription } from "@/lib/pm/notificationsApi";
import { cloneCardIntoList, setCardTemplate } from "@/lib/pm/templatesApi";

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
  const { can, user } = useAuth();
  const toast = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => fetchCardDetail(cardId),
  });

  const watching = useQuery({
    queryKey: ["watch", "card", cardId],
    queryFn: () => isWatching("card", cardId),
  });

  const activity = useQuery({
    queryKey: ["activity", cardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activity")
        .select("*, actor:actor_id(id, display_name, avatar_url)")
        .eq("card_id", cardId)
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as (ActivityT & { actor: { display_name: string; avatar_url: string | null } | null })[];
    },
  });

  const [title, setTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [desc, setDesc] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");

  useEffect(() => {
    if (data?.card) {
      setTitle(data.card.title);
      setDesc(data.card.description ?? "");
    }
  }, [data?.card]);

  useEffect(() => {
    const topic = `card:${cardId}:${Math.random().toString(36).slice(2, 10)}`;
    const ch = supabase
      .channel(topic)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "comment", filter: `card_id=eq.${cardId}` },
        () => {
          qc.invalidateQueries({ queryKey: ["card", cardId] });
          qc.invalidateQueries({ queryKey: ["activity", cardId] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "card_member", filter: `card_id=eq.${cardId}` },
        () => qc.invalidateQueries({ queryKey: ["card", cardId] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "card_label", filter: `card_id=eq.${cardId}` },
        () => qc.invalidateQueries({ queryKey: ["card", cardId] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "activity", filter: `card_id=eq.${cardId}` },
        () => qc.invalidateQueries({ queryKey: ["activity", cardId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [cardId, qc]);

  const saveTitle = useMutation({
    mutationFn: (v: string) => updateCard(cardId, { title: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
    },
  });

  const saveDesc = useMutation({
    mutationFn: (v: string) => updateCard(cardId, { description: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      setEditingDesc(false);
    },
  });

  const saveDue = useMutation({
    mutationFn: (v: { due_date: string | null; due_completed: boolean }) =>
      updateCard(cardId, { due_date: v.due_date, due_completed: v.due_completed }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
    },
  });

  const saveCover = useMutation({
    mutationFn: (color: string | null) => updateCard(cardId, { cover_color: color }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
    },
  });

  const toggleMember = useMutation({
    mutationFn: (v: { userId: string; on: boolean }) => toggleCardMember(cardId, v.userId, v.on),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["card", cardId] }),
  });

  const toggleLabel = useMutation({
    mutationFn: (v: { labelId: string; on: boolean }) => toggleCardLabel(cardId, v.labelId, v.on),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["card", cardId] }),
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

  const move = useMutation({
    mutationFn: (v: { listId: string }) => moveCard(cardId, v.listId, null, null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
      toast.push({ kind: "info", title: "Card moved" });
    },
  });

  const copyCard = useMutation({
    mutationFn: (v: { listId: string }) => cloneCardIntoList(cardId, v.listId, null),
    onSuccess: (newId) => {
      toast.push({ kind: "success", title: "Card copied" });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
      // Optionally navigate to the copy — leaving modal open on the source keeps context.
      void newId;
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Copy failed", description: e.message }),
  });

  const toggleTemplate = useMutation({
    mutationFn: (v: boolean) => setCardTemplate(cardId, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      qc.invalidateQueries({ queryKey: ["board", board.id] });
    },
  });

  const toggleWatch = useMutation({
    mutationFn: (v: boolean) => setSubscription("card", cardId, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watch", "card", cardId] }),
  });

  const postComment = useMutation({
    mutationFn: (body: string) => addComment(cardId, body),
    onSuccess: () => {
      setCommentDraft("");
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      qc.invalidateQueries({ queryKey: ["activity", cardId] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Comment failed", description: e.message }),
  });

  const labelsById = useMemo(() => new Map(boardLabels.map((l) => [l.id, l])), [boardLabels]);
  const memberById = useMemo(() => new Map(boardMembers.map((m) => [m.id, m])), [boardMembers]);

  return (
    <Modal open onClose={onClose} size="2xl" hideClose title={null} fitViewport>
      {isLoading || !data ? (
        <div className="flex-1 min-h-[200px] grid place-items-center">
          <Spinner size={20} />
        </div>
      ) : error ? (
        <div className="flex-1 min-h-[120px] grid place-items-center p-6 text-danger text-sm">
          {(error as Error).message}
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Sticky top bar — title, meta and close never scroll away. */}
          <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3 border-b border-line shrink-0">
            <div className="flex-1 min-w-0">
              {editingTitle && can("pm.edit_card") ? (
                <Input
                  value={title}
                  autoFocus
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => {
                    if (title.trim() && title !== data.card.title) saveTitle.mutate(title.trim());
                    setEditingTitle(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") {
                      setTitle(data.card.title);
                      setEditingTitle(false);
                    }
                  }}
                  className="text-lg font-semibold h-10"
                />
              ) : (
                <button
                  className="text-left text-lg font-semibold text-ink hover:bg-inset rounded px-1 py-0.5 -mx-1 transition-colors"
                  onClick={() => can("pm.edit_card") && setEditingTitle(true)}
                >
                  {data.card.title}
                </button>
              )}
              <div className="text-xs text-subtle mt-1 flex items-center gap-2">
                <span>
                  in list <span className="text-muted">{boardLists.find((l) => l.id === data.card.list_id)?.title ?? board.title}</span> · #{data.card.short_id}
                </span>
                {data.card.is_template && <Badge tone="accent">Template</Badge>}
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-md p-1 text-subtle hover:bg-inset hover:text-ink transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Panes. On mobile the row itself scrolls (one pane inside the card,
              never the page). On lg+ each pane scrolls on its own axis. */}
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
            {/* LEFT — actions toolbar on top, then description, checklists,
                custom fields, attachments. Own scroll on lg+. */}
            <div className="min-w-0 lg:w-1/2 lg:min-h-0 lg:overflow-y-auto px-4 sm:px-5 py-4 space-y-6">
              {/* Cover color strip */}
              {data.card.cover_color && (
                <div className="h-2 rounded-full" style={{ background: data.card.cover_color }} />
              )}

              {/* Action buttons — top of the left half */}
              <div className="flex flex-col gap-3 pb-2 border-b border-line">
                <div>
                  <div className="mb-1.5 text-[10px] font-semibold text-subtle uppercase tracking-[0.4px]">
                    Add to card
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <MembersPicker
                      boardMembers={boardMembers}
                      memberIds={data.memberIds}
                      onToggle={(uid, on) => toggleMember.mutate({ userId: uid, on })}
                      disabled={!can("pm.manage_members")}
                    />
                    <LabelsPicker
                      boardLabels={boardLabels}
                      labelIds={data.labelIds}
                      onToggle={(id, on) => toggleLabel.mutate({ labelId: id, on })}
                      disabled={!can("pm.manage_labels")}
                    />
                    <DueDatePicker
                      value={data.card.due_date}
                      completed={data.card.due_completed}
                      onChange={(due, completed) => saveDue.mutate({ due_date: due, due_completed: completed })}
                      disabled={!can("pm.manage_dates")}
                    />
                    <ColorPickerMenu
                      value={data.card.cover_color}
                      onChange={(c) => saveCover.mutate(c)}
                      trigger={
                        <Button
                          variant="subtle"
                          size="sm"
                          className="justify-start"
                          iconLeft={<Palette size={14} />}
                          disabled={!can("pm.edit_card")}
                        >
                          Color
                        </Button>
                      }
                    />
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-[10px] font-semibold text-subtle uppercase tracking-[0.4px]">
                    Actions
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ListPicker
                      trigger="Move"
                      icon={<ArrowRightLeft size={14} />}
                      boardLists={boardLists}
                      onPick={(id) => move.mutate({ listId: id })}
                      disabled={!can("pm.move_card")}
                    />
                    <ListPicker
                      trigger="Copy"
                      icon={<Copy size={14} />}
                      boardLists={boardLists}
                      onPick={(id) => copyCard.mutate({ listId: id })}
                      disabled={!can("pm.copy_card")}
                    />
                    <Button
                      variant="subtle"
                      size="sm"
                      className="justify-start"
                      iconLeft={watching.data ? <EyeOff size={14} /> : <Eye size={14} />}
                      onClick={() => toggleWatch.mutate(!(watching.data ?? false))}
                    >
                      {watching.data ? "Unwatch" : "Watch"}
                    </Button>
                    <Button
                      variant="subtle"
                      size="sm"
                      className="justify-start"
                      iconLeft={data.card.is_template ? <StarOff size={14} /> : <Star size={14} />}
                      disabled={!can("pm.manage_templates")}
                      onClick={() => toggleTemplate.mutate(!data.card.is_template)}
                    >
                      {data.card.is_template ? "Unmark template" : "Make template"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="justify-start"
                      iconLeft={<Archive size={14} />}
                      disabled={!can("pm.archive_card")}
                      onClick={() => archive.mutate()}
                    >
                      Archive
                    </Button>
                  </div>
                </div>
              </div>

              {/* Members + Labels + Dates chips row */}
              <div className="flex flex-wrap gap-3">
                {data.memberIds.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold text-subtle uppercase mb-1">Members</div>
                  <div className="flex -space-x-1.5">
                    {data.memberIds.map((uid) => {
                      const m = memberById.get(uid);
                      if (!m) return null;
                      return <Avatar key={uid} name={m.display_name} src={m.avatar_url} size={26} />;
                    })}
                  </div>
                </div>
              )}
              {data.labelIds.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold text-subtle uppercase mb-1">Labels</div>
                  <div className="flex flex-wrap gap-1">
                    {data.labelIds.map((id) => {
                      const l = labelsById.get(id);
                      if (!l) return null;
                      return (
                        <span
                          key={id}
                          className="text-xs text-white rounded px-2 py-0.5"
                          style={{ background: l.color }}
                        >
                          {l.name || " "}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
              {data.card.due_date && (
                <div>
                  <div className="text-[11px] font-semibold text-subtle uppercase mb-1">Due</div>
                  <button
                    onClick={() =>
                      can("pm.manage_dates") &&
                      saveDue.mutate({ due_date: data.card.due_date, due_completed: !data.card.due_completed })
                    }
                    className="inline-flex items-center gap-2 rounded-md border border-rule bg-surface px-2 py-1 text-sm hover:bg-inset hover:border-ink transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={data.card.due_completed}
                      onChange={() => {}}
                      className="accent-accent pointer-events-none"
                    />
                    <Badge
                      tone={
                        dueStatus(data.card.due_date, data.card.due_completed) === "overdue"
                          ? "danger"
                          : dueStatus(data.card.due_date, data.card.due_completed) === "soon"
                            ? "warn"
                            : dueStatus(data.card.due_date, data.card.due_completed) === "completed"
                              ? "success"
                              : "neutral"
                      }
                    >
                      {shortDate(data.card.due_date)}
                    </Badge>
                  </button>
                </div>
              )}
            </div>

            {/* Description */}
            <section>
              <SectionHeader icon={<AlignLeft size={14} />}>Description</SectionHeader>
              {editingDesc && can("pm.edit_card") ? (
                <div className="mt-2">
                  <Textarea rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus />
                  <div className="mt-2 flex items-center gap-2">
                    <Button variant="primary" size="sm" onClick={() => saveDesc.mutate(desc)}>
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDesc(data.card.description ?? "");
                        setEditingDesc(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => can("pm.edit_card") && setEditingDesc(true)}
                  className="mt-2 w-full text-left min-h-[60px] rounded-md border border-transparent hover:border-border p-2 text-sm text-ink"
                >
                  {data.card.description ? (
                    <RichText text={data.card.description} className="whitespace-pre-wrap" />
                  ) : (
                    <span className="text-subtle">Add a more detailed description…</span>
                  )}
                </button>
              )}
            </section>

            {/* Checklists */}
            <ChecklistsSection cardId={cardId} checklists={data.checklists} items={data.items} />

            {/* Custom fields */}
            <CustomFieldsSection boardId={board.id} cardId={cardId} />

              {/* Attachments */}
              <AttachmentsSection cardId={cardId} attachments={data.attachments} />
            </div>

            {/* RIGHT — comments + activity, independent scroll on lg+ */}
            <div className="min-w-0 lg:w-1/2 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-line px-4 sm:px-5 py-4 space-y-6">
              {/* Comments */}
              <section>
                <SectionHeader icon={<MessageSquare size={14} />}>Comments</SectionHeader>
              {can("pm.manage_comments") && (
                <div className="mt-3 flex gap-2">
                  <Avatar name={user?.user_metadata?.display_name ?? user?.email ?? "?"} size={28} />
                  <div className="flex-1">
                    <Textarea
                      rows={2}
                      placeholder="Write a comment… use @username to mention teammates."
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && commentDraft.trim()) {
                          postComment.mutate(commentDraft.trim());
                        }
                      }}
                    />
                    {commentDraft.trim() && (
                      <div className="mt-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => postComment.mutate(commentDraft.trim())}
                          loading={postComment.isPending}
                        >
                          Save
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-4 space-y-3">
                {data.comments.map((c) => (
                  <div key={c.id} className="flex gap-2">
                    <Avatar name={c.author?.display_name ?? "?"} src={c.author?.avatar_url} size={28} />
                    <div className="flex-1">
                      <div className="text-sm">
                        <span className="font-semibold text-ink">{c.author?.display_name}</span>{" "}
                        <span className="text-subtle text-xs">{relativeTime(c.created_at)}</span>
                      </div>
                      <div className="mt-0.5 rounded-md border border-border bg-inset px-2.5 py-1.5 text-sm">
                        <RichText text={c.body} className="whitespace-pre-wrap" />
                      </div>
                    </div>
                  </div>
                ))}
                {data.comments.length === 0 && (
                  <p className="text-sm text-subtle">No comments yet.</p>
                )}
              </div>
            </section>

            {/* Activity */}
            <section>
              <SectionHeader icon={<ActivityIcon size={14} />}>Activity</SectionHeader>
              {activity.isLoading ? (
                <Spinner size={14} />
              ) : (activity.data ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-subtle">No activity yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5 text-sm text-muted">
                  {(activity.data ?? []).map((a) => (
                    <li key={a.id} className="flex items-start gap-2">
                      <Avatar name={a.actor?.display_name ?? "?"} src={a.actor?.avatar_url} size={20} />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-ink">{a.actor?.display_name}</span>{" "}
                        <span>{humanAction(a.action)}</span>
                      </div>
                      <span className="shrink-0 text-xs text-subtle">{relativeTime(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          </div>
        </div>
      )}
    </Modal>
  );
}

function humanAction(action: string): string {
  const map: Record<string, string> = {
    "card.moved": "moved this card",
    "card.archived": "archived this card",
    "card.restored": "restored this card",
    "card.cloned": "copied this card",
    "card.templated": "marked as template",
    "card.untemplated": "unmarked as template",
    "card.self_assigned": "assigned themselves",
    "card.self_unassigned": "unassigned themselves",
    "list.moved": "moved a list",
    "board.created": "created the board",
  };
  return map[action] ?? action;
}

// ============================================================ Checklists ==

function ChecklistsSection({
  cardId,
  checklists,
  items,
}: {
  cardId: string;
  checklists: NonNullable<Awaited<ReturnType<typeof fetchCardDetail>>>["checklists"];
  items: ChecklistItem[];
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [newName, setNewName] = useState("");

  const bump = () => qc.invalidateQueries({ queryKey: ["card", cardId] });

  const addChecklist = useMutation({
    mutationFn: async (name: string) => {
      const { error } = await supabase.from("checklist").insert({
        card_id: cardId,
        name,
        position: `p${Date.now()}`,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewName("");
      bump();
    },
  });

  const addItem = useMutation({
    mutationFn: async (v: { checklistId: string; text: string }) => {
      const { error } = await supabase.from("checklist_item").insert({
        checklist_id: v.checklistId,
        text: v.text,
        position: `p${Date.now()}`,
      });
      if (error) throw error;
    },
    onSuccess: bump,
  });

  const toggleItem = useMutation({
    mutationFn: async (v: { id: string; completed: boolean }) => {
      const { error } = await supabase
        .from("checklist_item")
        .update({ completed: v.completed })
        .eq("id", v.id);
      if (error) throw error;
    },
    onSuccess: bump,
  });

  const deleteItem = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("checklist_item").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: bump,
  });

  return (
    <section>
      <SectionHeader icon={<CheckSquare size={14} />}>Checklists</SectionHeader>

      {checklists.map((cl) => {
        const clItems = items
          .filter((i) => i.checklist_id === cl.id)
          .sort((a, b) => (a.position < b.position ? -1 : 1));
        const done = clItems.filter((i) => i.completed).length;
        return (
          <div key={cl.id} className="mt-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-ink">{cl.name}</div>
              <div className="text-xs text-subtle">
                {done}/{clItems.length}
              </div>
            </div>
            <div className="mt-1.5 space-y-1">
              {clItems.map((i) => (
                <div key={i.id} className="flex items-center gap-2 text-sm group">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    disabled={!can("pm.manage_checklists")}
                    checked={i.completed}
                    onChange={(e) => toggleItem.mutate({ id: i.id, completed: e.target.checked })}
                  />
                  <span className={i.completed ? "line-through text-subtle" : "text-ink"}>{i.text}</span>
                  {can("pm.manage_checklists") && (
                    <button
                      className="opacity-0 group-hover:opacity-100 ml-auto text-subtle hover:text-danger p-0.5"
                      onClick={() => deleteItem.mutate(i.id)}
                      aria-label="Delete item"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ))}
              {can("pm.manage_checklists") && (
                <ChecklistItemAdder onAdd={(text) => addItem.mutate({ checklistId: cl.id, text })} />
              )}
            </div>
          </div>
        );
      })}

      {can("pm.manage_checklists") && (
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <Input
              value={newName}
              placeholder="Add checklist…"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) addChecklist.mutate(newName.trim());
              }}
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            disabled={!newName.trim()}
            onClick={() => newName.trim() && addChecklist.mutate(newName.trim())}
          >
            Add
          </Button>
        </div>
      )}
    </section>
  );
}

function ChecklistItemAdder({ onAdd }: { onAdd: (text: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="flex items-center gap-2 mt-1 min-w-0">
      <div className="flex-1 min-w-0">
        <Input
          placeholder="Add item…"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && v.trim()) {
              onAdd(v.trim());
              setV("");
            }
          }}
        />
      </div>
    </div>
  );
}

// ============================================================ Pickers ====

function SectionHeader({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold text-ink pb-2 border-b border-line mb-3">
      <span className="text-muted">{icon}</span>
      {children}
    </h3>
  );
}

function MembersPicker({
  boardMembers,
  memberIds,
  onToggle,
  disabled,
}: {
  boardMembers: Profile[];
  memberIds: string[];
  onToggle: (uid: string, on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Menu
      trigger={
        <Button variant="subtle" size="sm" className="justify-start" iconLeft={<Users size={14} />} disabled={disabled}>
          Members
        </Button>
      }
    >
      {() => (
        <div className="w-64 max-w-[calc(100vw-2rem)] max-h-72 overflow-auto py-1">
          {boardMembers.length === 0 && <div className="px-3 py-2 text-sm text-subtle">No board members.</div>}
          {boardMembers.map((m) => {
            const on = memberIds.includes(m.id);
            return (
              <MenuItem key={m.id} onClick={() => onToggle(m.id, !on)}>
                <span className="flex items-center gap-2">
                  <Avatar name={m.display_name} src={m.avatar_url} size={22} />
                  <span className="flex-1">{m.display_name}</span>
                  {on && <Check size={14} className="text-accent" />}
                </span>
              </MenuItem>
            );
          })}
        </div>
      )}
    </Menu>
  );
}

function LabelsPicker({
  boardLabels,
  labelIds,
  onToggle,
  disabled,
}: {
  boardLabels: LabelT[];
  labelIds: string[];
  onToggle: (id: string, on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Menu
      trigger={
        <Button variant="subtle" size="sm" className="justify-start" iconLeft={<Tag size={14} />} disabled={disabled}>
          Labels
        </Button>
      }
    >
      {() => (
        <div className="w-64 max-w-[calc(100vw-2rem)] max-h-72 overflow-auto p-2 space-y-1">
          {boardLabels.map((l) => {
            const on = labelIds.includes(l.id);
            return (
              <button
                key={l.id}
                onClick={() => onToggle(l.id, !on)}
                className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-inset transition-colors"
              >
                <span className="h-4 w-6 rounded" style={{ background: l.color }} />
                <span className="flex-1 text-left text-sm">{l.name || " "}</span>
                {on && <Check size={14} className="text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </Menu>
  );
}

function ListPicker({
  trigger,
  icon,
  boardLists,
  onPick,
  disabled,
}: {
  trigger: string;
  icon: React.ReactNode;
  boardLists: ListT[];
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <Menu
      trigger={
        <Button variant="subtle" size="sm" className="justify-start" iconLeft={icon} disabled={disabled}>
          {trigger}
        </Button>
      }
    >
      {(close) => (
        <div className="w-56 max-w-[calc(100vw-2rem)] max-h-72 overflow-auto py-1">
          {boardLists.length === 0 && (
            <div className="px-3 py-2 text-sm text-subtle">No lists.</div>
          )}
          {boardLists.map((l) => (
            <MenuItem
              key={l.id}
              onClick={() => {
                onPick(l.id);
                close();
              }}
            >
              {l.title}
            </MenuItem>
          ))}
        </div>
      )}
    </Menu>
  );
}

function DueDatePicker({
  value,
  completed,
  onChange,
  disabled,
}: {
  value: string | null;
  completed: boolean;
  onChange: (due: string | null, completed: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Menu
      trigger={
        <Button variant="subtle" size="sm" className="justify-start" iconLeft={<Clock size={14} />} disabled={disabled}>
          Dates
        </Button>
      }
    >
      {(close) => (
        <div className="w-64 max-w-[calc(100vw-2rem)] p-3 space-y-2">
          <Label htmlFor="due">Due date</Label>
          <Input
            id="due"
            type="datetime-local"
            defaultValue={value ? value.slice(0, 16) : ""}
            onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null, completed)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={completed}
              onChange={(e) => onChange(value, e.target.checked)}
              className="accent-accent"
              disabled={!value}
            />
            Mark due complete
          </label>
          <div className="flex justify-between">
            <Button size="sm" variant="ghost" onClick={() => onChange(null, false)}>
              Clear
            </Button>
            <Button size="sm" variant="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Menu>
  );
}

// ============================================================ Attachments =

function AttachmentsSection({
  cardId,
  attachments,
}: {
  cardId: string;
  attachments: Attachment[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [uploading, setUploading] = useState(false);

  const bump = () => qc.invalidateQueries({ queryKey: ["card", cardId] });

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        await uploadCardAttachment(cardId, f);
      }
      toast.push({ kind: "success", title: `Uploaded ${files.length} file${files.length > 1 ? "s" : ""}` });
      bump();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : "Upload failed.";
      toast.push({ kind: "error", title: "Upload failed", description: m });
    } finally {
      setUploading(false);
    }
  }

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
      <SectionHeader icon={<Paperclip size={14} />}>Attachments</SectionHeader>

      {canManage && (
        <label
          className="mt-2 flex items-center justify-center gap-2 rounded-md border-2 border-dashed border-rule bg-inset hover:bg-surface hover:border-ink hover:text-ink text-sm text-muted px-3 py-4 cursor-pointer transition-colors"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            e.preventDefault();
            void handleFiles(e.dataTransfer.files);
          }}
        >
          <Upload size={14} />
          {uploading ? "Uploading…" : "Drop files here or click to upload"}
          <input
            type="file"
            multiple
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      )}

      {attachments.length === 0 ? (
        <p className="mt-3 text-sm text-subtle">No attachments yet.</p>
      ) : (
        <div className="mt-3 space-y-3">
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
        className="flex-1 min-w-0 text-left"
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
          className="block w-full h-full"
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
