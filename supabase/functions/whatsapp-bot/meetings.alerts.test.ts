// Alerts about a call close once a team Calendly shows it booked (meetings.ts
// closeBookedAlerts): only with that person, by email or by whole name.
//   npm run test:bot

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { bookedFor, closeBookedAlerts } from "./meetings.ts";

const H = 60 * 60_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
const soon = (h: number) => new Date(Date.now() + h * H).toISOString();

const meeting = (o: Partial<{ invitee_name: string | null; invitee_email: string | null; attendees: unknown[]; topic: string }>) => ({
  event_id: "e1",
  topic: o.topic ?? "30 Minute Meeting",
  start_at: soon(24),
  invitee_name: o.invitee_name ?? null,
  invitee_email: o.invitee_email ?? null,
  attendees: o.attendees ?? [],
  created_at: ago(1),
  status: "booked",
});

test("a call booked with someone else who shares a first name doesn't close the alert", () => {
  const a = { person: "Ahmed Ali", created_at: ago(2) };
  assert.equal(bookedFor(a, [], [meeting({ invitee_name: "Ahmed Mohamed" })]), undefined);
  // A first name alone never matches, not even the same one.
  assert.equal(bookedFor({ person: "Ahmed", created_at: ago(2) }, [], [meeting({ invitee_name: "Ahmed" })]), undefined);
  // Nor the topic.
  assert.equal(bookedFor(a, [], [meeting({ invitee_name: "Sara Fathy", topic: "Call with Ahmed Ali" })]), undefined);
});

test("the whole name (brackets aside) or their email finds their call; someone on the team doesn't", () => {
  const a = { person: "Costi Ciorobea (Acme)", created_at: ago(2) };
  assert.ok(bookedFor(a, [], [meeting({ invitee_name: "costi ciorobea" })]));
  assert.ok(bookedFor({ person: "Olivia", created_at: ago(2) }, ["olivia@acme.com"], [meeting({ invitee_name: "O B", invitee_email: "Olivia@acme.com" })]));
  // The team member on the call isn't who it's about.
  const team = [{ kind: "team", id: "u1", name: "Costi Ciorobea", email: "costi@iklipse.com" }];
  assert.equal(bookedFor(a, ["costi@iklipse.com"], [meeting({ invitee_name: "Sara Fathy", attendees: team })]), undefined);
  // A call booked more than a day before the alert is another one.
  assert.equal(bookedFor(a, [], [{ ...meeting({ invitee_name: "Costi Ciorobea" }), created_at: ago(30) }]), undefined);
});

test("closed like any alert: it stops calling, it's in the alert's history, and its notifications go quiet", async () => {
  const quieted: unknown[] = [];
  const f = fakeDb(
    {
      watch_alert: [
        { id: "a1", chat_id: null, kind: "unanswered", status: "open", title: "Uliana asks for a call", detail: null, person: "Uliana", mail_from: "Uliana P <uliana@client.com>", created_at: ago(2) },
        { id: "a2", chat_id: null, kind: "unanswered", status: "open", title: "Ahmed Ali wants a meeting", detail: null, person: "Ahmed Ali", mail_from: null, created_at: ago(2) },
        { id: "a3", chat_id: null, kind: "follow_up", status: "open", title: "Waiting on Kenny for feedback", detail: null, person: "Kenny Smith", mail_from: null, created_at: ago(2) },
      ],
      wa_bot_meeting: [meeting({ invitee_name: "Uliana P", invitee_email: "uliana@client.com" }), meeting({ invitee_name: "Ahmed Mohamed" }), meeting({ invitee_name: "Kenny Smith" })],
      watch_recipient: [{ alert_id: "a1", user_id: "u1", next_call_at: ago(0) }],
      watch_event: [],
      client: [],
    },
    { rpc: { _watch_quiet_notifications: (args) => void quieted.push(args.p_alert) } },
  );
  assert.equal(await closeBookedAlerts(f.db), 1);
  const [a1, a2, a3] = f.tables.watch_alert;
  assert.equal(a1!.status, "handled");
  assert.match(String(a1!.close_note), /^Call booked: 30 Minute Meeting on .+ \(found on a team Calendly\)\.$/);
  assert.equal(a1!.next_alert_at, null);
  assert.equal(f.tables.watch_recipient[0]!.next_call_at, null);
  assert.deepEqual(f.tables.watch_event.map((e) => [e.alert_id, e.what]), [["a1", "handled"]]);
  assert.deepEqual(quieted, ["a1"]);
  // Ahmed Mohamed's call isn't Ahmed Ali's; Kenny's alert isn't about a call.
  assert.equal(a2!.status, "open");
  assert.equal(a3!.status, "open");
});
