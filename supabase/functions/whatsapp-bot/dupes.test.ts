// Duplicate alerts, the parts that can't be loaded here: the calls in index.ts
// (it serves) and the two SQL scripts in scripts/bot (run by hand, never by
// the bot). Their source is read instead: nobody is called twice for the same
// thing; a due time close by never makes two alerts one by itself, nor do two
// mailboxes; the close step closes only the approved list, chains followed to
// their root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sameAsOlder, type AlertLike, type Seen } from "./repeat.ts";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const index = read("supabase/functions/whatsapp-bot/index.ts");
const dryRun = read("scripts/bot/duplicate-alerts.sql");
const close = read("scripts/bot/close-duplicate-alerts.sql");
/** The SQL without its comments. */
const code = (sql: string) => sql.replace(/--.*$/gm, "");

// ------------------------------------------------------------------ calls --

test("calls skip what an older open alert already calls the person for, like the digest and the ringing", () => {
  const callDue = index.slice(index.indexOf("async function callDue("), index.indexOf("async function sweepCalls("));
  assert.ok(callDue.length > 100);
  assert.match(callDue, /const seen = due\?\.length \? await openSeen\(db, t\) : new Map<string, Seen>\(\);/);
  // The call waits (as an alert rung by an older one does), and is placed only when it's not a repeat.
  assert.match(
    callDue,
    /if \(sameAsOlder\(seen, r\.alert_id, r\.user_id\)\) \{\s*await db\.from\("watch_recipient"\)\.update\(\{ next_call_at: iso\(Date\.now\(\) \+ s\.call_retry_min \* MIN\) \}\)\.eq\("alert_id", r\.alert_id\)\.eq\("user_id", r\.user_id\);\s*continue;\s*\}/,
  );
  assert.ok(callDue.indexOf("sameAsOlder(") < callDue.indexOf("startCall("));

  // Who that is: Omar is on the older one too, so his call waits; Tarek is only on the newer one.
  const mail = (o: Partial<AlertLike>): AlertLike => ({ kind: "promise", source: "email", mail_account: "m1", mail_thread: "t1", person_key: "e:tom@lumio.test", title: "Send Tom the revised cut", ...o });
  const seen = new Map<string, Seen>(
    [
      { id: "old", created_at: "2026-10-24T08:00:00Z", people: ["omar"], ...mail({}) },
      { id: "new", created_at: "2026-10-24T08:05:00Z", people: ["omar", "tarek"], ...mail({ title: "Send Tom the revised cut today" }) },
    ].map((a) => [a.id, a]),
  );
  assert.equal(sameAsOlder(seen, "new", "omar"), true);
  assert.equal(sameAsOlder(seen, "new", "tarek"), false);
});

test("the digest, the ringing and the calls compare each person by who they are now (chat.ts openSeen with the team)", () => {
  assert.match(index, /import \{[^}]*\bopenSeen\b[^}]*\} from "\.\/chat\.ts";/);
  assert.doesNotMatch(index, /async function openSeen\(|openSeen\(db\)/);
  const part = (from: string, to: string) => index.slice(index.indexOf(from), index.indexOf(to));
  assert.match(part("async function digest(", "async function ring("), /const seen = await openSeen\(db, t\);/);
  assert.match(part("async function ring(", "async function sign("), /const seen = due\?\.length \? await openSeen\(db, t\) : new Map<string, Seen>\(\);/);
  assert.match(index, /await digest\(db, s, t, sendAs\(cfg\)\)/);
});

// ------------------------------------------------------------ the scripts --

test("the scripts never make two alerts one on a due time close by alone: the same matter is needed", () => {
  for (const [name, sql] of [["duplicate-alerts.sql", dryRun], ["close-duplicate-alerts.sql", close]]) {
    assert.doesNotMatch(code(sql!), /\bnear\b|7200|[dk]\.due_at/, `${name} still matches on the due time`);
    assert.doesNotMatch(sql!, /due within 2 hours/, name);
  }
  // Groups and Slack: the same chat and person, and a similar title (a client waiting: the same chat and person).
  assert.match(code(dryRun), /d\.place = k\.place and d\.who = k\.who\s+and \(d\.kind = 'unanswered' or \(not s\.other_numbers and \(s\.ratio >= 0\.5 or s\.cover >= 0\.8\)\)\)/);
  // Email: always a similar title.
  assert.match(code(dryRun), /\(s\.same_mail and \(s\.ratio >= 0\.5 or s\.cover >= 0\.8\)\)\s+or \(d\.mail_account = k\.mail_account and \(d\.who = k\.who or d\.norm_title = k\.norm_title\) and \(s\.ratio >= 0\.5 or s\.cover >= 0\.8\)\)/);
});

