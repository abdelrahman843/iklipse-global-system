// Alerts that say the same thing (repeat.ts): the cases the duplicates in
// the alerts came from, with the names changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { byShortId, normName, sameAlert, sameAsOlder, shortId, similarTitle, type AlertLike, type Seen } from "./repeat.ts";

const wa = (o: Partial<AlertLike>): AlertLike => ({ kind: "unanswered", source: "whatsapp", chat_id: "acme@g.us", title: "", ...o });
const mail = (o: Partial<AlertLike>): AlertLike => ({ kind: "follow_up", source: "email", title: "", ...o });

test("a client waiting is one alert per chat and person, however the name is written", () => {
  const a = wa({ person: "Sara Ahmed", person_key: "c:sara", title: "Sara is waiting for a reply" });
  assert.ok(sameAlert(a, wa({ person: "سارة", person_key: "c:sara", title: "Sara asks about the logo" })));
  assert.ok(sameAlert(a, wa({ person: "Sara Ahmed (Acme)", title: "Sara is waiting" })));
  // Another client in the same group, or the same client in another group.
  assert.ok(!sameAlert(a, wa({ person: "Sara Ahmed", person_key: "c:mona", title: "x" })));
  assert.ok(!sameAlert(a, wa({ person: "Sara Ahmed", person_key: "c:sara", chat_id: "other@g.us", title: "x" })));
});

test("a key that's only a name is a name: the same person once they're known", () => {
  const named = wa({ person: "Sara Ahmed", person_key: "n:sara ahmed", title: "Sara is waiting for a reply" });
  assert.ok(sameAlert(named, wa({ person: "Sara Ahmed (Acme)", person_key: "c:sara", title: "Sara is chasing" })));
  assert.ok(!sameAlert(named, wa({ person: "Mona", person_key: "c:mona", title: "Mona is waiting" })));
});

test("a promise said twice, or with a new time, is the same one; two different ones aren't", () => {
  const p = wa({ kind: "promise", person: "Omar", person_key: "t:omar", title: "Omar promised the final cut", due_at: "2026-10-23T15:00:00Z" });
  assert.ok(sameAlert(p, wa({ kind: "promise", person_key: "t:omar", title: "Omar will send the final cut", due_at: "2026-10-24T10:00:00Z" })));
  assert.ok(!sameAlert(p, wa({ kind: "promise", person_key: "t:omar", title: "Omar will call Sara back", due_at: "2026-10-23T16:00:00Z" })), "due close together isn't the same thing");
  assert.ok(!sameAlert(p, wa({ kind: "promise", person_key: "t:omar", title: "Omar will call Sara back", due_at: "2026-10-24T16:00:00Z" })));
  assert.ok(!sameAlert(p, wa({ kind: "deadline", person_key: "t:omar", title: "Omar promised the final cut", due_at: "2026-10-23T15:00:00Z" })));
});

test("two promises by the same person due close together are two (a near time alone never makes them one)", () => {
  const logo = { kind: "promise", person: "Omar", person_key: "t:omar", title: "Send the logo files", due_at: "2026-10-23T10:00:00Z" };
  const invoice = { kind: "promise", person: "Omar", person_key: "t:omar", title: "Send the invoice", due_at: "2026-10-23T11:00:00Z" };
  assert.ok(!sameAlert(wa(logo), wa(invoice)));
  assert.ok(!sameAlert(mail({ ...logo, mail_key: "k", mail_account: "m1", mail_thread: "t1" }), mail({ ...invoice, mail_key: "k", mail_account: "m1", mail_thread: "t1" })));
  // The same matter, by the same person: one.
  assert.ok(sameAlert(wa(logo), wa({ ...logo, title: "Omar will send the logo files", due_at: "2026-10-24T18:00:00Z" })));
  // The same matter by someone else: two.
  assert.ok(!sameAlert(wa(logo), wa({ ...logo, person: "Mona", person_key: "t:mona" })));
});

