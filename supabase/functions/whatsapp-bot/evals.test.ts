// The eval set (scripts/bot/evals/cases) is replayed against the real Claude
// API only on purpose (npm run eval:bot -- --real). Here, without the API:
// it's all there and well formed, in the three ways people write, made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join("scripts", "bot", "evals", "cases");
const cases = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; kind: string; lang: string; expect: { action?: unknown; opened?: number } }[]);

test("50 or more cases, each with an id of its own and something to expect", () => {
  assert.ok(cases.length >= 50, `${cases.length} cases`);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  for (const c of cases) {
    assert.ok(["route", "alerts", "reply", "booking"].includes(c.kind), c.id);
    assert.ok(c.expect && (c.expect.action !== undefined || c.expect.opened !== undefined), c.id);
  }
});

test("every kind in Egyptian Arabic, Franco-Arabic and English", () => {
  for (const kind of ["route", "alerts", "reply", "booking"]) {
    const langs = new Set(cases.filter((c) => c.kind === kind).map((c) => c.lang));
    for (const lang of ["ar-eg", "franco", "en"]) assert.ok(langs.has(lang), `${kind}: no ${lang}`);
  }
});

test("made up: no real-looking phone numbers (only 1555... ones)", () => {
  const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  for (const n of text.match(/\+?\d{9,}/g) ?? []) assert.match(n, /^\+?1555/, n);
});
