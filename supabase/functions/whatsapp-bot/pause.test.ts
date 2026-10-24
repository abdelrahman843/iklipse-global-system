// Pausing an alert and reminding people about it every so often (pause.ts,
// orders.ts action alert): an admin's "pause it till tomorrow at 2 pm, then
// every 20 minutes remind Omar, Karim and Hana till it's resolved" pauses it
// (no ringing, no calls, out of the open alerts list), then reminds them
// privately, in working hours, at most so often and so many a day, until it's
// closed; resume, stop and a new pace; what the ringing holds back; before
// 0116 runs; and the whole way through the router (Claude stubbed).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import {
  alertAct,
  DAY_MAX,
  held,
  holdCall,
  holdRing,
  listable,
  MIN_EVERY,
  nudgesOn,
  nudgeText,
  pausedNow,
  sendNudges,
  untilText,
  type AlertAct,
  type OpenAlert,
} from "./pause.ts";
import { ORDER_SYSTEM, orderTool, takeOrder, YOU_CAN } from "./orders.ts";
import { clockIn } from "./zones.ts";
import { countCall, TZ, type Person, type Settings, type Team } from "./kit.ts";
import type { Attendee } from "./meetings.ts";

const cairo = clockIn(TZ);
const at = (d: string, t: string) => cairo.at(d, t);
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
/** Friday 23 Oct 2026, 8:01 PM in Cairo: when it's asked. */
const NOW = at("2026-10-23", "20:01");
/** Saturday 24 Oct, 2 PM: the end of the pause. */
const TWO_PM = at("2026-10-24", "14:00");

const s = { orders_enabled: true, quiet_from: null, quiet_to: null, off_days: [], off_dates: [], model: "claude-haiku-5-5", bot_phone: null } as unknown as Settings;
/** Quiet from midnight to 12:01 PM, as the team has it. */
const noonOn = { ...s, quiet_from: "00:00:00", quiet_to: "12:01:00" } as unknown as Settings;
/** And Saturday and Sunday off (Sat 6, Sun 0), as the team has it too. */
const weekOff = { ...noonOn, off_days: [0, 6] } as unknown as Settings;

const att = (id: string, name: string, phone: string | null): Attendee => ({ kind: "team", id, name, email: null, phone });
const sara = att("u-sara", "Sara", "15555550104");
const omar = att("u-omar", "Omar", "15555550105");
const karim = att("u-karim", "Karim", "15555550106");
const hana = att("u-hana", "Hana", "15555550107");
const team = new Map([sara, omar, karim, hana].map((p) => [p.id!, p]));

const acme: OpenAlert = {
  id: "al-1",
  chat_id: "acme@g.us",
  title: "Lina shared the launch news",
  detail: "Lina tagged the team about the Acme launch on 28 October and is waiting for a reply.",
  source: "whatsapp",
  created_at: "2026-10-23T10:49:00.000Z",
  wa_group: { name: "Acme x iklipse" },
  slack_channel: null,
};
const nile: OpenAlert = { ...acme, id: "al-2", chat_id: "nile@g.us", title: "Mona asked for the invoice", detail: "Mona asked for the invoice.", created_at: "2026-10-23T09:00:00.000Z", wa_group: { name: "Nile Foods" } };

function world(o: { fail?: (c: { table: string }) => string | null } = {}) {
  return fakeDb(
    {
      watch_alert: [
        { ...acme, kind: "unanswered", status: "open", snoozed_until: null, next_alert_at: "2026-10-23T17:00:00.000Z", due_at: "2026-10-23T10:49:27.000Z" },
        { ...nile, kind: "unanswered", status: "open", snoozed_until: null, next_alert_at: "2026-10-23T17:00:00.000Z", due_at: "2026-10-23T09:00:00.000Z" },
      ],
      // Omar and Karim have been called all afternoon; Hana not yet.
      watch_recipient: [
        { alert_id: "al-1", user_id: "u-omar", calls: 86, calling: false, next_call_at: "2026-10-23T17:05:00.000Z" },
        { alert_id: "al-1", user_id: "u-karim", calls: 85, calling: false, next_call_at: "2026-10-23T17:04:00.000Z" },
        { alert_id: "al-1", user_id: "u-hana", calls: 0, calling: false, next_call_at: null },
      ],
      profile: [sara, omar, karim, hana].map((p) => ({ id: p.id, display_name: p.name, is_active: true, role: p.id === "u-sara" ? "admin" : "member" })),
      bot_alert_nudge: [],
      watch_event: [],
    },
    o.fail ? { fail: o.fail } : {},
  );
}

