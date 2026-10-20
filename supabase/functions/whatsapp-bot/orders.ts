// Orders from the team (0090, 0093). Anyone in a team group (ours: everyone
// there can do anything), and anyone on the team in a client group or
// privately, talks to the bot: "@iklipse tell Rabah to send the logo files to
// Acme", "ask Sara when she's free", "book a meeting with Sara Sunday at 3",
// "what did Acme say about the logo?". It carries orders out without asking
// anyone for an OK, toward the team or clients: it writes to the person
// privately, and keeps after them (Settings: how often) until they say it's
// done, or what's in the way. A client gets at most so many messages
// (Settings); then the bot says so. Everything about an order is said where it
// was given, as a reply to it (from a client group: privately to whoever gave
// it): sent, their answer, done, stuck, a question back (the team's reply to
// that goes to them). Questions are answered from what iklipse knows. A
// booking link sent privately (book.ts) is followed up the same way, until they
// book. Meetings go to book.ts; the details the bot asked the team for to
// people.ts. No alerts for orders. Reminders only in working hours. Always
// English, short, the way a person texts.

import { cairoOffset, cairoStamp, claude, iso, MIN, str, TZ, type ClaudeTool, type Db, type Person, type Settings, type Team } from "./kit.ts";
import { firstTime, takeAnswer, type Send } from "./people.ts";
import { bookedSince, directory, type Attendee } from "./meetings.ts";
import { bookTurnAt, botIds, heardPrivate, named, orderedMeeting, peopleFor, privateChat } from "./book.ts";
import { historyOf } from "./history.ts";

/** A team member's order is let go after this long without it getting done (it's said in the group). */
const TEAM_TTL_MS = 7 * 24 * 60 * MIN;

interface Order {
  id: string;
  chat_id: string;
  message_id: string | null;
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
  book_url: string | null;
  created_at: string;
  updated_at: string;
}
const COLS = "id, chat_id, message_id, by_user, by_name, order_text, kind, to_kind, to_id, to_name, to_chat, task, nudge, status, times, next_at, sent_ids, report_ids, outcome, book_url, created_at, updated_at";

/** "Sara" from "Sara Ahmed (Acme)" */
const first = (n: string) => str(n).split(/[\s(]+/)[0] || n;
/** "Sara, Rabah and Omar" */
const namesOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const quote = (t: string) => `"${t.replace(/\s+/g, " ").trim().slice(0, 600)}"`;

/** Says something about orders where they were given, as a reply to the order when there's one; kept so a reply to it carries on. */
async function report(db: Db, send: Send, at: { chat_id: string; message_id: string | null }, text: string, orders: Order[] = []) {
  const id = await send(at.chat_id, text, at.message_id);
  if (!id) return;
  for (const o of orders) {
    o.report_ids = [...o.report_ids, id];
    await db.from("bot_order").update({ report_ids: o.report_ids }).eq("id", o.id);
  }
}

/** Writes to the person about their order (after the first, as a reply to it); kept so their reply finds it. */
async function toThem(db: Db, send: Send, o: Order, text: string, patch: Record<string, unknown> = {}) {
  if (!o.to_chat) return null;
  const id = await send(o.to_chat, text, o.sent_ids[0] ?? null);
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
      action: { type: "string", enum: ["orders", "meeting", "my_order", "question", "answer", "stop", "status", "ignore", "none"] },
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
            wait: { type: "boolean", description: "false when it only passes something on and nothing is needed back; true when they're to do something or answer." },
          },
          required: ["kind", "to", "task", "message", "nudge", "wait"],
        },
      },
      about: { type: "array", items: { type: "string" }, description: "question: the refs of the people and projects it's about, at most 3." },
      stop: { type: "array", items: { type: "string" }, description: "stop: the ids of the open orders to stop." },
      reply: { type: "string", description: "none: the short question back, in English. Else empty." },
    },
    required: ["action"],
  },
};

