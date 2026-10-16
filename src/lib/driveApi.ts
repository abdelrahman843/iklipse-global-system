import { saveBlob } from "@/lib/nativeApp";
import { callFunction } from "@/lib/connectionsApi";
import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Google Drive (0054, edge function drive): the Drive accounts a person
// connected, and the ones (or the files and folders) others shared with them.
// Tokens never reach the browser; every call goes through the function, which
// checks what the caller may do.
// -----------------------------------------------------------------------------

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveFile {
  /** What it is (for a shortcut: what it points to). */
  id: string;
  /** The item itself (for a shortcut: the shortcut), for rename / star / delete. */
  ref: string;
  name: string;
  mime: string;
  folder: boolean;
  size: number | null;
  modified: string | null;
  starred: boolean;
  owner: string | null;
  /** Google Drive's own page (only useful to the account's owner). */
  link: string | null;
  shortcut: boolean;
}

export type DriveView = "folder" | "recent" | "starred";

export interface DrivePageData {
  files: DriveFile[];
  next: string | null;
}

export function listDrive(p: { account: string; folder?: string; view?: DriveView; q?: string; page?: string | null }): Promise<DrivePageData> {
  return callFunction<DrivePageData>("drive", { action: "list", ...p });
}

export async function driveSummary(): Promise<{ id: string; email: string; used: number; limit: number | null; error?: string }[]> {
  const r = await callFunction<{ accounts: { id: string; email: string; used: number; limit: number | null; error?: string }[] }>("drive", { action: "summary" });
  return r.accounts;
}

/** The file's bytes (Google's own files exported: Word / Excel / PowerPoint, or PDF for a preview). */
export async function fetchDriveFile(account: string, f: DriveFile, as?: "pdf"): Promise<Blob> {
  const blob = await callFunction<Blob>("drive", { action: "download", account, id: f.id, ...(as ? { as } : {}) });
  return new Blob([blob], { type: as === "pdf" ? "application/pdf" : f.mime.startsWith("application/vnd.google-apps.") ? exportOf(f.mime)?.mime : f.mime });
}

const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};
const exportOf = (mime: string) => EXPORTS[mime];

/** A Google file that has no download (Forms, Sites, Maps...): it only opens in Google Drive. */
export const googleOnly = (f: DriveFile) => f.mime.startsWith("application/vnd.google-apps.") && !f.folder && !exportOf(f.mime);
/** Google Docs, Sheets, Slides, Drawings: previewed as PDF. */
export const isGoogleDoc = (f: DriveFile) => Boolean(exportOf(f.mime));

export async function downloadDriveFile(account: string, f: DriveFile) {
  const blob = await fetchDriveFile(account, f);
  const ext = exportOf(f.mime)?.ext;
  const name = ext && !f.name.toLowerCase().endsWith(`.${ext}`) ? `${f.name}.${ext}` : f.name;
  await saveBlob(blob, name);
}

export const MAX_UPLOAD = 50 * 1024 * 1024;

export async function uploadDriveFile(account: string, folder: string, file: File): Promise<DriveFile> {
  const r = await callFunction<{ file: DriveFile }>("drive/upload", file, {
    "Content-Type": file.type || "application/octet-stream",
    "X-Iklipse-Meta": encodeURIComponent(JSON.stringify({ account, folder, name: file.name })),
  });
  return r.file;
}

export async function makeFolder(account: string, parent: string, name: string): Promise<DriveFile> {
  const r = await callFunction<{ file: DriveFile }>("drive", { action: "mkdir", account, parent, name });
  return r.file;
}

export async function renameDriveFile(account: string, id: string, name: string): Promise<DriveFile> {
  const r = await callFunction<{ file: DriveFile }>("drive", { action: "rename", account, id, name });
  return r.file;
}

export async function starDriveFile(account: string, id: string, on: boolean) {
  await callFunction("drive", { action: "star", account, id, on });
}

export async function trashDriveFiles(account: string, ids: string[]) {
  await callFunction("drive", { action: "trash", account, ids });
}

// ------------------------------------------------------ Google's own sharing --
// Who has access to a file or folder in Google Drive itself, like Drive's Share
// screen. `id` is DriveFile.id (for a shortcut: what it points to).

export type FileRole = "reader" | "commenter" | "writer";

export interface FilePerson {
  /** The permission's id. */
  id: string;
  type: "user" | "group";
  /** FileRole, or "owner" (can't be changed or removed). */
  role: string;
  email: string | null;
  name: string | null;
  photo: string | null;
  /** Comes from a parent folder. */
  inherited: boolean;
}

export interface FileAccess {
  name: string;
  folder: boolean;
  link: string | null;
  canShare: boolean;
  general: { access: "restricted" | "anyone" | "domain"; role: string | null; id: string | null; domain: string | null };
  people: FilePerson[];
}

export const fileAccessKey = (account: string, id: string) => ["drive-access", account, id] as const;

export function fetchFileAccess(account: string, id: string): Promise<FileAccess> {
  return callFunction<FileAccess>("drive", { action: "access", account, id });
}

