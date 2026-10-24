// Search that understands Arabic and meaning (search.ts, embed.ts, 0113),
// with the database in memory and the embedding provider stubbed: what was
// said is cut into pieces that keep who may read them; search asks the
// database with the asker's rules and checks again what comes back; words
// alone when there's no provider or it fails; the providers asked the way
// their docs say. Names and numbers are made up.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { cut, embedSome, indexSome, mayRead, piecesOf, search } from "./search.ts";
import { DIMS, embedder, type Embedder } from "./embed.ts";
import type { Db } from "./kit.ts";
import type { Me } from "./look.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const member: Me = { id: "u1", admin: false, boards: [], mail: ["box-mine"], dms: ["15550004001@c.us"], ffAccounts: ["ff-mine"], ffMeetings: ["m-shared"] };
const admin: Me = { ...member, id: "u0", admin: true, mail: [], dms: [], ffAccounts: [], ffMeetings: [] };
const vec = (x: number) => Array.from({ length: DIMS }, () => x);
/** An embedding provider that gives the same numbers for everything, or fails. */
const fakeEmbedder = (fail = false): Embedder & { asked: { texts: string[]; kind: string }[] } => {
  const asked: { texts: string[]; kind: string }[] = [];
  return {
    provider: "fake",
    model: "fake-1",
    asked,
    embed: async (texts, kind) => {
      asked.push({ texts, kind });
      if (fail) throw new Error("429 rate limited");
      return texts.map(() => vec(0.5));
    },
  };
};

// ------------------------------------------------------------- pieces --

