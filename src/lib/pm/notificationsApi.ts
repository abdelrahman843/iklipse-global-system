import { supabase, sessionUser } from "@/lib/supabase";
import type { Notification } from "@/lib/database.types";

/** Trello (kanban boards) or Miro (whiteboards): every notification belongs to one. */
export type NotificationProduct = "kanban" | "whiteboard";

export interface NotificationRow extends Notification {
  board_title: string | null;
  card_title: string | null;
  product: NotificationProduct;
}

const productOf = (kind: string, boardKind: string | null | undefined): NotificationProduct =>
  boardKind === "whiteboard" || (!boardKind && kind.startsWith("wb_")) ? "whiteboard" : "kanban";

export async function listNotifications(limit = 50, product?: NotificationProduct): Promise<NotificationRow[]> {
  let q = supabase
    .from("notification")
    .select(product ? "*, board:board_id!inner(title, kind), card:card_id(title)" : "*, board:board_id(title, kind), card:card_id(title)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (product) q = q.eq("board.kind", product);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown as (Notification & {
    board: { title: string; kind: string } | null;
    card: { title: string } | null;
  })[]).map((n) => ({
    ...n,
    board_title: n.board?.title ?? null,
    card_title: n.card?.title ?? null,
    product: productOf(n.kind, n.board?.kind),
  }));
}

/** Unread notifications per product (and in all). */
export async function unreadCounts(): Promise<{ all: number; kanban: number; whiteboard: number }> {
  const { data, error } = await supabase
    .from("notification")
    .select("id, kind, board:board_id(kind)")
    .is("read_at", null)
    .limit(1000);
  if (error) throw error;
  const out = { all: 0, kanban: 0, whiteboard: 0 };
  for (const n of (data ?? []) as unknown as { kind: string; board: { kind: string } | null }[]) {
    out.all++;
    out[productOf(n.kind, n.board?.kind)]++;
  }
  return out;
}

export async function markRead(ids: string[]) {
  if (!ids.length) return;
  const { error } = await supabase
    .from("notification")
    .update({ read_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}

/** Mark everything read, or only Trello's / Miro's. */
export async function markAllRead(product?: NotificationProduct) {
  if (product) {
    const rows = await listNotifications(1000, product);
    await markRead(rows.filter((n) => !n.read_at).map((n) => n.id));
    return;
  }
  const { error } = await supabase
    .from("notification")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  if (error) throw error;
}

export async function setSubscription(
  entity_type: "board" | "list" | "card",
  entity_id: string,
  watch: boolean,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("set_subscription", {
    p_entity_type: entity_type,
    p_entity_id: entity_id,
    p_watch: watch,
  });
  if (error) throw error;
  return Boolean(data);
}

export async function isWatching(
  entity_type: "board" | "list" | "card",
  entity_id: string,
): Promise<boolean> {
  const { data: u } = await sessionUser();
  if (!u.user) return false;
  const { data, error } = await supabase
    .from("subscription")
    .select("user_id")
    .eq("user_id", u.user.id)
    .eq("entity_type", entity_type)
    .eq("entity_id", entity_id)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}
