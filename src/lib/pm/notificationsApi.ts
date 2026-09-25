import { supabase, sessionUser } from "@/lib/supabase";
import type { Notification } from "@/lib/database.types";

export interface NotificationRow extends Notification {
  board_title: string | null;
  card_title: string | null;
}

export async function listNotifications(limit = 50): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from("notification")
    .select("*, board:board_id(title), card:card_id(title)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as (Notification & {
    board: { title: string } | null;
    card: { title: string } | null;
  })[]).map((n) => ({
    ...n,
    board_title: n.board?.title ?? null,
    card_title: n.card?.title ?? null,
  }));
}

export async function unreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from("notification")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  if (error) throw error;
  return count ?? 0;
}

export async function markRead(ids: string[]) {
  if (!ids.length) return;
  const { error } = await supabase
    .from("notification")
    .update({ read_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}

export async function markAllRead() {
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
