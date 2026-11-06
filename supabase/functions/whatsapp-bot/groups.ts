// The bot running WhatsApp groups (0143): making them, their people, admins,
// invite links and who may post; and changing or taking back what it posted.
// Everything is read back from WhatsApp after it's done, and what's said is
// what WhatsApp shows now, person by person: "done" only when it is.
//
// WhatsApp's own limits, said plainly when they're hit:
// - nothing changes in a group where the bot isn't an admin;
// - someone whose privacy settings stop it can't be added: they get the link;
// - a message can be edited for 15 minutes, and taken back for about 2 days,
//   and only the bot's own.

import { iso, str, type Db } from "./kit.ts";
import { groupNamed, groupsIn, type Group } from "./post.ts";

export class GroupNo extends Error {}

/** One line of the bridge: path after /api/<session>. */
export type Bridge = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; data: T | null }>;

export interface Member {
  JID: string;
  PhoneNumber?: string;
  LID?: string;
  IsAdmin?: boolean;
  IsSuperAdmin?: boolean;
  Error?: number;
  AddRequest?: unknown;
}

const MAX_PEOPLE = 20;
export const EDIT_MS = 15 * 60_000;
/** WhatsApp takes a message back for about 60 hours; a little less, to be sure. */
export const TAKE_BACK_MS = 59 * 60 * 60_000;

const digits = (v: unknown) => str(v).replace(/\D/g, "");
const phoneOf = (m: Member) => str(m.PhoneNumber).split("@")[0]?.split(":")[0] ?? "";
const enc = encodeURIComponent;
const listOf = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Why WhatsApp didn't take someone, from the code it gives. */
export function whyNotAdded(m: Member): string {
  if (m.AddRequest) return "their privacy settings stop it, WhatsApp sent them a request to join";
  switch (m.Error) {
    case 403:
      return "their privacy settings stop it";
    case 408:
      return "they left this group a short while ago";
    case 409:
      return "they're already in it";
    case 401:
      return "they blocked the bot";
    default:
      return `WhatsApp said ${m.Error ?? "no"}`;
  }
}

/** The group they mean, among the ones the bot is in; never guessed. */
export async function groupFor(db: Db, said: string): Promise<Group> {
  const { group, fits } = groupNamed(await groupsIn(db), said);
  if (group) return group;
  if (fits.length > 1) throw new GroupNo(`Which group: ${listOf(fits.slice(0, 6).map((g) => g.name))}?`);
  throw new GroupNo(`I'm not in a group called "${said}".`);
}

const people = async (w: Bridge, chat: string) => {
  const r = await w<Member[]>("GET", `/groups/${enc(chat)}/participants`);
  if (!Array.isArray(r.data)) throw new GroupNo("WhatsApp didn't show the group's people.");
  return r.data;
};

/** Nothing changes in a group where the bot isn't an admin. */
async function mustBeAdmin(w: Bridge, g: Group, bot: string | null) {
  const list = await people(w, g.chat_id);
  const me = list.find((m) => phoneOf(m) === digits(bot));
  if (!me) throw new GroupNo(`I can't see myself in ${g.name}: nothing changed.`);
  if (!me.IsAdmin && !me.IsSuperAdmin) throw new GroupNo(`I'm not an admin in ${g.name}, so WhatsApp won't let me: nothing changed. Make the bot an admin there first.`);
  return list;
}

const asIds = (phones: unknown) => {
  const list = [...new Set((Array.isArray(phones) ? phones : []).map(digits).filter(Boolean))];
  const bad = list.filter((p) => !/^[1-9]\d{7,14}$/.test(p));
  if (bad.length) throw new GroupNo(`Not a full number: ${bad.join(", ")}. International digits, like 201001234567.`);
  if (!list.length) throw new GroupNo("Whose numbers?");
  if (list.length > MAX_PEOPLE) throw new GroupNo(`At most ${MAX_PEOPLE} people at a time.`);
  return list;
};

export interface GroupAsk {
  action: string;
  group?: unknown;
  name?: unknown;
  text?: unknown;
  phones?: unknown;
  kind?: unknown;
}

