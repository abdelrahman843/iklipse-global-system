// drive — each person connects any number of Google Drive accounts (0054),
// with the same Google OAuth client as Gmail. Used for the Drive page (browse,
// open, download, upload, make folders, rename, star, delete) and for Drive
// accounts, files and folders shared with other people in iklipse.
//
// POST (login token) { action, ... }:
//   connect { returnTo }                               -> { url }
//   disconnect { account }                             -> { ok }
//   summary                                            -> { accounts: [{ id, email, used, limit }] }
//
// The rest also work on an account shared with the caller, within what the
// owner allowed (see Box below):
//   list { account, folder?, view?, q?, page? }        -> { files, next }
//        view: "folder" (default, folder "root" = the top), "recent", "starred"
//   download { account, id, as? }                      -> the file's bytes (as: "pdf" for a preview of a Google file)
//   mkdir { account, parent, name }                    -> { file }
//   rename { account, id, name }                       -> { file }
//   star { account, id, on }                           -> { ok }
//   trash { account, ids }                             -> { ok }   (Google's trash: the owner can restore it there)
//   deliver { account, folder, link }                  -> { added, skipped }  a Drive file, or a folder's files, into a delivery (0064)
// POST /drive/upload (login token), raw file body, header
//   X-Iklipse-Meta: encodeURIComponent(JSON { account, folder, name })  -> { file }
// GET  /drive/callback?code&state                      (Google sends the browser here)
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, optional DRIVE_REDIRECT_URI
// (default <project>/functions/v1/drive/callback, which must be an authorized
// redirect URI of the Google OAuth client). The Google Drive API must be
// switched on for the Google Cloud project. Deploy with --no-verify-jwt.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { backToApp, caller, cors, HttpError, json, readState, route, safeReturn, serviceClient, signState, SUPABASE_URL, toResponse } from "../_shared/oauth.ts";

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("DRIVE_REDIRECT_URI") ?? `${SUPABASE_URL}/functions/v1/drive/callback`;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const SCOPES = ["openid", "email", "profile", DRIVE_SCOPE];
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const MAX_ACCOUNTS = 10;
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const PAGE = 100;
const FIELDS = "id,name,mimeType,size,modifiedTime,starred,parents,webViewLink,owners(displayName),shortcutDetails(targetId,targetMimeType)";
const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

interface Account {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  access_token: string | null;
  refresh_token: string;
  token_expiry: string | null;
}

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

interface GFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  starred?: boolean;
  parents?: string[];
  webViewLink?: string;
  owners?: { displayName?: string }[];
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

// --------------------------------------------------------------- tokens --

async function tokenCall(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`google token: ${data.error ?? res.status}`);
  return data as GoogleTokens;
}

const expiry = (t: GoogleTokens) => new Date(Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000).toISOString();

/** A working access token for the account, refreshed if needed. */
async function token(db: SupabaseClient, a: Account, force = false): Promise<string> {
  if (!force && a.access_token && a.token_expiry && Date.parse(a.token_expiry) > Date.now() + 30_000) return a.access_token;
  let t: GoogleTokens;
  try {
    t = await tokenCall({ grant_type: "refresh_token", refresh_token: a.refresh_token });
  } catch (e) {
    // Access was removed (or, while the Google app is in Testing, the weekly expiry).
    if (/invalid_grant/.test((e as Error).message)) {
      await db.from("drive_account").delete().eq("id", a.id).eq("refresh_token", a.refresh_token);
      throw new HttpError(409, `${a.email} needs to be connected again`);
    }
    throw new HttpError(502, "Couldn't reach Google. Try again.");
  }
  const patch = {
    access_token: t.access_token,
    token_expiry: expiry(t),
    updated_at: new Date().toISOString(),
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
  };
  await db.from("drive_account").update(patch).eq("id", a.id).eq("refresh_token", a.refresh_token);
  Object.assign(a, patch);
  return t.access_token;
}