const ORDER_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team wrote to you: by mentioning you ("@iklipse") in a group, or privately ("where" says which). Everyone on the team can ask you anything and give you orders. You carry out orders without asking anyone for an OK: you write to the person privately on WhatsApp, and keep after them until it's done. Decide what to do with the message and call act once. They write in English, Arabic, Egyptian Arabic or Franco-Arabic; everything you write is in English.

- orders: tell someone to do something ("tell Rabah to send the logo files", "قول لرباح يبعت الفايلات لأكمي", "remind Sara to send the content") is kind tell; ask someone something and bring the answer back ("ask Sara when she's free this week", "اسأل عمر خلص الفيديو ولا لسه") is kind ask. Passing something on that needs nothing back ("قوله الميتنج اتأجلت لبكرة", "tell Sara the files are uploaded", "let Omar know I'm late") is kind tell with wait false: the message just says it ("Hi Omar, Sameh says he's running late."), with no "reply when it's done", and you don't follow up. Else wait is true. One order per person. to: their ref from people, never anyone else. task: what they're to do or what they're asked, short ("send the final logo files to Acme", "when she's free for a call this week"). message: the first message to them, the way a person texts. To someone on the team: "Hi <first name>, <first name of who asked> asks you to <task>." plus anything the order gives, then for tell with wait true "Reply here when it's done, or tell me what's in the way." To a client: speak for iklipse ("Hi Sara, ..."), only what the order says to tell or ask them, never a team member's name unless the order says it, nothing internal. nudge: the reminder if they don't answer, short ("Rabah, a reminder: Sameh asked you to send the logo files to Acme. Is it done?", "Hi Sara, just following up: when are you free for a call this week?"). Never invent a date, a file, a price or a promise.
- meeting: about meetings on Calendly: book one with someone, free times, move or cancel one, send a booking link (in the group, or privately to someone). Privately, also a reply in a meeting conversation you're having with them ("chat" shows it): after you offered a time, "yes" or "4" is about the meeting.
- my_order: privately, their own answer about something you asked them to do or asked them ("your_orders"): it's done, an answer, what's in the way, a question about it, when they'll do it.
- question: they ask about something or someone: a client, a project, a delivery, what someone said in a group or by email, someone's email or number, open alerts, meetings, who's working now, anything iklipse may know. about: the refs (from people and projects) it's about, at most 3; empty when it's about none in particular. A name written in a group means the one in people with in_this_group true and that name, before anyone else elsewhere; ask which one only when two people in this group fit. Someone named by their number ("who's +201...") is the one in people whose whatsapp is that number, in any format (+20 10..., 010..., 2010...).
- answer: the message gives what you asked the team about people in the client groups (an email, a number, a name, "skip", "is Rabah"); only when details_asked is true.
- stop: stop open orders ("stop asking Sara", "خلاص سيبه", "cancel the one to Rabah"); stop lists their ids from open_orders.
- status: they ask what's still open ("what's left?", "ايه اللي لسه").
- ignore: nothing for you (thanks, ok, a remark to someone else).
- none: an order you can't carry out: who it's for isn't clear or isn't in people, or what to do isn't said. reply: a short question back ("Who's Ahmed?", "What should I tell Rabah?"). No greeting, no apology.`;

/** Where the bot answers about an order: the team group (as a reply to it), or the private chat of the one who gave it. */
type At = { chat_id: string; message_id: string | null };

/**
 * Someone on the team talking to the bot (once per message): a mention in a
 * team group (anyone there), or in a client group or privately (0093: anyone
 * on the team, nobody else). Done right away; what came of it is said in the
 * team group as a reply to it, else privately to them (never in a client group).
 */