function sender() {
  const sent: { chat: string; text: string; quoted: string | null | undefined }[] = [];
  const send = async (chat: string, text: string, quoted?: string | null) => {
    sent.push({ chat, text, quoted });
    return `wamid-${sent.length}`;
  };
  return { send, sent };
}

const by = { id: "u-sara", name: "Sara", admin: true };
const where = { chat_id: "alerts@g.us", message_id: "m-1" };
const ask = (act: AlertAct, more: Partial<Parameters<typeof alertAct>[2]> = {}) => ({ by, act, open: [acme], alert: acme, people: [] as Attendee[], others: [] as string[], at: where, now: NOW, ...more });
const pauseAsk: AlertAct = { id: "a1", until_date: "2026-10-24", until_time: "02:00", until_ampm: "pm", every_min: 20 };

// ------------------------------------------------------------ the asking --

test("paused until tomorrow at 2 pm, then every 20 minutes to three people: said in one line, kept, and its alerts and calls stop", async () => {
  const f = world();
  const said = await alertAct(f.db, s, ask(pauseAsk, { people: [omar, karim, hana] }));
  assert.equal(said, "Paused until Sat 2:00 PM. Then every 20 minutes I'll remind Omar, Karim and Hana until it's resolved.");
  const a = f.tables.watch_alert!.find((x) => x.id === "al-1")!;
  assert.equal(a.snoozed_until, iso(TWO_PM));
  // Its own reminders take the place of its alerts and calls.
  assert.equal(a.next_alert_at, null);
  assert.deepEqual(f.tables.watch_recipient!.map((r) => r.next_call_at), [null, null, null]);
  const n = f.tables.bot_alert_nudge![0]!;
  assert.deepEqual(
    { people: n.people, every_min: n.every_min, next_at: n.next_at, status: n.status, set_by: n.set_by, chat_id: n.chat_id, message_id: n.message_id },
    { people: ["u-omar", "u-karim", "u-hana"], every_min: 20, next_at: iso(TWO_PM), status: "on", set_by: "u-sara", chat_id: "alerts@g.us", message_id: "m-1" },
  );
  assert.deepEqual(
    f.tables.watch_event!.map((e) => [e.what, e.detail]),
    [
      ["reminders", "Every 20 minutes to Omar, Karim and Hana on WhatsApp, said Sara"],
      ["snoozed", "Until Sat 2:00 PM, said Sara on WhatsApp"],
    ],
  );
  // The other open alert is untouched.
  assert.equal(f.tables.watch_alert!.find((x) => x.id === "al-2")!.next_alert_at, "2026-10-23T17:00:00.000Z");
});

test("a pause alone: its alerts and the calls already going wait for its end, then carry on as before", async () => {
  const f = world();
  const said = await alertAct(f.db, s, ask({ pause_minutes: 120 }));
  const until = NOW + 120 * MIN;
  assert.equal(said, `Paused until ${untilText(until, TZ, NOW)}. Then its usual alerts start again.`);
  const a = f.tables.watch_alert!.find((x) => x.id === "al-1")!;
  assert.equal(a.snoozed_until, iso(until));
  assert.equal(a.next_alert_at, iso(until));
  // Who was being called waits; who wasn't still isn't.
  assert.deepEqual(f.tables.watch_recipient!.map((r) => r.next_call_at), [iso(until), iso(until), null]);
  assert.deepEqual(f.tables.bot_alert_nudge, []);
});

test("in their own time zone: 2 pm is theirs, and said so", async () => {
  const f = world();
  const said = await alertAct(f.db, s, ask({ until_date: "2026-10-24", until_time: "14:00" }, { by: { ...by, zone: "Asia/Dubai" } }));
  const two = clockIn("Asia/Dubai").at("2026-10-24", "14:00");
  assert.equal(said, "Paused until Sat 2:00 PM Dubai time. Then its usual alerts start again.");
  assert.equal(f.tables.watch_alert![0]!.snoozed_until, iso(two));
});

test("no pause: the reminders start now; closer than 10 minutes isn't done; nobody named gets asked", async () => {
  const f = world();
  const said = await alertAct(f.db, s, ask({ every_min: 5 }, { people: [omar] }));
  assert.equal(said, `Every ${MIN_EVERY} minutes from now I'll remind Omar until it's resolved. ${MIN_EVERY} minutes apart is the most often I remind.`);
  assert.equal(f.tables.bot_alert_nudge![0]!.every_min, MIN_EVERY);
  assert.equal(f.tables.bot_alert_nudge![0]!.next_at, iso(NOW));
  assert.equal(await alertAct(world().db, s, ask({ every_min: 20 })), "Who should I remind?");
});

