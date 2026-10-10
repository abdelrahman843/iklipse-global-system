import { useSyncExternalStore } from "react";
import { later, tx } from "./idb";
import { isOnline, onConnectivity, reportOffline, reportOnline } from "./net";

// -----------------------------------------------------------------------------
// The outbox: no edit is ever lost.
//
// Every write the app makes through supabase-js (cards, lists, comments,
// checklists, whiteboard saves, file uploads...) passes through `outboxFetch`.
// Before it goes out it is written to IndexedDB; it leaves the outbox only once
// the server has answered. So closing the app, killing it on a phone, losing
// the network halfway: the write is still on the device and is sent the next
// time the app runs with a connection.
//
//   online, nothing waiting  -> sent at once, the caller gets the real answer
//                               (errors and all), exactly as before
//   offline, or older writes
//   still waiting            -> queued; the caller gets an "accepted" answer
//                               (status 202) shaped like the real one, so the
//                               screen keeps the change. The queue sends them
//                               in order when the server is reachable again.
//
// Writes are replayed in the order they were made. New rows get their id on
// the device, so a write that reached the server but whose answer was lost is
// recognised on retry (duplicate key = already saved) instead of saved twice.
// A write the server refuses for good (permissions, a card deleted meanwhile)
// is kept aside as "failed" and shown to the person, never silently dropped.
//
// Only writes that make sense later are queued (TABLES / RPCS / BUCKETS).
// Everything else (AI, share links, briefs, admin) needs the network and says so.
// Each entry belongs to the account that made it and is only ever sent with
// that account's login.
// -----------------------------------------------------------------------------

type Part = [name: string, value: string | Blob, filename?: string];
type StoredBody = { t: "text"; v: string } | { t: "blob"; v: Blob } | { t: "form"; v: Part[] } | null;

interface Entry {
  seq?: number;
  owner: string;
  at: number;
  url: string;
  method: string;
  headers: [string, string][];
  body: StoredBody;
  label: string;
  detail?: string;
  /** Same key = later saves may be folded into this one (whiteboard saves). */
  merge?: string;
  state: "pending" | "failed";
  /** Being sent until this time (ms since epoch); 0 = waiting its turn. */
  lease: number;
  /** Sent straight away by the screen that made it, not by the queue. */
  direct: boolean;
  /** Bumped when later saves are folded in: a send of an older revision doesn't finish it. */
  rev?: number;
  tries: number;
  error?: string;
  status?: number;
}

export interface FailedChange {
  seq: number;
  label: string;
  detail?: string;
  error: string;
  at: number;
}

export interface OutboxStatus {
  /** Changes on this device the server doesn't have yet. */
  waiting: number;
  /** Changes the server refused. */
  failed: FailedChange[];
  /** The queue is sending right now. */
  sending: boolean;
}

interface Config {
  anonKey: string;
  /** Account signed in on this device (from the stored session, no network). */
  owner: () => string | null;
  /** A token to send with now (refreshed if needed); null when signed out. */
  session: () => Promise<{ uid: string; token: string } | null>;
  /** Refresh the token after the server said it expired. */
  refresh: () => Promise<void>;
}

// ------------------------------------------------------------------- what --

/** Tables whose writes are queued, with how a person would call a row. */
const TABLES: Record<string, string> = {
  board: "board",
  board_member: "board member",
  list: "list",
  card: "card",
  label: "label",
  card_label: "card label",
  card_member: "card member",
  checklist: "checklist",
  checklist_item: "checklist item",
  attachment: "attachment",
  comment: "comment",
  comment_reaction: "reaction",
  subscription: "watch setting",
  custom_field_def: "custom field",
  custom_field_value: "custom field",
  automation_rule: "automation rule",
  notification: "notification",
  wb_comment: "board comment",
  wb_state: "timer",
  wb_doc_update: "doc edit",
};

/** Tables whose `id` is a uuid the server would make up: inserts get one here. */
const UUID_ID = new Set([
  "list",
  "card",
  "label",
  "checklist",
  "checklist_item",
  "attachment",
  "comment",
  "custom_field_def",
  "automation_rule",
  "wb_comment",
]);

type Json = Record<string, unknown>;