/** A Drive call for the account, as a raw response (retried once with a fresh token). */
async function raw(db: SupabaseClient, a: Account, url: string, init: RequestInit = {}): Promise<Response> {
  const go = async (tok: string) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tok}` } });
  let res = await go(await token(db, a));
  if (res.status === 401) res = await go(await token(db, a, true));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg: string = err?.error?.message ?? `status ${res.status}`;
    const reason: string = err?.error?.errors?.[0]?.reason ?? "";
    if (res.status === 403 && /insufficient/i.test(msg + reason)) throw new HttpError(409, `${a.email} needs to be connected again (Drive access wasn't allowed)`);
    if (reason === "accessNotConfigured" || /has not been used|is disabled/i.test(msg)) {
      throw new HttpError(503, "The Google Drive API isn't switched on for this Google Cloud project yet.");
    }
    if (reason === "exportSizeLimitExceeded") throw new HttpError(413, "Too big to export here. Open it in Google Drive.");
    if (res.status === 404) throw new HttpError(404, "That file isn't there any more");
    if (res.status === 403) throw new HttpError(403, `Google Drive: ${msg}`);
    throw new HttpError(502, `Google Drive: ${msg}`);
  }
  return res;
}

/** A Drive JSON call. */
async function drive<T>(db: SupabaseClient, a: Account, path: string, init: RequestInit = {}): Promise<T> {
  const res = await raw(db, a, `${API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  return (res.status === 204 ? {} : await res.json()) as T;
}

const enc = encodeURIComponent;
const ALL_DRIVES = "supportsAllDrives=true";
const meta = (db: SupabaseClient, a: Account, id: string) => drive<GFile>(db, a, `/files/${enc(id)}?fields=${enc(FIELDS)}&${ALL_DRIVES}`);

async function myAccount(db: SupabaseClient, userId: string, id: unknown): Promise<Account> {
  if (typeof id !== "string") throw new HttpError(400, "Pick an account");
  const { data } = await db.from("drive_account").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(404, "That Drive account isn't connected");
  return data as Account;
}

// --------------------------------------------------------------- sharing --
// An account is either mine or shared with me (0054, drive_share). A Box says
// what I may do with it; every action below checks it.

type Role = "owner" | "full" | "edit" | "read" | "custom";

interface Box {
  a: Account;
  role: Role;
  /** Opens the whole Drive (else only the picked files and what's in picked folders). */
  readAll: boolean;
  /** Upload, make folders, rename (custom: inside the picked folders). */
  write: boolean;
  /** Star and delete. */
  manage: boolean;
  /** The picked files and folders, newest share first. */
  picks: string[];
  picked: Set<string>;
}

interface ShareRow {
  id: string;
  access: Exclude<Role, "owner">;
  can_edit: boolean;
  account: Account;
  owner: { is_active: boolean } | null;
  items: { file_id: string; shared_at: string }[] | null;
}

function toBox(a: Account, role: Role, s?: ShareRow): Box {
  const picks = [...(s?.items ?? [])].sort((x, y) => y.shared_at.localeCompare(x.shared_at)).map((t) => t.file_id);
  return {
    a,
    role,
    readAll: role !== "custom",
    write: role === "owner" || role === "full" || role === "edit" || (role === "custom" && Boolean(s?.can_edit)),
    manage: role === "owner" || role === "full",
    picks,
    picked: new Set(picks),
  };
}

const SHARE_SELECT = "id, access, can_edit, account:account_id(*), owner:owner_id(is_active), items:drive_share_item(file_id, shared_at)";

/** Mine, or shared with me: what I may do with this account. */
async function box(db: SupabaseClient, userId: string, id: unknown): Promise<Box> {
  if (typeof id !== "string") throw new HttpError(400, "Pick an account");
  const { data: own } = await db.from("drive_account").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (own) return toBox(own as Account, "owner");
  const { data } = await db.from("drive_share").select(SHARE_SELECT).eq("account_id", id).eq("grantee_id", userId).maybeSingle();
  const s = data as unknown as ShareRow | null;
  if (!s?.account || !s.owner?.is_active) throw new HttpError(404, "That Drive isn't shared with you (any more)");
  return toBox(s.account, s.access, s);
}

/**
 * May I open this file or folder? Whole Drive: yes. Otherwise it must be one
 * of the picked ones or sit somewhere inside a picked folder (walked up
 * through its parents). A shortcut inside a picked folder doesn't open what it
 * points to unless that is shared too.
 */
async function canReach(db: SupabaseClient, bx: Box, id: string): Promise<boolean> {
  if (bx.readAll) return true;
  if (!bx.picks.length || id === "root") return false;
  const seen = new Set<string>();
  let level = [id];
  for (let depth = 0; depth < 30 && level.length; depth++) {
    if (level.some((x) => bx.picked.has(x))) return true;
    const next: string[] = [];
    for (const x of level.slice(0, 5)) {
      if (seen.has(x)) continue;
      seen.add(x);
      const f = await drive<{ parents?: string[] }>(db, bx.a, `/files/${enc(x)}?fields=parents&${ALL_DRIVES}`).catch(() => null);
      next.push(...(f?.parents ?? []));
    }
    level = next;
  }
  return false;
}

async function mustReach(db: SupabaseClient, bx: Box, id: string) {
  if (!(await canReach(db, bx, id))) throw new HttpError(403, "This isn't shared with you");
}

/** What others do in a Drive shared with them, for the owner to see. */
async function logShared(db: SupabaseClient, bx: Box, actor: string, action: string, detail?: string) {
  if (bx.role === "owner") return;
  await db.from("drive_share_log").insert({ account_id: bx.a.id, actor_id: actor, action, detail: detail ? detail.slice(0, 300) : null });
}

// ---------------------------------------------------------------- files --

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const fileId = (v: unknown, what = "Pick a file") => {
  if (typeof v !== "string" || !ID.test(v)) throw new HttpError(400, what);
  return v;
};
const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim();
function cleanName(v: unknown) {
  const n = oneLine(v).slice(0, 255);
  if (!n) throw new HttpError(400, "Give it a name");
  return n;
}
/** A value inside a Drive query string ('...'). */
const quoteQ = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** One file as the app sees it. */
function out(f: GFile) {
  const shortcut = f.mimeType === SHORTCUT && f.shortcutDetails?.targetId ? f.shortcutDetails : null;
  const mime = shortcut?.targetMimeType ?? f.mimeType;
  return {
    // A shortcut opens what it points to; renaming, starring or deleting it acts on the shortcut (ref).
    id: shortcut?.targetId ?? f.id,
    ref: f.id,
    name: f.name,
    mime,
    folder: mime === FOLDER,
    size: f.size ? Number(f.size) : null,
    modified: f.modifiedTime ?? null,
    starred: Boolean(f.starred),
    owner: f.owners?.[0]?.displayName ?? null,
    link: f.webViewLink ?? null,
    shortcut: Boolean(shortcut),
  };
}

async function listQuery(db: SupabaseClient, a: Account, q: string, orderBy: string, page: string | undefined) {
  const params = new URLSearchParams({
    q,
    orderBy,
    pageSize: String(PAGE),
    fields: `nextPageToken,files(${FIELDS})`,
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (page) params.set("pageToken", page);
  const r = await drive<{ files?: GFile[]; nextPageToken?: string }>(db, a, `/files?${params}`);
  return { files: (r.files ?? []).map(out), next: r.nextPageToken ?? null };
}

async function list(db: SupabaseClient, bx: Box, b: Record<string, unknown>) {
  const view = b.view === "recent" || b.view === "starred" ? b.view : "folder";
  const folder = b.folder == null || b.folder === "root" ? "root" : fileId(b.folder, "Pick a folder");
  const q = typeof b.q === "string" ? oneLine(b.q).slice(0, 200) : "";
  const page = typeof b.page === "string" && b.page ? b.page.slice(0, 2000) : undefined;
  const named = q ? ` and name contains '${quoteQ(q)}'` : "";

  if (!bx.readAll) {
    // Only some files: the top is the picked ones, folders open below that.
    if (folder === "root") {
      const files = (await Promise.all(bx.picks.slice(0, 200).map((id) => meta(db, bx.a, id).then(out).catch(() => null)))).filter(
        (f): f is ReturnType<typeof out> => f !== null && (!q || f.name.toLowerCase().includes(q.toLowerCase())),
      );
      return { files, next: null };
    }
    await mustReach(db, bx, folder);
    return listQuery(db, bx.a, `'${folder}' in parents and trashed=false${named}`, "folder,name", page);
  }

  if (view === "recent") return listQuery(db, bx.a, `trashed=false and mimeType != '${FOLDER}'${named}`, "modifiedTime desc", page);
  if (view === "starred") return listQuery(db, bx.a, `starred=true and trashed=false${named}`, "folder,name", page);
  // Searching from the top looks through the whole Drive.
  if (q && folder === "root") return listQuery(db, bx.a, `trashed=false${named}`, "folder,modifiedTime desc", page);
  return listQuery(db, bx.a, `'${folder}' in parents and trashed=false${named}`, "folder,name", page);
}

// Google's own files can't be downloaded as they are: they're exported.
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};

async function download(db: SupabaseClient, bx: Box, b: Record<string, unknown>): Promise<Response> {
  const id = fileId(b.id);
  await mustReach(db, bx, id);
  const f = await meta(db, bx.a, id);
  if (f.mimeType === FOLDER) throw new HttpError(400, "Folders can't be downloaded");
  let res: Response;
  if (f.mimeType.startsWith("application/vnd.google-apps.")) {
    const to = b.as === "pdf" ? { mime: "application/pdf", ext: "pdf" } : EXPORTS[f.mimeType];
    if (!to) throw new HttpError(415, "This kind of Google file only opens in Google Drive");
    res = await raw(db, bx.a, `${API}/files/${enc(id)}/export?mimeType=${enc(to.mime)}`);
  } else {
    if (Number(f.size ?? 0) > MAX_DOWNLOAD) throw new HttpError(413, "Too big to open here (over 100 MB). Open it in Google Drive.");
    res = await raw(db, bx.a, `${API}/files/${enc(id)}?alt=media&${ALL_DRIVES}`);
  }
  // Always octet-stream: the app reads it as a Blob and knows the real type.
  return new Response(res.body, { headers: { ...cors, "content-type": "application/octet-stream", "cache-control": "no-store" } });
}

/** Upload or make a folder here? (Whole Drive: anywhere; else inside a picked folder.) */
async function mustWriteIn(db: SupabaseClient, bx: Box, folder: string) {
  if (!bx.write) throw new HttpError(403, "You can't add files to this Drive");
  if (bx.readAll) return;
  if (folder === "root") throw new HttpError(403, "Open one of the folders shared with you first");
  await mustReach(db, bx, folder);
  const f = await meta(db, bx.a, folder);
  if (f.mimeType !== FOLDER) throw new HttpError(400, "Pick a folder");
}

async function upload(req: Request, db: SupabaseClient, me: { id: string }): Promise<Response> {
  let m: { account?: unknown; folder?: unknown; name?: unknown };
  try {
    m = JSON.parse(decodeURIComponent(req.headers.get("x-iklipse-meta") ?? ""));
  } catch {
    throw new HttpError(400, "Pick a file to upload");
  }
  const bx = await box(db, me.id, m.account);
  const folder = m.folder == null || m.folder === "root" ? "root" : fileId(m.folder, "Pick a folder");
  const name = cleanName(m.name);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD) throw new HttpError(413, "Files up to 50 MB can be uploaded here");
  await mustWriteIn(db, bx, folder);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_UPLOAD) throw new HttpError(413, "Files up to 50 MB can be uploaded here");
  const type = req.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  // A resumable session (works for any size), then the bytes in one go.
  const start = await raw(db, bx.a, `${UPLOAD_API}?uploadType=resumable&${ALL_DRIVES}&fields=${enc(FIELDS)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(bytes.length) },
    body: JSON.stringify({ name, parents: [folder] }),
  });
  const session = start.headers.get("location");
  await start.body?.cancel();
  if (!session?.startsWith("https://www.googleapis.com/")) throw new HttpError(502, "Google Drive didn't take the upload. Try again.");
  const put = await fetch(session, { method: "PUT", headers: { "Content-Type": type }, body: bytes });
  if (!put.ok) throw new HttpError(502, "The upload didn't finish. Try again.");
  const file = out((await put.json()) as GFile);
  await logShared(db, bx, me.id, "uploaded", name);
  return json({ file });
}