test("someone with no number, or not on the team: said, and the rest still happens", async () => {
  const f = world();
  const said = await alertAct(f.db, s, ask(pauseAsk, { people: [omar, att("u-ziad", "Ziad", null)], others: ["Lina Hassan (Acme)"] }));
  assert.equal(
    said,
    "Paused until Sat 2:00 PM. Then every 20 minutes I'll remind Omar until it's resolved. I don't have Ziad's WhatsApp number. Add it on the Users page. I only remind the team this way, not Lina.",
  );
  assert.deepEqual(f.tables.bot_alert_nudge![0]!.people, ["u-omar"]);
});

test("asked at night, with quiet hours: the reminders start when work does, and that's said", async () => {
  const f = world();
  const said = await alertAct(f.db, noonOn, ask({ every_min: 30 }, { people: [omar], now: at("2026-10-24", "01:00") }));
  assert.equal(said, "From Sat 12:01 PM, when work starts, every 30 minutes I'll remind Omar until it's resolved.");
});

test("asked on a Friday evening, with Saturday and Sunday off: the pause ends on a day off, and the reminders are said to start Monday", async () => {
  const f = world();
  const said = await alertAct(f.db, weekOff, ask(pauseAsk, { people: [omar, karim, hana] }));
  assert.equal(said, "Paused until Sat 2:00 PM. From Mon 12:01 PM, when work starts, every 20 minutes I'll remind Omar, Karim and Hana until it's resolved.");
  assert.equal(f.tables.bot_alert_nudge![0]!.next_at, iso(TWO_PM));
});

test("which alert: the one said; else the only one open; else asked, and nothing changes", async () => {
  const f = world();
  assert.equal(
    await alertAct(f.db, s, ask({ pause_minutes: 60 }, { open: [nile, acme], alert: undefined })),
    "Which alert: Mona asked for the invoice (Nile Foods) or Lina shared the launch news (Acme x iklipse)?",
  );
  assert.equal(f.tables.watch_alert!.every((a) => a.snoozed_until === null), true);
  // Two open, one said: its place goes first.
  const said = await alertAct(f.db, s, ask({ pause_minutes: 60 }, { open: [nile, acme], alert: nile }));
  assert.match(said, /^Nile Foods: Paused until /);
  assert.equal(f.tables.watch_alert!.find((x) => x.id === "al-2")!.snoozed_until, iso(NOW + 60 * MIN));
});

test("carrying on: \"every 30 minutes instead\", \"resume\" and \"stop reminding them\" find the one with reminders", async () => {
  const f = world();
  await alertAct(f.db, s, ask(pauseAsk, { people: [omar, karim, hana] }));
  const later = { open: [nile, acme], alert: undefined, now: NOW + 5 * MIN };
  // A new pace: the same people, the pause kept.
  assert.equal(
    await alertAct(f.db, s, ask({ every_min: 30 }, later)),
    "Acme x iklipse: It's paused until Sat 2:00 PM. Then every 30 minutes I'll remind Omar, Karim and Hana until it's resolved.",
  );
  assert.deepEqual([f.tables.bot_alert_nudge![0]!.every_min, f.tables.bot_alert_nudge![0]!.people], [30, ["u-omar", "u-karim", "u-hana"]]);
  // Also Sara: on top of them.
  await alertAct(f.db, s, ask({ people: ["t:u-sara"], also: true }, { ...later, people: [sara] }));
  assert.deepEqual(f.tables.bot_alert_nudge![0]!.people, ["u-omar", "u-karim", "u-hana", "u-sara"]);
  // Resume: the pause ends, the reminders start now.
  assert.equal(await alertAct(f.db, s, ask({ resume: true }, later)), "Acme x iklipse: Resumed. Every 30 minutes from now I'll remind Omar, Karim, Hana and Sara until it's resolved.");
  const a = f.tables.watch_alert!.find((x) => x.id === "al-1")!;
  assert.equal(a.snoozed_until, null);
  assert.equal(a.next_alert_at, null);
  assert.equal(f.tables.bot_alert_nudge![0]!.next_at, iso(NOW + 5 * MIN));
  // Stop: its usual alerts come back, and the calls to whoever was being called.
  assert.equal(await alertAct(f.db, s, ask({ stop: true }, later)), "Acme x iklipse: Stopped reminding Omar, Karim, Hana and Sara. Its usual alerts are back on.");
  assert.equal(f.tables.bot_alert_nudge![0]!.status, "stopped");
  assert.equal(a.next_alert_at, iso(NOW + 5 * MIN));
  assert.deepEqual(f.tables.watch_recipient!.map((r) => r.next_call_at), [iso(NOW + 5 * MIN), iso(NOW + 5 * MIN), null]);
  assert.equal(
    await alertAct(f.db, s, ask({ stop: true }, { ...later, alert: acme })),
    "Acme x iklipse: I'm not sending any reminders of my own about it. Its usual alerts are still on: tell me to pause it until a time, or mark it handled.",
  );
});

