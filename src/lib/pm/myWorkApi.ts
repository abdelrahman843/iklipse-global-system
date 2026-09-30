import { supabase } from "@/lib/supabase";

/** A card the caller is a member of, flattened with its board and list. */
export interface MyWorkCard {
  id: string;
  title: string;
  due_date: string | null;
  due_completed: boolean;
  board_id: string;
  board_title: string;
  list_id: string;
  list_title: string;
  /** The card sits in a "done" list (list.is_done). */
  done_by_list: boolean;
  labels: { id: string; name: string; color: string }[];
}

type One<T> = T | T[] | null;
// supabase-js sometimes types embedded 1:1 joins as arrays; take the row either way.
const one = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

interface Row {
  card: One<{
    id: string;
    title: string;
    due_date: string | null;
    due_completed: boolean;
    board_id: string;
    list_id: string;
    list: One<{ id: string; title: string; is_done: boolean; is_archived: boolean }>;
    board: One<{ id: string; title: string; is_archived: boolean }>;
    card_label: { label: One<{ id: string; name: string; color: string; position: string }> }[] | null;
  }>;
}

/** Every live card assigned to `userId`, across all boards. RLS limits the
 *  rows to boards the caller can see. Cards in an archived list or board
 *  are dropped, like the board itself hides them. */
export async function fetchMyWork(userId: string): Promise<MyWorkCard[]> {
  const { data, error } = await supabase
    .from("card_member")
    .select(
      "card:card!inner(id, title, due_date, due_completed, board_id, list_id, list:list_id(id, title, is_done, is_archived), board:board_id(id, title, is_archived), card_label(label:label_id(id, name, color, position)))",
    )
    .eq("user_id", userId)
    .eq("card.is_archived", false)
    .eq("card.is_template", false);
  if (error) throw error;

  const out: MyWorkCard[] = [];
  for (const r of (data ?? []) as unknown as Row[]) {
    const c = one(r.card);
    if (!c) continue;
    const list = one(c.list);
    const board = one(c.board);
    if (!list || !board || list.is_archived || board.is_archived) continue;
    out.push({
      id: c.id,
      title: c.title,
      due_date: c.due_date,
      due_completed: c.due_completed,
      board_id: board.id,
      board_title: board.title,
      list_id: list.id,
      list_title: list.title,
      done_by_list: list.is_done,
      labels: (c.card_label ?? [])
        .map((cl) => one(cl.label))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
        .map(({ id, name, color }) => ({ id, name, color })),
    });
  }
  return out;
}