/** Functions whose calls are queued: a label, and the answer to give while queued. */
const RPCS: Record<string, { label: (b: Json) => string; result?: (b: Json) => unknown; needs?: string }> = {
  wb_save: { label: () => "Whiteboard changes" },
  move_card: { label: () => "Move a card" },
  reorder_list: { label: () => "Move a list" },
  set_card_archived: { label: (b) => (b.p_archived ? "Archive a card" : "Restore a card") },
  set_subscription: { label: (b) => (b.p_watch ? "Watch" : "Stop watching"), result: (b) => Boolean(b.p_watch) },
  set_card_template: { label: () => "Template setting" },
  wb_doc_mention: { label: () => "Doc mention" },
  // Only with an id made on the device (p_id), so the new board can be opened at once.
  create_board: { label: () => "Create a board", result: (b) => b.p_id ?? null, needs: "p_id" },
};

/** Storage buckets whose uploads / removals are queued. */
const BUCKETS = new Set(["attachments", "whiteboard"]);
const NOT_A_BUCKET = new Set(["sign", "list", "move", "copy", "info", "public", "authenticated", "upload", "render"]);

/** A send gives up after this (and counts as "no network"); leases outlast it. */
const SEND_TIMEOUT_MS = 45_000;
const UPLOAD_TIMEOUT_MS = 9 * 60_000;
const DIRECT_LEASE_MS = 60_000;
const UPLOAD_LEASE_MS = 10 * 60_000;

/** Primary keys other than `id`: a duplicate on these means "already saved". */
const PRIMARY_KEYS: Record<string, string> = {
  board_member: "board_id,user_id",
  card_label: "card_id,label_id",
  card_member: "card_id,user_id",
  subscription: "user_id,entity_type,entity_id",
  comment_reaction: "comment_id,user_id,emoji",
  custom_field_value: "card_id,field_id",
  wb_state: "board_id",
};
/** Answers that mean "try again later", not "no". */
const TRANSIENT = new Set([408, 425, 429, 502, 503, 504]);
const MAX_MERGED = 4000;

interface Op {
  kind: "rest" | "rpc" | "storage";
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  /** Parsed JSON body (rest / rpc). */
  json: unknown;
  label: string;
  detail?: string;
  merge?: string;
  fn?: string;
}

const verb = (method: string, upsert: boolean) =>
  upsert ? "Save" : method === "POST" ? "Add" : method === "DELETE" ? "Remove" : "Edit";

function excerpt(v: unknown): string | undefined {
  const row = (Array.isArray(v) ? v[0] : v) as Json | undefined;
  if (!row || typeof row !== "object") return undefined;
  for (const k of ["title", "name", "body", "text", "emoji"]) {
    const s = row[k];
    if (typeof s === "string" && s.trim()) {
      const t = s.replace(/\s+/g, " ").trim();
      return t.length > 60 ? `${t.slice(0, 57)}...` : t;
    }
  }
  return undefined;
}

function parseJson(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string" || !body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Is this request a write we queue? Returns it ready to store (ids added). */
function classify(url: URL, method: string, init: RequestInit): Op | null {
  const headers = new Headers(init.headers);
  const body = init.body;
  const path = url.pathname;

  let m = path.match(/\/rest\/v1\/rpc\/([a-z0-9_]+)$/);
  if (m) {
    const fn = m[1]!;
    const spec = RPCS[fn];
    if (!spec || method !== "POST") return null;
    const json = parseJson(body);
    if (!json || typeof json !== "object") return null;
    if (spec.needs && !(json as Json)[spec.needs]) return null;
    const merge = fn === "wb_save" ? `wb_save:${String((json as Json).p_board)}` : undefined;
    return { kind: "rpc", url, method, headers, body, json, fn, label: spec.label(json as Json), merge };
  }

  m = path.match(/\/rest\/v1\/([a-z0-9_]+)$/);
  if (m) {
    const table = m[1]!;
    const noun = TABLES[table];
    if (!noun || !["POST", "PATCH", "DELETE"].includes(method)) return null;
    let json = parseJson(body);
    if (body != null && json === undefined) return null;
    const upsert = /resolution=/.test(headers.get("prefer") ?? "");
    let nextBody: BodyInit | null | undefined = body;
    let nextUrl = url;
    // Give new rows their id here, so a retry can't save them twice.
    if (method === "POST" && !upsert && UUID_ID.has(table) && json && typeof json === "object") {
      const rows = (Array.isArray(json) ? json : [json]) as Json[];
      let added = false;
      for (const r of rows) {
        if (r && typeof r === "object" && !r.id) {
          r.id = crypto.randomUUID();
          added = true;
        }
      }
      if (added) {
        json = Array.isArray(json) ? rows : rows[0];
        nextBody = JSON.stringify(json);
        // Array inserts name their columns; the new id must be one of them.
        const cols = url.searchParams.get("columns");
        if (cols && !cols.split(",").includes('"id"')) {
          nextUrl = new URL(url.href);
          nextUrl.searchParams.set("columns", `${cols},"id"`);
        }
      }
    }
    return {
      kind: "rest",
      url: nextUrl,
      method,
      headers,
      body: nextBody,
      json,
      label: `${verb(method, upsert)} ${noun}`,
      detail: excerpt(json),
    };
  }

  m = path.match(/\/storage\/v1\/object\/(.+)$/);
  if (m) {
    const segs = m[1]!.split("/");
    const bucket = decodeURIComponent(segs[0]!);
    if (!BUCKETS.has(bucket) || NOT_A_BUCKET.has(bucket)) return null;
    if ((method === "POST" || method === "PUT") && segs.length >= 2) {
      const name = decodeURIComponent(segs[segs.length - 1]!).replace(/^[0-9a-f-]{36}_?/, "");
      const detail = name && !name.startsWith(".") ? name : undefined;
      return { kind: "storage", url, method, headers, body, json: undefined, label: "Upload a file", detail };
    }
    if (method === "DELETE" && segs.length === 1) {
      return { kind: "storage", url, method, headers, body, json: parseJson(body), label: "Remove a file" };
    }
  }
  return null;
}

// ------------------------------------------------------- queued answers --

function reply(data: unknown, status = 202): Response {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "x-iklipse-queued": "1" },
  });
}