test("\"stop the reminders\" when it has none of its own: what still goes on is said, and what to do", async () => {
  const f = world();
  const calling = { ...s, calls_enabled: true } as Settings;
  assert.equal(
    await alertAct(f.db, calling, ask({ stop: true })),
    "I'm not sending any reminders of my own about it. Its usual alerts and calls are still on: tell me to pause it until a time, or mark it handled.",
  );
  await alertAct(f.db, calling, ask({ until_date: "2026-10-24", until_time: "02:00", until_ampm: "pm" }));
  assert.equal(await alertAct(f.db, calling, ask({ stop: true })), "I'm not sending any reminders of my own about it. It's paused until Sat 2:00 PM, then its usual alerts and calls start again.");
  assert.deepEqual(f.tables.bot_alert_nudge, []);
});

test("\"stop reminding\" someone who isn't reminded (the asker, a freelancer): nothing changes, and who is reminded is said", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar, hana] }));
  // Sara asked for them and isn't reminded herself: "stop reminding me".
  assert.equal(await alertAct(f.db, s, ask({ stop: true }, { people: [sara] })), "I'm not reminding you about it. I remind Omar and Hana every 20 minutes.");
  assert.equal(await alertAct(f.db, s, ask({ stop: true }, { people: [karim] })), "I'm not reminding Karim about it. I remind Omar and Hana every 20 minutes.");
  assert.equal(await alertAct(f.db, s, ask({ stop: true }, { others: ["Lina Hassan (Acme)"] })), "I'm not reminding Lina about it. I remind Omar and Hana every 20 minutes.");
  const n = f.tables.bot_alert_nudge![0]!;
  assert.deepEqual([n.status, n.people, n.next_at], ["on", ["u-omar", "u-hana"], iso(NOW)]);
  // The alert's usual alerts and calls stay off.
  assert.equal(f.tables.watch_alert![0]!.next_alert_at, null);
  assert.deepEqual(f.tables.watch_recipient!.map((r) => r.next_call_at), [null, null, null]);
  assert.deepEqual(f.tables.watch_event!.map((e) => e.what), ["reminders"]);
});

test("resumed a few minutes after a round: the next one still waits for the pace", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar] }));
  assert.equal(await sendNudges(f.db, s, sender().send, team, Date.now() + 60_000, NOW + MIN), 1);
  // Paused right after it, resumed two minutes later.
  await alertAct(f.db, s, ask({ pause_minutes: 60 }, { now: NOW + 2 * MIN }));
  assert.equal(await alertAct(f.db, s, ask({ resume: true }, { now: NOW + 4 * MIN })), "Resumed. From Fri 8:22 PM, every 20 minutes I'll remind Omar until it's resolved.");
  assert.equal(f.tables.bot_alert_nudge![0]!.next_at, iso(NOW + 21 * MIN));
});

test("stopped, then set again a moment later: the first round still waits for the pace", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar] }));
  assert.equal(await sendNudges(f.db, s, sender().send, team, Date.now() + 60_000, NOW + MIN), 1);
  await alertAct(f.db, s, ask({ stop: true }, { now: NOW + 2 * MIN }));
  assert.equal(f.tables.bot_alert_nudge![0]!.status, "stopped");
  assert.equal(await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar], now: NOW + 3 * MIN })), "From Fri 8:22 PM, every 20 minutes I'll remind Omar until it's resolved.");
  const n = f.tables.bot_alert_nudge![0]!;
  assert.deepEqual([n.status, n.next_at], ["on", iso(NOW + 21 * MIN)]);
});

test("\"stop reminding Omar\": only him; the others go on, and the alert's usual alerts stay off", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar, karim, hana] }));
  assert.equal(await alertAct(f.db, s, ask({ stop: true }, { people: [omar] })), "I'll stop reminding Omar. Still every 20 minutes: Karim and Hana, until it's resolved.");
  const n = f.tables.bot_alert_nudge![0]!;
  assert.deepEqual([n.status, n.people], ["on", ["u-karim", "u-hana"]]);
  assert.equal(f.tables.watch_alert![0]!.next_alert_at, null);
});