export async function takeOrder(
  db: Db,
  s: Settings,
  t: Team,
  send: Send,
  o: { id: string; chatId: string; where: "team" | "client" | "private"; text: string; quoted: string | null; phone: string | null; lid: string | null; name: string | null },
  answerNow: (id: string) => Promise<void>,
) {
  if (!(await firstTime(db, `order:${o.id}`))) return;
  const by = (o.phone ? t.byPhone.get(o.phone) : undefined) ?? (o.lid ? t.byLid.get(o.lid) : undefined);
  // Outside the team groups only the team is heard: anyone else gets nothing.
  if (o.where !== "team" && !by?.active) return;
  const byName = by?.name ?? o.name ?? "Someone on the team";
  const dm = o.where === "private" ? o.chatId : o.where === "client" && by ? await privateChat(db, by.id) : null;
  const at: At = o.where === "team" ? { chat_id: o.chatId, message_id: o.id } : { chat_id: dm ?? "", message_id: o.where === "private" ? o.id : null };
  // From a client group with no number for them: nowhere to answer that the client wouldn't see.
  if (!at.chat_id) return;
  const ids = s.bot_phone ? await botIds(db, s.bot_phone) : new Set<string>();
  const text = await named(db, o.chatId, o.text, ids);
  const quoted = o.quoted ? await named(db, o.chatId, o.quoted, ids) : null;

  const dir = await directory(db);
  const [{ data: cl }, { data: pr }, { data: openRows }, { data: asked }] = await Promise.all([
    db.from("client").select("id, name, company, name_known, wa_group(name)").order("updated_at", { ascending: false }).limit(300),
    db.from("project").select("id, title, status, client:client_id(name, company)").in("status", ["active", "on_hold"]).order("updated_at", { ascending: false }).limit(150),
    db.from("bot_order").select(COLS).eq("status", "open").order("created_at").limit(30),
    db.from("bot_ask_message").select("id").eq("chat_id", o.chatId).gt("sent_at", iso(Date.now() - 3 * 24 * 60 * MIN)).limit(1),
  ]);
  // Who's in this group: a name said here means them first.
  const here = o.chatId.endsWith("@g.us")
    ? new Set((await peopleFor(db, o.chatId, by?.id ?? "", s.bot_phone ?? null)).people.filter((p) => p.in_group).map((p) => p.ref))
    : new Set<string>();
  const people = [
    ...[...dir.team.values()].filter((a) => a.phone !== s.bot_phone).map((a) => ({ ref: `t:${a.id}`, name: a.name, who: "team", whatsapp: a.phone ? `+${a.phone}` : null })),
    ...((cl ?? []) as unknown as { id: string; company: string | null; wa_group: { name: string | null } | null }[]).map((c) => {
      const a = dir.clients.get(c.id)!;
      return { ref: `c:${c.id}`, name: a.name, who: "client", ...(c.wa_group?.name ? { group: c.wa_group.name } : {}), whatsapp: a.phone ? `+${a.phone}` : null };
    }),
  ].map((p) => (here.has(p.ref) ? { ...p, in_this_group: true } : p));
  const projects = ((pr ?? []) as unknown as { id: string; title: string; status: string; client: { name: string; company: string | null } | null }[]).map((p) => ({
    ref: `p:${p.id}`,
    title: p.title,
    status: p.status,
    ...(p.client ? { client: `${p.client.name}${p.client.company ? ` (${p.client.company})` : ""}` } : {}),
  }));
  const open = await freshNames(db, (openRows ?? []) as Order[]);

  // Privately: the chat so far (a meeting being arranged, what the bot asked them), and what they were asked to do.
  let chat: string[] = [];
  let mine: Order[] = [];
  if (o.where === "private") {
    const { data: rows } = await db.from("wa_dm").select("from_bot, text, sent_at").eq("chat_id", o.chatId).order("sent_at", { ascending: false }).limit(10);
    chat = ((rows ?? []) as { from_bot: boolean; text: string | null; sent_at: string }[])
      .reverse()
      .map((m) => `[${cairoStamp.format(new Date(m.sent_at))}] ${m.from_bot ? "YOU" : "THEM"}: ${str(m.text).replace(/\s+/g, " ").slice(0, 500)}`);
    mine = by ? open.filter((x) => x.to_kind === "team" && x.to_id === by.id) : [];
  }

  const r = (await claude(
    s.model,
    ORDER_SYSTEM,
    JSON.stringify({
      now: `${cairoStamp.format(new Date())} Cairo time`,
      where: o.where === "team" ? "the team group" : o.where === "client" ? "a client group (you answer them privately, never in the group)" : "privately",
      from: byName,
      message: text,
      ...(quoted ? { replying_to: quoted } : {}),
      details_asked: !!asked?.length,
      people,
      projects,
      open_orders: open.map((x, i) => ({ id: `o${i + 1}`, to: x.to_name, kind: x.kind, task: x.task, since: cairoStamp.format(new Date(x.created_at)) })),
      ...(o.where === "private" ? { chat, your_orders: mine.map((x) => ({ task: x.task, kind: x.kind, from: x.by_name })) } : {}),
    }),
    ORDER_TOOL,
    2000,
  )) as { action?: string; orders?: { kind?: string; to?: string; task?: string; message?: string; nudge?: string; wait?: boolean }[]; about?: string[]; stop?: string[]; reply?: string } | null;
  if (!r?.action) throw new Error("Claude gave no answer");
  const off = () => report(db, send, at, "Orders are off. Turn on Take orders from the team in Alerts > Settings.");

  switch (r.action) {
    case "ignore":
      return;
    case "none":
      return await report(db, send, at, str(r.reply) || "Didn't get that. Who's it for, and what should I tell them?");
    case "answer":
      await takeAnswer(db, s, t, { id: o.id, chatId: o.chatId, text: o.text, quotedId: null }, send);
      return;
    case "my_order":
      if (o.where === "private" && (await fromTarget(db, s, send, { id: o.id, chatId: o.chatId, text: o.text, quotedId: null }))) return;
      return await report(db, send, at, "Got it.");
    case "meeting": {
      if (!by) return await report(db, send, at, "I don't know who you are on iklipse, so I can't book on your Calendly. Link your number on the Users page.");
      if (!s.book_enabled) return await report(db, send, at, "Booking meetings from WhatsApp is off (Alerts > Settings).");
      // Privately, a meeting being arranged goes on; anything else starts one where they asked.
      const going = o.where === "private" ? await bookTurnAt(db, o.chatId, null) : null;
      const on =
        going && o.phone && Date.now() - Date.parse(going) < 2 * 60 * MIN
          ? await heardPrivate(db, { id: o.id, chatId: o.chatId, text: o.text, quotedId: null, phone: o.phone })
          : await orderedMeeting(db, { id: o.id, chatId: o.chatId, text, quoted, userId: by.id });
      if (on) await answerNow(o.id);
      return;
    }
    case "question":
      if (!s.orders_enabled) return await off();
      return await report(db, send, at, await answerQuestion(db, s, t, dir, { by, text, quoted, about: (r.about ?? []).map(str).filter(Boolean).slice(0, 3) }));
    case "status": {
      if (!s.orders_enabled) return await off();
      if (!open.length) return await report(db, send, at, "Nothing open.");
      const lines = open.map(
        (x, i) => `${i + 1}. ${x.to_name}: ${x.task} (${x.kind === "ask" ? "asked" : "since"} ${cairoStamp.format(new Date(x.created_at))}${x.times > 1 ? `, ${x.times - 1} reminder${x.times === 2 ? "" : "s"}` : ""})`,
      );
      return await report(db, send, at, ["Open:", ...lines].join("\n"));
    }
    case "stop": {
      if (!s.orders_enabled) return await off();
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
  if (!s.orders_enabled) return await off();

  // Orders: written to each person now, then kept after.
  const made: Order[] = [];
  const told: string[] = [];
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
        chat_id: at.chat_id,
        message_id: at.message_id,
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
      // Only passing something on: said, and nothing to keep after.
      if (kind === "tell" && x.wait === false) {
        await close(db, ord, "done", "Told");
        told.push(first(p.name));
        continue;
      }
      made.push(ord);
    } catch (e) {
      await db.from("bot_order").update({ status: "failed", outcome: (e as Error).message.slice(0, 300), closed_at: iso(), next_at: null }).eq("id", ord.id);
      problems.push(`Couldn't send it to ${p.name}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const tells = made.filter((x) => x.kind === "tell").map((x) => first(x.to_name));
  const asks = made.filter((x) => x.kind === "ask").map((x) => first(x.to_name));
  const lines = [
    ...(told.length ? [`Told ${namesOf(told)}.`] : []),
    ...(tells.length ? [`Sent to ${namesOf(tells)}. I'll follow up until it's done.`] : []),
    ...(asks.length ? [`Asked ${namesOf(asks)}. I'll bring the answer ${o.where === "team" ? "here" : "to you"}.`] : []),
    ...problems,
  ];
  if (!lines.length) lines.push("Didn't get that. Who's it for, and what should I tell them?");
  await report(db, send, at, lines.join("\n"), made);
}

// ---------------------------------------------------------- a question --

const ANSWER_TOOL: ClaudeTool = {
  name: "reply",
  description: "The answer to send them.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", description: "The answer, in English." } },
    required: ["text"],
  },
};

