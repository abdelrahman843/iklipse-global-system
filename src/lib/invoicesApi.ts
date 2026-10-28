import { supabase } from "@/lib/supabase";
import { callFunction } from "@/lib/connectionsApi";
import { zip } from "@/lib/zip";

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
  /** needs_file: it came as a link; waits for someone to download and upload it. */
  status: "done" | "needs_file" | "skipped" | "failed";
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
  /** Where the email says the invoice can be downloaded (needs_file). */
  download_url: string | null;
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

/** Every invoice still waiting for its file (any month), newest first. */
export async function fetchInvoicesNeedingFiles(): Promise<Invoice[]> {
  const { data, error } = await supabase.rpc("invoices_needing_files");
  if (error) throw error;
  return (data ?? []) as Invoice[];
}

/** The downloaded file of an invoice that came as a link: read and filed like the rest. */
export function uploadInvoiceFile(id: string, file: File) {
  return callFunction<{ ok: true; month: string }>("invoices/upload", file, {
    "Content-Type": file.type || "application/octet-stream",
    "X-Iklipse-Meta": encodeURIComponent(JSON.stringify({ id, name: file.name })),
  });
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
  return callFunction<{ done: number; waiting: number; skipped: number; failed: number; stop: string | null }>("invoices", { action: "run" });
}

/** The month as a Google Sheet in that Drive's month folder: its link. */
/** The month as an Excel file (.xlsx) to download; link: its copy in Drive (none when no Drive is picked). */
export async function exportInvoices(month: string, account?: string): Promise<{ name: string; blob: Blob; link: string | null }> {
  const r = await callFunction<{ name: string; file: string; link: string | null }>("invoices", { action: "export", month, account });
  const bytes = Uint8Array.from(atob(r.file), (c) => c.charCodeAt(0));
  return { name: r.name, link: r.link, blob: new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The month's folder in Drive: "2026-07" -> "invoices-Jul-2026". */
export const monthFolder = (month: string) => `invoices-${MONTHS[Number(month.slice(5, 7)) - 1]}-${month.slice(0, 4)}`;

/**
 * The filed invoices' files (a month, or every month with month null) in one
 * zip, with the folders and names they have in Drive (invoices-Jul-2026,
 * its refunds folder). A few files at a time; one that can't be fetched is
 * counted, the rest still come.
 */
export async function downloadInvoiceFiles(
  month: string | null,
  onProgress?: (done: number, total: number) => void,
): Promise<{ name: string; blob: Blob; count: number; failed: number }> {
  const { files } = await callFunction<{ files: { path: string; invoice: string; id: string }[] }>("invoices", { action: "files", ...(month ? { month } : {}) });
  if (!files.length) throw new Error(month ? `No invoice files in ${monthLabel(month)}` : "No invoice files yet");
  const got: { name: string; data: Uint8Array }[] = [];
  const queue = [...files];
  let done = 0;
  onProgress?.(0, files.length);
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          const blob = await callFunction<Blob>("invoices", { action: "file", invoice: f.invoice, id: f.id });
          got.push({ name: f.path, data: new Uint8Array(await blob.arrayBuffer()) });
        } catch {
          // Counted below; the others still come.
        }
        onProgress?.(++done, files.length);
      }
    }),
  );
  if (!got.length) throw new Error("Couldn't get the files from Drive. Try again.");
  got.sort((a, b) => a.name.localeCompare(b.name));
  return { name: month ? `${monthFolder(month)}.zip` : "invoices.zip", blob: zip(got), count: got.length, failed: files.length - got.length };
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