test("only admins; a time that's gone or too far is asked back; a closed alert is said", async () => {
  const f = world();
  assert.equal(await alertAct(f.db, s, ask(pauseAsk, { by: { ...by, admin: false }, people: [omar] })), "Only admins can pause an alert or set its reminders.");
  assert.equal(await alertAct(f.db, s, ask({ until_date: "2026-10-23", until_time: "09:00", until_ampm: "am" })), "That time's already gone. Until when should I pause it?");
  assert.equal(await alertAct(f.db, s, ask({ until_date: "2026-11-20", until_time: "10:00", until_ampm: "am" })), "I can pause an alert for up to 7 days. Until when?");
  assert.equal(await alertAct(f.db, s, ask({})), "What should I do with the alert: pause it until when, or remind whom and how often?");
  assert.deepEqual(f.tables.watch_event, []);
  f.tables.watch_alert![0]!.status = "handled";
  assert.equal(await alertAct(f.db, s, ask(pauseAsk, { people: [omar] })), "That alert is closed already.");
});

test("before 0116 runs: the pause still works, and the reminders are said not to yet", async () => {
  const f = world({ fail: (c) => (c.table === "bot_alert_nudge" ? 'relation "public.bot_alert_nudge" does not exist' : null) });
  const said = await alertAct(f.db, s, ask(pauseAsk, { people: [omar] }));
  assert.equal(said, "Paused until Sat 2:00 PM. Then its usual alerts start again. I can't send them reminders every 20 minutes yet: iklipse needs an update for that first.");
  assert.equal(f.tables.watch_alert![0]!.snoozed_until, iso(TWO_PM));
  assert.equal(f.tables.watch_alert![0]!.next_alert_at, iso(TWO_PM));
  assert.deepEqual(await nudgesOn(f.db, ["al-1"]), new Set());
  assert.equal(await sendNudges(f.db, s, sender().send, team, Date.now() + 60_000, TWO_PM), 0);
});

// --------------------------------------------------------- the ringing --

test("what the ringing holds back: a paused alert until the pause ends; one with its own reminders, for good", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar] }));
  const nudged = await nudgesOn(f.db, ["al-1", "al-2"]);
  assert.deepEqual(nudged, new Set(["al-1"]));
  assert.deepEqual(held({ id: "al-1", snoozed_until: null }, nudged, NOW), { until: null });
  assert.deepEqual(held({ id: "al-2", snoozed_until: iso(TWO_PM) }, nudged, NOW), { until: iso(TWO_PM) });
  assert.equal(held({ id: "al-2", snoozed_until: iso(NOW - MIN) }, nudged, NOW), null);
  assert.equal(held({ id: "al-2", snoozed_until: null }, nudged, NOW), null);
  // The open alerts list leaves out a paused one.
  assert.equal(pausedNow({ snoozed_until: iso(TWO_PM) }, NOW), true);
  assert.equal(pausedNow({ snoozed_until: iso(TWO_PM) }, TWO_PM), false);
});

test("held back, as the minute's run writes it (index.ts ring, callDue): the next alert and call at the pause's end, or none with its own reminders", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar] }));
  const nudged = await nudgesOn(f.db, ["al-1", "al-2"]);
  // al-2 paused from the app, with a call due to Omar.
  const nile2 = f.tables.watch_alert!.find((x) => x.id === "al-2")!;
  nile2.snoozed_until = iso(TWO_PM);
  f.tables.watch_recipient!.push({ alert_id: "al-2", user_id: "u-omar", calls: 3, calling: false, next_call_at: iso(NOW) });
  assert.equal(await holdRing(f.db, { id: "al-2", snoozed_until: iso(TWO_PM) }, nudged, NOW), true);
  assert.equal(await holdCall(f.db, { alert_id: "al-2", user_id: "u-omar" }, { id: "al-2", snoozed_until: iso(TWO_PM) }, nudged, NOW), true);
  assert.equal(nile2.next_alert_at, iso(TWO_PM));
  assert.equal(f.tables.watch_recipient!.at(-1)!.next_call_at, iso(TWO_PM));
  // al-1 with its own reminders: due again (the app, say), it's set to none.
  const acme1 = f.tables.watch_alert!.find((x) => x.id === "al-1")!;
  acme1.next_alert_at = iso(NOW);
  f.tables.watch_recipient![0]!.next_call_at = iso(NOW);
  assert.equal(await holdRing(f.db, { id: "al-1", snoozed_until: null }, nudged, NOW), true);
  assert.equal(await holdCall(f.db, { alert_id: "al-1", user_id: "u-omar" }, { id: "al-1", snoozed_until: null }, nudged, NOW), true);
  assert.equal(acme1.next_alert_at, null);
  assert.equal(f.tables.watch_recipient![0]!.next_call_at, null);
  // Neither, or the pause over: it rings, and nothing is written.
  const before = JSON.stringify(f.tables);
  assert.equal(await holdRing(f.db, { id: "al-2", snoozed_until: iso(TWO_PM) }, nudged, TWO_PM), false);
  assert.equal(await holdCall(f.db, { alert_id: "al-2", user_id: "u-omar" }, { id: "al-2", snoozed_until: null }, nudged, NOW), false);
  assert.equal(JSON.stringify(f.tables), before);
});