const ANSWER_SYSTEM = `You are iklipse, the team's assistant on WhatsApp (iklipse is a creative and marketing agency). Someone on the team asked you something. Answer from what iklipse knows, below: people, projects and deliveries, open alerts, meetings, orders, who's working today, and what people said in the groups and by email (voice notes written out, files read). They're on the team, so share anything below with them, numbers and emails too. Money (prices, costs, invoices) isn't below: say it's on the project's page in iklipse. When the answer isn't below, say you don't know it; never guess or invent. Always English, short, the way a person texts: no greeting, no offer of more help; a short list only when it helps. Times are Cairo time. Call reply once.`;

/** A question from the team, answered from what iklipse knows (0093): about the people and projects named, and what's going on. */
async function answerQuestion(
  db: Db,
  s: Settings,
  t: Team,
  dir: Awaited<ReturnType<typeof directory>>,
  q: { by: Person | undefined; text: string; quoted: string | null; about: string[] },
) {
  const stamp = (x: string | null | undefined) => (x ? cairoStamp.format(new Date(x)) : null);
  const nameOf = (id: string | null | undefined) => (id ? dir.team.get(id)?.name ?? t.people.get(id)?.name ?? null : null);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dayStart = iso(Date.parse(`${today}T00:00:00${cairoOffset()}`));

  const about: Record<string, unknown>[] = [];
  for (const ref of q.about) {
    const id = ref.slice(2);
    if (ref.startsWith("c:")) {
      const { data: c } = await db.from("client").select("id, name, company, email, phone, wa_lid, notes, wa_group(name)").eq("id", id).maybeSingle();
      if (!c) continue;
      const { data: ps } = await db.from("project").select("title, status, due_at").eq("client_id", id).order("created_at", { ascending: false }).limit(10);
      const a = dir.clients.get(id);
      about.push({
        client: a?.name ?? c.name,
        company: c.company,
        email: c.email,
        whatsapp: a?.phone ? `+${a.phone}` : c.phone,
        group: (c as unknown as { wa_group: { name: string | null } | null }).wa_group?.name ?? null,
        notes: str(c.notes).slice(0, 1000) || null,
        projects: (ps ?? []).map((p) => ({ title: p.title, status: p.status, due: stamp(p.due_at) })),
        said: await historyOf(db, { phone: a?.phone ?? null, lid: c.wa_lid, email: c.email }, 40),
      });
    } else if (ref.startsWith("t:")) {
      const a = dir.team.get(id);
      if (!a) continue;
      const [{ data: ds }, { data: rec }] = await Promise.all([
        db.from("project_delivery").select("title, due_at, project(title)").eq("assignee_id", id).is("done_at", null).order("due_at").limit(10),
        db.from("watch_recipient").select("watch_alert!inner(title, status, created_at)").eq("user_id", id).eq("watch_alert.status", "open").limit(10),
      ]);
      about.push({
        team_member: a.name,
        email: a.email,
        whatsapp: a.phone ? `+${a.phone}` : null,
        deliveries: ((ds ?? []) as unknown as { title: string; due_at: string; project: { title: string } | null }[]).map((d) => ({ title: d.title, project: d.project?.title, due: stamp(d.due_at) })),
        alerts_on_them: ((rec ?? []) as unknown as { watch_alert: { title: string; created_at: string } }[]).map((r) => ({ title: r.watch_alert.title, since: stamp(r.watch_alert.created_at) })),
        said: await historyOf(db, { phone: a.phone, email: a.email }, 20),
      });
    } else if (ref.startsWith("p:")) {
      const { data: p } = await db
        .from("project")
        .select("id, title, description, status, priority, start_on, due_at, delivered_at, client:client_id(name, company)")
        .eq("id", id)
        .maybeSingle();
      if (!p) continue;
      const [{ data: team }, { data: ds }, { data: notes }] = await Promise.all([
        db.from("project_member").select("user_id, role").eq("project_id", id),
        db.from("project_delivery").select("title, due_at, done_at, assignee_id").eq("project_id", id).order("due_at").limit(20),
        db.from("project_note").select("body, author_id, created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(5),
      ]);
      const cl = (p as unknown as { client: { name: string; company: string | null } | null }).client;
      about.push({
        project: p.title,
        client: cl ? `${cl.name}${cl.company ? ` (${cl.company})` : ""}` : null,
        status: p.status,
        priority: p.priority,
        about: str(p.description).slice(0, 1000) || null,
        starts: p.start_on,
        due: stamp(p.due_at),
        delivered: stamp(p.delivered_at),
        team: (team ?? []).map((m) => `${nameOf(m.user_id) ?? "Someone"}${m.role ? ` (${m.role})` : ""}`),
        deliveries: (ds ?? []).map((d) => ({ title: d.title, due: stamp(d.due_at), done: stamp(d.done_at), who: nameOf(d.assignee_id) })),
        notes: (notes ?? []).map((n) => `${stamp(n.created_at)} ${nameOf(n.author_id) ?? ""}: ${str(n.body).replace(/\s+/g, " ").slice(0, 400)}`),
      });
    }
  }

  // What's going on: open alerts, meetings, orders, deliveries soon, who's working today.
  const [{ data: alerts }, { data: meetings }, { data: orders }, { data: soon }, { data: sessions }, { data: breaks }] = await Promise.all([
    db.from("watch_alert").select("id, title, detail, person, source, mail_subject, created_at, wa_group(name), slack_channel(name)").eq("status", "open").order("created_at", { ascending: false }).limit(25),
    db.from("wa_bot_meeting").select("topic, start_at, minutes, owner, invitee_name, attendees").eq("status", "booked").gte("start_at", iso(Date.now() - 60 * MIN)).order("start_at").limit(10),
    db.from("bot_order").select("to_kind, to_id, to_name, task, by_name, kind, times, created_at").eq("status", "open").order("created_at").limit(20),
    db.from("project_delivery").select("title, due_at, assignee_id, project(title)").is("done_at", null).lte("due_at", iso(Date.now() + 7 * 24 * 60 * MIN)).order("due_at").limit(20),
    db.from("work_session").select("user_id, started_at, ended_at").gte("started_at", dayStart),
    db.from("work_break").select("user_id").is("ended_at", null),
  ]);
  const { data: rec } = alerts?.length ? await db.from("watch_recipient").select("alert_id, user_id").in("alert_id", alerts.map((a) => a.id)) : { data: [] };
  const onBreak = new Set((breaks ?? []).map((b) => b.user_id as string));
  const working = new Map<string, string>();
  for (const w of sessions ?? []) {
    const name = nameOf(w.user_id);
    if (!name) continue;
    const now = !w.ended_at ? (onBreak.has(w.user_id) ? "on a break" : "working") : null;
    if (now || !working.has(name)) working.set(name, now ?? `logged out (came at ${stamp(w.started_at)})`);
  }

  const r = (await claude(
    s.model,
    ANSWER_SYSTEM,
    JSON.stringify({
      now: `${cairoStamp.format(new Date())} Cairo time`,
      asked_by: q.by?.name ?? "someone on the team",
      question: q.text,
      ...(q.quoted ? { replying_to: q.quoted } : {}),
      about,
      open_alerts: ((alerts ?? []) as unknown as { id: string; title: string; detail: string | null; person: string | null; source: string; mail_subject: string | null; created_at: string; wa_group: { name: string | null } | null; slack_channel: { name: string | null } | null }[]).map((a) => ({
        title: a.title,
        detail: a.detail,
        about: a.person,
        where: a.source === "email" ? `email "${a.mail_subject ?? ""}"` : a.source === "slack" ? `Slack #${a.slack_channel?.name ?? ""}` : a.wa_group?.name,
        since: stamp(a.created_at),
        for: (rec ?? []).filter((x) => x.alert_id === a.id).map((x) => nameOf(x.user_id)).filter(Boolean),
      })),
      meetings: ((meetings ?? []) as unknown as { topic: string; start_at: string; minutes: number | null; owner: string; invitee_name: string | null; attendees: { name: string; host?: boolean }[] | null }[]).map((m) => ({
        topic: m.topic,
        at: stamp(m.start_at),
        minutes: m.minutes,
        on: nameOf(m.owner),
        with: (m.attendees ?? []).filter((a) => !a.host).map((a) => a.name).join(", ") || m.invitee_name,
      })),
      orders: (await freshNames(db, orders ?? [])).map((x) => ({ to: x.to_name, task: x.task, from: x.by_name, since: stamp(x.created_at), messages: x.times })),
      deliveries_soon: ((soon ?? []) as unknown as { title: string; due_at: string; assignee_id: string | null; project: { title: string } | null }[]).map((d) => ({
        title: d.title,
        project: d.project?.title,
        due: stamp(d.due_at),
        who: nameOf(d.assignee_id),
      })),
      working_today: Object.fromEntries(working),
    }),
    ANSWER_TOOL,
    1500,
  )) as { text?: string } | null;
  return str(r?.text).replace(/[—–]/g, ", ") || "I couldn't find that.";
}

// ------------------------------------------------------- booking links --

/**
 * A booking link sent privately from a meeting conversation (book.ts, 0093):
 * to each person named, followed up like an order until they book a time on it
 * (it closes by itself once Calendly has their booking) or say what's in the
 * way. What comes of it goes privately to the one who asked (at).
 * With a slot ("Tuesday 21-10-2026, 3:00 PM"), the link is a custom one per
 * person: it opens on that time with their details filled in, so they only
 * confirm it.
 */
export async function linkOrders(
  db: Db,
  s: Settings,
  send: Send,
  at: At,
  o: { byUser: string; byName: string; text: string; url: string | ((p: Attendee) => string); by: string; slot?: string },
  people: Attendee[],
) {
  const made: Order[] = [];
  const problems: string[] = [];
  const asker = first(o.byName);
  const until = o.by ? ` by ${o.by}` : "";
  for (const p of people) {
    if (p.kind === "guest" || !p.id) {
      problems.push(`I don't know ${p.name} on iklipse, so I can't write to them.`);
      continue;
    }
    if (!p.phone) {
      problems.push(`I don't have ${p.name}'s WhatsApp number. Add it ${p.kind === "team" ? "on the Users page" : "in Clients (Projects)"}, then ask again.`);
      continue;
    }
    const name = first(p.name);
    const hi = /^[A-Za-z]/.test(name) ? `Hi ${name}` : "Hi";
    const url = typeof o.url === "function" ? o.url(p) : o.url;
    const message = o.slot
      ? p.kind === "team"
        ? `${hi}, ${asker} set a call with you for ${o.slot} (Cairo time). Your details are filled in, just tap "Schedule Event" to confirm:\n${url}`
        : `${hi}, your call with us is set for ${o.slot} (Cairo time). Your details are filled in, just tap "Schedule Event" to confirm:\n${url}`
      : p.kind === "team"
        ? `${hi}, ${asker} asks you to book a time for a call${until}:\n${url}`
        : `${hi}, please pick a time that suits you for a call with us${until}:\n${url}`;
    const nudge = o.slot
      ? `${hi}, a reminder to confirm our call on ${o.slot} (Cairo time):\n${url}`
      : p.kind === "team"
        ? `${/^[A-Za-z]/.test(name) ? `${name}, a` : "A"} reminder: ${asker} asked you to book a time for a call${until}:\n${url}`
        : `${hi}, just a reminder to pick a time for our call${until}:\n${url}`;
    const { data: row, error } = await db
      .from("bot_order")
      .insert({
        chat_id: at.chat_id,
        message_id: at.message_id,
        by_user: o.byUser,
        by_name: o.byName,
        order_text: o.text.slice(0, 4000),
        kind: "tell",
        to_kind: p.kind,
        to_id: p.id,
        to_name: p.name,
        to_chat: `${p.phone}@c.us`,
        task: o.slot ? `confirm the call on ${o.slot} on the link` : `book a time for a call on the link${until}`,
        nudge,
        times: 1,
        next_at: iso(Date.now() + s.order_every_min * MIN),
        book_url: url,
      })
      .select(COLS)
      .single();
    if (error || !row) {
      problems.push(`Couldn't keep it for ${p.name}.`);
      continue;
    }
    const ord = row as Order;
    try {
      await toThem(db, send, ord, message);
      made.push(ord);
    } catch (e) {
      await db.from("bot_order").update({ status: "failed", outcome: (e as Error).message.slice(0, 300), closed_at: iso(), next_at: null }).eq("id", ord.id);
      problems.push(`Couldn't send it to ${p.name}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const sent = namesOf(made.map((x) => first(x.to_name)));
  const lines = [
    ...(made.length
      ? [o.slot ? `Sent ${sent} the link for ${o.slot}, with the details filled in. I'll follow up until they confirm.` : `Sent the link to ${sent}. I'll follow up until they book.`]
      : []),
    ...problems,
  ];
  await report(db, send, at, lines.join("\n") || "Nobody to send it to.", made);
}

/** Booking links followed up: closed once Calendly has their booking (found by their email), and the one who asked is told. */
export async function bookedOrders(db: Db, send: Send) {
  const { data } = await db.from("bot_order").select(COLS).eq("status", "open").not("book_url", "is", null).order("created_at").limit(20);
  const open = await freshNames(db, (data ?? []) as Order[]);
  if (!open.length) return 0;
  const booked = await bookedSince(db, iso(Date.parse(open[0].created_at) - MIN));
  let n = 0;
  for (const x of open) {
    const b = booked.find((m) => m.at >= Date.parse(x.created_at) - MIN && m.people.some((a) => a.kind === x.to_kind && a.id === x.to_id));
    if (!b) continue;
    if (await close(db, x, "done", `Booked ${b.when}`)) {
      await report(db, send, { chat_id: x.chat_id, message_id: x.message_id }, `${first(x.to_name)} booked: *${b.topic}*, ${b.when} Cairo time.`, [x]).catch(() => null);
      n++;
    }
  }
  return n;
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
  return (await freshNames(db, (data ?? []) as Order[]))[0] ?? null;
}

/**
 * Orders keep the name the person had when they were given (a client known
 * only by their number then): they're said by the name iklipse has now.
 */
async function freshNames<T extends { to_kind: string; to_id: string | null; to_name: string }>(db: Db, list: T[]): Promise<T[]> {
  const ids = (kind: string) => [...new Set(list.filter((x) => x.to_kind === kind && x.to_id).map((x) => x.to_id!))];
  const [clients, team] = [ids("client"), ids("team")];
  const [c, t] = await Promise.all([
    clients.length ? db.from("client").select("id, name").in("id", clients) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    team.length ? db.from("profile").select("id, display_name").in("id", team) : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
  ]);
  const now = new Map<string, string>();
  for (const r of c.data ?? []) if (str(r.name)) now.set(`client:${r.id}`, str(r.name));
  for (const r of t.data ?? []) if (str(r.display_name)) now.set(`team:${r.id}`, str(r.display_name));
  for (const x of list) x.to_name = now.get(`${x.to_kind}:${x.to_id}`) ?? x.to_name;
  return list;
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
  for (const x of await freshNames(db, (data ?? []) as Order[])) {
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
