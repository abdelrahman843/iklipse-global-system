import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// WhatsApp (Green API) and email (Gmail through n8n). The secrets live in
// Vault and never come back to the browser: integration_status() only says
// what is connected. See migration 0037.
// -----------------------------------------------------------------------------

export interface IntegrationStatus {
  whatsapp: { configured: boolean; instance: string | null; url: string | null };
  email: { configured: boolean };
  /** The list "email to card" drops cards into (null = off). */
  inbox: { list_id: string | null; list_title: string | null; board_title: string | null };
  /** WhatsApp and email together, for the whole workspace. */
  sent_last_hour: number;
}

/** A person's WhatsApp number and email (the person and admins can read it). */
export interface ProfileContact {
  user_id: string;
  whatsapp: string | null;
  email: string | null;
  notify_whatsapp: boolean;
  notify_email: boolean;
}

/** Messages per hour for the workspace, enforced by the database. */
export const SEND_LIMIT_PER_HOUR = 300;
// Same checks as the profile_contact table.
export const WHATSAPP_RE = /^[1-9][0-9]{7,14}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const EMAIL_TAKEN = "That email is already used by another member.";

/** International digits, no +: "+20 100-123 4567", "0020..." and "01001234567" all become "201001234567". */
export function normalizeWhatsapp(v: string): string {
  let d = v.replace(/[\s+-]/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  // Egyptian mobile typed the local way.
  if (/^0[0-9]{10}$/.test(d)) d = `2${d}`;
  return d;
}

export async function fetchIntegrationStatus(): Promise<IntegrationStatus> {
  const { data, error } = await supabase.rpc("integration_status");
  if (error) throw error;
  return data as IntegrationStatus;
}

/** All three empty removes the connection. */
export async function setGreenApi(url: string, instance: string, token: string) {
  const { error } = await supabase.rpc("admin_set_greenapi", { p_url: url, p_instance: instance, p_token: token });
  if (error) throw error;
}

/** Sends a message to the admin's own number; false = not sent (not connected or over the limit). */
export async function testWhatsapp(): Promise<boolean> {
  const { data, error } = await supabase.rpc("admin_test_whatsapp");
  if (error) throw error;
  return data as boolean;
}

export async function testEmail(): Promise<boolean> {
  const { data, error } = await supabase.rpc("admin_test_email");
  if (error) throw error;
  return data as boolean;
}

export async function setEmailInbox(listId: string | null) {
  const { error } = await supabase.rpc("admin_set_email_inbox", { p_list: listId });
  if (error) throw error;
}

/** Every open list on an open board, as "Board / List". */
export async function inboxTargets(): Promise<{ value: string; label: string }[]> {
  const { data, error } = await supabase
    .from("list")
    .select("id, title, position, board:board_id(title, is_archived)")
    .eq("is_archived", false)
    .order("position");
  if (error) throw error;
  type Row = { id: string; title: string; board: { title: string; is_archived: boolean } | { title: string; is_archived: boolean }[] | null };
  return ((data ?? []) as unknown as Row[])
    .map((l) => ({ l, b: Array.isArray(l.board) ? l.board[0] : l.board }))
    .filter(({ b }) => b && !b.is_archived)
    .map(({ l, b }) => ({ value: l.id, label: `${b!.title} / ${l.title}` }))
    .sort((x, y) => x.label.localeCompare(y.label));
}

export async function fetchContact(userId: string): Promise<ProfileContact | null> {
  const { data, error } = await supabase
    .from("profile_contact")
    .select("user_id, whatsapp, email, notify_whatsapp, notify_email")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as ProfileContact | null) ?? null;
}

/** Case-insensitive, like the unique index. */
export async function emailInUse(email: string, exceptUserId?: string): Promise<boolean> {
  const { data, error } = await supabase.from("profile_contact").select("user_id, email").not("email", "is", null);
  if (error) throw error;
  const e = email.toLowerCase();
  return ((data ?? []) as Pick<ProfileContact, "user_id" | "email">[]).some(
    (r) => r.user_id !== exceptUserId && r.email?.toLowerCase() === e,
  );
}

export async function saveContact(c: ProfileContact) {
  const { error } = await supabase
    .from("profile_contact")
    .upsert({ ...c, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error?.code === "23505") throw new Error(EMAIL_TAKEN);
  if (error) throw error;
}