test("the open alerts list (index.ts digest): a paused one is left out, and when they all are, that's said", () => {
  const a = { id: "x", snoozed_until: null };
  const b = { id: "y", snoozed_until: iso(TWO_PM) };
  const c = { id: "z", snoozed_until: iso(TWO_PM + 60 * MIN) };
  assert.deepEqual(listable([a, b], NOW), { open: [a], none: null });
  assert.deepEqual(listable([b, c], NOW), { open: [], none: "No open alerts right now (2 paused)." });
  assert.deepEqual(listable([], NOW), { open: [], none: "No open alerts right now." });
  // The pause over: back on the list.
  assert.deepEqual(listable([b], TWO_PM), { open: [b], none: null });
});

test("calls made (index.ts startCall): several people called in one run all add up", async () => {
  const f = world();
  const a = f.tables.watch_alert!.find((x) => x.id === "al-1")!;
  a.calls_made = 218;
  // Two calls in one run, both read with the same count.
  await countCall(f.db, "al-1", 218);
  await countCall(f.db, "al-1", 218);
  assert.equal(a.calls_made, 220);
});

// --------------------------------------------------------- the sending --

test("from the end of the pause: one private message to each, then every 20 minutes, said on the alert", async () => {
  const f = world();
  await alertAct(f.db, s, ask(pauseAsk, { people: [omar, karim, hana] }));
  const { send, sent } = sender();
  // Still paused: nothing.
  assert.equal(await sendNudges(f.db, s, send, team, Date.now() + 60_000, TWO_PM - MIN), 0);
  assert.equal(await sendNudges(f.db, s, send, team, Date.now() + 60_000, TWO_PM), 1);
  assert.deepEqual(sent.map((x) => x.chat), ["15555550105@c.us", "15555550106@c.us", "15555550107@c.us"]);
  assert.equal(
    sent[0]!.text,
    "Hi Omar, a reminder from Sara about an open alert in Acme x iklipse: Lina tagged the team about the Acme launch on 28 October and is waiting for a reply. Waiting 1 day. Once it's dealt with, tap Handled on it in iklipse, or tell me here.",
  );
  assert.doesNotMatch(sent.map((x) => x.text).join("\n"), /[—–]/);
  const n = f.tables.bot_alert_nudge![0]!;
  assert.deepEqual([n.next_at, n.rounds, n.rounds_day, n.day], [iso(TWO_PM + 20 * MIN), 1, 1, "2026-10-24"]);
  assert.deepEqual(f.tables.watch_event!.at(-1)!.what, "reminder");
  assert.equal(f.tables.watch_event!.at(-1)!.detail, "Reminder 1 to Omar, Karim and Hana on WhatsApp");
  // Not before 20 minutes; then again.
  assert.equal(await sendNudges(f.db, s, send, team, Date.now() + 60_000, TWO_PM + 10 * MIN), 0);
  assert.equal(await sendNudges(f.db, s, send, team, Date.now() + 60_000, TWO_PM + 20 * MIN), 1);
  assert.equal(sent.length, 6);
});

test("two runs at once send a round once", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar, karim] }));
  const { send, sent } = sender();
  const [x, y] = await Promise.all([sendNudges(f.db, s, send, team, Date.now() + 60_000, NOW + MIN), sendNudges(f.db, s, send, team, Date.now() + 60_000, NOW + MIN)]);
  assert.equal(x + y, 1);
  assert.equal(sent.length, 2);
});

test("in the quiet hours nothing goes; paused again, they wait for it", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar] }));
  const { send, sent } = sender();
  assert.equal(await sendNudges(f.db, noonOn, send, team, Date.now() + 60_000, at("2026-10-24", "03:00")), 0);
  // Paused from the app meanwhile: the round moves to its end.
  f.tables.watch_alert![0]!.snoozed_until = iso(TWO_PM);
  assert.equal(await sendNudges(f.db, s, send, team, Date.now() + 60_000, NOW + MIN), 0);
  assert.equal(f.tables.bot_alert_nudge![0]!.next_at, iso(TWO_PM));
  assert.deepEqual(sent, []);
});

test("at most so many a day: then nothing until work starts the next day", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar] }));
  Object.assign(f.tables.bot_alert_nudge![0]!, { rounds: 40, rounds_day: DAY_MAX, day: "2026-10-23", next_at: iso(NOW) });
  const { send, sent } = sender();
  assert.equal(await sendNudges(f.db, noonOn, send, team, Date.now() + 60_000, NOW + MIN), 0);
  assert.deepEqual(sent, []);
  assert.equal(f.tables.bot_alert_nudge![0]!.next_at, iso(at("2026-10-24", "12:01")));
  // A new day counts from nothing.
  assert.equal(await sendNudges(f.db, noonOn, send, team, Date.now() + 60_000, at("2026-10-24", "12:01")), 1);
  assert.equal(f.tables.bot_alert_nudge![0]!.rounds_day, 1);
});