/** One thing done to a group. What comes back is what WhatsApp shows now. */
export async function manageGroup(db: Db, w: Bridge, bot: string | null, x: GroupAsk, now = Date.now()): Promise<string> {
  const action = str(x.action);
  if (action === "create") return await create(db, w, x, now);
  const g = await groupFor(db, str(x.group));
  const chat = enc(g.chat_id);

  if (action === "people") {
    const list = await people(w, g.chat_id);
    const admins = list.filter((m) => m.IsAdmin || m.IsSuperAdmin).length;
    const lines = list.map((m) => `${phoneOf(m) ? `+${phoneOf(m)}` : "hidden number"}${m.IsSuperAdmin ? " (owner)" : m.IsAdmin ? " (admin)" : ""}`);
    return `${g.name}: ${list.length} people, ${admins} admins.\n${lines.join("\n")}`;
  }

  if (action === "leave") {
    await w("POST", `/groups/${chat}/leave`);
    await db.from("wa_group").update({ left_at: iso(now) }).eq("chat_id", g.chat_id);
    return `Left ${g.name}.`;
  }

  const list = await mustBeAdmin(w, g, bot);

  if (action === "rename") {
    const name = str(x.name).trim();
    if (!name) throw new GroupNo("What's the new name?");
    if (name.length > 100) throw new GroupNo("WhatsApp takes 100 characters at most.");
    await w("PUT", `/groups/${chat}/subject`, { subject: name });
    const r = await w<{ Name?: string }>("GET", `/groups/${chat}`);
    if (str(r.data?.Name) !== name) throw new GroupNo(`WhatsApp didn't take it: the group is still called ${str(r.data?.Name) || g.name}.`);
    await db.from("wa_group").update({ name }).eq("chat_id", g.chat_id);
    return `${g.name} is called ${name} now.`;
  }

  if (action === "describe") {
    const text = str(x.text).trim().slice(0, 2048);
    await w("PUT", `/groups/${chat}/description`, { description: text });
    const r = await w<{ Topic?: string }>("GET", `/groups/${chat}`);
    if (str(r.data?.Topic).trim() !== text) throw new GroupNo("WhatsApp didn't take the description.");
    return text ? `Description of ${g.name} changed.` : `Description of ${g.name} removed.`;
  }

  if (action === "link") {
    const r = await w<string>("GET", `/groups/${chat}/invite-code`);
    if (!str(r.data)) throw new GroupNo("WhatsApp gave no link.");
    return `Link to ${g.name}: ${str(r.data)}`;
  }

  if (action === "reset_link") {
    const was = await w<string>("GET", `/groups/${chat}/invite-code`);
    await w("POST", `/groups/${chat}/invite-code/revoke`);
    const is = await w<string>("GET", `/groups/${chat}/invite-code`);
    if (!str(is.data) || str(is.data) === str(was.data)) throw new GroupNo(`The link to ${g.name} did NOT change: WhatsApp still gives the same one. To stop it, do it from the phone: Group info, Invite via link, Reset link.`);
    return `The old link to ${g.name} stopped working. The new one: ${str(is.data)}`;
  }

  if (["only_admins_post", "everyone_posts", "only_admins_edit", "everyone_edits"].includes(action)) {
    const posts = action.endsWith("post") || action === "everyone_posts";
    const adminsOnly = action.startsWith("only");
    await w("PUT", `/groups/${chat}/settings/security/${posts ? "messages-admin-only" : "info-admin-only"}`, { adminsOnly });
    const r = await w<{ IsAnnounce?: boolean; IsLocked?: boolean }>("GET", `/groups/${chat}`);
    const shown = posts ? r.data?.IsAnnounce : r.data?.IsLocked;
    if (typeof shown === "boolean" && shown !== adminsOnly) throw new GroupNo("WhatsApp didn't take it: nothing changed.");
    return `${g.name}: ${adminsOnly ? "only admins" : "everyone"} may ${posts ? "post" : "change the group's info"} now.`;
  }

  if (["add", "remove", "make_admin", "remove_admin"].includes(action)) {
    const phones = asIds(x.phones);
    const body = { participants: phones.map((p) => ({ id: `${p}@c.us` })) };
    const path = action === "add" ? "participants/add" : action === "remove" ? "participants/remove" : action === "make_admin" ? "admin/promote" : "admin/demote";
    const r = await w<Member[]>("POST", `/groups/${chat}/${path}`, body);
    const answer = Array.isArray(r.data) ? r.data : [];
    const after = await people(w, g.chat_id);
    const done: string[] = [];
    const not: string[] = [];
    phones.forEach((p, i) => {
      // WhatsApp may answer with their hidden id: in the order asked, then by number.
      const a = answer.find((m) => phoneOf(m) === p) ?? answer[i];
      const now_ = a ? after.find((m) => m.JID === a.JID || (!!phoneOf(m) && phoneOf(m) === p)) : after.find((m) => phoneOf(m) === p);
      const was = list.find((m) => phoneOf(m) === p || (!!a && m.JID === a.JID));
      const ok = action === "add" ? !!now_ && !a?.Error : action === "remove" ? !now_ : action === "make_admin" ? !!now_?.IsAdmin : !!now_ && !now_.IsAdmin;
      if (ok) done.push(`+${p}`);
      else not.push(`+${p} (${a?.Error ? whyNotAdded(a) : !was && action !== "add" ? "isn't in the group" : "WhatsApp didn't do it"})`);
    });
    const verb = { add: "Added to", remove: "Removed from", make_admin: "Made admin in", remove_admin: "No longer admin in" }[action]!;
    const parts = [done.length ? `${verb} ${g.name}: ${done.join(", ")}.` : "", not.length ? `NOT done: ${not.join(", ")}.` : ""].filter(Boolean);
    if (not.length && action === "add") {
      const link = await w<string>("GET", `/groups/${chat}/invite-code`).catch(() => null);
      if (str(link?.data)) parts.push(`They can join by the link: ${str(link?.data)}`);
    }
    return parts.join("\n");
  }
  throw new GroupNo("action: create, people, rename, describe, add, remove, make_admin, remove_admin, link, reset_link, only_admins_post, everyone_posts, only_admins_edit, everyone_edits or leave.");
}

