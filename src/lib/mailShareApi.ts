import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Sharing a connected Gmail account with people in iklipse (0053). The owner
// picks what each person may do; the gmail edge function checks it on every
// call. Accounts shared with me show on Shared mail, apart from my own.
// -----------------------------------------------------------------------------

export type ShareAccess = "full" | "read_send" | "read" | "send" | "custom";

export const ACCESS: { value: ShareAccess; label: string; hint: string }[] = [
  { value: "full", label: "Full access", hint: "Same as you: read, send, archive, star and delete." },
  { value: "read_send", label: "Read and send", hint: "Reads the whole mailbox and sends from this address." },
  { value: "read", label: "Read only", hint: "Reads the whole mailbox. Can't send or change anything." },
  { value: "send", label: "Send only", hint: "Writes new emails from this address. Can't read the mailbox." },
  { value: "custom", label: "Only some emails", hint: "Only the emails you pick, and everything from the senders you list." },
];

export const accessLabel = (a: ShareAccess) => ACCESS.find((x) => x.value === a)?.label ?? a;

export interface Caps {
  /** Reads the whole mailbox (else only picked emails and listed senders). */
  readAll: boolean;
  /** any: new mail and replies; reply: replies to what they can read. */
  send: "any" | "reply" | "none";
  /** Archive, star, mark read / unread, delete. */
  manage: boolean;
}

export const OWNER_CAPS: Caps = { readAll: true, send: "any", manage: true };

export function capsOf(access: ShareAccess, canReply: boolean): Caps {
  return {
    readAll: access === "full" || access === "read_send" || access === "read",
    send: access === "full" || access === "read_send" || access === "send" ? "any" : access === "custom" && canReply ? "reply" : "none",
    manage: access === "full",
  };
}

/** What someone can do, in a few words ("Read and send", "Only some emails, can reply"). */
export function capsText(access: ShareAccess, canReply: boolean): string {
  if (access === "custom") return canReply ? "Only some emails, can reply" : "Only some emails, read only";
  return accessLabel(access);
}

export interface SharedThread {
  thread_id: string;
  subject: string | null;
  shared_at: string;
}

export interface MyShare {
  id: string;
  grantee_id: string;
  name: string;
  username: string;
  avatar_url: string | null;
  access: ShareAccess;
  senders: string[];
  can_reply: boolean;
  created_at: string;
  threads: SharedThread[];
}

export interface ShareLogLine {
  action: string;
  detail: string | null;
  at: string;
  actor_id: string;
  actor_name: string;
}

export interface MyAccountShares {
  account_id: string;
  email: string;
  shares: MyShare[];
  log: ShareLogLine[];
}

export interface SharedWithMe {
  share_id: string;
  account_id: string;
  email: string;
  owner_id: string;
  owner_name: string;
  owner_avatar: string | null;
  access: ShareAccess;
  senders: string[];
  can_reply: boolean;
  threads: number;
  created_at: string;
}

/** My Gmail accounts: who has access, and what they did lately. */
export async function fetchMyShares(): Promise<MyAccountShares[]> {
  const { data, error } = await supabase.rpc("gmail_shares_mine");
  if (error) throw error;
  return (data ?? []) as MyAccountShares[];
}

/** Gmail accounts other people shared with me. */
export async function fetchSharedWithMe(): Promise<SharedWithMe[]> {
  const { data, error } = await supabase.rpc("gmail_shared_with_me");
  if (error) throw error;
  return (data ?? []) as SharedWithMe[];
}

export async function setShare(p: { account: string; grantee: string; access: ShareAccess; senders: string[]; canReply: boolean }) {
  const { error } = await supabase.rpc("gmail_share_set", {
    p_account: p.account,
    p_grantee: p.grantee,
    p_access: p.access,
    p_senders: p.senders,
    p_can_reply: p.canReply,
  });
  if (error) throw error;
}

/** The owner stops sharing, or the person gives the access back. */
export async function removeShare(id: string) {
  const { error } = await supabase.rpc("gmail_share_remove", { p_share: id });
  if (error) throw error;
}

/** Share one conversation. "already": they can read it anyway. */
export async function shareThread(p: { account: string; grantee: string; thread: string; subject: string }): Promise<"added" | "already"> {
  const { data, error } = await supabase.rpc("gmail_share_thread_add", {
    p_account: p.account,
    p_grantee: p.grantee,
    p_thread: p.thread,
    p_subject: p.subject,
  });
  if (error) throw error;
  return data as "added" | "already";
}

export async function unshareThread(share: string, thread: string) {
  const { error } = await supabase.rpc("gmail_share_thread_remove", { p_share: share, p_thread: thread });
  if (error) throw error;
}

/** "boss@client.com, client.org" -> ["boss@client.com", "@client.org"] (the server tidies them too). */
export function parseSenders(s: string): string[] {
  return [
    ...new Set(
      s
        .split(/[\s,;]+/)
        .map((x) => x.trim().toLowerCase())
        .filter((x) => /^[^@\s]*@?[^@\s]+\.[^@\s]+$/.test(x))
        .map((x) => (x.includes("@") ? x : `@${x}`)),
    ),
  ];
}