// ----------------------------------------------------------- deliveries --
// Put Drive files into a delivery (0064) instead of uploading them: the files
// stay private in Drive and delivery-media plays them from there.

/** The file or folder id in a Drive link (or a bare id). */
function driveIdFrom(v: unknown): string | null {
  const s = oneLine(v);
  if (/^[A-Za-z0-9_-]{10,200}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (!/(^|\.)google\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/(?:file\/d|folders|d)\/([A-Za-z0-9_-]{10,200})/);
    if (m) return m[1];
    const q = u.searchParams.get("id");
    return q && /^[A-Za-z0-9_-]{10,200}$/.test(q) ? q : null;
  } catch {
    return null;
  }
}

const MAX_DELIVER = 300;
const kindOf = (mime: string) => (mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file");

async function deliver(db: SupabaseClient, me: { id: string }, b: Record<string, unknown>) {
  const { data: p } = await db.from("profile").select("role, delivery_role").eq("id", me.id).maybeSingle();
  if (!p || (p.role !== "admin" && p.delivery_role !== "manage")) throw new HttpError(403, "You can't prepare deliveries");
  const folder = typeof b.folder === "string" && /^[0-9a-f-]{36}$/.test(b.folder) ? b.folder : "";
  const { data: f } = folder ? await db.from("delivery_folder").select("id").eq("id", folder).maybeSingle() : { data: null };
  if (!f) throw new HttpError(404, "That delivery isn't there any more");
  const id = driveIdFrom(b.link);
  if (!id) throw new HttpError(400, "Paste a Google Drive link to a file or a folder");

  const bx = await box(db, me.id, b.account);
  await mustReach(db, bx, id);
  const top = out(await meta(db, bx.a, id).catch((e) => {
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) {
      throw new HttpError(404, `${bx.a.email} can't open that. Pick the Drive account it's in.`);
    }
    throw e;
  }));

  // A folder: the files in it (not its sub folders).
  let files: ReturnType<typeof out>[] = [];
  if (top.folder) {
    let page: string | undefined;
    do {
      const r = await listQuery(db, bx.a, `'${top.id}' in parents and trashed=false and mimeType != '${FOLDER}'`, "name", page);
      files.push(...r.files);
      page = r.next ?? undefined;
    } while (page && files.length < MAX_DELIVER);
    files = files.filter((x) => !x.folder && !x.mime.startsWith("application/vnd.google-apps.")).slice(0, MAX_DELIVER);
    if (!files.length) throw new HttpError(400, "There are no pictures, videos or files in that folder");
  } else {
    if (top.mime.startsWith("application/vnd.google-apps.")) {
      throw new HttpError(415, "Google Docs, Sheets and Slides can't be previewed here. Add them with Add link.");
    }
    files = [top];
  }

  // Already in this delivery: skipped.
  const { data: have } = await db
    .from("delivery_item")
    .select("drive_file_id")
    .eq("folder_id", folder)
    .is("removed_at", null)
    .in("drive_file_id", files.map((x) => x.id));
  const had = new Set((have ?? []).map((r) => r.drive_file_id as string));
  const fresh = files.filter((x) => !had.has(x.id));
  if (fresh.length) {
    const { error } = await db.from("delivery_item").insert(
      fresh.map((x) => ({
        folder_id: folder,
        kind: kindOf(x.mime),
        name: x.name.slice(0, 200),
        drive_file_id: x.id,
        drive_account_id: bx.a.id,
        drive_email: bx.a.email,
        mime_type: x.mime.slice(0, 120),
        size: x.size,
        created_by: me.id,
      })),
    );
    if (error) {
      console.error("deliver", error.message);
      throw new HttpError(500, "Couldn't add them. Try again.");
    }
    await logShared(db, bx, me.id, "added to a delivery", fresh.length > 1 ? `${fresh[0].name} and ${fresh.length - 1} more` : fresh[0].name);
  }
  return { added: fresh.length, skipped: files.length - fresh.length };
}

