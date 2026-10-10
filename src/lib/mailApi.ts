import { callFunction } from "@/lib/connectionsApi";

// The Mail page's calls (edge function gmail). Conversations (Gmail threads)
// from one connected account or all of them, newest first.

export type MailFolder = "inbox" | "sent" | "starred" | "all";

export interface MailThread {
  account: string;
  accountEmail: string;
  id: string;
  subject: string;
  /** Senders (or, in Sent, recipients) in the conversation. */
  people: string[];
  snippet: string;
  date: number;
  count: number;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
}

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: number;
  snippet: string;
  unread: boolean;
  labels: string[];
  messageId: string;
  references: string;
  text: string | null;
  html: string | null;
  attachments: { id: string; name: string; mime: string; size: number }[];
}

export interface MailThreadFull {
  id: string;
  account: string;
  accountEmail: string;
  messages: MailMessage[];
}

export interface MailPage {
  threads: MailThread[];
  /** Next page per account (null = no more). */
  next: Record<string, string | null>;
  errors: Record<string, string>;
}

export function listMail(p: { accounts?: string[]; folder: MailFolder; q?: string; pages?: Record<string, string | null> }): Promise<MailPage> {
  return callFunction<MailPage>("gmail", { action: "list", ...p });
}

export async function mailSummary(): Promise<{ id: string; email: string; unread: number; error?: string }[]> {
  const r = await callFunction<{ accounts: { id: string; email: string; unread: number; error?: string }[] }>("gmail", { action: "summary" });
  return r.accounts;
}

export async function getThread(account: string, id: string): Promise<MailThreadFull> {
  const r = await callFunction<{ thread: MailThreadFull }>("gmail", { action: "thread", account, id });
  return r.thread;
}

export interface Outgoing {
  account: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

export function sendMail(m: Outgoing): Promise<{ id: string; threadId: string }> {
  return callFunction("gmail", { action: "send", ...m });
}

/** Labels on whole conversations: UNREAD, INBOX (archive = remove), STARRED. */
export async function modifyThreads(account: string, ids: string[], add: string[], remove: string[]) {
  await callFunction("gmail", { action: "modify", account, ids, add, remove });
}

export async function trashThreads(account: string, ids: string[]) {
  await callFunction("gmail", { action: "trash", account, ids });
}

/** Download one attachment as a file. */
export async function downloadAttachment(account: string, message: string, a: { id: string; name: string; mime: string }) {
  const r = await callFunction<{ data: string }>("gmail", { action: "attachment", account, message, id: a.id });
  const b64 = r.data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: a.mime || "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = a.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** "Jane Doe <jane@x.com>" -> "Jane Doe"; a bare address stays as is. */
export function displayName(addr: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(addr);
  return (m?.[1]?.trim() || m?.[2] || addr).trim();
}

/** The address part of "Name <a@b.c>". */
export function addressOf(addr: string): string {
  return (/<([^>]+)>/.exec(addr)?.[1] ?? addr).trim();
}
