import { supabase } from "@/lib/supabase";
import { callFunction } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// Invoices (admins only, migration 0056 + the invoices function): invoice and
// refund emails read from the Gmail accounts admins picked, their files filed
// in Drive by month, one row per email.
// -----------------------------------------------------------------------------

export interface InvoiceFile {
  account: string;
  email: string;
  id: string;
  name: string;
  link: string | null;
}

export interface Invoice {
  id: string;
  mailbox: string;
  message_id: string;
  thread_id: string | null;
  status: "done" | "skipped" | "failed";
  error: string | null;
  sender_name: string | null;
  sender_email: string | null;
  subject: string | null;
  received_at: string | null;
  is_refund: boolean;
  provider: string | null;
  invoice_number: string | null;
  description: string | null;
  purchaser_email: string | null;
  invoice_date: string | null;
  amount: number | null;
  currency: string | null;
  month: string | null;
  files: InvoiceFile[];
}

export interface InvoiceSource {
  account_id: string;
  email: string;
  owner: string | null;
  mine: boolean;
  added_at: string;
  last_run_at: string | null;
  last_error: string | null;
}

export interface InvoiceTarget {
  account_id: string;
  email: string;
  owner: string | null;
  mine: boolean;
  parent_id: string | null;
  parent_name: string | null;
  added_at: string;
  last_error: string | null;
}

export interface InvoicesOverview {
  settings: { enabled: boolean; start_date: string; updated_at: string; updated_by: string | null };
  sources: InvoiceSource[];
  targets: InvoiceTarget[];
  my_gmail: { id: string; email: string }[];
  my_drive: { id: string; email: string }[];
  pending: number;
}

export async function fetchInvoicesOverview(): Promise<InvoicesOverview> {
  const { data, error } = await supabase.rpc("invoices_overview");
  if (error) throw error;
  return data as InvoicesOverview;
}

/** month: "2026-07" */
export async function fetchInvoicesMonth(month: string): Promise<Invoice[]> {
  const { data, error } = await supabase.rpc("invoices_month", { p_month: `${month}-01` });
  if (error) throw error;
  return (data ?? []) as Invoice[];
}

export async function saveInvoiceSettings(enabled: boolean, start: string) {
  const { error } = await supabase.rpc("invoices_settings_set", { p_enabled: enabled, p_start: start });
  if (error) throw error;
}

export async function addInvoiceSource(account: string) {
  const { error } = await supabase.rpc("invoices_source_add", { p_account: account });
  if (error) throw error;
}

export async function removeInvoiceSource(account: string) {
  const { error } = await supabase.rpc("invoices_source_remove", { p_account: account });
  if (error) throw error;
}

/** folder: a Google Drive folder link (or empty for the top of the Drive). */
export async function addInvoiceTarget(account: string, folder: string) {
  await callFunction("invoices", { action: "target", account, folder });
}

export async function removeInvoiceTarget(account: string) {
  const { error } = await supabase.rpc("invoices_target_remove", { p_account: account });
  if (error) throw error;
}

export async function rereadInvoice(id: string) {
  const { error } = await supabase.rpc("invoices_reread", { p_id: id });
  if (error) throw error;
}

export async function dismissInvoice(id: string) {
  const { error } = await supabase.rpc("invoices_dismiss", { p_id: id });
  if (error) throw error;
}

export function runInvoices() {
  return callFunction<{ done: number; skipped: number; failed: number; stop: string | null }>("invoices", { action: "run" });
}

/** The month as a Google Sheet in that Drive's month folder: its link. */
export async function exportInvoices(month: string, account?: string): Promise<string> {
  const { link } = await callFunction<{ link: string }>("invoices", { action: "export", month, account });
  return link;
}

// ------------------------------------------------------------------ helpers --

const TZ = "Africa/Cairo";

/** This month in Cairo, "2026-07". */
export function thisMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function money(amount: number | null, currency: string | null): string {
  if (amount === null) return "No amount";
  const n = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${n} ${currency}` : n;
}

/** Totals per currency, biggest first. */
export function totals(rows: Invoice[]): { currency: string; amount: number }[] {
  const by = new Map<string, number>();
  for (const r of rows) if (r.amount !== null) by.set(r.currency ?? "", (by.get(r.currency ?? "") ?? 0) + r.amount);
  return [...by].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);
}

export const gmailLink = (r: Invoice) => `https://mail.google.com/mail/u/${encodeURIComponent(r.mailbox)}/#all/${r.message_id}`;

/** The month as a CSV file (the same columns as the Google Sheet). */
export function invoicesCsv(rows: Invoice[]): string {
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ["Type", "Provider", "Invoice number", "Invoice date", "Amount", "Currency", "Bought by", "Came to (mailbox)", "From", "From address", "Subject", "Received", "What", "Drive files", "Email"];
  const lines = [head.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        cell(r.is_refund ? "Refund" : "Invoice"),
        cell(r.provider),
        cell(r.invoice_number),
        cell(r.invoice_date),
        r.amount ?? "",
        cell(r.currency),
        cell(r.purchaser_email),
        cell(r.mailbox),
        cell(r.sender_name),
        cell(r.sender_email),
        cell(r.subject),
        cell(r.received_at?.slice(0, 10)),
        cell(r.description),
        cell(r.files.map((f) => f.link).filter(Boolean).join(" ")),
        cell(gmailLink(r)),
      ].join(","),
    );
  }
  return `﻿${lines.join("\r\n")}`;
}
