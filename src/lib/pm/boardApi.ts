import type { QueryClient } from "@tanstack/react-query";
import { supabase, sessionUser } from "@/lib/supabase";
import type {
  Attachment,
  Board,
  BoardRole,
  BoardVisibility,
  Card,
  Checklist,
  ChecklistItem,
  Comment,
  Label,
  List,
  Profile,
  WbRole,
} from "@/lib/database.types";
import { between } from "@/lib/lexorank";
import { saveWbSnapshot } from "@/lib/offline/wbCache";
import { NO_ACCESS, type BoardAccessInfo } from "@/lib/permissions";

export interface BoardSummary extends Board {
  member_count: number;
  /** Caller's role on the board; null = visible via workspace, not joined. */
  my_role: BoardRole | null;
  /** Whiteboards: caller's Miro role (0039). */
  my_wb_role?: WbRole | null;
}

export async function listBoards(userId: string): Promise<BoardSummary[]> {
  // RLS returns boards the caller belongs to plus workspace-visible ones.
  const [boardsRes, mineRes] = await Promise.all([
    supabase
      .from("board")
      .select("*, board_member(count)")
      .eq("is_archived", false)
      .order("updated_at", { ascending: false }),
    supabase.from("board_member").select("board_id, role, wb_role").eq("user_id", userId),
  ]);
  if (boardsRes.error) throw boardsRes.error;
  if (mineRes.error) throw mineRes.error;
  const rows = (mineRes.data ?? []) as { board_id: string; role: BoardRole; wb_role: WbRole | null }[];
  const mine = new Map(rows.map((r) => [r.board_id, r.role]));
  const mineWb = new Map(rows.map((r) => [r.board_id, r.wb_role]));
  return ((boardsRes.data ?? []) as (Board & { board_member?: { count: number }[] })[]).map((b) => ({
    ...b,
    member_count: b.board_member?.[0]?.count ?? 0,
    my_role: mine.get(b.id) ?? null,
    my_wb_role: mineWb.get(b.id) ?? null,
  }));
}

export async function createBoard(input: {
  title: string;
  description?: string;
  background?: string | null;
  visibility?: BoardVisibility;
  /** 'whiteboard' makes a canvas board (0038). */
  kind?: "kanban" | "whiteboard";
}): Promise<string> {
  // The id is made here (0051), so a board made offline opens right away.
  const id = crypto.randomUUID();
  const { data, error } = await supabase.rpc("create_board", {
    p_title: input.title,
    p_description: input.description ?? null,
    p_background: input.background ?? null,
    p_visibility: input.visibility ?? "workspace",
    p_kind: input.kind ?? "kanban",
    p_id: id,
  });
  if (error) throw error;
  return (data as string | null) ?? id;
}

/**
 * Put a board just made into the caches, as the server would return it, so it
 * shows in the list and opens even before the server has it (offline). The
 * next fetch replaces all of this with the real rows.
 */
export function seedNewBoard(
  qc: QueryClient,
  me: Profile,
  b: { id: string; title: string; kind: "kanban" | "whiteboard"; visibility: BoardVisibility; description?: string | null },
) {
  const now = new Date().toISOString();
  const board: Board = {
    id: b.id,
    workspace_id: "00000000-0000-0000-0000-000000000001",
    title: b.title,
    description: b.description ?? null,
    background: null,
    is_archived: false,
    visibility: b.visibility,
    comment_policy: "members",
    member_policy: "members",
    self_join: true,
    kind: b.kind,
    preview: null,
    created_by: me.id,
    created_at: now,
    updated_at: now,
  } as Board;
  const isWb = b.kind === "whiteboard";
  qc.setQueryData<BoardSummary[]>(["boards", me.id], (list) =>
    list && !list.some((x) => x.id === b.id)
      ? [{ ...board, member_count: 1, my_role: "admin", my_wb_role: isWb ? "owner" : null }, ...list]
      : list,
  );
  const access: BoardAccessInfo = {
    access: "admin",
    can_edit: true,
    can_comment: true,
    manage_members: true,
    delete_board: true,
    ...(isWb ? { wb_role: "owner" as const, team_access: "edit" as const, allow_copy: true } : {}),
  };
  if (!qc.getQueryData(["board-access", b.id, me.id])) qc.setQueryData(["board-access", b.id, me.id], access);
  if (isWb) {
    if (!qc.getQueryData(["wb-board", b.id])) qc.setQueryData(["wb-board", b.id], board);
    // An empty canvas on the device: the new board opens offline too.
    void saveWbSnapshot(b.id, [], me.id);
    return;
  }
  if (qc.getQueryData(["board", b.id])) return;
  qc.setQueryData<BoardBundle>(["board", b.id], {
    board,
    lists: [],
    cards: [],
    labels: [],
    members: [me],
    memberRoles: { [me.id]: "admin" },
    cardLabels: [],
    cardMembers: [],
  });
}