/** Filters like id=eq.<uuid> become fields of the row the caller gets back. */
function filterFields(url: URL): Json {
  const out: Json = {};
  for (const [k, v] of url.searchParams) {
    if (["select", "columns", "on_conflict", "order", "limit", "offset"].includes(k)) continue;
    if (v.startsWith("eq.")) out[k] = v.slice(3);
  }
  return out;
}

/** What the server would have answered, as far as the screen needs it. */
function queuedReply(op: Op): Response {
  if (op.kind === "storage") {
    if (op.method === "DELETE") return reply([]);
    const key = decodeURIComponent(op.url.pathname.replace(/^.*\/storage\/v1\/object\//, ""));
    return reply({ Key: key, Id: crypto.randomUUID() });
  }
  if (op.kind === "rpc") {
    const spec = RPCS[op.fn!];
    return reply(spec?.result ? spec.result((op.json ?? {}) as Json) : null);
  }
  if (!/return=representation/.test(op.headers.get("prefer") ?? "")) return reply(undefined);
  const now = new Date().toISOString();
  const rows: Json[] =
    op.method === "POST"
      ? ((Array.isArray(op.json) ? op.json : [op.json]) as Json[]).map((r) => ({ created_at: now, updated_at: now, ...r }))
      : [{ ...filterFields(op.url), ...(op.method === "PATCH" && op.json && typeof op.json === "object" ? (op.json as Json) : {}) }];
  const single = /vnd\.pgrst\.object/.test(op.headers.get("accept") ?? "");
  return reply(single ? rows[0] ?? null : rows);
}

// ------------------------------------------------------------- bodies --

function storeBody(body: BodyInit | null | undefined): StoredBody | undefined {
  if (body == null) return null;
  if (typeof body === "string") return { t: "text", v: body };
  if (body instanceof FormData) {
    const parts: Part[] = [];
    body.forEach((v, k) => parts.push(typeof v === "string" ? [k, v] : [k, v, (v as File).name]));
    return { t: "form", v: parts };
  }
  if (body instanceof Blob) return { t: "blob", v: body };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { t: "blob", v: new Blob([body as BlobPart]) };
  if (body instanceof URLSearchParams) return { t: "text", v: body.toString() };
  return undefined; // a stream can't be kept
}

function restoreBody(b: StoredBody): BodyInit | null {
  if (!b) return null;
  if (b.t === "text" || b.t === "blob") return b.v;
  const fd = new FormData();
  for (const [k, v, name] of b.v) {
    if (typeof v === "string") fd.append(k, v);
    else fd.append(k, v, name);
  }
  return fd;
}

function keepHeaders(h: Headers): [string, string][] {
  const out: [string, string][] = [];
  h.forEach((v, k) => {
    if (!["authorization", "apikey", "content-length"].includes(k.toLowerCase())) out.push([k, v]);
  });
  return out;
}

// --------------------------------------------- folding whiteboard saves --

interface WbSave {
  p_board: string;
  p_put: Json[];
  p_patch: Json[];
  p_delete: string[];
  p_sid?: string | null;
}

const SCALARS = ["x", "y", "w", "h", "rotation", "z", "locked"];

/** Later patch over an earlier one, the way wb_save applies them. */
function foldPatch(into: Json, p: Json): Json {
  const out: Json = { ...into };
  for (const k of SCALARS) if (p[k] != null) out[k] = p[k];
  for (const k of ["frame_id", "group_id", "type"]) if (k in p) out[k] = p[k];
  if (p.data && typeof p.data === "object") out.data = { ...((into.data as Json) ?? {}), ...(p.data as Json) };
  return out;
}

/** Two queued wb_save calls as one: same result as running a then b. */
function foldWbSave(a: WbSave, b: WbSave): WbSave | null {
  const put = new Map((a.p_put ?? []).map((r) => [String(r.id), r]));
  const patch = new Map((a.p_patch ?? []).map((r) => [String(r.id), r]));
  const del = new Set((a.p_delete ?? []).map(String));
  for (const r of b.p_put ?? []) {
    const id = String(r.id);
    put.set(id, r);
    patch.delete(id);
    del.delete(id);
  }
  for (const p of b.p_patch ?? []) {
    const id = String(p.id);
    if (put.has(id)) put.set(id, foldPatch(put.get(id)!, p));
    else if (!del.has(id)) patch.set(id, patch.has(id) ? foldPatch(patch.get(id)!, p) : p);
  }
  for (const id of (b.p_delete ?? []).map(String)) {
    put.delete(id);
    patch.delete(id);
    del.add(id);
  }
  if (put.size + patch.size + del.size > MAX_MERGED) return null;
  return { p_board: a.p_board, p_put: [...put.values()], p_patch: [...patch.values()], p_delete: [...del], p_sid: b.p_sid ?? a.p_sid };
}

// -------------------------------------------------------------- storage --

let cfg: Config | null = null;
const tabId = Math.random().toString(36).slice(2);
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("iklipse-outbox") : null;

/** Anything waiting its turn for this account (the queue goes first). */
async function hasBacklog(owner: string): Promise<boolean> {
  const now = Date.now();
  const box = await tx("outbox", "readonly", (t) => {
    const res = { found: false };
    const req = t.objectStore("outbox").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const e = c.value as Entry;
      if (e.owner === owner && e.state === "pending" && !(e.direct && e.lease > now)) {
        res.found = true;
        return;
      }
      c.continue();
    };
    return res;
  });
  return box.found;
}

async function add(e: Entry): Promise<number> {
  const box = await tx("outbox", "readwrite", (t) => later(t.objectStore("outbox").add(e)));
  return box.value as number;
}

/** Fold a whiteboard save into the last queued one for the same board. */
async function foldIntoTail(e: Entry): Promise<boolean> {
  const now = Date.now();
  const box = await tx("outbox", "readwrite", (t) => {
    const res = { folded: false };
    const req = t.objectStore("outbox").openCursor(null, "prev");
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const tail = c.value as Entry;
      if (tail.owner !== e.owner || tail.merge !== e.merge || tail.state !== "pending" || tail.lease > now) return;
      if (tail.body?.t !== "text" || e.body?.t !== "text") return;
      try {
        const folded = foldWbSave(JSON.parse(tail.body.v) as WbSave, JSON.parse(e.body.v) as WbSave);
        if (!folded) return;
        c.update({ ...tail, rev: (tail.rev ?? 0) + 1, body: { t: "text", v: JSON.stringify(folded) } });
        res.folded = true;
      } catch {
        /* not foldable: queue it on its own */
      }
    };
    return res;
  });
  return box.folded;
}

