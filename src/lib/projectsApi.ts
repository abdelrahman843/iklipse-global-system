import { supabase, sessionUser } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Projects (migration 0058): clients and their projects. Admins see and change
// everything; people on a project's team see and change everything in it
// (0073) except the money and the invoices, and only admins make or delete
// projects. Files go in the private 'projects' bucket:
// <project>/files/... (the team) and <project>/invoices/... (admins).
// -----------------------------------------------------------------------------

export type ProjectStatus = "active" | "on_hold" | "delivered" | "cancelled";
export type ProjectPriority = "low" | "medium" | "high" | "urgent";

export const STATUSES: { value: ProjectStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On hold" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
];
export const PRIORITIES: { value: ProjectPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];
export const PRIORITY_RANK: Record<ProjectPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
export const statusLabel = (s: ProjectStatus) => STATUSES.find((x) => x.value === s)?.label ?? s;
export const priorityLabel = (p: ProjectPriority) => PRIORITIES.find((x) => x.value === p)?.label ?? p;

export interface ProjectMember {
  user_id: string;
  role: string | null;
  name: string;
  avatar_url: string | null;
}

export interface Client {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  /** In the overview: how many projects, how many still open. */
  projects?: number;
  open?: number;
}

export interface ProjectSummary {
  id: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  priority: ProjectPriority;
  start_on: string | null;
  due_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  client: { name: string; company: string | null } | null;
  members: ProjectMember[];
  deliveries_total: number;
  deliveries_done: number;
  next_due: { title: string; due_at: string } | null;
  files_count: number;
  // Admins only:
  client_id?: string | null;
  cost?: number | null;
  currency?: string;
  invoiced?: number;
  paid?: number;
}

export interface Delivery {
  id: string;
  title: string;
  due_at: string;
  done_at: string | null;
  assignee_id: string | null;
  assignee: string | null;
  assignee_avatar: string | null;
  done_by: string | null;
}

export interface ProjectNote {
  id: string;
  body: string;
  created_at: string;
  author_id: string | null;
  author: string | null;
  author_avatar: string | null;
}

export interface ProjectFile {
  id: string;
  name: string;
  mime_type: string | null;
  size: number | null;
  storage_path: string | null;
  external_url: string | null;
  delivered: boolean;
  delivery_id: string | null;
  delivery: string | null;
  uploaded_by: string | null;
  uploader: string | null;
  created_at: string;
}

export interface ProjectInvoice {
  id: string;
  project_id: string;
  number: string | null;
  amount: number;
  currency: string;
  issued_on: string | null;
  due_on: string | null;
  paid_on: string | null;
  note: string | null;
  storage_path: string | null;
  file_name: string | null;
  created_at: string;
}

export interface ProjectDetail extends Omit<ProjectSummary, "client"> {
  admin: boolean;
  client: (Partial<Client> & { name: string; company: string | null }) | null;
  deliveries: Delivery[];
  notes: ProjectNote[];
  files: ProjectFile[];
  invoices: ProjectInvoice[];
}

export interface Person {
  id: string;
  name: string;
  avatar_url: string | null;
  role: string;
}

export interface ProjectsOverview {
  admin: boolean;
  projects: ProjectSummary[];
  clients: Client[];
  people: Person[];
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function fetchProjectsOverview(): Promise<ProjectsOverview> {
  const { data, error } = await supabase.rpc("projects_overview");
  if (error) throw error;
  const d = data as ProjectsOverview;
  return {
    ...d,
    projects: d.projects.map((p) => ({ ...p, cost: num(p.cost), invoiced: num(p.invoiced) ?? 0, paid: num(p.paid) ?? 0 })),
  };
}

export async function fetchProjectsCount(): Promise<number> {
  const { data, error } = await supabase.rpc("projects_count");
  if (error) throw error;
  return Number(data ?? 0);
}

/** A delivery date coming up (or late): one of a project's deliveries, or its final date (delivery_id null). */
export interface UpcomingDelivery {
  project_id: string;
  project: string;
  client: string | null;
  priority: ProjectPriority;
  status: ProjectStatus;
  delivery_id: string | null;
  title: string;
  due_at: string;
  assignee: string | null;
  assignee_avatar: string | null;
}

/** What's due in the next `days` days and anything late, on the active projects I can see (0083). */
export async function fetchUpcomingDeliveries(days = 3): Promise<{ projects: number; items: UpcomingDelivery[] }> {
  const { data, error } = await supabase.rpc("home_deliveries", { p_days: days });
  if (error) throw error;
  const d = data as { projects: number; items: UpcomingDelivery[] };
  return { projects: Number(d.projects ?? 0), items: d.items ?? [] };
}

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const { data, error } = await supabase.rpc("project_get", { p_id: id });
  if (error) throw error;
  const d = data as ProjectDetail;
  return {
    ...d,
    cost: num(d.cost),
    invoiced: num(d.invoiced) ?? 0,
    paid: num(d.paid) ?? 0,
    invoices: d.invoices.map((i) => ({ ...i, amount: Number(i.amount) })),
  };
}