test("the alert closed: they stop, and that's said where they were asked for, once", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar, karim, hana] }));
  f.tables.watch_alert![0]!.status = "handled";
  const { send, sent } = sender();
  assert.equal(await sendNudges(f.db, s, send, team, Date.now() + 60_000, NOW + MIN), 0);
  assert.deepEqual(sent, [{ chat: "alerts@g.us", text: "The alert in Acme x iklipse is closed, so I stopped reminding Omar, Karim and Hana.", quoted: "m-1" }]);
  assert.equal(f.tables.bot_alert_nudge![0]!.status, "done");
  assert.equal(await sendNudges(f.db, s, send, team, Date.now() + 60_000, NOW + 30 * MIN), 0);
  assert.equal(sent.length, 1);
});

test("nobody of them can be reached anymore: they end, its usual alerts and calls come back, said once", async () => {
  const f = world();
  await alertAct(f.db, s, ask({ every_min: 20 }, { people: [omar, karim] }));
  // A team that couldn't be read (nobody's number) ends nothing.
  await sendNudges(f.db, s, sender().send, new Map(), Date.now() + 60_000, NOW + MIN);
  assert.equal(f.tables.bot_alert_nudge![0]!.status, "on");
  f.tables.bot_alert_nudge![0]!.next_at = iso(NOW + MIN);
  // Omar left the team, and Karim's number is gone.
  const left = new Map([sara, hana, { ...karim, phone: null }].map((p) => [p.id!, p]));
  const { send, sent } = sender();
  assert.equal(await sendNudges(f.db, s, send, left, Date.now() + 60_000, NOW + 2 * MIN), 0);
  assert.deepEqual(sent, [{ chat: "alerts@g.us", text: "Nobody I was reminding about the alert in Acme x iklipse is reachable, so its usual alerts are back on.", quoted: "m-1" }]);
  assert.equal(f.tables.bot_alert_nudge![0]!.status, "stopped");
  assert.equal(f.tables.watch_alert![0]!.next_alert_at, iso(NOW + 2 * MIN));
  // The calls come back to whoever was being called.
  assert.deepEqual(f.tables.watch_recipient!.map((r) => r.next_call_at), [iso(NOW + 2 * MIN), iso(NOW + 2 * MIN), null]);
  assert.deepEqual(await nudgesOn(f.db, ["al-1"]), new Set());
  assert.equal(f.tables.watch_event!.at(-1)!.detail, "Stopped: nobody they were for can be reached; its usual alerts are back");
  assert.equal(await sendNudges(f.db, s, send, left, Date.now() + 60_000, NOW + 30 * MIN), 0);
  assert.equal(sent.length, 1);
});

test("with Saturday and Sunday off: nothing goes on the days off, and the first round is Monday when work starts", async () => {
  const f = world();
  await alertAct(f.db, weekOff, ask(pauseAsk, { people: [omar, karim, hana] }));
  const { send, sent } = sender();
  for (const t of [TWO_PM, at("2026-10-24", "18:00"), at("2026-10-25", "12:30"), at("2026-10-26", "11:59")]) {
    assert.equal(await sendNudges(f.db, weekOff, send, team, Date.now() + 60_000, t), 0);
  }
  assert.deepEqual(sent, []);
  assert.equal(await sendNudges(f.db, weekOff, send, team, Date.now() + 60_000, at("2026-10-26", "12:01")), 1);
  assert.equal(sent.length, 3);
  assert.equal(f.tables.bot_alert_nudge![0]!.next_at, iso(at("2026-10-26", "12:21")));
});

test("the day's most reached on a Friday: the next round waits past the days off, for Monday", async () => {
  const f = world();
  await alertAct(f.db, weekOff, ask({ every_min: 20 }, { people: [omar] }));
  Object.assign(f.tables.bot_alert_nudge![0]!, { rounds: 40, rounds_day: DAY_MAX, day: "2026-10-23", next_at: iso(NOW) });
  const { send, sent } = sender();
  assert.equal(await sendNudges(f.db, weekOff, send, team, Date.now() + 60_000, NOW + MIN), 0);
  assert.deepEqual(sent, []);
  assert.equal(f.tables.bot_alert_nudge![0]!.next_at, iso(at("2026-10-26", "12:01")));
});