async function create(db: Db, w: Bridge, x: GroupAsk, now: number) {
  const name = str(x.name).trim();
  if (!name) throw new GroupNo("What's the group's name?");
  if (name.length > 100) throw new GroupNo("WhatsApp takes 100 characters at most.");
  const kind = str(x.kind) === "client" ? "client" : str(x.kind) === "team" ? "team" : "";
  if (!kind) throw new GroupNo("Is it a team group or a client's group (kind)?");
  const phones = asIds(x.phones);
  const r = await w<{ JID?: string; Name?: string; Participants?: Member[] }>("POST", "/groups", { name, participants: phones.map((p) => ({ id: `${p}@c.us` })) });
  const chat = str(r.data?.JID);
  if (!chat.endsWith("@g.us")) throw new GroupNo("WhatsApp didn't make the group.");
  await db.from("wa_group").upsert({ chat_id: chat, name, kind, monitored: kind === "client", bot_replies: kind === "team", synced_at: iso(now) }, { onConflict: "chat_id" });
  const missed = (r.data?.Participants ?? []).filter((m) => m.Error);
  const link = await w<string>("GET", `/groups/${enc(chat)}/invite-code`).catch(() => null);
  return [
    `Made ${name} (${kind}): ${phones.length - missed.length} of ${phones.length} added, the bot is its admin.`,
    missed.length ? `NOT added: ${missed.map((m) => `${phoneOf(m) ? `+${phoneOf(m)}` : "one number"} (${whyNotAdded(m)})`).join(", ")}.` : "",
    str(link?.data) ? `Link: ${str(link?.data)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// --------------------------------------------- what the bot already posted --

interface Posted {
  id: string;
  text: string | null;
  sent_at: string;
}

/** What the bot posted there lately, newest first: the one with those words, or the last. */
async function postedIn(db: Db, chat: string, words: string): Promise<Posted> {
  const { data } = await db.from("wa_message").select("id, text, sent_at").eq("chat_id", chat).eq("from_bot", true).order("sent_at", { ascending: false }).limit(50);
  const list = (data ?? []) as Posted[];
  const want = words.trim().toLowerCase();
  const fits = want ? list.filter((m) => str(m.text).toLowerCase().includes(want)) : list.slice(0, 1);
  if (!fits.length) throw new GroupNo(want ? `I didn't post anything saying "${words.trim()}" there lately.` : "I didn't post anything there lately.");
  return fits[0]!;
}

/** Change or take back something the bot posted in a group. */
export async function changePost(db: Db, w: Bridge, bot: string | null, x: { action: string; group: string; find?: string; text?: string }, now = Date.now()) {
  const g = await groupFor(db, x.group);
  const m = await postedIn(db, g.chat_id, str(x.find));
  const age = now - Date.parse(m.sent_at);
  const { data: full } = await db.from("waha_msg").select("full_id").eq("id", m.id).maybeSingle();
  const whole = str(full?.full_id) || `true_${g.chat_id}_${m.id}_${digits(bot)}@c.us`;
  const path = `/chats/${enc(g.chat_id)}/messages/${enc(whole)}`;
  const quote = `"${str(m.text).slice(0, 60)}"`;
  if (x.action === "edit") {
    const text = str(x.text).trim();
    if (!text) throw new GroupNo("What should it say?");
    if (age > EDIT_MS) throw new GroupNo(`NOT edited: WhatsApp lets a message be edited for 15 minutes, and ${quote} went ${Math.round(age / 60_000)} minutes ago. I can take it back and post the new one.`);
    await w("PUT", path, { text });
    await db.from("wa_message").update({ text }).eq("id", m.id);
    return `Edited in ${g.name}: ${quote} now says "${text.slice(0, 60)}".`;
  }
  if (x.action === "delete") {
    if (age > TAKE_BACK_MS) throw new GroupNo(`NOT taken back: WhatsApp lets a message be taken back for about 2 days, and ${quote} went ${Math.round(age / 3_600_000)} hours ago.`);
    await w("DELETE", path);
    await db.from("wa_message").update({ text: "[taken back by the bot]" }).eq("id", m.id);
    return `Taken back from ${g.name} for everyone: ${quote}.`;
  }
  throw new GroupNo("action: edit or delete.");
}

// ---------------------------------------------------------- the bot itself --

/** The bot's own WhatsApp name, About and picture, read back. */
export async function changeProfile(w: Bridge, x: { name?: string; about?: string; picture?: { mimetype: string; data: string } | null }, settle = [3000, 5000, 8000]) {
  const said: string[] = [];
  if (x.name) {
    const name = x.name.trim();
    if (name.length > 25) throw new GroupNo("WhatsApp takes 25 characters at most for the name.");
    await w("PUT", "/profile/name", { name });
    const r = await w<{ name?: string }>("GET", "/profile");
    if (str(r.data?.name) !== name) throw new GroupNo(`WhatsApp didn't take the name: it's still ${str(r.data?.name) || "the old one"}.`);
    said.push(`Name: ${name}`);
  }
  if (typeof x.about === "string") {
    await w("PUT", "/profile/status", { status: x.about.trim().slice(0, 139) });
    said.push("About changed");
  }
  if (x.picture === null) {
    await w("DELETE", "/profile/picture");
    said.push("Picture removed");
  } else if (x.picture) {
    const was = await w<{ picture?: string | null }>("GET", "/profile");
    await w("PUT", "/profile/picture", { file: { mimetype: x.picture.mimetype, filename: x.picture.mimetype === "image/png" ? "picture.png" : "picture.jpg", data: x.picture.data } });
    // WhatsApp shows the new one a few seconds later: asked again before saying it didn't change.
    let is = await w<{ picture?: string | null }>("GET", "/profile");
    for (let i = 0; i < settle.length && str(is.data?.picture) === str(was.data?.picture); i++) {
      await new Promise((r) => setTimeout(r, settle[i]));
      is = await w<{ picture?: string | null }>("GET", "/profile");
    }
    if (!str(is.data?.picture) || str(is.data?.picture) === str(was.data?.picture)) throw new GroupNo(`${said.length ? `${said.join("; ")}. ` : ""}The picture did NOT change: WhatsApp still shows the old one.`);
    said.push("Picture changed");
  }
  if (!said.length) throw new GroupNo("Change what: name, about or picture?");
  return `${said.join("; ")}.`;
}
