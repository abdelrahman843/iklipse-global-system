import { supabase } from "@/lib/supabase";
import type { Entry, Fields } from "../../supabase/functions/whatsapp-bot/directory-lists";

export { nameLike, rowsOf, tableOf, toCsv } from "../../supabase/functions/whatsapp-bot/directory-lists";
export type { Entry, Fields, ListRows } from "../../supabase/functions/whatsapp-bot/directory-lists";

// -----------------------------------------------------------------------------
// The directory (0144): everyone iklipse deals with, one record each. Anyone on
// the team reads; admins also see notes, access, where someone is and the
// history, and change records. The rules are in the database, shared with the
// bot, so what's refused here is refused on WhatsApp too.
// -----------------------------------------------------------------------------

export interface Match {
  ref: string;
  kind: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  why: string;
}

export interface Places {
  projects: string[];
  clients: string[];
  groups: string[];
  slack: string[];
}

export interface HistoryRow {
  at: string;
  action: string;
  actor_name: string | null;
  via: string;
  label: string | null;
  changes: Record<string, unknown> | null;
}

export type Saved = { status: "added" | "saved"; ref: string; record: Entry } | { status: "duplicates"; matches: Match[] };

async function read<T>(what: string, p: Record<string, unknown> = {}) {
  const { data, error } = await supabase.rpc("directory_read", { p_what: what, p });
  if (error) throw new Error(error.message);
  return data as T;
}

async function act<T>(op: string, p: Record<string, unknown>) {
  const { data, error } = await supabase.rpc("directory_do", { p_op: op, p });
  if (error) throw new Error(error.message);
  return data as T;
}

export const fetchDirectory = () => read<Entry[]>("list");
export const fetchPlaces = (ref: string) => read<Places>("places", { ref });
export const fetchHistory = (ref: string) => read<HistoryRow[]>("history", { ref });
export const fetchDupes = (f: Fields) => read<Match[]>("dupes", { name: f.name, email: f.email, phone: f.phone });

export const saveRecord = (ref: string | null, fields: Fields, force = false) => act<Saved>("save", { ...(ref ? { ref } : {}), fields, force });
export const archiveRecord = (ref: string, archived: boolean) => act("archive", { ref, archived });
export const deleteRecord = (ref: string) => act("delete", { ref });
export const mergeRecords = (keep: string, drop: string) => act("merge", { keep, drop });

export const KINDS: { value: string; label: string }[] = [
  { value: "staff", label: "Team" },
  { value: "client", label: "Clients" },
  { value: "freelancer", label: "Freelancers" },
  { value: "partner", label: "Partners" },
  { value: "vendor", label: "Vendors" },
  { value: "contact", label: "Contacts" },
];

export const kindLabel = (k: string) => (KINDS.find((x) => x.value === k)?.label ?? k).replace(/s$/, "").replace(/^Team$/, "Team member");