async function remove(seq: number) {
  await tx("outbox", "readwrite", (t) => {
    t.objectStore("outbox").delete(seq);
  });
}

/**
 * The server has this revision of the entry. Gone, unless later saves were
 * folded into it while it was on its way: then it waits to go again.
 */
async function finish(seq: number, rev: number) {
  await tx("outbox", "readwrite", (t) => {
    const s = t.objectStore("outbox");
    const req = s.get(seq);
    req.onsuccess = () => {
      const e = req.result as Entry | undefined;
      if (!e) return;
      if ((e.rev ?? 0) === rev) s.delete(seq);
      else s.put({ ...e, lease: 0, direct: false });
    };
  });
}

/**
 * A change the server refused: changes made after it to the same rows can't
 * land either (they'd hit nothing), so they wait with it for the person to
 * decide (Try again sends them all, in order).
 */
async function holdDependents(failed: Entry) {
  const ids = new Set<string>();
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const m of failed.url.match(uuid) ?? []) ids.add(m.toLowerCase());
  if (failed.method === "POST" && failed.body?.t === "text") {
    try {
      const rows = JSON.parse(failed.body.v) as unknown;
      for (const r of (Array.isArray(rows) ? rows : [rows]) as Json[]) if (typeof r?.id === "string") ids.add(r.id.toLowerCase());
    } catch {
      /* not JSON */
    }
  }
  if (!ids.size) return;
  await tx("outbox", "readwrite", (t) => {
    const req = t.objectStore("outbox").openCursor(IDBKeyRange.lowerBound(failed.seq!, true));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const e = c.value as Entry;
      if (e.owner === failed.owner && e.state === "pending" && !(e.lease > Date.now())) {
        const text = `${e.url} ${e.body?.t === "text" ? e.body.v : ""}`.toLowerCase();
        if ([...ids].some((id) => text.includes(id))) {
          c.update({ ...e, state: "failed", error: `Waits on a change that couldn't be saved (${failed.label}).` });
        }
      }
      c.continue();
    };
  });
}