test("the scripts never make two mailboxes' alerts one, not even about the same email: email alerts stay with their owner", () => {
  // Closing one adds its people to the one kept, so across mailboxes that would ring an owner on another's alert (mail.ts never does).
  const c = code(dryRun);
  const guard = c.indexOf("when d.mail_account is distinct from k.mail_account then false");
  assert.ok(guard > c.indexOf("when d.source <> 'email' then") && guard < c.indexOf("when d.kind = 'unanswered' then s.same_mail"), "every email pair is in one mailbox");
  assert.match(dryRun, /Two mailboxes' alerts never match, not even about the\n--\s+same email: email alerts stay with their mailbox's owner/);
  // An approve line from an older dry run doesn't either.
  assert.match(code(close), /where k\.id <> d\.id and k\.source = d\.source and k\.kind = d\.kind\s+and \(d\.source <> 'email' or d\.mail_account = k\.mail_account\)/);
});

test("the dry run changes nothing, follows chains to the root, and gives each row's line to approve", () => {
  assert.doesNotMatch(code(dryRun), /\b(insert|update|delete|begin|commit|truncate|alter|drop)\b/i);
  assert.match(code(dryRun), /^with recursive a as \(/m);
  // Kept in an alert that's closed as a duplicate too: on to the one it's kept in, to the end.
  assert.match(code(dryRun), /walk as \(\s*select p\.dup_id, p\.keep_id as root, 0 as hops from pick p\s+union all\s+select k\.dup_id, p\.keep_id, k\.hops \+ 1 from walk k join pick p on p\.dup_id = k\.root\s*\)/);
  assert.match(code(dryRun), /select distinct on \(dup_id\) dup_id, root from walk order by dup_id, hops desc/);
  // The one shown as kept, and in the line to approve, is the root.
  assert.match(code(dryRun), /r\.root::text as keep/);
  assert.match(code(dryRun), /format\('\(%L, %L\),', p\.dup_id, r\.root\) as approve/);
  assert.match(code(dryRun), /join w k on k\.id = r\.root/);
});

test("the close step closes only the approved list: nothing worked out again, chains to their root, people moved there", () => {
  const c = code(close);
  // Nothing closes until the owner pastes the approved lines: the list is empty as it ships.
  assert.match(c, /from \(values\s+\(null::text, null::text\)\s+\) v\(dup_id, keep_id\)\s+where v\.dup_id is not null/);
  assert.match(close, /the dry run's approve lines, pasted here, above the \(null, null\) line/);
  // It doesn't look for duplicates itself (the dry run run again later can't change what closes).
  assert.doesNotMatch(c, /pair as|pick as|s\.ratio|norm_title|from w d/);
  // Chains on the list are followed to their root, loops left alone.
  assert.match(c, /with recursive walk as \(\s*select a\.dup_id, a\.keep_id as root, 0 as hops, array\[a\.dup_id\] as seen from dup_approved a/);
  assert.match(c, /join dup_approved n on n\.dup_id = k\.root\s+where not n\.dup_id = any\(k\.seen\)/);
  assert.match(c, /and not exists \(select 1 from dup_approved x where x\.dup_id = r\.root\)/);
  // Only one still open, kept in a root still open of the same kind and source.
  assert.match(c, /join public\.watch_alert d on d\.id = r\.dup_id and d\.status = 'open'\s+join public\.watch_alert k on k\.id = r\.root and k\.status = 'open'\s+where k\.id <> d\.id and k\.source = d\.source and k\.kind = d\.kind/);
  // People go to the root; then it's closed, quietly, in one transaction.
  assert.match(c, /insert into public\.watch_recipient \(alert_id, user_id\)\s+select p\.keep_id, r\.user_id\s+from dup_pick p/);
  assert.match(c, /close_note = 'Duplicate of ' \|\| p\.keep_id/);
  assert.match(c, /^begin;[\s\S]*^commit;\s*$/m);
});
