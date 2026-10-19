// Orders from the team groups (0090). Anyone in a team group (ours: everyone
// there can do anything) mentions the bot with an order: "@iklipse tell Rabah
// to send the logo files to Acme", "ask Sara when she's free", "book a meeting
// with Sara Sunday at 3". It carries it out without asking anyone for an OK,
// toward the team or clients: it writes to the person privately, and keeps
// after them (Settings: how often) until they say it's done, or what's in the
// way. A client gets at most so many messages (Settings); then the bot says so
// in the team group. Everything about an order is said there as a reply to it:
// sent, their answer, done, stuck, a question back (the team's reply to that
// goes to them). Meetings go to book.ts; the details the bot asked the team for
// to people.ts. No alerts for orders. Reminders only in working hours. Always
// English, short, the way a person texts.

import { cairoStamp, claude, iso, MIN, str, type ClaudeTool, type Db, type Settings, type Team } from "./kit.ts";
import { firstTime, takeAnswer, type Send } from "./people.ts";
import { directory } from "./meetings.ts";
import { botIds, named, orderedMeeting } from "./book.ts";

/** A team member's order is let go after this long without it getting done (it's said in the group). */
const TEAM_TTL_MS = 7 * 24 * 60 * MIN;

interface Order {
  id: string;
  chat_id: string;
  message_id: string;
  by_user: string | null;
  by_name: string | null;
  order_text: string;
  kind: "tell" | "ask";
  to_kind: "team" | "client";
  to_id: string | null;
  to_name: string;
  to_chat: string | null;
  task: string;
  nudge: string | null;
  status: string;
  times: number;
  next_at: string | null;
  sent_ids: string[];
  report_ids: string[];
  outcome: string | null;
  created_at: string;
  updated_at: string;
}
const COLS = "id, chat_id, message_id, by_user, by_name, order_text, kind, to_kind, to_id, to_name, to_chat, task, nudge, status, times, next_at, sent_ids, report_ids, outcome, created_at, updated_at";

/** "Sara" from "Sara Ahmed (Acme)" */
const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
/** "Sara, Rabah and Omar" */
const namesOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const quote = (t: string) => `"${t.replace(/\s+/g, " ").trim().slice(0, 600)}"`;

/** Says something in the team group about orders, as a reply to the order; kept so a reply to it carries on. */
async function report(db: Db, send: Send, at: { chat_id: string; message_id: string }, text: string, orders: Order[] = []) {
  const id = await send(at.chat_id, text, at.message_id);
  if (!id) return;
  for (const o of orders) {
    o.report_ids = [...o.report_ids, id];
    await db.from("bot_order").update({ report_ids: o.report_ids }).eq("id", o.id);
  }
}

/** Writes to the person about their order; kept so their reply finds it. */
async function toThem(db: Db, send: Send, o: Order, text: string, patch: Record<string, unknown> = {}) {
  if (!o.to_chat) return null;
  const id = await send(o.to_chat, text);
  o.sent_ids = id ? [...o.sent_ids, id] : o.sent_ids;
  await db.from("bot_order").update({ sent_ids: o.sent_ids, updated_at: iso(), ...patch }).eq("id", o.id);
  return id;
}

async function close(db: Db, o: Order, status: "done" | "blocked" | "stopped" | "no_answer", outcome: string | null) {
  const { data } = await db
    .from("bot_order")
    .update({ status, outcome: outcome?.slice(0, 2000) ?? o.outcome, closed_at: iso(), next_at: null, updated_at: iso() })
    .eq("id", o.id)
    .eq("status", "open")
    .select("id");
  return !!data?.length;
}

// ------------------------------------------------------------- an order --

const ORDER_TOOL: ClaudeTool = {
  name: "act",
  description: "What to do with the message.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["orders", "meeting", "answer", "stop", "status", "ignore", "none"] },
      orders: {
        type: "array",
        description: "orders: one per person.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tell", "ask"] },
            to: { type: "string", description: "Their ref from people." },
            task: { type: "string", description: "What they're to do, or what they're asked, short, in English." },
            message: { type: "string", description: "The first message to them, in English." },
            nudge: { type: "string", description: "The reminder, in English." },
          },
          required: ["kind", "to", "task", "message", "nudge"],
        },
      },
      stop: { type: "array", items: { type: "string" }, description: "stop: the ids of the open orders to stop." },
      reply: { type: "string", description: "none: the short question back, in English. Else empty." },
    },
    required: ["action"],
  },
};