test("the words: a promise that's late says how late; Slack says the channel", () => {
  const a = { id: "x", kind: "promise", status: "open", title: "Send the cut", detail: "Omar promised the final cut by 6 PM.", source: "slack", snoozed_until: null, created_at: iso(NOW - 3 * 60 * MIN), due_at: iso(NOW - 90 * MIN), wa_group: null, slack_channel: { name: "acme-launch" } };
  assert.equal(
    nudgeText(karim, sara, a, NOW),
    "Hi Karim, a reminder from Sara about an open alert in #acme-launch: Omar promised the final cut by 6 PM. Overdue by 1 hour 30 minutes. Once it's dealt with, tap Handled on it in iklipse, or tell me here.",
  );
});

// ---------------------------------------------------------- the router --

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function claudeSays(...acts: Record<string, unknown>[]) {
  const asked: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    asked.push(JSON.parse(String(b.messages[0].content)));
    const act = acts.shift();
    if (!act) throw new Error("Claude was asked once too often");
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "act", input: act }], usage: {} }), { status: 200 });
  }) as typeof fetch;
  return asked;
}
const saraP: Person = { id: "u-sara", name: "Sara", username: "sara", active: true, admin: true };
const omarP: Person = { id: "u-omar", name: "Omar", username: "omar", active: true, admin: false };
const theTeam: Team = {
  people: new Map([
    [saraP.id, saraP],
    [omarP.id, omarP],
  ]),
  byPhone: new Map([
    ["15555550104", saraP],
    ["15555550105", omarP],
  ]),
  byLid: new Map(),
  others: new Set(),
};
const routed = () => {
  const f = world();
  f.tables.profile_contact = [sara, omar, karim, hana].map((p) => ({ user_id: p.id, whatsapp: p.phone }));
  f.tables.bot_order = [];
  return f;
};
const msg = {
  id: "g-1",
  chatId: "alerts@g.us",
  where: "team" as const,
  text: "@iklipse pause reminders for this alert for 2 hours then send 1 message every 20 minutes to @Omar and Karim till it's resolved",
  quoted: null,
  phone: "15555550104",
  lid: null,
  name: "Sara",
  via: "mention" as const,
};

test("the router: alert is an action, and the words say when it's alert (never remind or orders)", () => {
  const actions = (orderTool(false).input_schema.properties as Record<string, { enum: string[] }>).action.enum;
  assert.ok(actions.includes("alert"));
  assert.ok((orderTool(false).input_schema.properties as Record<string, unknown>).alert);
  assert.match(ORDER_SYSTEM, /\n- alert: pause one open alert until a time, or remind people about it every so often until it's resolved/);
  assert.match(ORDER_SYSTEM, /Reminding people about an open alert every so often is alert, never remind or orders\./);
  assert.ok(YOU_CAN.some((x) => /^pause an open alert until a time, and remind people on the team about it privately every so often until it's resolved/.test(x)));
  assert.doesNotMatch(YOU_CAN.join("\n"), /[—–]/);
});

test("an admin's pause and reminders, the whole way: done, and said back as a reply to them", async () => {
  const f = routed();
  const { send, sent } = sender();
  claudeSays({ action: "alert", alert: { id: "a2", pause_minutes: 120, every_min: 20, people: ["t:u-omar", "t:u-karim"] } });
  await takeOrder(f.db, s, theTeam, send, msg, async () => {});
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chat, "alerts@g.us");
  assert.equal(sent[0]!.quoted, "g-1");
  // Two open alerts: the one Claude said (the newest, a2) by its place.
  assert.match(sent[0]!.text, /^Acme x iklipse: Paused until \w{3} \d{1,2}:\d{2} [AP]M\. Then every 20 minutes I'll remind Omar and Karim until it's resolved\.$/);
  const n = f.tables.bot_alert_nudge![0]!;
  assert.deepEqual([n.alert_id, n.people, n.every_min, n.chat_id, n.message_id], ["al-1", ["u-omar", "u-karim"], 20, "alerts@g.us", "g-1"]);
  assert.ok(f.tables.watch_alert!.find((x) => x.id === "al-1")!.snoozed_until);
});

test("someone who isn't an admin: nothing changes", async () => {
  const f = routed();
  const { send, sent } = sender();
  claudeSays({ action: "alert", alert: { id: "a2", pause_minutes: 120 } });
  await takeOrder(f.db, s, theTeam, send, { ...msg, id: "g-2", phone: "15555550105", name: "Omar" }, async () => {});
  assert.deepEqual(sent, [{ chat: "alerts@g.us", text: "Only admins can pause an alert or set its reminders.", quoted: "g-2" }]);
  assert.equal(f.tables.watch_alert!.every((a) => a.snoozed_until === null), true);
});