// ------------------------------------------------------------ callback --

function idClaims(idToken: string | undefined): { email?: string; name?: string } {
  if (!idToken) return {};
  try {
    const p = idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
}

async function callback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = await readState(url.searchParams.get("state"));
  const back = state?.r ?? safeReturn(null);
  if (url.searchParams.get("error")) return backToApp(back, "drive", "denied");
  const code = url.searchParams.get("code");
  if (!state || !code) return backToApp(back, "drive", "error");
  try {
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    // The person may untick "see, edit, create and delete your Drive files" on Google's screen.
    if (!(t.scope ?? "").split(" ").includes(DRIVE_SCOPE)) return backToApp(back, "drive", "missing_scope");
    const who = idClaims(t.id_token);
    const email = who.email?.toLowerCase();
    if (!email) return backToApp(back, "drive", "error");
    const db = serviceClient();
    const { data: existing } = await db.from("drive_account").select("id").eq("user_id", state.u).eq("email", email).maybeSingle();
    if (!existing) {
      const { count } = await db.from("drive_account").select("id", { count: "exact", head: true }).eq("user_id", state.u);
      if ((count ?? 0) >= MAX_ACCOUNTS) return backToApp(back, "drive", "too_many");
    }
    const row = {
      user_id: state.u,
      email,
      name: who.name ?? null,
      access_token: t.access_token,
      token_expiry: expiry(t),
      scope: t.scope ?? null,
      updated_at: new Date().toISOString(),
    };
    if (t.refresh_token) {
      const { error } = await db
        .from("drive_account")
        .upsert({ ...row, refresh_token: t.refresh_token, connected_at: new Date().toISOString() }, { onConflict: "user_id,email" });
      if (error) throw error;
    } else if (existing) {
      const { error } = await db.from("drive_account").update(row).eq("id", existing.id);
      if (error) throw error;
    } else {
      return backToApp(back, "drive", "error");
    }
    return backToApp(back, "drive", "connected");
  } catch (e) {
    console.error("drive callback", (e as Error).message);
    return backToApp(back, "drive", "error");
  }
}

