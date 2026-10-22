// Questions from the team, looked up in iklipse itself. answerQuestion
// (orders.ts) gives what's going on now; anything else (Trello boards and
// cards, Miro, projects, deliveries, clients, mail, WhatsApp and Slack,
// meetings and their transcripts, attendance, invoices...) Claude finds with
// the find tool, a few lookups at most, then answers. There is no SQL: find
// reads one table from the list below, only its listed columns (never a token
// or a key), with simple filters. What each person may read follows what
// iklipse shows them: admins everything admins see, members the boards they're
// on and their own attendance, nobody anyone else's mail or Fireflies meetings
// unless it's shared with them, money only for admins, guests nothing.

import { cairoOffset, claudeTurn, str, type ClaudeTool, type Db, type Settings } from "./kit.ts";

/** Lookups before it has to answer. */
const STEPS = 8;
/** What one lookup gives back, at most (characters of JSON). */
const MAX_OUT = 14_000;
const NONE = "00000000-0000-0000-0000-000000000000";

type Scope =
  | "boards" // board_id on a board they can see (members)
  | "board" // the board itself
  | "cards" // only with a card_id filter, on a board they can see (members)
  | "mail" // accounts that are theirs or shared with them to read (everyone)
  | "fireflies" // meetings on their accounts or shared with them (everyone)
  | "own" // their own rows (members)
  | "mine"; // their own rows (everyone)

interface Spec {
  about: string;
  cols: string;
  /** Columns only admins get. */
  adminCols?: string;
  admin?: true;
  scope?: Scope;
}