const ORDER_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team mentioned you ("@iklipse") in the team's own group. Everyone there is on the team and can ask you anything. You carry out orders without asking anyone for an OK: you write to the person privately on WhatsApp, and keep after them until it's done. Decide what to do with the message and call act once. They write in English, Arabic, Egyptian Arabic or Franco-Arabic; everything you write is in English.

- orders: tell someone to do something ("tell Rabah to send the logo files", "قول لرباح يبعت الفايلات لأكمي", "remind Sara to send the content") is kind tell; ask someone something and bring the answer back ("ask Sara when she's free this week", "اسأل عمر خلص الفيديو ولا لسه") is kind ask. One order per person. to: their ref from people, never anyone else. task: what they're to do or what they're asked, short ("send the final logo files to Acme", "when she's free for a call this week"). message: the first message to them, the way a person texts. To someone on the team: "Hi <first name>, <first name of who asked> asks you to <task>." plus anything the order gives, then for tell "Reply here when it's done, or tell me what's in the way." To a client: speak for iklipse ("Hi Sara, ..."), only what the order says to tell or ask them, never a team member's name unless the order says it, nothing internal. nudge: the reminder if they don't answer, short ("Rabah, a reminder: Sameh asked you to send the logo files to Acme. Is it done?", "Hi Sara, just following up: when are you free for a call this week?"). Never invent a date, a file, a price or a promise.
- meeting: about meetings on Calendly: book one with someone, free times, move or cancel one, a booking link.
- answer: the message gives what you asked the team about people in the client groups (an email, a number, a name, "skip", "is Rabah"); only when details_asked is true.
- stop: stop open orders ("stop asking Sara", "خلاص سيبه", "cancel the one to Rabah"); stop lists their ids from open_orders.
- status: they ask what's still open ("what's left?", "ايه اللي لسه").
- ignore: nothing for you (thanks, ok, a remark to someone else).
- none: an order you can't carry out: who it's for isn't clear or isn't in people, or what to do isn't said. reply: a short question back ("Who's Ahmed?", "What should I tell Rabah?"). No greeting, no apology.`;

/**
 * An order in a team group (once per message). Done right away; what came of
 * it is said there, as a reply to it.
 */