// ----------------------------------------------------------------- serve --

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const r = route(req);
  if (req.method === "GET" && r === "callback") return callback(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const db = serviceClient();
    const me = await caller(req, db);
    if (r === "upload") return await upload(req, db, me);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    switch (b.action) {
      case "connect": {
        if (!configured()) throw new HttpError(503, "Google isn't set up on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
        const state = await signState(me.id, safeReturn(b.returnTo));
        const q = new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          // Always the account picker (to add another Drive) and a fresh refresh token.
          prompt: "consent select_account",
          include_granted_scopes: "true",
          state,
        });
        return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
      }

      case "disconnect": {
        const a = await myAccount(db, me.id, b.account);
        // Revoking ends every grant of this Google login to the app, Gmail
        // included: only when the same login isn't also connected for Gmail.
        const { data: mail } = await db.from("gmail_account").select("id").eq("user_id", me.id).eq("email", a.email).maybeSingle();
        if (!mail) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refresh_token)}`, { method: "POST" }).catch(() => undefined);
        await db.from("drive_account").delete().eq("id", a.id);
        return json({ ok: true });
      }

      case "summary": {
        const { data } = await db.from("drive_account").select("*").eq("user_id", me.id).order("connected_at");
        const accounts = await Promise.all(
          ((data ?? []) as Account[]).map(async (a) => {
            try {
              const r = await drive<{ storageQuota?: { limit?: string; usage?: string } }>(db, a, "/about?fields=storageQuota");
              return { id: a.id, email: a.email, used: Number(r.storageQuota?.usage ?? 0), limit: r.storageQuota?.limit ? Number(r.storageQuota.limit) : null };
            } catch (e) {
              return { id: a.id, email: a.email, used: 0, limit: null, error: (e as Error).message };
            }
          }),
        );
        return json({ accounts });
      }

      case "list": {
        const bx = await box(db, me.id, b.account);
        return json(await list(db, bx, b));
      }

      case "download":
        return await download(db, await box(db, me.id, b.account), b);

      case "deliver":
        return json(await deliver(db, me, b));

      case "mkdir": {
        const bx = await box(db, me.id, b.account);
        const parent = b.parent == null || b.parent === "root" ? "root" : fileId(b.parent, "Pick a folder");
        const name = cleanName(b.name);
        await mustWriteIn(db, bx, parent);
        const f = await drive<GFile>(db, bx.a, `/files?fields=${enc(FIELDS)}&${ALL_DRIVES}`, {
          method: "POST",
          body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
        });
        await logShared(db, bx, me.id, "made the folder", name);
        return json({ file: out(f) });
      }

      case "rename": {
        const bx = await box(db, me.id, b.account);
        if (!bx.write) throw new HttpError(403, "You can't rename things in this Drive");
        const id = fileId(b.id);
        const name = cleanName(b.name);
        await mustReach(db, bx, id);
        const before = await meta(db, bx.a, id);
        const f = await drive<GFile>(db, bx.a, `/files/${enc(id)}?fields=${enc(FIELDS)}&${ALL_DRIVES}`, { method: "PATCH", body: JSON.stringify({ name }) });
        await logShared(db, bx, me.id, "renamed", `${before.name} to ${name}`);
        return json({ file: out(f) });
      }

      case "star": {
        const bx = await box(db, me.id, b.account);
        if (!bx.manage) throw new HttpError(403, "You can't star things in this Drive");
        const id = fileId(b.id);
        await drive(db, bx.a, `/files/${enc(id)}?fields=id&${ALL_DRIVES}`, { method: "PATCH", body: JSON.stringify({ starred: Boolean(b.on) }) });
        return json({ ok: true });
      }

      case "trash": {
        const bx = await box(db, me.id, b.account);
        if (!bx.manage) throw new HttpError(403, "You can't delete things in this Drive");
        const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => fileId(x)).slice(0, 50);
        const names = await Promise.all(
          ids.map(async (id) => {
            const f = await drive<GFile>(db, bx.a, `/files/${enc(id)}?fields=name&${ALL_DRIVES}`, { method: "PATCH", body: JSON.stringify({ trashed: true }) });
            return f.name;
          }),
        );
        if (names.length) await logShared(db, bx, me.id, "deleted", names.length > 1 ? `${names[0]} and ${names.length - 1} more` : names[0]);
        return json({ ok: true });
      }

      default:
        throw new HttpError(400, "Unknown action");
    }
  } catch (e) {
    return toResponse(e);
  }
});