// ------------------------------------------------------------------ clients --
export interface ClientInput {
  name: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
}

export async function saveClient(id: string | null, c: ClientInput): Promise<string> {
  const { data, error } = await supabase.rpc("client_save", {
    p_id: id,
    p_name: c.name,
    p_company: c.company,
    p_email: c.email,
    p_phone: c.phone,
    p_notes: c.notes,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteClient(id: string) {
  const { error } = await supabase.rpc("client_delete", { p_id: id });
  if (error) throw error;
}

// ----------------------------------------------------------------- projects --
export interface ProjectInput {
  client_id: string | null;
  title: string;
  description: string;
  status: ProjectStatus;
  priority: ProjectPriority;
  start_on: string | null;
  due_at: string | null;
  cost: number | null;
  currency: string;
}

export async function saveProject(id: string | null, p: ProjectInput): Promise<string> {
  const { data, error } = await supabase.rpc("project_save", {
    p_id: id,
    p_client: p.client_id,
    p_title: p.title,
    p_description: p.description,
    p_status: p.status,
    p_priority: p.priority,
    p_start_on: p.start_on,
    p_due_at: p.due_at,
    p_cost: p.cost,
    p_currency: p.currency,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteProject(id: string) {
  const { data, error } = await supabase.rpc("project_delete", { p_id: id });
  if (error) throw error;
  const paths = (data as string[] | null) ?? [];
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
}

export async function setProjectMembers(id: string, members: { user_id: string; role: string | null }[]) {
  const { error } = await supabase.rpc("project_members_set", { p_id: id, p_members: members });
  if (error) throw error;
}

export async function saveDelivery(id: string | null, project: string, title: string, dueAt: string, assignee: string | null) {
  const { error } = await supabase.rpc("project_delivery_save", {
    p_id: id,
    p_project: project,
    p_title: title,
    p_due_at: dueAt,
    p_assignee: assignee,
  });
  if (error) throw error;
}

export async function deleteDelivery(id: string) {
  const { error } = await supabase.rpc("project_delivery_delete", { p_id: id });
  if (error) throw error;
}

export async function setDeliveryDone(id: string, done: boolean) {
  const { error } = await supabase.rpc("project_delivery_done", { p_id: id, p_done: done });
  if (error) throw error;
}

// -------------------------------------------------------------------- notes --
export async function addNote(project: string, body: string) {
  const { error } = await supabase.rpc("project_note_add", { p_project: project, p_body: body });
  if (error) throw error;
}

export async function deleteNote(id: string) {
  const { error } = await supabase.rpc("project_note_delete", { p_id: id });
  if (error) throw error;
}

// -------------------------------------------------------------------- files --
const BUCKET = "projects";
/** The bucket's own limit (Supabase's per-file cap): bigger files go as a link. */
export const MAX_FILE = 50 * 1024 * 1024;

const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file";

async function put(path: string, file: File) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: "3600",
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (error) throw error;
}

/** Upload files (each up to 50 MB) and add them in one go: the team hears once. */
export async function uploadProjectFiles(
  project: string,
  delivery: string | null,
  files: File[],
  onProgress?: (done: number) => void,
) {
  const { data: u } = await sessionUser();
  if (!u.user) throw new Error("Not signed in.");
  const big = files.find((f) => f.size > MAX_FILE);
  if (big) throw new Error(`${big.name} is over 50 MB. Upload it to Drive and add its link instead.`);
  const added: { name: string; mime_type: string | null; size: number; storage_path: string }[] = [];
  try {
    for (const f of files) {
      const path = `${project}/files/${crypto.randomUUID()}_${sanitize(f.name)}`;
      await put(path, f);
      added.push({ name: f.name, mime_type: f.type || null, size: f.size, storage_path: path });
      onProgress?.(added.length);
    }
    const { error } = await supabase.rpc("project_files_add", { p_project: project, p_delivery: delivery, p_files: added });
    if (error) throw error;
  } catch (e) {
    if (added.length) await supabase.storage.from(BUCKET).remove(added.map((a) => a.storage_path)).catch(() => {});
    throw e;
  }
}

export async function addProjectLink(project: string, delivery: string | null, url: string, name: string) {
  let href = url.trim();
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  const parsed = new URL(href);
  const { error } = await supabase.rpc("project_files_add", {
    p_project: project,
    p_delivery: delivery,
    p_files: [{ name: name.trim() || parsed.host.replace(/^www\./, "") + parsed.pathname.replace(/\/$/, ""), external_url: href }],
  });
  if (error) throw error;
}

export async function updateProjectFile(id: string, delivered: boolean, delivery: string | null) {
  const { error } = await supabase.rpc("project_file_update", { p_id: id, p_delivered: delivered, p_delivery: delivery });
  if (error) throw error;
}

export async function deleteProjectFile(id: string) {
  const { data, error } = await supabase.rpc("project_file_delete", { p_id: id });
  if (error) throw error;
  if (data) await supabase.storage.from(BUCKET).remove([data as string]).catch(() => {});
}

/** Short-lived links to stored files (to open, download or preview). */
export async function signedUrls(paths: string[], download = false): Promise<Record<string, string>> {
  if (!paths.length) return {};
  if (download && paths.length === 1) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(paths[0], 300, { download: true });
    if (error) throw error;
    return { [paths[0]]: data.signedUrl };
  }
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const r of data ?? []) if (r.path && r.signedUrl) out[r.path] = r.signedUrl;
  return out;
}

// ----------------------------------------------------------------- invoices --
export interface InvoiceInput {
  number: string;
  amount: number;
  currency: string;
  issued_on: string | null;
  due_on: string | null;
  paid_on: string | null;
  note: string;
}

/** Save an invoice; a new file replaces the old one. */
export async function saveProjectInvoice(project: string, current: ProjectInvoice | null, v: InvoiceInput, file: File | null) {
  let path = current?.storage_path ?? null;
  let fileName = current?.file_name ?? null;
  if (file) {
    if (file.size > MAX_FILE) throw new Error("The file is over 50 MB.");
    path = `${project}/invoices/${crypto.randomUUID()}_${sanitize(file.name)}`;
    fileName = file.name;
    await put(path, file);
  }
  const { error } = await supabase.rpc("project_invoice_save", {
    p_id: current?.id ?? null,
    p_project: project,
    p_number: v.number,
    p_amount: v.amount,
    p_currency: v.currency,
    p_issued_on: v.issued_on,
    p_due_on: v.due_on,
    p_paid_on: v.paid_on,
    p_note: v.note,
    p_path: path,
    p_file_name: fileName,
  });
  if (error) {
    if (file && path) await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    throw error;
  }
  if (file && current?.storage_path) await supabase.storage.from(BUCKET).remove([current.storage_path]).catch(() => {});
}

export async function deleteProjectInvoice(id: string) {
  const { data, error } = await supabase.rpc("project_invoice_delete", { p_id: id });
  if (error) throw error;
  if (data) await supabase.storage.from(BUCKET).remove([data as string]).catch(() => {});
}

// ------------------------------------------------------------------ helpers --
export function money(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return "No amount";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency ?? ""}`.trim();
  }
}

export type DueTone = "late" | "soon" | "later" | "done";

/** Late, within two days, or later (done when finished). */
export function dueTone(due: string | null, done: boolean): DueTone | null {
  if (done) return "done";
  if (!due) return null;
  const t = new Date(due).getTime();
  if (t <= Date.now()) return "late";
  if (t - Date.now() <= 2 * 24 * 3600 * 1000) return "soon";
  return "later";
}

export function dueText(due: string) {
  const d = new Date(due);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 2 days", "3 hours late"… */
export function dueIn(due: string) {
  const ms = new Date(due).getTime() - Date.now();
  const abs = Math.abs(ms);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  const span = abs < 3600000 ? "under an hour" : h < 36 ? `${h} ${h === 1 ? "hour" : "hours"}` : `${d} days`;
  return ms >= 0 ? `in ${span}` : `${span} late`;
}

/** <input type="datetime-local"> value from an ISO date, and back. */
export const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function fileSize(n: number | null) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function whatsappLink(phone: string) {
  const digits = phone.replace(/[^\d]/g, "");
  return `https://wa.me/${digits}`;
}

export function invoiceState(i: ProjectInvoice): "paid" | "late" | "unpaid" {
  if (i.paid_on) return "paid";
  if (i.due_on && new Date(`${i.due_on}T23:59:59`).getTime() < Date.now()) return "late";
  return "unpaid";
}