async function patchEntry(seq: number, patch: Partial<Entry>) {
  await tx("outbox", "readwrite", (t) => {
    const s = t.objectStore("outbox");
    const req = s.get(seq);
    req.onsuccess = () => {
      if (req.result) s.put({ ...(req.result as Entry), ...patch });
    };
  });
}

/** The oldest change of this account that hasn't been refused. */
async function firstPending(owner: string): Promise<Entry | null> {
  const box = await tx("outbox", "readonly", (t) => {
    const res: { e: Entry | null } = { e: null };
    const req = t.objectStore("outbox").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const e = c.value as Entry;
      if (e.owner === owner && e.state === "pending") {
        res.e = e;
        return;
      }
      c.continue();
    };
    return res;
  });
  return box.e;
}

/** Take an entry for sending, unless someone else already is. */
async function claim(seq: number, ms: number): Promise<Entry | null> {
  const now = Date.now();
  const box = await tx("outbox", "readwrite", (t) => {
    const res: { e: Entry | null } = { e: null };
    const s = t.objectStore("outbox");
    const req = s.get(seq);
    req.onsuccess = () => {
      const e = req.result as Entry | undefined;
      if (!e || e.state !== "pending" || e.lease > now) return;
      const next = { ...e, lease: now + ms, direct: false };
      s.put(next);
      res.e = next;
    };
    return res;
  });
  return box.e;
}

// --------------------------------------------------------------- status --

let status: OutboxStatus = { waiting: 0, failed: [], sending: false };
const statusSubs = new Set<() => void>();
let recountTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(next: Partial<OutboxStatus>) {
  status = { ...status, ...next };
  for (const f of statusSubs) f();
}

async function recount() {
  recountTimer = null;
  const owner = cfg?.owner();
  if (!owner) {
    setStatus({ waiting: 0, failed: [] });
    return;
  }
  try {
    const now = Date.now();
    const box = await tx("outbox", "readonly", (t) => {
      const res = { waiting: 0, failed: [] as FailedChange[] };
      const req = t.objectStore("outbox").openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const e = c.value as Entry;
        if (e.owner === owner) {
          if (e.state === "failed") res.failed.push({ seq: e.seq!, label: e.label, detail: e.detail, error: e.error ?? "Refused", at: e.at });
          else if (!(e.direct && e.lease > now)) res.waiting++;
        }
        c.continue();
      };
      return res;
    });
    setStatus(box);
    rememberWaiting(owner, box.waiting);
  } catch {
    /* no IndexedDB: nothing to show */
  }
}

// A flag in localStorage (read synchronously at startup): changes were left
// waiting, so the app sends them before it fetches anything.
const WAITING_FLAG = "iklipse.outbox.waiting";

function rememberWaiting(owner: string, n: number) {
  try {
    if (n > 0) localStorage.setItem(WAITING_FLAG, JSON.stringify({ owner, n }));
    else localStorage.removeItem(WAITING_FLAG);
  } catch {
    /* storage blocked */
  }
}

/** Changes of the signed-in account were waiting when the app last ran. */
export function hadWaitingChanges(): boolean {
  try {
    const raw = localStorage.getItem(WAITING_FLAG);
    if (!raw) return false;
    const v = JSON.parse(raw) as { owner?: string; n?: number };
    return !!v.n && v.owner === cfg?.owner();
  } catch {
    return false;
  }
}

function changed(broadcast = true) {
  if (!recountTimer) recountTimer = setTimeout(() => void recount(), 60);
  if (broadcast) channel?.postMessage({ type: "changed", from: tabId });
}

export function getOutboxStatus(): OutboxStatus {
  return status;
}