export function shareFile(p: { account: string; id: string; emails: string[]; role: FileRole; notify?: boolean; message?: string }): Promise<FileAccess> {
  return callFunction<FileAccess>("drive", { action: "share", ...p });
}

export function setFileRole(account: string, id: string, permission: string, role: FileRole): Promise<FileAccess> {
  return callFunction<FileAccess>("drive", { action: "setRole", account, id, permission, role });
}

export function unshareFile(account: string, id: string, permission: string): Promise<FileAccess> {
  return callFunction<FileAccess>("drive", { action: "unshare", account, id, permission });
}

/** Restricted, or anyone with the link (with a role). */
export function setGeneralAccess(account: string, id: string, access: "restricted" | "anyone", role?: FileRole): Promise<FileAccess> {
  return callFunction<FileAccess>("drive", { action: "general", account, id, access, ...(role ? { role } : {}) });
}

export function fileSize(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

// ---------------------------------------------------------------- sharing --
// The owner picks what each person may do; the drive function checks it.

export type DriveAccess = "full" | "edit" | "read" | "custom";

export const DRIVE_ACCESS: { value: DriveAccess; label: string; hint: string }[] = [
  { value: "full", label: "Full access", hint: "Same as you: open, download, upload, rename, star and delete." },
  { value: "edit", label: "Open and add", hint: "Opens and downloads everything, uploads files, makes folders and renames. Can't delete." },
  { value: "read", label: "Open only", hint: "Opens and downloads everything. Can't change anything." },
  { value: "custom", label: "Only some files", hint: "Only the files and folders you pick, with everything inside those folders." },
];

export const driveAccessLabel = (a: DriveAccess) => DRIVE_ACCESS.find((x) => x.value === a)?.label ?? a;

export interface DriveCaps {
  /** Opens the whole Drive (else only picked files and folders). */
  readAll: boolean;
  /** Upload, make folders, rename (custom: inside the picked folders). */
  write: boolean;
  /** Star and delete. */
  manage: boolean;
}

export const DRIVE_OWNER_CAPS: DriveCaps = { readAll: true, write: true, manage: true };

export function driveCapsOf(access: DriveAccess, canEdit: boolean): DriveCaps {
  return {
    readAll: access !== "custom",
    write: access === "full" || access === "edit" || (access === "custom" && canEdit),
    manage: access === "full",
  };
}

export function driveCapsText(access: DriveAccess, canEdit: boolean): string {
  if (access === "custom") return canEdit ? "Only some files, can add" : "Only some files, open only";
  return driveAccessLabel(access);
}

export interface DriveSharedItem {
  file_id: string;
  name: string | null;
  mime: string | null;
  shared_at: string;
}

export interface MyDriveShare {
  id: string;
  grantee_id: string;
  name: string;
  username: string;
  avatar_url: string | null;
  access: DriveAccess;
  can_edit: boolean;
  created_at: string;
  items: DriveSharedItem[];
}

export interface DriveLogLine {
  action: string;
  detail: string | null;
  at: string;
  actor_id: string;
  actor_name: string;
}

export interface MyDriveShares {
  account_id: string;
  email: string;
  shares: MyDriveShare[];
  log: DriveLogLine[];
}

export interface DriveSharedWithMe {
  share_id: string;
  account_id: string;
  email: string;
  owner_id: string;
  owner_name: string;
  owner_avatar: string | null;
  access: DriveAccess;
  can_edit: boolean;
  items: number;
  created_at: string;
}

export async function fetchMyDriveShares(): Promise<MyDriveShares[]> {
  const { data, error } = await supabase.rpc("drive_shares_mine");
  if (error) throw error;
  return (data ?? []) as MyDriveShares[];
}

export async function fetchDriveSharedWithMe(): Promise<DriveSharedWithMe[]> {
  const { data, error } = await supabase.rpc("drive_shared_with_me");
  if (error) throw error;
  return (data ?? []) as DriveSharedWithMe[];
}

export async function setDriveShare(p: { account: string; grantee: string; access: DriveAccess; canEdit: boolean }) {
  const { error } = await supabase.rpc("drive_share_set", {
    p_account: p.account,
    p_grantee: p.grantee,
    p_access: p.access,
    p_can_edit: p.canEdit,
  });
  if (error) throw error;
}

/** The owner stops sharing, or the person gives the access back. */
export async function removeDriveShare(id: string) {
  const { error } = await supabase.rpc("drive_share_remove", { p_share: id });
  if (error) throw error;
}

/** Share one file or folder. "already": they open everything anyway. */
export async function shareDriveItem(p: { account: string; grantee: string; file: DriveFile }): Promise<"added" | "already"> {
  const { data, error } = await supabase.rpc("drive_share_item_add", {
    p_account: p.account,
    p_grantee: p.grantee,
    p_file: p.file.id,
    p_name: p.file.name,
    p_mime: p.file.mime,
  });
  if (error) throw error;
  return data as "added" | "already";
}

export async function unshareDriveItem(share: string, file: string) {
  const { error } = await supabase.rpc("drive_share_item_remove", { p_share: share, p_file: file });
  if (error) throw error;
}