test("the same email in several team members' mailboxes is one alert", () => {
  // Three mailboxes, three threads, the same client and words.
  const a = mail({ person: "Tom (Lumio)", mail_account: "m1", mail_thread: "t1", title: "Waiting on Tom for feedback on the first LUMIO batch" });
  assert.ok(sameAlert(a, mail({ person: "Tom (Lumio)", mail_account: "m2", mail_thread: "t2", title: "Waiting on Tom for feedback on the first LUMIO batch" })));
  assert.ok(sameAlert(mail({ person: "Ann Bell", mail_account: "m1", title: "Waiting on Ann for LinkedIn and Reddit feedback" }), mail({ person: "Ann Bell", mail_account: "m2", title: "Waiting on Ann for LinkedIn and Reddit feedback and approval" })));
  // The same email, named after different people in each mailbox.
  assert.ok(sameAlert(mail({ kind: "deadline", person: "Ann Bell", title: "Send Ann the updated content by Monday" }), mail({ kind: "deadline", person: "Omar", title: "Send Ann the updated content by Monday" })));
  // A client waiting: the same email (its Message-ID), or the same conversation in one mailbox.
  assert.ok(sameAlert(mail({ kind: "unanswered", mail_key: "abc@x", mail_account: "m1" }), mail({ kind: "unanswered", mail_key: "abc@x", mail_account: "m2" })));
  assert.ok(!sameAlert(mail({ kind: "unanswered", mail_key: "abc@x", person_key: "e:sara@x.com" }), mail({ kind: "unanswered", mail_key: "def@x", person_key: "e:sara@x.com" })));
});

test("different things about the same client stay apart", () => {
  const inv = (n: string) => mail({ person: "Ken Lowe", person_key: "e:ken@x.com", title: `Waiting on Ken for payment of invoice I2602${n}`, due_at: "2026-10-25T10:00:00Z" });
  assert.ok(!sameAlert(inv("81"), inv("83")), "two invoices");
  assert.ok(!sameAlert(mail({ person: "Ken Lowe", title: "Waiting on Ken for feedback on the paid social plan" }), mail({ person: "Kenneth Lowe", title: "Waiting on Kenneth for feedback on the updated reel" })));
  // Two promises in one email are two.
  assert.ok(!sameAlert(mail({ kind: "promise", mail_key: "k", person: "Omar", title: "Send the logo files" }), mail({ kind: "promise", mail_key: "k", person: "Omar", title: "Book the studio for Sunday", due_at: "2026-10-30T10:00:00Z" })));
});

test("titles: words in common, any language, no number that differs", () => {
  assert.ok(similarTitle("Waiting on Sara for the logo files", "Sara: logo files"));
  assert.ok(similarTitle("هبعت التصميمات بكرة", "التصميمات بكرة"));
  assert.ok(!similarTitle("Invoice I260281", "Invoice I260282"));
  assert.equal(normName("Tom (Lumio)"), "tom");
});

test("Claude's short ids find the alert, and the old A1 still works", () => {
  const open = [{ id: "1f3a9c2e-0000-4000-8000-000000000001" }, { id: "77aa00bb-0000-4000-8000-000000000002" }];
  assert.equal(shortId(open[0]!.id), "A1f3a9c");
  assert.equal(byShortId(open, "A77aa00"), open[1]);
  assert.equal(byShortId(open, "a1f3a9c"), open[0]);
  assert.equal(byShortId(open, "A2"), open[1]);
  assert.equal(byShortId(open, "A9"), undefined);
});

test("the digest shows each thing once, and nobody is rung twice for it", () => {
  const seen = new Map<string, Seen>(
    [
      { id: "old", created_at: "2026-10-21T05:54:00Z", people: ["omar", "mona"], ...mail({ person: "Tom", title: "Waiting on Tom for feedback" }) },
      { id: "new", created_at: "2026-10-21T05:54:01Z", people: ["omar", "tarek"], ...mail({ person: "Tom", title: "Waiting on Tom for feedback" }) },
      { id: "else", created_at: "2026-10-21T06:00:00Z", people: ["omar"], ...mail({ person: "Ann", title: "Waiting on Ann for the brief" }) },
    ].map((a) => [a.id, a]),
  );
  assert.equal(sameAsOlder(seen, "new"), true);
  assert.equal(sameAsOlder(seen, "old"), false);
  assert.equal(sameAsOlder(seen, "else"), false);
  // Omar is rung by the old one; Tarek only has the new one, so he's rung for it.
  assert.equal(sameAsOlder(seen, "new", "omar"), true);
  assert.equal(sameAsOlder(seen, "new", "tarek"), false);
});