export function useOutboxStatus(): OutboxStatus {
  return useSyncExternalStore(
    (f) => {
      statusSubs.add(f);
      return () => statusSubs.delete(f);
    },
    () => status,
    () => status,
  );
}

type OutboxEvent = { type: "failed"; change: FailedChange } | { type: "synced"; count: number };
const eventSubs = new Set<(e: OutboxEvent) => void>();
export function onOutboxEvent(fn: (e: OutboxEvent) => void): () => void {
  eventSubs.add(fn);
  return () => eventSubs.delete(fn);
}
const emit = (e: OutboxEvent) => eventSubs.forEach((f) => f(e));

// ---------------------------------------------------------------- queue --

let draining: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 2000;
let sentThisRun = 0;
const idleWaiters = new Set<() => void>();

function retryIn(ms: number) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    kick();
  }, ms);
}

/** Send whatever is waiting (if we're online). Safe to call any time. */
export function kick(): Promise<void> {
  if (!cfg) return Promise.resolve();
  if (!draining) draining = runDrain().finally(() => (draining = null));
  return draining;
}

async function runDrain() {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    // One tab sends at a time; the others leave it to that one.
    await navigator.locks.request("iklipse-outbox", { ifAvailable: true }, async (lock) => {
      if (!lock) {
        retryIn(1500);
        return;
      }
      await drainLoop();
    });
  } else {
    await drainLoop();
  }
}

type Verdict = "done" | "later" | "auth" | "fail";

async function judge(e: Entry, res: Response): Promise<{ v: Verdict; error?: string }> {
  if (res.ok) return { v: "done" };
  if (TRANSIENT.has(res.status)) return { v: "later" };
  let info: { code?: string; message?: string; error?: string; msg?: string; details?: string } = {};
  try {
    info = (await res.clone().json()) as typeof info;
  } catch {
    /* not JSON */
  }
  const message = info.message ?? info.msg ?? info.error ?? `The server answered ${res.status}`;
  if (res.status === 401 || /jwt/i.test(message)) return { v: "auth", error: message };
  // Already saved by an earlier try whose answer got lost: the row's own key
  // is taken. Any other unique rule broken is a real refusal.
  if (e.method === "POST" || e.method === "PUT") {
    const path = new URL(e.url).pathname;
    if (path.includes("/storage/v1/object/") && /already exists|duplicate/i.test(message)) return { v: "done" };
    const table = path.match(/\/rest\/v1\/([a-z0-9_]+)$/)?.[1];
    if (info.code === "23505" && table) {
      const cols = info.details?.match(/Key \(([^)]*)\)=/)?.[1]?.replace(/\s+/g, "");
      if (!cols || cols === (PRIMARY_KEYS[table] ?? "id")) return { v: "done" };
    }
  }
  if (res.status >= 500) return { v: e.tries < 4 ? "later" : "fail", error: message };
  return { v: "fail", error: message };
}

async function transmit(e: Entry, token: string): Promise<Response> {
  const h = new Headers(e.headers);
  h.set("apikey", cfg!.anonKey);
  h.set("Authorization", `Bearer ${token}`);
  const signal = AbortSignal.timeout(e.body?.t === "form" ? UPLOAD_TIMEOUT_MS : SEND_TIMEOUT_MS);
  return fetch(e.url, { method: e.method, headers: h, body: restoreBody(e.body), signal });
}