// ============================================================ Access =====

export async function fetchBoardAccess(boardId: string): Promise<BoardAccessInfo> {
  const { data, error } = await supabase.rpc("my_board_access", { b: boardId });
  if (error) throw error;
  return { ...NO_ACCESS, ...((data ?? {}) as Partial<BoardAccessInfo>) };
}

export interface BoardMemberRow {
  user_id: string;
  role: BoardRole;
  created_at: string;
  profile: Profile;
}

export async function fetchBoardMembers(boardId: string): Promise<BoardMemberRow[]> {
  const { data, error } = await supabase
    .from("board_member")
    .select("user_id, role, created_at, profile:profile!inner(*)")
    .eq("board_id", boardId)
    .order("created_at");
  if (error) throw error;
  return ((data ?? []) as unknown as (Omit<BoardMemberRow, "profile"> & { profile: Profile | Profile[] })[]).map(
    (r) => ({ ...r, profile: Array.isArray(r.profile) ? r.profile[0]! : r.profile }),
  );
}

export async function addBoardMember(boardId: string, userId: string, role: BoardRole) {
  const { error } = await supabase.from("board_member").insert({ board_id: boardId, user_id: userId, role });
  if (error) throw error;
}

export async function setBoardMemberRole(boardId: string, userId: string, role: BoardRole) {
  const { error } = await supabase
    .from("board_member")
    .update({ role })
    .eq("board_id", boardId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function removeBoardMember(boardId: string, userId: string) {
  const { error } = await supabase.from("board_member").delete().eq("board_id", boardId).eq("user_id", userId);
  if (error) throw error;
}

export type BoardSettings = Pick<
  Board,
  "title" | "description" | "visibility" | "comment_policy" | "member_policy" | "self_join"
>;

export async function updateBoard(boardId: string, patch: Partial<BoardSettings>) {
  const { error } = await supabase.from("board").update(patch).eq("id", boardId);
  if (error) throw error;
}

export async function deleteBoard(boardId: string) {
  const { error } = await supabase.from("board").delete().eq("id", boardId);
  if (error) throw error;
}

/** A Trello mirror card (its title is a link to another card) shows the real
 *  card in its place, like Trello does. See migrations 0024 / 0025. */
export interface MirrorInfo {
  target_id: string;
  board_id: string;
  board_title: string;
  list_title: string;
  labels: { name: string; color: string }[];
  members: { id: string; name: string; avatar_url: string | null }[];
}
export type CardWithMirror = Card & { mirror?: MirrorInfo };

export interface BoardBundle {
  board: Board;
  lists: List[];
  cards: Card[];
  labels: Label[];
  members: Profile[];
  /** Board role per member user id. */
  memberRoles: Record<string, BoardRole>;
  cardLabels: { card_id: string; label_id: string }[];
  cardMembers: { card_id: string; user_id: string }[];
}

export async function fetchBoardBundle(boardId: string): Promise<BoardBundle> {
  const [boardRes, listsRes, cardsRes, labelsRes, memRes, clRes, cmRes, mirRes] = await Promise.all([
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
      .select("user_id, role, profile:profile!inner(*)")
      .eq("board_id", boardId),
    // board_id is denormalised on these (0016), so no join through card.
    supabase.from("card_label").select("card_id, label_id").eq("board_id", boardId),
    supabase.from("card_member").select("card_id, user_id").eq("board_id", boardId),
    supabase.rpc("board_mirrors" as never, { p_board: boardId } as never),
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
    role: BoardRole;
    profile: Profile | Profile[];
  }[];
  const clRows = (clRes.data ?? []) as unknown as { card_id: string; label_id: string }[];
  const cmRows = (cmRes.data ?? []) as unknown as { card_id: string; user_id: string }[];

  const lists = (listsRes.data ?? []) as List[];
  // A missing mirror RPC (older database) just leaves mirrors as links.
  const mirrors = new Map(((mirRes.data ?? []) as MirrorRow[]).map((m) => [m.card_id, m]));
  // Cards inside an archived list stay hidden with it — otherwise they leak
  // into the calendar/table/timeline/dashboard views with no list.
  const liveLists = new Set(lists.map((l) => l.id));

  return {
    board: boardRes.data as Board,
    lists,
    cards: ((cardsRes.data ?? []) as Card[])
      .filter((c) => liveLists.has(c.list_id))
      // A mirror of an archived card is hidden, like the card itself.
      .filter((c) => !mirrors.get(c.id)?.is_archived)
      .map((c) => withMirror(c, mirrors.get(c.id))),
    labels: (labelsRes.data ?? []) as Label[],
    members: memRows.map((r) => (Array.isArray(r.profile) ? r.profile[0]! : r.profile)),
    memberRoles: Object.fromEntries(memRows.map((r) => [r.user_id, r.role])),
    cardLabels: clRows.map((r) => ({ card_id: r.card_id, label_id: r.label_id })),
    cardMembers: cmRows.map((r) => ({ card_id: r.card_id, user_id: r.user_id })),
  };
}

interface MirrorRow extends MirrorInfo {
  card_id: string;
  title: string;
  has_description: boolean;
  due_date: string | null;
  due_completed: boolean;
  start_date: string | null;
  cover_color: string | null;
  is_archived: boolean;
}

// Show the real card's face on the mirror; every view (board, table,
// calendar, filters) then reads the right title and dates.
function withMirror(c: Card, m: MirrorRow | undefined): CardWithMirror {
  if (!m) return c;
  return {
    ...c,
    title: m.title,
    description: m.has_description ? c.description ?? " " : null,
    due_date: m.due_date,
    due_completed: m.due_completed,
    start_date: m.start_date,
    cover_color: m.cover_color,
    mirror: {
      target_id: m.target_id,
      board_id: m.board_id,
      board_title: m.board_title,
      list_title: m.list_title,
      labels: m.labels ?? [],
      members: m.members ?? [],
    },
  };
}

// ============================================================ Lists ======

/** `opts.id` / `opts.position` let callers render the list optimistically
 *  with the same id and position the server will store. */
export async function createList(
  boardId: string,
  title: string,
  afterPos: string | null,
  opts: { id?: string; position?: string } = {},
) {
  const position = opts.position ?? between(afterPos, null);
  const { data, error } = await supabase
    .from("list")
    .insert({ ...(opts.id ? { id: opts.id } : {}), board_id: boardId, title, position })
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

export async function restoreList(id: string) {
  const { error } = await supabase.from("list").update({ is_archived: false }).eq("id", id);
  if (error) throw error;
}

export interface ArchivedList extends List {
  card_count: number;
}

export async function fetchArchivedLists(boardId: string): Promise<ArchivedList[]> {
  const { data, error } = await supabase
    .from("list")
    .select("*, card(count)")
    .eq("board_id", boardId)
    .eq("is_archived", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as (List & { card: { count: number }[] })[]).map(({ card, ...l }) => ({
    ...l,
    card_count: card?.[0]?.count ?? 0,
  }));
}

/** Flag a list as "done": its cards count as finished (never overdue). */
export async function setListDone(id: string, is_done: boolean) {
  const { error } = await supabase.from("list").update({ is_done }).eq("id", id);
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
  beforePos: string | null = null,
): Promise<string> {
  // Between this list and the next, so the copy never ties with a neighbour.
  const created = await createList(boardId, newTitle, afterPos, { position: between(afterPos, beforePos) });
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
  opts: { id?: string; position?: string } = {},
) {
  const position = opts.position ?? between(afterPos, null);
  // The saved session, read locally: works offline, no round trip per card.
  const { data: sess } = await sessionUser();
  const uid = sess.user?.id;
  if (!uid) throw new Error("Not signed in");

  const { data, error } = await supabase
    .from("card")
    .insert({
      ...(opts.id ? { id: opts.id } : {}),
      board_id: boardId,
      list_id: listId,
      title,
      position,
      created_by: uid,
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
  list_archived: boolean;
}

export async function fetchArchivedCards(boardId: string): Promise<ArchivedCard[]> {
  const { data, error } = await supabase
    .from("card")
    .select("*, list:list_id(title, is_archived)")
    .eq("board_id", boardId)
    .eq("is_archived", true)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as (Card & { list: { title: string; is_archived: boolean } | null })[]).map(({ list, ...c }) => ({
    ...c,
    list_title: list?.title ?? null,
    list_archived: list?.is_archived ?? false,
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
  reactions: CommentReaction[];
}

export interface CommentReaction {
  id: string;
  comment_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
}

// Trello-mirrored comments / history whose author has no account yet are
// stored under the admin; this maps those rows to the real Trello person
// (name + avatar) so the card shows who actually wrote them. See 0020.
export type TrelloAuthor = { id?: string; display_name: string; avatar_url: string | null };
export async function fetchTrelloAuthors(cardId: string): Promise<Map<string, TrelloAuthor>> {
  const { data } = await supabase.rpc("trello_card_authors" as never, { p_card: cardId } as never);
  const rows = (data ?? []) as { entity_id: string; name: string; avatar_url: string | null }[];
  return new Map(rows.map((r) => [r.entity_id, { display_name: r.name, avatar_url: r.avatar_url }]));
}

export async function fetchCardDetail(cardId: string): Promise<CardDetailBundle> {
  const [c, comments, checklists, items, atts, labels, members, reactions, trello] = await Promise.all([
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
    supabase
      .from("comment_reaction")
      .select("id, comment_id, user_id, emoji, created_at")
      .eq("card_id", cardId)
      .order("created_at"),
    fetchTrelloAuthors(cardId),
  ]);
  if (c.error) throw c.error;

  const labelRows = (labels.data ?? []) as { label_id: string }[];
  const memberRows = (members.data ?? []) as { user_id: string }[];

  return {
    card: c.data as Card,
    comments: ((comments.data ?? []) as CardDetailBundle["comments"]).map((cm) =>
      trello.has(cm.id) ? { ...cm, author: trello.get(cm.id) as CardDetailBundle["comments"][number]["author"] } : cm,
    ),
    checklists: (checklists.data ?? []) as Checklist[],
    items: (items.data ?? []) as ChecklistItem[],
    attachments: (atts.data ?? []) as Attachment[],
    labelIds: labelRows.map((r) => r.label_id),
    memberIds: memberRows.map((r) => r.user_id),
    reactions: (reactions.data ?? []) as CommentReaction[],
  };
}

/** Every row of a board-wide query (PostgREST answers 1000 rows at most). */
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/**
 * The card modal's data for every card on a board, in a few requests (for
 * offline use: see lib/offline/prefetch.ts). Same shape as fetchCardDetail,
 * minus the Trello author names, which the modal fills in when it opens online.
 */
export async function fetchBoardCardDetails(bundle: BoardBundle): Promise<Map<string, CardDetailBundle>> {
  const b = bundle.board.id;
  const strip = <T extends Record<string, unknown>>(rows: T[]) => rows.map(({ card: _card, ...r }) => r as unknown as T);
  const [comments, checklists, items, attachments, reactions] = await Promise.all([
    allRows<CardDetailBundle["comments"][number] & Record<string, unknown>>((f, t) =>
      supabase
        .from("comment")
        .select("*, author:author_id(id, display_name, avatar_url), card!inner(board_id)")
        .eq("card.board_id", b)
        .order("created_at")
        .order("id")
        .range(f, t),
    ),
    allRows<Checklist & Record<string, unknown>>((f, t) =>
      supabase.from("checklist").select("*, card!inner(board_id)").eq("card.board_id", b).order("position").order("id").range(f, t),
    ),
    allRows<ChecklistItem & Record<string, unknown>>((f, t) =>
      supabase
        .from("checklist_item")
        .select("*, checklist:checklist_id!inner(card_id, card!inner(board_id))")
        .eq("checklist.card.board_id", b)
        .order("id")
        .range(f, t),
    ),
    allRows<Attachment & Record<string, unknown>>((f, t) =>
      supabase.from("attachment").select("*, card!inner(board_id)").eq("card.board_id", b).order("created_at").order("id").range(f, t),
    ),
    allRows<CommentReaction & { card_id: string } & Record<string, unknown>>((f, t) =>
      supabase
        .from("comment_reaction")
        .select("id, comment_id, user_id, emoji, created_at, card_id, card!inner(board_id)")
        .eq("card.board_id", b)
        .order("created_at")
        .range(f, t),
    ),
  ]);

  const out = new Map<string, CardDetailBundle>();
  for (const card of bundle.cards as CardWithMirror[]) {
    if (card.mirror) continue; // a mirror opens its real card instead
    out.set(card.id, {
      card,
      comments: [],
      checklists: [],
      items: [],
      attachments: [],
      labelIds: bundle.cardLabels.filter((r) => r.card_id === card.id).map((r) => r.label_id),
      memberIds: bundle.cardMembers.filter((r) => r.card_id === card.id).map((r) => r.user_id),
      reactions: [],
    });
  }
  for (const c of strip(comments)) out.get(c.card_id)?.comments.push(c);
  const checklistCard = new Map<string, string>();
  for (const c of strip(checklists)) {
    checklistCard.set(c.id, c.card_id);
    out.get(c.card_id)?.checklists.push(c);
  }
  for (const i of items) {
    // Same embed as fetchCardDetail's rows: checklist: { card_id }.
    const cardId = (i.checklist as { card_id?: string } | null)?.card_id ?? checklistCard.get(i.checklist_id);
    if (cardId) out.get(cardId)?.items.push({ ...i, checklist: { card_id: cardId } } as ChecklistItem);
  }
  for (const a of strip(attachments)) out.get(a.card_id)?.attachments.push(a);
  for (const r of strip(reactions)) {
    const { card_id, ...row } = r;
    out.get(card_id)?.reactions.push(row as CommentReaction);
  }
  return out;
}

export async function updateComment(id: string, body: string) {
  const { error } = await supabase
    .from("comment")
    .update({ body, edited_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// Deleting a root comment also removes its thread (replies cascade).
export async function deleteComment(id: string) {
  const { error } = await supabase.from("comment").delete().eq("id", id);
  if (error) throw error;
}

export async function setReaction(commentId: string, emoji: string, on: boolean) {
  const { data: u } = await sessionUser();
  if (!u.user) throw new Error("Not signed in");
  if (on) {
    const { error } = await supabase
      .from("comment_reaction")
      .insert({ comment_id: commentId, user_id: u.user.id, emoji });
    if (error && error.code !== "23505") throw error; // already reacted → fine
  } else {
    const { error } = await supabase
      .from("comment_reaction")
      .delete()
      .eq("comment_id", commentId)
      .eq("user_id", u.user.id)
      .eq("emoji", emoji);
    if (error) throw error;
  }
}

// parentId null → a root comment (new discussion). parentId set → a reply that
// lands in that root's thread. The caller only ever passes a root id as parent
// (replies never nest under replies), keeping threads two levels deep.
export async function addComment(cardId: string, body: string, parentId: string | null = null, id?: string) {
  const { data: u } = await sessionUser();
  if (!u.user) throw new Error("Not signed in");
  const { error } = await supabase
    .from("comment")
    .insert({ ...(id ? { id } : {}), card_id: cardId, author_id: u.user.id, body, parent_id: parentId });
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