const TABLES: Record<string, Spec> = {
  // people
  profile: { about: "the team: display_name, role admin/member/guest, is_active", cols: "id,username,display_name,role,is_active,created_at,trello_role,miro_role,brief_role,delivery_role" },
  profile_contact: { about: "a team member's WhatsApp number and email", cols: "user_id,whatsapp,email" },
  client: { about: "clients: name, company, email, phone, notes; from_chat is their WhatsApp group", cols: "id,name,company,email,phone,notes,created_at,updated_at,from_chat" },
  // projects and deliveries
  project: { about: "projects of clients: status active/on_hold/done..., due_at, delivered_at", cols: "id,client_id,title,description,status,priority,start_on,due_at,delivered_at,created_by,created_at,updated_at", adminCols: "cost,currency" },
  project_member: { about: "who's on a project and as what", cols: "project_id,user_id,role,added_at" },
  project_delivery: { about: "a project's deliverables: due_at, who (assignee_id), done_at", cols: "id,project_id,title,due_at,assignee_id,done_at,done_by,created_at" },
  project_note: { about: "notes on a project", cols: "id,project_id,author_id,body,created_at" },
  project_file: { about: "files on a project", cols: "id,project_id,delivery_id,name,mime_type,size,external_url,delivered,uploaded_by,created_at" },
  project_invoice: { about: "invoices to clients for a project: amount, issued, due, paid", cols: "id,project_id,number,amount,currency,issued_on,due_on,paid_on,note,file_name,created_at", admin: true },
  delivery_folder: { about: "work sent to a client for review (Deliveries): state, round", cols: "id,title,note,project_id,round,state,created_by,created_at,updated_at" },
  delivery_round: { about: "each review round of a delivery: outcome, the client's note, when submitted", cols: "id,folder_id,number,opened_at,opened_by,outcome,submitted_at,submitted_name,submitted_email,client_note,closed_at,closed_by" },
  delivery_item: { about: "the files in a delivery", cols: "id,folder_id,kind,name,external_url,mime_type,size,added_round,removed_at,created_by,created_at" },
  delivery_comment: { about: "the client's and team's comments on delivery files (at_seconds: a time in a video)", cols: "id,folder_id,item_id,round,body,at_seconds,guest,author_id,author_name,author_email,resolved_at,created_at" },
  // Trello and Miro
  board: { about: "boards: kind kanban (Trello) or whiteboard (Miro)", cols: "id,title,description,is_archived,visibility,kind,created_by,created_at,updated_at", scope: "board" },
  board_member: { about: "who's on a board and their role", cols: "board_id,user_id,role,wb_role", scope: "boards" },
  list: { about: "Trello lists on a board (is_done: a done column)", cols: "id,board_id,title,position,is_archived,is_done,created_at,updated_at", scope: "boards" },
  card: { about: "Trello cards: title, description, list, due_date, due_completed", cols: "id,board_id,list_id,short_id,title,description,start_date,due_date,due_completed,is_archived,created_by,created_at,updated_at", scope: "boards" },
  card_member: { about: "who's on a card", cols: "card_id,user_id,board_id", scope: "boards" },
  label: { about: "a board's labels", cols: "id,board_id,name,color", scope: "boards" },
  card_label: { about: "a card's labels", cols: "card_id,label_id,board_id", scope: "boards" },
  activity: { about: "what happened on boards and cards (moved, renamed, done...)", cols: "id,board_id,card_id,actor_id,action,data,created_at", scope: "boards" },
  custom_field_def: { about: "a board's custom fields", cols: "id,board_id,name,type,options", scope: "boards" },
  comment: { about: "comments on a card", cols: "id,card_id,author_id,body,created_at,parent_id", scope: "cards" },
  checklist: { about: "a card's checklists", cols: "id,card_id,name", scope: "cards" },
  checklist_item: { about: "checklist items (completed, assignee_id, due_date)", cols: "id,checklist_id,card_id,text,completed,assignee_id,due_date", scope: "cards" },
  attachment: { about: "files on a card", cols: "id,card_id,name,mime_type,size,external_url,uploaded_by,created_at", scope: "cards" },
  custom_field_value: { about: "a card's custom field values", cols: "card_id,field_id,value", scope: "cards" },
  wb_item: { about: "what's on a Miro board: stickies, text, shapes, frames (the words are in data)", cols: "id,board_id,type,data,frame_id,created_by,updated_by,created_at,updated_at", scope: "boards" },
  wb_comment: { about: "comments on a Miro board", cols: "id,board_id,item_id,author_id,body,resolved,created_at,guest_name", scope: "boards" },
  // WhatsApp, Slack, alerts, orders, meetings
  wa_group: { about: "WhatsApp groups (kind client/team), project_id links one to a project", cols: "chat_id,name,monitored,size,left_at,last_message_at,kind,project_id" },
  wa_participant: { about: "who's in each WhatsApp group", cols: "chat_id,phone,name,is_admin" },
  wa_message: { about: "messages in the WhatsApp groups (voice notes written out)", cols: "id,chat_id,sender_name,phone,from_bot,text,quoted_id,sent_at" },
  wa_dm_chat: { about: "the bot's private WhatsApp chats", cols: "chat_id,phone,name,last_message_at" },
  wa_dm: { about: "messages in the bot's private chats (from_bot: the bot)", cols: "id,chat_id,from_bot,sender_name,text,quoted_id,sent_at" },
  wa_file: { about: "files sent on WhatsApp, with the words read out of them (text)", cols: "id,chat_id,kind,mime,name,text,created_at" },
  slack_channel: { about: "Slack channels", cols: "channel_id,name,is_private,monitored,last_message_at" },
  slack_message: { about: "Slack messages", cols: "channel_id,ts,slack_id,thread_ts,text,sent_at" },
  watch_alert: { about: "alerts: messages waiting for an answer, promises, deadlines (status open/handled/stopped)", cols: "id,chat_id,kind,title,detail,person,priority,status,due_at,alerts_sent,calls_made,snoozed_until,closed_at,closed_by,close_note,created_at,source,mail_subject,mail_from,channel_id" },
  watch_event: { about: "what happened on an alert (sent, called, answered, closed)", cols: "id,alert_id,at,what,detail,user_id" },
  watch_recipient: { about: "who each alert goes to", cols: "alert_id,user_id,calls,answered" },
  bot_order: { about: "orders the team gave the bot (tell or ask someone): status, outcome", cols: "id,by_name,order_text,kind,to_kind,to_name,task,status,times,outcome,closed_at,created_at" },
  wa_bot_meeting: { about: "meetings booked on Calendly (status booked/deleted)", cols: "event_id,owner,topic,start_at,minutes,join_url,status,invitee_email,invitee_name,source,attendees,created_at,updated_at" },
  fireflies_meeting: { about: "recorded meetings (Fireflies): summary, who was in it, the transcript (sentences)", cols: "id,account_id,title,started_at,duration,organizer_email,participants,attendees,speakers,meeting_link,summary,sentences", scope: "fireflies" },
  // mail
  gmail_account: { about: "connected Gmail accounts (which address an account_id is)", cols: "id,user_id,email,name,connected_at" },
  mail_thread: { about: "email threads on the watched Gmail accounts (verdict: what the bot made of it)", cols: "account_id,thread_id,subject,verdict,pending_since,note,created_at", scope: "mail" },
  mail_message: { about: "the emails themselves: from, to (addrs), subject, body", cols: "id,account_id,thread_id,from_addr,from_name,addrs,subject,body,sent_at", scope: "mail" },
  // attendance, money, the rest
  work_session: { about: "attendance: logged in (started_at) and out (ended_at); auto_closed: didn't log out", cols: "id,user_id,started_at,ended_at,auto_closed", scope: "own" },
  work_break: { about: "breaks during a work session", cols: "id,session_id,user_id,started_at,ended_at", scope: "own" },
  invoice: { about: "invoices and receipts that came by email (subscriptions, tools): amount, provider, month", cols: "id,status,sender_name,sender_email,subject,received_at,is_refund,provider,invoice_number,description,purchaser_email,invoice_date,amount,currency,month", admin: true },
  audit_log: { about: "who changed what in iklipse", cols: "id,at,actor_name,action,area,entity,label,changes", admin: true },
  notification: { about: "their own notifications", cols: "id,user_id,board_id,card_id,kind,data,read_at,created_at", scope: "mine" },
};

