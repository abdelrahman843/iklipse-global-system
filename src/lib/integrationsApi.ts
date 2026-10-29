import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Each person's WhatsApp number and email, for notifications (migration 0037).
// -----------------------------------------------------------------------------

/** A person's WhatsApp number and email (the person and admins can read it). */
export interface ProfileContact {
  user_id: string;
  whatsapp: string | null;
  email: string | null;
  notify_whatsapp: boolean;
  notify_email: boolean;
}

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

/** Everyone's WhatsApp numbers and email, for admins (0086; role since 0132). */
export interface TeamContact {
  user_id: string;
  name: string;
  username: string;
  avatar_url: string | null;
  active: boolean;
  role?: "admin" | "member" | "guest";
  whatsapp: string | null;
  email: string | null;
  notify_whatsapp: boolean;
  notify_email: boolean;
  /** Numbers linked to them in Alerts > Groups. */
  linked: string[];
}

export async function fetchTeamContacts(): Promise<TeamContact[]> {
  const { data, error } = await supabase.rpc("team_contacts");
  if (error) throw error;
  return (data ?? []) as TeamContact[];
}

/** A number the bot can write to them on: one linked to them, or the one on their card. */
export const hasNumber = (c: TeamContact) => !!c.whatsapp || c.linked.length > 0;