test("cut: short text is one piece; long text is cut at line ends, up to a number of pieces", () => {
  assert.deepEqual(cut("الفيديو لسه هيخلص بكرة", 4), ["الفيديو لسه هيخلص بكرة"]);
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i}: ${"word ".repeat(10)}`).join("\n");
  const pieces = cut(long, 4);
  assert.equal(pieces.length, 3);
  assert.ok(pieces.every((p) => p.length <= 1500 && /^Line \d+/.test(p)));
  assert.equal(cut(long, 2).length, 2);
});

test("each source's piece keeps who may read it, where and who", () => {
  const [g] = piecesOf("wa_message", { id: "w1", chat_id: "acme@g.us", sender_name: "Sara", text: "el logo gahz?", sent_at: "2026-10-22T10:00:00Z", wa_group: { name: "Acme | iklipse" } });
  assert.deepEqual({ ...g }, { source: "wa_message", source_id: "w1", part: 0, at: "2026-10-22T10:00:00Z", chat_id: "acme@g.us", account_id: null, meeting_id: null, place: "Acme | iklipse", who: "Sara", text: "el logo gahz?" });

  const [d] = piecesOf("wa_dm", { id: "d1", chat_id: "15550004002@c.us", from_bot: true, text: "Booked.", sent_at: "2026-10-22T10:00:00Z" });
  assert.equal(d!.chat_id, "15550004002@c.us");
  assert.equal(d!.who, "the bot");

  const [m] = piecesOf("mail_message", { id: "e1", account_id: "box-mine", from_name: "Sara", subject: "Logo", body: "Approved!\n\nOn Mon, Oct 19, 2026 Rabah wrote:\n> old words", sent_at: "2026-10-22T10:00:00Z" });
  assert.equal(m!.account_id, "box-mine");
  assert.equal(m!.place, 'the email "Logo"');
  assert.equal(m!.text, "Logo\nApproved!");

  const [s] = piecesOf("slack_message", { channel_id: "C1", ts: "1700.1", text: "shipped", channel_name: "design", who: "Omar" });
  assert.equal(s!.source_id, "C1:1700.1");
  assert.equal(s!.place, "#design");

  const f = piecesOf("fireflies", { id: "m1", account_id: "ff-mine", title: "Kickoff", summary: { overview: "Launch plan" }, sentences: [{ s: "Sara", t: "We launch in May" }] });
  assert.equal(f[0]!.meeting_id, "m1");
  assert.equal(f[0]!.text, "Kickoff\nLaunch plan\nSara: We launch in May");

  assert.deepEqual(piecesOf("wa_file", { id: "f1", chat_id: "acme@g.us", name: "brief.pdf", text: "" }), []);
});

test("who may read what: find's rules", () => {
  assert.equal(mayRead(member, { source: "wa_dm", chat_id: "15550004001@c.us", account_id: null, meeting_id: null }), true);
  assert.equal(mayRead(member, { source: "wa_dm", chat_id: "15550004009@c.us", account_id: null, meeting_id: null }), false);
  assert.equal(mayRead(admin, { source: "wa_dm", chat_id: "15550004009@c.us", account_id: null, meeting_id: null }), true);
  assert.equal(mayRead(member, { source: "wa_file", chat_id: "acme@g.us", account_id: null, meeting_id: null }), true);
  assert.equal(mayRead(member, { source: "wa_file", chat_id: "15550004009@c.us", account_id: null, meeting_id: null }), false);
  assert.equal(mayRead(member, { source: "mail_message", chat_id: null, account_id: "box-other", meeting_id: null }), false);
  // Email stays with its mailbox, admins included.
  assert.equal(mayRead(admin, { source: "mail_message", chat_id: null, account_id: "box-other", meeting_id: null }), false);
  assert.equal(mayRead(member, { source: "fireflies", chat_id: null, account_id: "ff-other", meeting_id: "m-shared" }), true);
  assert.equal(mayRead(member, { source: "wa_message", chat_id: "x@g.us", account_id: null, meeting_id: null }), true);
});

// ------------------------------------------------------------ indexing --

test("what's queued is cut into pieces in place of the old ones; gone or empty, its pieces go; then embedded", async () => {
  const f = fakeDb(
    {
      wa_message: [{ id: "w1", chat_id: "acme@g.us", sender_name: "Sara", text: "الفيديو لسه هيخلص بكرة", sent_at: "2026-10-22T10:00:00Z" }],
      wa_dm: [],
      bot_search_chunk: [
        { id: 1, source: "wa_message", source_id: "w1", part: 0, text: "an old version", tries: 0 },
        { id: 2, source: "wa_dm", source_id: "gone", part: 0, text: "deleted since", tries: 0 },
      ],
      bot_search_queue: [{ source: "wa_message", source_id: "w1" }, { source: "wa_dm", source_id: "gone" }],
    },
    {
      rpc: {
        _search_take: () => [{ source: "wa_message", source_id: "w1" }, { source: "wa_dm", source_id: "gone" }],
        _search_set_embeddings: (a, t) => {
          for (const x of a.p as { id: number; e: string }[]) Object.assign(t.bot_search_chunk!.find((c) => c.id === x.id)!, { embedding: x.e, model: a.p_model });
          return (a.p as unknown[]).length;
        },
      },
    },
  );
  const e = fakeEmbedder();
  const r = await indexSome(f.db, Date.now() + 60_000, e);
  assert.deepEqual(r, { indexed: 2, pieces: 1, embedded: 1 });
  assert.equal(f.tables.bot_search_chunk.length, 1);
  const c = f.tables.bot_search_chunk[0]!;
  assert.equal(c.text, "الفيديو لسه هيخلص بكرة");
  assert.equal(c.chat_id, "acme@g.us");
  assert.equal(c.model, "fake-1");
  assert.equal(JSON.parse(String(c.embedding)).length, DIMS);
  assert.deepEqual(e.asked[0]!.kind, "document");
  assert.deepEqual(f.tables.bot_search_queue, []);
});

test("before 0113: nothing to index", async () => {
  const before = { ...fakeDb().db, rpc: async () => ({ data: null, error: { message: "function _search_take does not exist" } }) } as unknown as Db;
  assert.equal(await indexSome(before, Date.now() + 60_000, null), null);
});

test("the provider failing: pieces tried once more, left to words after five", async () => {
  const f = fakeDb({ bot_search_chunk: [{ id: 7, source: "wa_message", source_id: "w1", part: 0, text: "x", tries: 2, embedding: null }] });
  assert.equal(await embedSome(f.db, fakeEmbedder(true), Date.now() + 60_000), 0);
  assert.equal(f.tables.bot_search_chunk[0]!.tries, 3);
  assert.equal(f.tables.bot_search_chunk[0]!.error, "429 rate limited");
});

// ----------------------------------------------------------- searching --

function searchWorld(rows: Record<string, unknown>[]) {
  const asked: Record<string, unknown>[] = [];
  const f = fakeDb({}, { rpc: { bot_search: (a) => (asked.push(a), rows) } });
  return { db: f.db, asked };
}
const row = (o: Record<string, unknown>) => ({ id: 1, part: 0, account_id: null, meeting_id: null, chat_id: "acme@g.us", place: "Acme | iklipse", who: "Sara", at: "2026-10-22T10:00:00Z", score: 0.03, text: "الفيديو لسه هيخلص بكرة", source: "wa_message", source_id: "w1", ...o });

test("search asks with the asker's rules, by meaning and words, and gives where, who, when", async () => {
  const w = searchWorld([row({})]);
  const e = fakeEmbedder();
  const out = JSON.parse(await search(w.db, member, { text: "is the video done?", in: ["groups", "private"] }, e));
  assert.equal(out.by, "meaning and words");
  assert.deepEqual(out.found, [{ where: "Acme | iklipse", who: "Sara", when: out.found[0].when, text: "الفيديو لسه هيخلص بكرة" }]);
  assert.match(out.found[0].when, /Cairo time$/);
  const a = w.asked[0]!;
  assert.deepEqual(a.p_sources, ["wa_message", "wa_dm"]);
  assert.deepEqual(a.p_scope, { admin: false, dms: ["15550004001@c.us"], mail: ["box-mine"], ff_accounts: ["ff-mine"], ff_meetings: ["m-shared"] });
  assert.equal(JSON.parse(String(a.p_embedding)).length, DIMS);
  assert.equal(a.p_model, "fake-1");
  assert.deepEqual(e.asked[0], { texts: ["is the video done?"], kind: "query" });
});

test("what comes back is checked again: someone else's private chat or mailbox never shows", async () => {
  const w = searchWorld([
    row({ id: 1 }),
    row({ id: 2, source: "wa_dm", chat_id: "15550004009@c.us", text: "a client's private chat" }),
    row({ id: 3, source: "mail_message", chat_id: null, account_id: "box-other", text: "someone else's email" }),
  ]);
  const out = JSON.parse(await search(w.db, member, { text: "video" }, null));
  assert.deepEqual(out.found.map((x: { text: string }) => x.text), ["الفيديو لسه هيخلص بكرة"]);
});

test("a private Slack channel: admins only (checked again on what comes back); unread, no Slack shows", async () => {
  const pieces = [
    row({ id: 1, source: "slack_message", source_id: "C0OPEN001:1.1", chat_id: "C0OPEN001", place: "#acme-test", text: "the open channel" }),
    row({ id: 2, source: "slack_message", source_id: "G0PRIV001:1.2", chat_id: "G0PRIV001", place: "#salaries-test", text: "the private channel" }),
    row({ id: 3, text: "a group message" }),
  ];
  const channels = [
    { channel_id: "C0OPEN001", is_private: false },
    { channel_id: "G0PRIV001", is_private: true },
  ];
  const texts = (out: string) => JSON.parse(out).found.map((x: { text: string }) => x.text);
  const f = fakeDb({ slack_channel: channels }, { rpc: { bot_search: () => pieces } });
  assert.deepEqual(texts(await search(f.db, member, { text: "salary" }, null)), ["the open channel", "a group message"]);
  assert.deepEqual(texts(await search(f.db, admin, { text: "salary" }, null)), ["the open channel", "the private channel", "a group message"]);
  // Which channels are private can't be read: no Slack for a member, rather than the wrong one.
  const down = fakeDb({ slack_channel: channels }, { rpc: { bot_search: () => pieces }, fail: (c) => (c.table === "slack_channel" ? "timeout" : null) });
  assert.deepEqual(texts(await search(down.db, member, { text: "salary" }, null)), ["a group message"]);
});

test("no provider, or it fails: by words, and it says so", async () => {
  const none = JSON.parse(await search(searchWorld([]).db, member, { text: "video" }, null));
  assert.equal(none.by, "words");
  assert.match(none.note, /no embedding provider/);
  const w = searchWorld([]);
  const failing = JSON.parse(await search(w.db, member, { text: "video" }, fakeEmbedder(true)));
  assert.equal(failing.by, "words");
  assert.equal(w.asked[0]!.p_embedding, null);
  await assert.rejects(search(w.db, member, { text: " " }, null), /needs words/);
  await assert.rejects(search(w.db, member, { text: "x", in: ["whatsapp"] }, null), /Unknown place whatsapp/);
});

// ----------------------------------------------------------- providers --

test("the provider from the secrets; none set, none", () => {
  const get = (o: Record<string, string>) => (k: string) => o[k] ?? "";
  assert.equal(embedder(get({})), null);
  assert.equal(embedder(get({ EMBED_PROVIDER: "voyage" })), null);
  assert.equal(embedder(get({ EMBED_PROVIDER: "voyage", VOYAGE_API_KEY: "k" }))?.model, "voyage-4");
  assert.equal(embedder(get({ EMBED_PROVIDER: "openai", OPENAI_API_KEY: "k", EMBED_MODEL: "text-embedding-3-large" }))?.model, "text-embedding-3-large");
});

test("Voyage and OpenAI are asked the way their docs say, for 1024 numbers", async () => {
  const sent: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ url, body, auth: (init.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify({ data: (body.input as string[]).map((_, i) => ({ index: i, embedding: vec(i) })).reverse() }), { status: 200 });
  }) as unknown as typeof fetch;
  const v = embedder((k) => ({ EMBED_PROVIDER: "voyage", VOYAGE_API_KEY: "vk" })[k] ?? "")!;
  const out = await v.embed(["a", "b"], "query");
  assert.deepEqual(out.map((e) => e[0]), [0, 1]);
  assert.deepEqual(sent[0], { url: "https://api.voyageai.com/v1/embeddings", body: { input: ["a", "b"], model: "voyage-4", input_type: "query", output_dimension: 1024 }, auth: "Bearer vk" });
  const o = embedder((k) => ({ EMBED_PROVIDER: "openai", OPENAI_API_KEY: "ok" })[k] ?? "")!;
  await o.embed(["a"], "document");
  assert.deepEqual(sent[1], { url: "https://api.openai.com/v1/embeddings", body: { input: ["a"], model: "text-embedding-3-small", dimensions: 1024 }, auth: "Bearer ok" });

  globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "Invalid API key" }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(v.embed(["a"], "query"), /401 Invalid API key/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(v.embed(["a"], "query"), /expected 1 embeddings of 1024/);
});