async function drainLoop() {
  sentThisRun = 0;
  let authRetried = false;
  setStatus({ sending: true });
  try {
    for (;;) {
      if (!isOnline() || !cfg) return;
      const owner = cfg.owner();
      if (!owner) return;
      const first = await firstPending(owner);
      if (!first) {
        retryDelay = 2000;
        if (sentThisRun) emit({ type: "synced", count: sentThisRun });
        for (const f of idleWaiters) f();
        idleWaiters.clear();
        return;
      }
      // An older change is still on its way from a screen: keep the order.
      if (first.direct && first.lease > Date.now()) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      const sess = await cfg.session().catch(() => null);
      if (!sess || sess.uid !== owner) {
        // The token couldn't be refreshed just now: try again shortly.
        if (isOnline()) retryIn(retryDelay);
        return;
      }
      const e = await claim(first.seq!, first.body?.t === "form" ? UPLOAD_LEASE_MS : DIRECT_LEASE_MS);
      if (!e) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      let res: Response;
      try {
        res = await transmit(e, sess.token);
      } catch {
        reportOffline();
        await patchEntry(e.seq!, { lease: 0 });
        retryIn(retryDelay);
        retryDelay = Math.min(60_000, retryDelay * 2);
        return;
      }
      reportOnline();
      const { v, error } = await judge(e, res);
      if (v === "done") {
        await finish(e.seq!, e.rev ?? 0);
        sentThisRun++;
        authRetried = false;
        changed();
        continue;
      }
      if (v === "auth" && !authRetried) {
        authRetried = true;
        await patchEntry(e.seq!, { lease: 0 });
        await cfg.refresh().catch(() => undefined);
        continue;
      }
      if (v === "later" || v === "auth") {
        await patchEntry(e.seq!, { lease: 0, tries: e.tries + 1 });
        retryIn(retryDelay);
        retryDelay = Math.min(60_000, retryDelay * 2);
        return;
      }
      await patchEntry(e.seq!, { lease: 0, state: "failed", error, status: res.status, tries: e.tries + 1 });
      await holdDependents(e).catch(() => undefined);
      emit({ type: "failed", change: { seq: e.seq!, label: e.label, detail: e.detail, error: error ?? "Refused", at: e.at } });
      changed();
    }
  } catch {
    // IndexedDB trouble: try again in a while.
    retryIn(15_000);
  } finally {
    setStatus({ sending: false });
    changed(false);
  }
}

/**
 * Resolves once nothing of this account is waiting (or after `maxMs`), so a
 * reconnect can read server data that already includes the queued changes.
 */
export async function whenSent(maxMs = 20_000): Promise<void> {
  const owner = cfg?.owner();
  if (!owner) return;
  let waiting: boolean;
  try {
    waiting = (await firstPending(owner)) !== null;
  } catch {
    return;
  }
  if (!waiting) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      idleWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, maxMs);
    idleWaiters.add(done);
    void kick();
  });
}

// --------------------------------------------------------------- fetch --

function isAbort(e: unknown) {
  return e instanceof DOMException && e.name === "AbortError";
}

/** Thrown for a request that needs the network when there is none. */
export class OfflineError extends Error {
  constructor() {
    super("This needs an internet connection.");
    this.name = "Offline";
  }
}

/** A request that isn't queued: sent as is; network trouble is reported. */
async function pass(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(input, init);
    reportOnline();
    return res;
  } catch (e) {
    if (isAbort(e)) throw e;
    reportOffline();
    throw new OfflineError();
  }
}

/**
 * Writes this tab sends straight away go one after another: if one is cut off
 * and queued, nothing made after it can reach the server first (an older
 * value landing over a newer one). Uploads run on their own: nothing waits on
 * them except the screen that started them.
 */
let sendChain: Promise<void> = Promise.resolve();

/** The caller's abort signal plus our timeout; tells which one fired. */
function withTimeout(init: RequestInit, ms: number): { init: RequestInit; timedOut: () => boolean } {
  const timer = AbortSignal.timeout(ms);
  const own = init.signal;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (own && !any) return { init, timedOut: () => false };
  return { init: { ...init, signal: own ? any!([own, timer]) : timer }, timedOut: () => timer.aborted && !own?.aborted };
}

