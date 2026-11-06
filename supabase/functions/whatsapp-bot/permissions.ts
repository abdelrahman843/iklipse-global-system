// What each person may have the bot do (0137): apart from their role in the
// app. The super admin has everything; everyone else has their kind's
// defaults (admin, member, client: anyone not on the team), with their own
// grants on top, by account or by number, optionally only in some chats.
// Read fresh with every message and every tool call, so a change counts at
// once. Only the super admin sees or changes any of it (the permissions tool,
// and Alerts > Brain > Permissions on their account).
//
// Before 0137 is in the database the bot goes by the tiers, as it always did
// (skillsFor answers null).

import { str, type Db } from "./kit.ts";
import type { Tier } from "./brain.ts";

export type Kind = "admin" | "member" | "client";

/** The kind a tier's defaults come from (the super admin's don't matter: they have everything). */
export const kindOf = (tier: Tier): Kind => (tier === "client" ? "client" : tier === "member" ? "member" : "admin");

export interface Who {
  /** Their account (the team); null for anyone else. */
  user: string | null;
  /** Their number, digits (anyone). */
  phone: string | null;
  tier: Tier;
  /** Where: a private chat ("...@c.us") or a group ("...@g.us"). */
  chat: string;
}

const digits = (v: unknown) => str(v).replace(/\D/g, "");

/** Their skills now, here. null: 0137 isn't in yet (go by the tiers). */
export async function skillsFor(db: Db, who: Who): Promise<Set<string> | null> {
  const { data, error } = await db.rpc("bot_skills_for", {
    p_user: who.user,
    p_phone: digits(who.phone) || null,
    p_kind: kindOf(who.tier),
    p_chat: who.chat,
  });
  if (error) {
    if (!/bot_skills_for|does not exist|schema cache/i.test(error.message)) console.error(JSON.stringify({ ev: "permissions.read_failed", why: error.message }));
    return null;
  }
  // Always a list once 0137 is in (empty: nothing); anything else isn't it.
  if (!Array.isArray(data)) return null;
  return new Set((data as unknown[]).map((s) => str(s)).filter(Boolean));
}

/** May they talk to the bot at all (talk); true before 0137. */
export async function mayTalk(db: Db, who: Who): Promise<boolean> {
  const s = await skillsFor(db, who);
  return !s || s.has("talk");
}

/** May the bot answer them without someone's OK first (reply_alone); true before 0143. */
export async function repliesAlone(db: Db, who: Who): Promise<boolean> {
  const s = await skillsFor(db, who);
  return !s || !s.has("talk") || s.has("reply_alone");
}

/** The super admin said to ignore numbers the bot doesn't know (0143). */
export async function ignoringUnknown(db: Db): Promise<boolean> {
  const { data, error } = await db.from("watch_settings").select("ignore_unknown").eq("id", 1).maybeSingle();
  return !error && (data as { ignore_unknown?: boolean } | null)?.ignore_unknown === true;
}

/** A number the bot knows: a client, someone in a group it's in, or someone it wrote to first. */
export async function knownNumber(db: Db, phone: string): Promise<boolean> {
  const n = digits(phone);
  if (!n) return false;
  const [client, member, wrote] = await Promise.all([
    db.from("client").select("id").eq("phone", n).limit(1),
    db.from("wa_participant").select("chat_id").eq("phone", n).limit(1),
    db.from("wa_dm").select("id").eq("chat_id", `${n}@c.us`).eq("from_bot", true).limit(1),
  ]);
  return !!(client.data?.length || member.data?.length || wrote.data?.length);
}

/** The super admin's own instructions for this kind, and whether the kind is on. Before 0137: on, none. */
export async function kindRules(db: Db, kind: Kind): Promise<{ enabled: boolean; instructions: string }> {
  const { data, error } = await db.from("bot_kind_rules").select("enabled, instructions").eq("kind", kind).maybeSingle();
  if (error || !data) return { enabled: true, instructions: "" };
  return { enabled: data.enabled !== false, instructions: str(data.instructions) };
}

/** The skills' names, for saying what's missing. */
export async function skillNames(db: Db): Promise<Map<string, string>> {
  const { data } = await db.from("bot_skill").select("key, name");
  return new Map(((data ?? []) as { key: string; name: string }[]).map((s) => [s.key, s.name]));
}

// ----------------------------------------------- the super admin's tool --

type Change =
  | { op: "grant"; user_id?: string; phone?: string; skill: string; allowed: boolean; chats?: string[]; note?: string }
  | { op: "reset"; user_id?: string; phone?: string; skill?: string }
  | { op: "default"; kind: Kind; skill: string; allowed: boolean }
  | { op: "rules"; kind: Kind; enabled?: boolean; instructions?: string };

/** One change, as the page makes it (0137 _bot_permissions_apply). The caller checked it's the super admin's own run. */
export async function applyChange(db: Db, c: Change): Promise<void> {
  const { error } = await db.rpc("_bot_permissions_apply", { p: c });
  if (error) throw new Error(error.message.replace(/^.*?ERROR:\s*/, ""));
}

/** Everything, for the super admin: the skills, each kind's defaults and rules, and everyone's own grants. */
export async function overviewOf(db: Db) {
  const [sk, df, gr, ru] = await Promise.all([
    db.from("bot_skill").select("key, name, about, area, grantable").order("sort"),
    db.from("bot_default").select("kind, skill, allowed"),
    db.from("bot_grant").select("user_id, phone, skill, allowed, chats, note, updated_at, profile:user_id(display_name, username)").order("updated_at", { ascending: false }),
    db.from("bot_kind_rules").select("kind, enabled, instructions"),
  ]);
  if (sk.error) throw new Error("Permissions aren't set up yet (0137).");
  const defaults: Record<string, string[]> = { admin: [], member: [], client: [] };
  for (const d of (df.data ?? []) as { kind: Kind; skill: string; allowed: boolean }[]) if (d.allowed) defaults[d.kind]!.push(d.skill);
  return {
    skills: sk.data ?? [],
    defaults,
    rules: ru.data ?? [],
    grants: ((gr.data ?? []) as Record<string, unknown>[]).map((g) => {
      const p = g.profile as { display_name?: string; username?: string } | null;
      return {
        who: g.user_id ? str(p?.display_name) || str(p?.username) || String(g.user_id) : `+${g.phone}`,
        user_id: g.user_id ?? null,
        phone: g.phone ?? null,
        skill: g.skill,
        allowed: g.allowed,
        only_in: g.chats ?? null,
        note: g.note ?? null,
      };
    }),
  };
}