const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "ilike", "in", "is"] as const;

const FIND_TOOL: ClaudeTool = {
  name: "find",
  description: "Read rows from one table of iklipse. Several finds in one turn run together.",
  input_schema: {
    type: "object",
    properties: {
      table: { type: "string", enum: Object.keys(TABLES) },
      columns: { type: "array", items: { type: "string" }, description: "The columns to get; all when empty." },
      where: {
        type: "array",
        description: "Filters, all of them must hold. ilike: contains (case doesn't matter). in: value is a list. is: value null, true or false.",
        items: {
          type: "object",
          properties: { column: { type: "string" }, op: { type: "string", enum: [...OPS] }, value: {} },
          required: ["column", "op", "value"],
        },
      },
      search: {
        type: "object",
        description: "Words in any of these columns (case doesn't matter).",
        properties: { columns: { type: "array", items: { type: "string" } }, text: { type: "string" } },
        required: ["columns", "text"],
      },
      order: { type: "object", properties: { column: { type: "string" }, desc: { type: "boolean" } }, required: ["column"] },
      limit: { type: "integer", description: "At most 100; 30 when not given." },
      count: { type: "boolean", description: "Only how many rows match." },
    },
    required: ["table"],
  },
};

const REPLY_TOOL: ClaudeTool = {
  name: "reply",
  description: "The answer to send them. Call it once, at the end.",
  input_schema: { type: "object", properties: { text: { type: "string", description: "The answer, in English." } }, required: ["text"] },
};