/** The fetch supabase-js uses (see supabase.ts). */
export async function outboxFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!cfg || input instanceof Request) return pass(input, init);
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return pass(input, init);
  const url = new URL(String(input));
  const op = classify(url, method, init);
  const owner = op && cfg.owner();
  if (!op || !owner) return pass(input, init);
  const body = storeBody(op.body);
  if (body === undefined) return pass(op.url, { ...init, body: op.body });
  const upload = body?.t === "form";

  // Wait for this tab's earlier writes to be answered (or queued).
  let release = () => {};
  if (!upload) {
    const before = sendChain;
    sendChain = new Promise<void>((r) => (release = r));
    await before;
  }
  try {
    const queueNow = !isOnline() || (await hasBacklog(owner).catch(() => false));
    const entry: Entry = {
      owner,
      at: Date.now(),
      url: op.url.href,
      method,
      headers: keepHeaders(op.headers),
      body,
      label: op.label,
      detail: op.detail,
      merge: op.merge,
      state: "pending",
      lease: queueNow ? 0 : Date.now() + (upload ? UPLOAD_LEASE_MS : DIRECT_LEASE_MS),
      direct: !queueNow,
      rev: 0,
      tries: 0,
    };

    let seq: number;
    try {
      if (queueNow && entry.merge && (await foldIntoTail(entry))) {
        changed();
        return queuedReply(op);
      }
      seq = await add(entry);
    } catch {
      // No room on the device. Online: send it the old way. Offline: say so,
      // rather than pretend it was kept.
      if (queueNow) throw new Error("Couldn't keep this change on the device (its storage is full or blocked).");
      return pass(op.url, { ...init, body: op.body });
    }
    changed();
    if (queueNow) {
      void kick();
      return queuedReply(op);
    }

    // Online with nothing waiting: send it now. The stored copy covers the app
    // closing or the connection dropping before the answer comes back.
    const t = withTimeout({ ...init, body: op.body }, upload ? UPLOAD_TIMEOUT_MS : SEND_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(op.url, t.init);
    } catch (e) {
      if (isAbort(e) && !t.timedOut()) {
        // The screen cancelled it: drop it, as it asked.
        await remove(seq).catch(() => undefined);
        changed();
        throw e;
      }
      reportOffline();
      await patchEntry(seq, { lease: 0, direct: false }).catch(() => undefined);
      changed();
      return queuedReply(op);
    }
    reportOnline();
    // Try again later rather than lose it: a server hiccup, or a login token
    // that needs refreshing (the queue refreshes it).
    if (TRANSIENT.has(res.status) || res.status === 401) {
      await patchEntry(seq, { lease: 0, direct: false, tries: 1 }).catch(() => undefined);
      changed();
      if (res.status === 401) void cfg.refresh().catch(() => undefined);
      retryIn(retryDelay);
      return queuedReply(op);
    }
    // Answered (saved, or refused: the screen shows the refusal itself).
    await finish(seq, 0).catch(() => undefined);
    changed();
    return res;
  } finally {
    release();
  }
}

// ------------------------------------------------------------ for screens --

/** Was this answer made up by the outbox (the write is queued, not yet saved)? */
export const isQueued = (status: number) => status === 202;

/** Try the refused changes again (all, or one). */
export async function retryFailed(seq?: number) {
  const owner = cfg?.owner();
  if (!owner) return;
  await tx("outbox", "readwrite", (t) => {
    const req = t.objectStore("outbox").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const e = c.value as Entry;
      if (e.owner === owner && e.state === "failed" && (seq === undefined || e.seq === seq)) {
        c.update({ ...e, state: "pending", lease: 0, tries: 0, error: undefined });
      }
      c.continue();
    };
  });
  changed();
  void kick();
}

/** Drop refused changes (all, or one): the server keeps what it has. */
export async function discardFailed(seq?: number) {
  const owner = cfg?.owner();
  if (!owner) return;
  await tx("outbox", "readwrite", (t) => {
    const req = t.objectStore("outbox").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const e = c.value as Entry;
      if (e.owner === owner && e.state === "failed" && (seq === undefined || e.seq === seq)) c.delete();
      c.continue();
    };
  });
  changed();
}

/** A file still waiting to upload (shown from the device meanwhile). */
export async function queuedUpload(bucket: string, path: string): Promise<Blob | null> {
  const tail = `/storage/v1/object/${bucket}/${path}`;
  const owner = cfg?.owner();
  if (!owner) return null;
  try {
    const box = await tx("outbox", "readonly", (t) => {
      const res: { blob: Blob | null } = { blob: null };
      const req = t.objectStore("outbox").openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const e = c.value as Entry;
        if (e.owner === owner && e.method !== "DELETE" && decodeURIComponent(new URL(e.url).pathname).endsWith(tail) && e.body) {
          if (e.body.t === "blob") res.blob = e.body.v;
          else if (e.body.t === "form") res.blob = (e.body.v.find((p) => typeof p[1] !== "string")?.[1] as Blob) ?? null;
          if (res.blob) return;
        }
        c.continue();
      };
      return res;
    });
    return box.blob;
  } catch {
    return null;
  }
}

/** Wire the outbox to the Supabase client and start sending what's waiting. */
export function configureOutbox(c: Config) {
  cfg = c;
  onConnectivity((online) => {
    if (online) {
      retryDelay = 2000;
      void kick();
    }
  });
  channel?.addEventListener("message", (ev: MessageEvent<{ type?: string; from?: string }>) => {
    if (ev.data?.type !== "changed" || ev.data.from === tabId) return;
    changed(false);
    // Another tab queued something: whoever holds the lock sends it.
    if (isOnline()) retryIn(800);
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        changed(false);
        if (isOnline()) void kick();
      }
    });
  }
  changed(false);
  // Leftovers from last time (the app was closed with changes waiting).
  setTimeout(() => void kick(), 1500);
}

/** Changes of this account still on the device (for the sign-out warning). */
export async function waitingCount(): Promise<number> {
  await recount();
  return status.waiting + status.failed.length;
}