export async function takeOrder(
  db: Db,
  s: Settings,
  t: Team,
  send: Send,
  o: { id: string; chatId: string; text: string; quoted: string | null; phone: string | null; lid: string | null; name: string | null },
  answerNow: (id: string) => Promise<void>,
) {
  if (!(await firstTime(db, `order:${o.id}`))) return;
  const at = { chat_id: o.chatId, message_id: o.id };
  const by = (o.phone ? t.byPhone.get(o.phone) : undefined) ?? (o.lid ? t.byLid.get(o.lid) : undefined);
  const byName = by?.name ?? o.name ?? "Someone on the team";
  const ids = s.bot_phone ? await botIds(db, s.bot_phone) : new Set<string>();
  const text = await named(db, o.chatId, o.text, ids);
  const quoted = o.quoted ? await named(db, o.chatId, o.quoted, ids) : null;

  const dir = await directory(db);
  const { data: cl } = await db.from("client").select("id, name, company, name_known, wa_group(name)").order("updated_at", { ascending: false }).limit(300);
  const people = [
    ...[...dir.team.values()].filter((a) => a.phone !== s.bot_phone).map((a) => ({ ref: `t:${a.id}`, name: a.name, who: "team", whatsapp: !!a.phone })),
    ...((cl ?? []) as unknown as { id: string; company: string | null; wa_group: { name: string | null } | null }[]).map((c) => {
      const a = dir.clients.get(c.id)!;
      return { ref: `c:${c.id}`, name: a.name, who: "client", ...(c.wa_group?.name ? { group: c.wa_group.name } : {}), whatsapp: !!a.phone };
    }),
  ];
  const { data: openRows } = await db.from("bot_order").select(COLS).eq("status", "open").order("created_at").limit(30);
  const open = (openRows ?? []) as Order[];
  const { data: asked } = await db.from("bot_ask_message").select("id").eq("chat_id", o.chatId).gt("sent_at", iso(Date.now() - 3 * 24 * 60 * MIN)).limit(1);

  const r = (await claude(
    s.model,
    ORDER_SYSTEM,
    JSON.stringify({
      now: `${cairoStamp.format(new Date())} Cairo time`,
      from: byName,
      message: text,
      ...(quoted ? { replying_to: quoted } : {}),
      details_asked: !!asked?.length,
      people,
      open_orders: open.map((x, i) => ({ id: `o${i + 1}`, to: x.to_name, kind: x.kind, task: x.task, since: cairoStamp.format(new Date(x.created_at)) })),
    }),
    ORDER_TOOL,
    2000,
  )) as { action?: string; orders?: { kind?: string; to?: string; task?: string; message?: string; nudge?: string }[]; stop?: string[]; reply?: string } | null;
  if (!r?.action) throw new Error("Claude gave no answer");

  switch (r.action) {
    case "ignore":
      return;
    case "none":
      return await report(db, send, at, str(r.reply) || "Didn't get that. Who's it for, and what should I tell them?");
    case "answer":
      await takeAnswer(db, s, t, { id: o.id, chatId: o.chatId, text: o.text, quotedId: null }, send);
      return;
    case "meeting": {
      if (!by) return await report(db, send, at, "I don't know who you are on iklipse, so I can't book on your Calendly. Link your number on the Users page.");
      if (!s.book_enabled) return await report(db, send, at, "Booking meetings from WhatsApp is off (Alerts > Settings).");
      if (await orderedMeeting(db, { id: o.id, chatId: o.chatId, text, quoted, userId: by.id })) await answerNow(o.id);
      return;
    }
    case "status": {
      if (!open.length) return await report(db, send, at, "Nothing open.");
      const lines = open.map(
        (x, i) => `${i + 1}. ${x.to_name}: ${x.task} (${x.kind === "ask" ? "asked" : "since"} ${cairoStamp.format(new Date(x.created_at))}${x.times > 1 ? `, ${x.times - 1} reminder${x.times === 2 ? "" : "s"}` : ""})`,
      );
      return await report(db, send, at, ["Open:", ...lines].join("\n"));
    }
    case "stop": {
      const hit = (r.stop ?? []).map((id) => open[Number(str(id).replace(/\D/g, "")) - 1]).filter((x): x is Order => !!x);
      if (!hit.length) return await report(db, send, at, "Which one? Nothing open matches.");
      const stopped: Order[] = [];
      for (const x of hit) {
        if (!(await close(db, x, "stopped", `Stopped by ${byName}`))) continue;
        stopped.push(x);
        // Someone on the team doesn't do it for nothing.
        if (x.kind === "tell" && x.to_kind === "team") await toThem(db, send, x, `No need to ${x.task} anymore.`).catch(() => null);
      }
      return await report(db, send, at, stopped.length ? `Stopped: ${stopped.map((x) => `${x.to_name} (${x.task})`).join("; ")}.` : "Already closed.");
    }
  }

  // Orders: written to each person now, then kept after.
  const made: Order[] = [];
  const problems: string[] = [];
  for (const x of r.orders ?? []) {
    const ref = str(x.to);
    const kind = x.kind === "ask" ? "ask" : "tell";
    const p = ref.startsWith("t:") ? dir.team.get(ref.slice(2)) : ref.startsWith("c:") ? dir.clients.get(ref.slice(2)) : undefined;
    if (!p || !str(x.message) || !str(x.task)) {
      problems.push(`Who's ${ref.replace(/^[tc]:/, "") || "that for"}?`);
      continue;
    }
    if (!p.phone) {
      problems.push(`I don't have ${p.name}'s WhatsApp number. Add it ${p.kind === "team" ? "on the Users page" : "in Clients (Projects)"}, then ask again.`);
      continue;
    }
    const { data: row, error } = await db
      .from("bot_order")
      .insert({
        chat_id: o.chatId,
        message_id: o.id,
        by_user: by?.id ?? null,
        by_name: byName,
        order_text: text.slice(0, 4000),
        kind,
        to_kind: p.kind === "team" ? "team" : "client",
        to_id: p.id,
        to_name: p.name,
        to_chat: `${p.phone}@c.us`,
        task: str(x.task).slice(0, 500),
        nudge: str(x.nudge).slice(0, 1000) || null,
        times: 1,
        next_at: iso(Date.now() + s.order_every_min * MIN),
      })
      .select(COLS)
      .single();
    if (error || !row) {
      problems.push(`Couldn't keep the order for ${p.name}.`);
      continue;
    }
    const ord = row as Order;
    try {
      await toThem(db, send, ord, str(x.message).replace(/[—–]/g, ", ").slice(0, 2000));
      made.push(ord);
    } catch (e) {
      await db.from("bot_order").update({ status: "failed", outcome: (e as Error).message.slice(0, 300), closed_at: iso(), next_at: null }).eq("id", ord.id);
      problems.push(`Couldn't send it to ${p.name}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const tells = made.filter((x) => x.kind === "tell").map((x) => first(x.to_name));
  const asks = made.filter((x) => x.kind === "ask").map((x) => first(x.to_name));
  const lines = [
    ...(tells.length ? [`Sent to ${namesOf(tells)}. I'll follow up until it's done.`] : []),
    ...(asks.length ? [`Asked ${namesOf(asks)}. I'll bring the answer here.`] : []),
    ...problems,
  ];
  if (!lines.length) lines.push("Didn't get that. Who's it for, and what should I tell them?");
  await report(db, send, at, lines.join("\n"), made);
}

// ------------------------------------------------------ their answer --

/** The open orders to this private chat. */
async function openTo(db: Db, chatId: string) {
  const { data } = await db.from("bot_order").select(COLS).eq("to_chat", chatId).eq("status", "open").order("created_at");
  return (data ?? []) as Order[];
}

/** When the bot last wrote to them about an open order (null: none open). */
export async function orderAt(db: Db, chatId: string): Promise<string | null> {
  const { data } = await db.from("bot_order").select("updated_at").eq("to_chat", chatId).eq("status", "open").order("updated_at", { ascending: false }).limit(1);
  return (data?.[0]?.updated_at as string | undefined) ?? null;
}

/** The message replied to is the bot's, about an order (to them, or in the team group). */
export async function orderOf(db: Db, quotedId: string | null, col: "sent_ids" | "report_ids"): Promise<Order | null> {
  if (!quotedId) return null;
  const { data } = await db.from("bot_order").select(COLS).contains(col, [quotedId]).order("created_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] as Order | undefined) ?? null;
}

const REPLY_TOOL: ClaudeTool = {
  name: "outcome",
  description: "What their message says about what they were asked.",
  input_schema: {
    type: "object",
    properties: {
      order: { type: "string", description: "The id of the order it's about (o1...)." },
      result: { type: "string", enum: ["done", "answer", "blocked", "later", "question", "other"] },
      text: { type: "string", description: "In English: done, what they said about it (empty if just done); answer, their answer, exactly what they mean; blocked, what's in the way; question, their question. Else empty." },
      until: { type: "string", description: "later: when they said they'll do it, ISO 8601 with the Cairo offset, if they said. Else empty." },
    },
    required: ["order", "result"],
  },
};

const REPLY_SYSTEM = `The iklipse bot (a creative and marketing agency's assistant on WhatsApp) wrote to someone privately because the team asked it to: to do something (tell), or to answer a question (ask). You get what it asked them (open orders), the last messages, and their new message. They write in English, Arabic, Egyptian Arabic or Franco-Arabic. Decide through the outcome tool:
- done: it's done ("done", "sent", "خلصت", "بعته", "تم").
- answer: an ask, answered ("Tuesday at 3 works", "الفيديو لسه هيخلص بكرة").
- blocked: they can't, or something is in the way ("I don't have the files", "مش هقدر", "مستني العميل").
- later: they will, not yet ("ok", "on it", "حاضر", "بعد الغدا").
- question: they ask something back about it that the team has to answer ("which files?", "أبعتها لمين؟").
- other: not about it.
Always answer by calling the outcome tool, once.`;

/**
 * Someone the bot wrote to about an order answering it privately. What it
 * says goes to the team group (done, an answer, what's in the way, a
 * question back); false: it isn't about an order (the caller carries on).
 */
export async function fromTarget(db: Db, s: Settings, send: Send, o: { id: string; chatId: string; text: string; quotedId: string | null }): Promise<boolean> {
  if (!(await firstTime(db, `target:${o.id}`))) return true;
  const quoted = await orderOf(db, o.quotedId, "sent_ids");
  const open = quoted?.status === "open" ? [quoted] : await openTo(db, o.chatId);
  if (!open.length) return false;
  const { data: rows } = await db.from("wa_dm").select("from_bot, text, sent_at").eq("chat_id", o.chatId).order("sent_at", { ascending: false }).limit(12);
  const r = (await claude(
    s.model,
    REPLY_SYSTEM,
    [
      "Open orders:",
      ...open.map((x, i) => `o${i + 1}: ${x.kind}; ${x.task} (from ${x.by_name ?? "the team"})`),
      "",
      "Last messages:",
      ...((rows ?? []) as { from_bot: boolean; text: string | null; sent_at: string }[])
        .reverse()
        .map((m) => `[${cairoStamp.format(new Date(m.sent_at))}] ${m.from_bot ? "BOT" : "THEM"}: ${str(m.text).replace(/\s+/g, " ").slice(0, 500)}`),
      "",
      `Their new message: ${o.text.slice(0, 2000)}`,
    ].join("\n"),
    REPLY_TOOL,
    800,
  )) as { order?: string; result?: string; text?: string; until?: string } | null;
  const x = open[Number(str(r?.order).replace(/\D/g, "")) - 1] ?? (open.length === 1 ? open[0] : undefined);
  if (!r || !x || r.result === "other" || !r.result) return false;
  const said = str(r.text);
  const name = first(x.to_name);
  const at = { chat_id: x.chat_id, message_id: x.message_id };

  switch (r.result) {
    case "done":
      if (await close(db, x, "done", said || "Done")) {
        await report(db, send, at, `${name} says it's done${said ? `: ${quote(said)}` : "."}`, [x]);
        await send(o.chatId, "Got it, thanks.", o.id);
      }
      return true;
    case "answer":
      if (await close(db, x, "done", said)) {
        await report(db, send, at, `${name}: ${quote(said || o.text)}`, [x]);
        await send(o.chatId, "Thanks, I'll pass it on.", o.id);
      }
      return true;
    case "blocked":
      if (await close(db, x, "blocked", said)) {
        await report(db, send, at, `${name} is stuck${said ? `: ${quote(said)}` : "."}`, [x]);
        await send(o.chatId, "OK, I told the team.", o.id);
      }
      return true;
    case "question":
      // Not reminded while the team answers.
      await db.from("bot_order").update({ next_at: iso(Date.now() + Math.max(s.order_every_min, 120) * MIN), updated_at: iso() }).eq("id", x.id);
      await report(db, send, at, `${name} asks: ${quote(said || o.text)}\nReply to this message and I'll pass it on.`, [x]);
      await send(o.chatId, "I'll ask the team and get back to you.", o.id);
      return true;
    case "later": {
      const when = Date.parse(str(r.until));
      const next = Number.isFinite(when) && when > Date.now() && when < Date.now() + 7 * 24 * 60 * MIN ? when + 10 * MIN : Date.now() + s.order_every_min * MIN;
      await db.from("bot_order").update({ next_at: iso(next), updated_at: iso() }).eq("id", x.id);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------- the team about it --

const FOLLOW_TOOL: ClaudeTool = {
  name: "follow",
  description: "What the team's reply means for the order.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["relay", "again", "done", "stop", "ignore"] },
      text: { type: "string", description: "relay: the message to send them, in English, keeping exactly what the team means, short, the way a person texts. Else empty." },
    },
    required: ["action"],
  },
};

const FOLLOW_SYSTEM = `The iklipse bot is carrying out an order from the team: it wrote privately to someone (to do something, or to answer a question) and reports in the team group. Someone on the team replied to one of those reports. They write in English, Arabic, Egyptian Arabic or Franco-Arabic. Decide through the follow tool:
- relay: something to tell the person: an answer to their question, more details, a change ("the ones in the Drive folder", "قوله يبعتها لسارة"). text: that message to them.
- again: remind them now ("remind him", "فكره تاني").
- done: it's done or not needed ("done", "خلاص اتعمل").
- stop: stop following it up ("stop", "سيبه", "cancel").
- ignore: nothing for the bot (thanks, ok, a remark).
Always answer by calling the follow tool, once.`;

/** The team replying in the group to the bot's report on an order. */
export async function followOrder(db: Db, s: Settings, send: Send, x: Order, o: { id: string; chatId: string; text: string }) {
  if (!(await firstTime(db, `follow:${o.id}`))) return;
  const { data: rows } = x.to_chat ? await db.from("wa_dm").select("from_bot, text, sent_at").eq("chat_id", x.to_chat).order("sent_at", { ascending: false }).limit(8) : { data: [] };
  const r = (await claude(
    s.model,
    FOLLOW_SYSTEM,
    [
      `The order (${x.kind}, to ${x.to_name}, ${x.status}): ${x.task}`,
      "",
      "The private chat with them:",
      ...((rows ?? []) as { from_bot: boolean; text: string | null; sent_at: string }[])
        .reverse()
        .map((m) => `${m.from_bot ? "BOT" : "THEM"}: ${str(m.text).replace(/\s+/g, " ").slice(0, 400)}`),
      "",
      `The team's reply: ${o.text.slice(0, 2000)}`,
    ].join("\n"),
    FOLLOW_TOOL,
    800,
  )) as { action?: string; text?: string } | null;
  const at = { chat_id: o.chatId, message_id: o.id };
  const name = first(x.to_name);
  switch (r?.action) {
    case "relay": {
      const text = str(r.text).replace(/[—–]/g, ", ");
      if (!text || !x.to_chat) return;
      // Back on: they have what they asked for.
      await toThem(db, send, x, text, x.status === "open" ? { next_at: iso(Date.now() + s.order_every_min * MIN) } : {});
      if (x.status === "blocked") await db.from("bot_order").update({ status: "open", closed_at: null, next_at: iso(Date.now() + s.order_every_min * MIN) }).eq("id", x.id);
      return await report(db, send, at, `Sent to ${name}.`, [x]);
    }
    case "again":
      if (x.status !== "open" || !x.nudge) return await report(db, send, at, "That one's closed.");
      await toThem(db, send, x, x.nudge, { times: x.times + 1, next_at: iso(Date.now() + s.order_every_min * MIN) });
      return await report(db, send, at, `Reminded ${name}.`, [x]);
    case "done":
      if (await close(db, x, "done", "Closed by the team")) await report(db, send, at, "OK, closed.");
      return;
    case "stop":
      if (await close(db, x, "stopped", "Stopped by the team")) await report(db, send, at, "OK, I stopped.");
      return;
  }
}

// ------------------------------------------------------------ reminders --

/** Orders nobody has answered: reminded every order_every_min (working hours only; the caller checks). */
export async function nagOrders(db: Db, s: Settings, send: Send, deadline: number) {
  const { data } = await db.from("bot_order").select(COLS).eq("status", "open").lte("next_at", iso()).order("next_at").limit(10);
  let n = 0;
  for (const x of (data ?? []) as Order[]) {
    if (Date.now() > deadline) break;
    const at = { chat_id: x.chat_id, message_id: x.message_id };
    // A client gets so many messages at most; then the team hears it.
    if (x.to_kind === "client" && x.times >= s.order_client_max) {
      if (await close(db, x, "no_answer", null)) {
        await report(db, send, at, `${first(x.to_name)} hasn't answered after ${x.times} message${x.times === 1 ? "" : "s"}, so I stopped.`).catch(() => null);
      }
      continue;
    }
    if (x.to_kind === "team" && Date.now() - Date.parse(x.created_at) > TEAM_TTL_MS) {
      if (await close(db, x, "no_answer", null)) {
        await report(db, send, at, `${first(x.to_name)} still hasn't said it's done after a week, so I stopped reminding.`).catch(() => null);
      }
      continue;
    }
    try {
      await toThem(db, send, x, x.nudge || `A reminder: ${x.task}.`, { times: x.times + 1, next_at: iso(Date.now() + s.order_every_min * MIN) });
      n++;
    } catch (e) {
      await db.from("bot_order").update({ next_at: iso(Date.now() + s.order_every_min * MIN) }).eq("id", x.id);
      console.error("order nudge", (e as Error).message);
    }
  }
  return n;
}