const catalog = Object.entries(TABLES)
  .map(([t, s]) => `- ${t}: ${s.about}. Columns: ${s.cols}${s.adminCols ? ` (admins also ${s.adminCols})` : ""}.${s.admin ? " Admins only." : ""}${s.scope === "cards" ? " Members must filter it by card_id (find the cards first)." : ""}`)
  .join("\n");

const LOOK_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team asked you something. The message gives what's going on now: open alerts, meetings, orders, deliveries soon, who's working today, and the people and projects named, with what they said. Everything else in iklipse you look up yourself with find, as many times as you need (several at once when they don't depend on each other), then answer with reply.

Never answer that you don't know before looking it up. Look in more than one place when the first finds nothing: a name may be a client, a project, a card, a group; spelling differs (Arabic or English, part of a name). Only when it really isn't in iklipse, say so in a few words and where you looked. When find says something is for admins, or isn't shared with them, say that.

The tables:
${catalog}

How things connect: ids (user_id, author_id, assignee_id, created_by, owner, actor_id...) are people in profile; client_id is client; project_id is project; a Trello board (kind kanban) has lists, and lists have cards (card.list_id); a card's people are card_member, its words are comment, its to-dos checklist_item; a Miro board is board kind whiteboard and its contents are wb_item. A WhatsApp group's chat_id ties wa_group, wa_message, wa_participant and alerts (watch_alert.chat_id). Mail: mail_thread and mail_message by account_id and thread_id (gmail_account says whose address). Find results add a people list (id to name) and show times in Cairo time; to filter on a time, write it with Cairo's offset (now is in the message).

Answer: always English, short, the way a person texts: no greeting, no offer of more help; a short list only when it helps; Cairo time. They're on the team: share numbers and emails. Never invent anything that isn't in what you found.`;

// --------------------------------------------------------------- who asks --

interface Me {
  id: string;
  admin: boolean;
  /** Boards a member can see (admins: all). */
  boards: string[];
  /** Gmail accounts whose mail they can read. */
  mail: string[];
  /** Fireflies: their accounts, and meetings shared with them. */
  ffAccounts: string[];
  ffMeetings: string[];
}

async function whoAsks(db: Db, id: string): Promise<Me | null> {
  const { data: p } = await db.from("profile").select("id, role, is_active, trello_role, miro_role").eq("id", id).maybeSingle();
  if (!p?.is_active || p.role === "guest") return null;
  const admin = p.role === "admin";
  const [gm, gs, ffa, ffs, bm, bs] = await Promise.all([
    db.from("gmail_account").select("id").eq("user_id", id),
    db.from("gmail_share").select("account_id").eq("grantee_id", id).in("access", ["full", "read_send", "read"]),
    db.from("fireflies_account").select("id").eq("user_id", id),
    db.from("fireflies_share").select("meeting_id").eq("grantee_id", id),
    admin ? Promise.resolve({ data: [] }) : db.from("board_member").select("board_id").eq("user_id", id),
    admin ? Promise.resolve({ data: [] }) : db.from("board").select("id, kind, visibility"),
  ]);
  // Members: the boards they're on, and the workspace's open ones, of the products they have.
  const has = (kind: string) => ((kind === "whiteboard" ? p.miro_role : p.trello_role) ?? p.role) !== "none";
  const on = new Set(((bm.data ?? []) as { board_id: string }[]).map((r) => r.board_id));
  const boards = ((bs.data ?? []) as { id: string; kind: string; visibility: string }[])
    .filter((b) => has(b.kind) && (on.has(b.id) || b.visibility !== "private"))
    .map((b) => b.id);
  return {
    id,
    admin,
    boards,
    mail: [...new Set([...(gm.data ?? []), ...(gs.data ?? [])].map((r: { id?: string; account_id?: string }) => (r.id ?? r.account_id)!))],
    ffAccounts: ((ffa.data ?? []) as { id: string }[]).map((r) => r.id),
    ffMeetings: ((ffs.data ?? []) as { meeting_id: string }[]).map((r) => r.meeting_id),
  };
}

// ------------------------------------------------------------------ find --

interface Find {
  table?: string;
  columns?: string[];
  where?: { column?: string; op?: string; value?: unknown }[];
  search?: { columns?: string[]; text?: string };
  order?: { column?: string; desc?: boolean };
  limit?: number;
  count?: boolean;
}

class Refused extends Error {}

const prim = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/** A value inside a PostgREST or=(...) filter, quoted. */
const orValue = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Cairo time for a stored time ("2026-10-21T12:30:00+00:00" -> "2026-10-21T15:30:00+03:00"). */
function cairo(v: string) {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return v;
  const off = cairoOffset(new Date(ms));
  const mins = (off.startsWith("-") ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
  return `${new Date(ms + mins * 60_000).toISOString().slice(0, 19)}${off}`;
}

/** Long words cut, times in Cairo time, the people named. */
function tidy(rows: Record<string, unknown>[], names: Map<string, string>) {
  const people: Record<string, string> = {};
  const fix = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (names.has(v)) people[v] = names.get(v)!;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return cairo(v);
      return v.length > 1500 ? `${v.slice(0, 1500)}… (cut)` : v;
    }
    if (v && typeof v === "object") {
      const s = JSON.stringify(v);
      return s.length > 2500 ? `${s.slice(0, 2500)}… (cut)` : v;
    }
    return v;
  };
  const out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fix(v)])));
  return { rows: out, people };
}

async function find(db: Db, me: Me, f: Find, names: Map<string, string>): Promise<string> {
  const table = str(f.table);
  const spec = TABLES[table];
  if (!spec) throw new Refused(`There's no table ${table}.`);
  if (spec.admin && !me.admin) throw new Refused(`${table} is for admins only.`);
  const allowed = [...spec.cols.split(","), ...(me.admin && spec.adminCols ? spec.adminCols.split(",") : [])];
  const col = (c: unknown) => {
    const x = str(c);
    if (!allowed.includes(x)) throw new Refused(`${table} has no column ${x} you can read. Columns: ${allowed.join(", ")}.`);
    return x;
  };
  const cols = (f.columns ?? []).length ? [...new Set((f.columns ?? []).map(col))] : allowed;
  let q = db.from(table).select(cols.join(","), f.count ? { count: "exact", head: true } : undefined);

  for (const w of f.where ?? []) {
    const c = col(w.column);
    const op = str(w.op) as (typeof OPS)[number];
    const v = w.value;
    if (op === "in") {
      if (!Array.isArray(v) || !v.length || v.length > 200 || !v.every(prim)) throw new Refused("in takes a list of up to 200 values.");
      q = q.in(c, v as (string | number | boolean)[]);
    } else if (op === "is") {
      if (v !== null && v !== true && v !== false) throw new Refused("is takes null, true or false.");
      q = q.is(c, v as null | boolean);
    } else if (op === "ilike") {
      if (typeof v !== "string") throw new Refused("ilike takes words.");
      q = q.ilike(c, v.includes("%") ? v : `%${v}%`);
    } else if (OPS.includes(op)) {
      if (!prim(v)) throw new Refused(`${op} takes one value.`);
      q = q[op](c, v as string | number | boolean);
    } else {
      throw new Refused(`Unknown op ${op}.`);
    }
  }

  // Who may see what: added here, whatever was asked.
  const or: string[][] = [];
  if (f.search?.text && (f.search.columns ?? []).length) {
    const text = str(f.search.text).replace(/[*%]/g, " ").slice(0, 100);
    or.push((f.search.columns ?? []).map((c) => `${col(c)}.ilike.${orValue(`*${text}*`)}`));
  }
  const list = (xs: string[]) => `(${(xs.length ? xs : [NONE]).map(orValue).join(",")})`;
  switch (spec.scope) {
    case "board":
      if (!me.admin) q = q.in("id", me.boards.length ? me.boards : [NONE]);
      break;
    case "boards":
      if (!me.admin) q = q.in("board_id", me.boards.length ? me.boards : [NONE]);
      break;
    case "cards": {
      // Members: only cards on their boards, so by card_id. Admins see every board.
      if (me.admin) break;
      const ids = (f.where ?? []).filter((w) => str(w.column) === "card_id" && ["eq", "in"].includes(str(w.op))).flatMap((w) => (Array.isArray(w.value) ? w.value : [w.value])).map(String);
      if (!ids.length) throw new Refused(`Filter ${table} by card_id: find the cards first.`);
      const { data } = await db.from("card").select("id").in("id", ids).in("board_id", me.boards.length ? me.boards : [NONE]);
      if ((data ?? []).length < new Set(ids).size) throw new Refused("Some of those cards are on boards they aren't on.");
      break;
    }
    case "mail":
      q = q.in("account_id", me.mail.length ? me.mail : [NONE]);
      break;
    case "fireflies":
      or.push([`account_id.in.${list(me.ffAccounts)}`, `id.in.${list(me.ffMeetings)}`]);
      break;
    case "own":
      if (!me.admin) q = q.eq("user_id", me.id);
      break;
    case "mine":
      q = q.eq("user_id", me.id);
      break;
  }
  // Two "any of" groups must both hold: (a or b) and (c or d) = a&c or a&d or b&c or b&d.
  if (or.length === 1) q = q.or(or[0]!.join(","));
  else if (or.length === 2) q = q.or(or[0]!.flatMap((a) => or[1]!.map((b) => `and(${a},${b})`)).join(","));

  if (f.order?.column) q = q.order(col(f.order.column), { ascending: !f.order.desc, nullsFirst: false });
  q = q.limit(Math.max(1, Math.min(100, Math.floor(Number(f.limit) || 30))));

  const { data, error, count } = await q;
  if (error) throw new Refused(error.message);
  if (f.count) return JSON.stringify({ count });
  const { rows, people } = tidy((data ?? []) as unknown as Record<string, unknown>[], names);
  let shown = rows;
  let out = JSON.stringify({ rows: shown, people });
  while (out.length > MAX_OUT && shown.length > 1) {
    shown = shown.slice(0, Math.ceil(shown.length / 2));
    out = JSON.stringify({ rows: shown, people, cut: `${shown.length} of ${rows.length} rows: ask for fewer columns or rows` });
  }
  return out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}… (cut)` : out;
}

// ----------------------------------------------------------------- answer --

/**
 * The answer to a team member's question, looked up in iklipse as far as it
 * takes; null when they can't look things up (not on the team, a guest) or
 * Claude never answered.
 */
export async function lookUp(db: Db, s: Settings, asker: string, known: string, names: Map<string, string>): Promise<string | null> {
  const me = await whoAsks(db, asker);
  if (!me) return null;
  const messages: Record<string, unknown>[] = [{ role: "user", content: known }];
  for (let step = 0; step <= STEPS; step++) {
    // The last turn can only answer.
    const content = await claudeTurn(s.model, LOOK_SYSTEM, messages, step === STEPS ? [REPLY_TOOL] : [FIND_TOOL, REPLY_TOOL], 2000);
    const reply = content.find((c) => c.type === "tool_use" && c.name === "reply");
    if (reply) return str(reply.input?.text) || null;
    const finds = content.filter((c) => c.type === "tool_use" && c.name === "find");
    if (!finds.length) return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim() || null;
    messages.push({ role: "assistant", content });
    const results = await Promise.all(
      finds.map(async (c) => {
        try {
          return { type: "tool_result", tool_use_id: c.id, content: await find(db, me, (c.input ?? {}) as Find, names) };
        } catch (e) {
          const msg = e instanceof Refused ? e.message : "That lookup failed.";
          if (!(e instanceof Refused)) console.error("look", (e as Error).message);
          return { type: "tool_result", tool_use_id: c.id, content: msg, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return null;
}
