// Shared pieces of the Iklipse MCP tools: the tool shape, argument checks and
// small database helpers. Every query runs as the signed-in person (their
// token on PostgREST), so row-level security decides what is allowed.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type Args = Record<string, unknown>;

export interface Ctx {
  db: SupabaseClient;
  uid: string;
  appUrl: string;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (a: Args, c: Ctx) => Promise<unknown>;
}

/** A problem the AI can fix (shown to it as the tool result). */
export class UserError extends Error {}

export const str = (v: unknown, name: string, max = 10000): string => {
  if (typeof v !== "string" || !v.trim()) throw new UserError(`${name} is required`);
  if (v.length > max) throw new UserError(`${name} is too long (max ${max} characters)`);
  return v.trim();
};
export const optStr = (v: unknown, max = 10000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
export const uuid = (v: unknown, name: string): string => {
  const s = str(v, name, 64);
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new UserError(`${name} must be an id returned by another tool`);
  return s;
};
export const optUuid = (v: unknown, name: string): string | undefined => (v === undefined || v === null || v === "" ? undefined : uuid(v, name));
export const num = (v: unknown, name: string): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new UserError(`${name} must be a number`);
  return n;
};
export const optNum = (v: unknown, name: string): number | undefined => (v === undefined || v === null ? undefined : num(v, name));
export const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
/** ISO date, null to clear, undefined to leave alone. */
export const date = (v: unknown, name: string): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || isNaN(Date.parse(v))) throw new UserError(`${name} must be an ISO 8601 date or null`);
  return new Date(v).toISOString();
};
export const oneOf = <T extends string>(v: unknown, name: string, list: readonly T[]): T => {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) throw new UserError(`${name} must be one of: ${list.join(", ")}`);
  return v as T;
};

/** Data from a query, or a clear error (not found usually means no access). */
// Rows come back loosely typed (joined columns especially); callers say what they expect.
// deno-lint-ignore no-explicit-any
export const must = (r: { data: unknown; error: { message: string } | null }, what: string): any => {
  if (r.error) throw new UserError(`${what}: ${r.error.message}`);
  if (r.data == null) throw new UserError(`${what}: not found or no access`);
  return r.data;
};
/** A write that must have touched a row (RLS silently skips rows you may not change). */
export async function changed(q: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, what: string) {
  const r = await q;
  if (r.error) throw new UserError(`${what}: ${r.error.message}`);
  if (!r.data?.length) throw new UserError(`${what}: not found, or you don't have permission`);
}
export async function ok(q: PromiseLike<{ error: { message: string } | null }>, what: string) {
  const r = await q;
  if (r.error) throw new UserError(`${what}: ${r.error.message}`);
}

export const boardUrl = (c: Ctx, b: { id: string; kind: string }) => `${c.appUrl}/#/${b.kind === "whiteboard" ? "wb" : "pm/boards"}/${b.id}`;
export const cardUrl = (c: Ctx, boardId: string, cardId: string) => `${c.appUrl}/#/pm/boards/${boardId}/cards/${cardId}`;

/** A position between two others (the app's ordering, lexorank). */
export async function rank(c: Ctx, prev: string | null, next: string | null): Promise<string> {
  return must(await c.db.rpc("rank_between", { prev, nxt: next }), "Position") as string;
}
/** Position at the end of a set of rows ordered by `position`. */
export async function rankLast(c: Ctx, table: string, col: string, id: string): Promise<string> {
  const last = await c.db.from(table).select("position").eq(col, id).order("position", { ascending: false }).limit(1).maybeSingle();
  return rank(c, (last.data as { position: string } | null)?.position ?? null, null);
}

export async function boardOf(c: Ctx, id: string, kind?: "kanban" | "whiteboard") {
  const b = must(await c.db.from("board").select("id, title, kind").eq("id", id).maybeSingle(), "Board") as { id: string; title: string; kind: string };
  if (kind === "kanban" && b.kind !== "kanban") throw new UserError("That is a Miro board; use the Miro tools");
  if (kind === "whiteboard" && b.kind !== "whiteboard") throw new UserError("That is a Trello board; use the Trello tools");
  return b;
}

/** A person by id, @username or display name (for members, assignees). */
export async function person(c: Ctx, who: unknown, name = "user", inactiveToo = false): Promise<{ id: string; display_name: string; username: string }> {
  const q = str(who, name, 100).replace(/^@/, "");
  const base = c.db.from("profile").select("id, display_name, username");
  const sel = inactiveToo ? base : base.eq("is_active", true);
  const r = /^[0-9a-f-]{36}$/i.test(q)
    ? await sel.eq("id", q).maybeSingle()
    : await sel.or(`username.ilike.${q.replace(/[,()%]/g, "")},display_name.ilike.${q.replace(/[,()%]/g, "")}`).limit(2);
  const rows = (Array.isArray(r.data) ? r.data : r.data ? [r.data] : []) as { id: string; display_name: string; username: string }[];
  if (r.error) throw new UserError(`${name}: ${r.error.message}`);
  if (!rows.length) throw new UserError(`${name}: no person "${q}" (use list_people)`);
  if (rows.length > 1) throw new UserError(`${name}: "${q}" matches more than one person; use their username`);
  return rows[0]!;
}

/** Helper for tools with an `action` argument. */
export function actions(a: Args, table: Record<string, (a: Args) => Promise<unknown>>) {
  const name = typeof a.action === "string" ? a.action : "";
  const fn = table[name];
  if (!fn) throw new UserError(`action must be one of: ${Object.keys(table).join(", ")}`);
  return fn(a);
}
