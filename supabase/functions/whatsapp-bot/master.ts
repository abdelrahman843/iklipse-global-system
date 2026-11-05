// The super admin's master agent (the relay on the VPS, personal/ in the repo)
// driving the bot: the bot does what it sends exactly as if the super admin
// had written to it privately, and what the bot says back comes back to the
// master instead of WhatsApp. Everyone else talks to the bot as before.
//
// POST /whatsapp-bot/master/<op>, signed with MASTER_SECRET (brain.ts
// signature, direction "master"), JSON:
//   task  { task_id, text, auto?, quoted? }  one task, as the super admin. The
//         sender is never taken from the request: it's always the one super
//         admin (0136). auto: the master asked by itself, so the bot only
//         reads (brain-tools.ts refuses any change). The same task_id twice is
//         one task.
//   poll  { after, tasks? }  what the bot said since (master_reply, by seq), and
//         how each task is doing: its state and the tools that actually ran.
//   words { id, text }  the super admin's own words, typed by them in the
//         master group: an OK ("yes 4821", "no"), stop or start (brain.ts
//         ownerSays), exactly as their private chat takes them.
// What would go to the super admin's private chat (OKs to give, the day's
// spend) goes to the master group instead (brain.ts ownerChats).

import { iso, str, type Db } from "./kit.ts";
import { brainEnv, brainOn, brainSettings, forward, signedBy, tierNow } from "./brain.ts";
import { MASTER_CHAT, masterOn, masterSecret } from "./master-env.ts";
import { note, seen, workerChecks, type Check } from "./connections.ts";

export { MASTER_CHAT, masterOn };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A task's message id: "master:<task_id>". */
export const taskMessage = (taskId: string) => `master:${taskId}`;
const taskOf = (messageId: string | null | undefined) => (str(messageId).startsWith("master:") ? str(messageId).slice(7) : null);

/**
 * What the bot says in the master group: kept for the relay to read, never
 * sent on WhatsApp. quotedId: the task's message, when it answers one.
 */
export async function masterOut(db: Db, text: string, quotedId?: string | null): Promise<string> {
  const task = taskOf(quotedId);
  const kind = /^OK needed\b/.test(text) ? "approval" : task ? "reply" : "notice";
  const { data, error } = await db.from("master_reply").insert({ task_id: task, kind, text: text.slice(0, 8000) }).select("seq").single();
  if (error) throw new Error(`master reply not kept: ${error.message}`);
  return `master-out:${(data as { seq: number }).seq}`;
}

export interface MasterHooks {
  /** The super admin's own words (brain.ts ownerSays through index.ts): true when they were one of them. */
  words: (o: { id: string; text: string; phone: string | null }) => Promise<boolean>;
  fetch?: typeof fetch;
  /** Telling the super admin a connection went down or came back. */
  tell?: (text: string, c: Check) => Promise<void>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function masterApi(req: Request, op: string, db: Db, hooks: MasterHooks, get?: (k: string) => string): Promise<Response> {
  if (!masterOn(get)) return json({ error: "The master channel isn't set up." }, 404);
  const body = await req.text();
  if (!(await signedBy(masterSecret(get), "master", body, req.headers.get("x-master-signature")))) return json({ error: "Forbidden" }, 403);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  try {
    if (op === "task") return json(await task(db, p, hooks));
    if (op === "poll") {
      // Its polling is the server's sign of life, and it says how its workers are (connections.ts).
      await seen(db, "master").catch(() => {});
      for (const c of workerChecks(p.health)) await note(db, c, hooks.tell ?? (async () => {})).catch(() => {});
      return json(await poll(db, p));
    }
    if (op === "words") return json(await words(db, p, hooks));
    return json({ error: "Unknown" }, 404);
  } catch (e) {
    console.error(JSON.stringify({ ev: "master.error", op, why: (e as Error).message }));
    return json({ ok: false, error: (e as Error).message }, 500);
  }
}

async function task(db: Db, p: Record<string, unknown>, hooks: MasterHooks) {
  const id = str(p.task_id);
  const text = str(p.text).trim();
  if (!UUID.test(id)) return { ok: false, error: "task_id: a UUID." };
  if (!text || text.length > 8000) return { ok: false, error: "text: 1 to 8000 characters." };
  const e = brainEnv();
  if (!brainOn(e)) return { ok: false, error: "The brain isn't on." };
  const bs = await brainSettings(db);
  if (!bs?.super_admin) return { ok: false, error: "No super admin is set (0136)." };
  // Always the one super admin, as they are now: never anyone the request names.
  const asker = await tierNow(db, bs, bs.super_admin);
  if (!asker || asker.tier !== "owner") return { ok: false, error: "The super admin can't use the bot right now." };
  const quoted = str(p.quoted).slice(0, 4000) || null;
  const r = await forward(
    db,
    e,
    { id: taskMessage(id), chatId: MASTER_CHAT, where: "private", text, quoted, quotedId: null, asker, replyChat: MASTER_CHAT, chatName: "master", tag: p.auto === true ? "master-auto" : "master" },
    hooks.fetch,
  );
  return r === "fallback" ? { ok: false, error: "The bot's brain didn't take it (down or slow). Try again in a bit." } : { ok: true, state: r === "duplicate" ? "already" : "sent" };
}

async function poll(db: Db, p: Record<string, unknown>) {
  const after = Math.max(0, Number(p.after) || 0);
  const { data: replies } = await db.from("master_reply").select("seq, task_id, kind, text, created_at").gt("seq", after).order("seq").limit(100);
  const ids = (Array.isArray(p.tasks) ? p.tasks : []).map((t) => str(t)).filter((t) => UUID.test(t)).slice(0, 50);
  const tasks: Record<string, unknown>[] = [];
  if (ids.length) {
    const { data: runs } = await db.from("brain_run").select("id, message_id, status, error, finished_at").in("message_id", ids.map(taskMessage));
    for (const r of (runs ?? []) as { id: string; message_id: string; status: string; error: string | null; finished_at: string | null }[]) {
      // What actually ran: the tools the brain used, and how each ended (the log, not the model's words).
      const { data: steps } = await db.from("brain_step").select("tool, outcome, detail").eq("run_id", r.id).order("at").limit(60);
      tasks.push({ task_id: taskOf(r.message_id), state: r.status, error: r.error, finished_at: r.finished_at, steps: steps ?? [] });
    }
  }
  return { ok: true, now: iso(), replies: replies ?? [], tasks };
}

async function words(db: Db, p: Record<string, unknown>, hooks: MasterHooks) {
  const text = str(p.text).trim();
  const id = str(p.id);
  if (!text || text.length > 200 || !/^[\w:-]{4,80}$/.test(id)) return { ok: false, error: "id and text." };
  const bs = await brainSettings(db);
  // Taken as the super admin's own: by one of their numbers (brain.ts fromOwner).
  const phone = bs?.owner_phones[0] ?? null;
  if (!phone) return { ok: false, error: "No super admin number." };
  const handled = await hooks.words({ id: `master-words:${id}`, text, phone });
  return { ok: true, handled };
}
