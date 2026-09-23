import { supabase } from "@/lib/supabase";
import type {
  Attachment,
  Board,
  Card,
  Checklist,
  ChecklistItem,
  Comment,
  Label,
  List,
  Profile,
} from "@/lib/database.types";
import { between } from "@/lib/lexorank";

export interface BoardSummary extends Board {
  member_count: number;
}

export async function listBoards(): Promise<BoardSummary[]> {
  // RLS restricts this to boards the caller is a member of.
  const { data, error } = await supabase
    .from("board")
    .select("*, board_member(count)")
    .eq("is_archived", false)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as (Board & { board_member?: { count: number }[] })[]).map((b) => ({
    ...b,
    member_count: b.board_member?.[0]?.count ?? 0,
  }));
}

export async function createBoard(input: {
  title: string;
  description?: string;
  background?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc("create_board", {
    p_title: input.title,
    p_description: input.description ?? null,
    p_background: input.background ?? null,
  });
  if (error) throw error;
  return data as string;
}

export interface BoardBundle {
  board: Board;
  lists: List[];
  cards: Card[];
  labels: Label[];
  members: Profile[];
  cardLabels: { card_id: string; label_id: string }[];
  cardMembers: { card_id: string; user_id: string }[];
}

export async function fetchBoardBundle(boardId: string): Promise<BoardBundle> {
  const [boardRes, listsRes, cardsRes, labelsRes, memRes, clRes, cmRes] = await Promise.all([
    supabase.from("board").select("*").eq("id", boardId).single(),
    supabase
      .from("list")
      .select("*")
      .eq("board_id", boardId)
      .eq("is_archived", false)
      .order("position"),
    supabase
      .from("card")
      .select("*")
      .eq("board_id", boardId)
      .eq("is_archived", false)
      .order("position"),
    supabase.from("label").select("*").eq("board_id", boardId).order("position"),
    supabase
      .from("board_member")
      .select("user_id, profile:profile!inner(*)")
      .eq("board_id", boardId),
    supabase
      .from("card_label")
      .select("card_id, label_id, card:card!inner(board_id)")
      .eq("card.board_id", boardId),
    supabase
      .from("card_member")
      .select("card_id, user_id, card:card!inner(board_id)")
      .eq("card.board_id", boardId),
  ]);
  if (boardRes.error) throw boardRes.error;
  if (listsRes.error) throw listsRes.error;
  if (cardsRes.error) throw cardsRes.error;
  if (labelsRes.error) throw labelsRes.error;
  if (memRes.error) throw memRes.error;
  if (clRes.error) throw clRes.error;
  if (cmRes.error) throw cmRes.error;

  // supabase-js sometimes types embedded 1:1 joins as arrays; normalise via unknown.
  const memRows = (memRes.data ?? []) as unknown as {
    user_id: string;
    profile: Profile | Profile[];
  }[];
  const clRows = (clRes.data ?? []) as unknown as { card_id: string; label_id: string }[];
  const cmRows = (cmRes.data ?? []) as unknown as { card_id: string; user_id: string }[];

  return {
    board: boardRes.data as Board,
    lists: (listsRes.data ?? []) as List[],
    cards: (cardsRes.data ?? []) as Card[],
    labels: (labelsRes.data ?? []) as Label[],
    members: memRows.map((r) => (Array.isArray(r.profile) ? r.profile[0]! : r.profile)),
    cardLabels: clRows.map((r) => ({ card_id: r.card_id, label_id: r.label_id })),
    cardMembers: cmRows.map((r) => ({ card_id: r.card_id, user_id: r.user_id })),
  };
}

// ============================================================ Lists ======

export async function createList(boardId: string, title: string, afterPos: string | null) {
  const position = between(afterPos, null);
  const { data, error } = await supabase
    .from("list")
    .insert({ board_id: boardId, title, position })
    .select("*")
    .single();
  if (error) throw error;
  return data as List;
}

export async function renameList(id: string, title: string) {
  const { error } = await supabase.from("list").update({ title }).eq("id", id);
  if (error) throw error;
}

export async function archiveList(id: string) {
  const { error } = await supabase.from("list").update({ is_archived: true }).eq("id", id);
  if (error) throw error;
}

export async function setListColor(id: string, color: string | null) {
  const { error } = await supabase.from("list").update({ color }).eq("id", id);
  if (error) throw error;
}

// Permanent delete. FK cascades remove the list's cards and each card's
// satellites (labels, members, checklists, attachments rows, comments,
// custom-field values); activity rows keep their history with a null card_id.
export async function deleteList(id: string) {
  const { error } = await supabase.from("list").delete().eq("id", id);
  if (error) throw error;
}

export async function deleteCard(id: string) {
  const { error } = await supabase.from("card").delete().eq("id", id);
  if (error) throw error;
}

// Duplicate a list and all its non-archived cards (via clone_card, which also
// copies labels, checklists and custom fields). Cards are re-positioned after
// cloning so the copy keeps the source order regardless of clone placement.
export async function copyList(
  boardId: string,
  sourceListId: string,
  newTitle: string,
  afterPos: string | null,
): Promise<string> {
  const created = await createList(boardId, newTitle, afterPos);
  const { data: cards, error } = await supabase
    .from("card")
    .select("id, position")
    .eq("list_id", sourceListId)
    .eq("is_archived", false)
    .order("position");
  if (error) throw error;

  const newIds: string[] = [];
  for (const c of cards ?? []) {
    const { data: nid, error: cErr } = await supabase.rpc("clone_card", {
      p_source_card: c.id,
      p_target_list: created.id,
      p_after_position: null,
    });
    if (cErr) throw cErr;
    newIds.push(nid as string);
  }
  let prev: string | null = null;
  for (const id of newIds) {
    const pos = between(prev, null);
    await updateCard(id, { position: pos });
    prev = pos;
  }
  return created.id;
}

export async function reorderList(id: string, prev: string | null, next: string | null) {
  const { data, error } = await supabase.rpc("reorder_list", {
    p_list_id: id,
    p_prev_position: prev,
    p_next_position: next,
  });
  if (error) throw error;
  return data as string;
}

// ============================================================ Cards ======

export async function createCard(
  boardId: string,
  listId: string,
  title: string,
  afterPos: string | null,
) {
  const position = between(afterPos, null);
  const {
    data: userData,
  } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Not signed in");

  const { data, error } = await supabase
    .from("card")
    .insert({
      board_id: boardId,
      list_id: listId,
      title,
      position,
      created_by: userData.user.id,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Card;
}

export async function updateCard(id: string, patch: Partial<Card>) {
  const { error } = await supabase.from("card").update(patch).eq("id", id);
  if (error) throw error;
}

export async function moveCard(
  cardId: string,
  listId: string,
  prev: string | null,
  next: string | null,
) {
  const { data, error } = await supabase.rpc("move_card", {
    p_card_id: cardId,
    p_list_id: listId,
    p_prev_position: prev,
    p_next_position: next,
  });
  if (error) throw error;
  return data as string;
}

export async function setCardArchived(cardId: string, archived: boolean) {
  const { error } = await supabase.rpc("set_card_archived", {
    p_card: cardId,
    p_archived: archived,
  });
  if (error) throw error;
}

export interface ArchivedCard extends Card {
  list_title: string | null;
}

export async function fetchArchivedCards(boardId: string): Promise<ArchivedCard[]> {
  const { data, error } = await supabase
    .from("card")
    .select("*, list:list_id(title)")
    .eq("board_id", boardId)
    .eq("is_archived", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as (Card & { list: { title: string } | null })[]).map((c) => ({
    ...c,
    list_title: c.list?.title ?? null,
  }));
}

// ============================================================ Card body ==

export interface CardDetailBundle {
  card: Card;
  comments: (Comment & {
    author: { id: string; display_name: string; avatar_url: string | null } | null;
  })[];
  checklists: Checklist[];
  items: ChecklistItem[];
  attachments: Attachment[];
  labelIds: string[];
  memberIds: string[];
}

export async function fetchCardDetail(cardId: string): Promise<CardDetailBundle> {
  const [c, comments, checklists, items, atts, labels, members] = await Promise.all([
    supabase.from("card").select("*").eq("id", cardId).single(),
    supabase
      .from("comment")
      .select("*, author:author_id(id, display_name, avatar_url)")
      .eq("card_id", cardId)
      .order("created_at"),
    supabase.from("checklist").select("*").eq("card_id", cardId).order("position"),
    supabase
      .from("checklist_item")
      .select("*, checklist:checklist_id!inner(card_id)")
      .eq("checklist.card_id", cardId),
    supabase.from("attachment").select("*").eq("card_id", cardId).order("created_at"),
    supabase.from("card_label").select("label_id").eq("card_id", cardId),
    supabase.from("card_member").select("user_id").eq("card_id", cardId),
  ]);
  if (c.error) throw c.error;

  const labelRows = (labels.data ?? []) as { label_id: string }[];
  const memberRows = (members.data ?? []) as { user_id: string }[];

  return {
    card: c.data as Card,
    comments: (comments.data ?? []) as CardDetailBundle["comments"],
    checklists: (checklists.data ?? []) as Checklist[],
    items: (items.data ?? []) as ChecklistItem[],
    attachments: (atts.data ?? []) as Attachment[],
    labelIds: labelRows.map((r) => r.label_id),
    memberIds: memberRows.map((r) => r.user_id),
  };
}

export async function addComment(cardId: string, body: string) {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error("Not signed in");
  const { error } = await supabase
    .from("comment")
    .insert({ card_id: cardId, author_id: u.user.id, body });
  if (error) throw error;
}

export async function toggleCardMember(cardId: string, userId: string, on: boolean) {
  if (on) {
    const { error } = await supabase
      .from("card_member")
      .insert({ card_id: cardId, user_id: userId });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("card_member")
      .delete()
      .eq("card_id", cardId)
      .eq("user_id", userId);
    if (error) throw error;
  }
}

export async function toggleCardLabel(cardId: string, labelId: string, on: boolean) {
  if (on) {
    const { error } = await supabase
      .from("card_label")
      .insert({ card_id: cardId, label_id: labelId });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("card_label")
      .delete()
      .eq("card_id", cardId)
      .eq("label_id", labelId);
    if (error) throw error;
  }
}
