// Everything iklipse kept about one person (0090), for the bot: what they wrote
// in the groups (voice notes written out, files read), and their emails with
// the team. Only the bot reads it; nothing of it is shown in iklipse.

import { cairoStamp, str, type Db } from "./kit.ts";

const oneLine = (t: string, n: number) => t.replace(/\s+/g, " ").trim().slice(0, n);

const NONE = "00000000-0000-0000-0000-000000000000";

/**
 * What they said elsewhere, oldest first, one line each: "[Mon 3 Oct, 14:00]
 * in Acme group: ...", "[...] email "Logo": ...". The private chat isn't in it
 * (the caller has that). mail: when someone on the team asks, only the emails
 * of the mailboxes they may read (look.ts whoAsks); none given, all of them
 * (the bot talking with the person themselves, about their own emails).
 */
export async function historyOf(db: Db, p: { phone: string | null; lid?: string | null; email?: string | null }, limit = 30, mail?: string[]): Promise<string[]> {
  let emails = p.email ? db.from("mail_message").select("subject, body, sent_at, from_addr").contains("addrs", [p.email.toLowerCase()]) : null;
  if (emails && mail) emails = emails.in("account_id", mail.length ? mail : [NONE]);
  const ors = [p.phone ? `phone.eq.${p.phone}` : "", p.lid ? `sender_id.eq."${p.lid}"` : ""].filter(Boolean);
  const [groups, mails] = await Promise.all([
    ors.length
      ? db.from("wa_message").select("text, sent_at, wa_group(name)").or(ors.join(",")).eq("from_bot", false).order("sent_at", { ascending: false }).limit(limit)
      : Promise.resolve({ data: [] as unknown[] }),
    emails ? emails.order("sent_at", { ascending: false }).limit(10) : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const lines: { at: number; text: string }[] = [];
  for (const m of (groups.data ?? []) as { text: string | null; sent_at: string; wa_group: { name: string | null } | null }[]) {
    if (!str(m.text)) continue;
    lines.push({ at: Date.parse(m.sent_at), text: `[${cairoStamp.format(new Date(m.sent_at))}] in ${m.wa_group?.name ?? "a group"}: ${oneLine(m.text!, 500)}` });
  }
  for (const m of (mails.data ?? []) as { subject: string | null; body: string | null; sent_at: string; from_addr: string | null }[]) {
    const theirs = str(m.from_addr).toLowerCase() === str(p.email).toLowerCase();
    lines.push({
      at: Date.parse(m.sent_at),
      text: `[${cairoStamp.format(new Date(m.sent_at))}] email ${theirs ? "from them" : "from the team"} "${oneLine(m.subject ?? "(no subject)", 120)}": ${oneLine(m.body ?? "", 600)}`,
    });
  }
  return lines.sort((a, b) => a.at - b.at).map((l) => l.text);
}
