// The directory (directory.ts): finding people as they're asked for, and lists
// in and out. Names and numbers are made up. What the database decides (0144)
// is tried on the database itself.
//   npm run test:bot

import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectoryNo, plain, planOf, rowsOf, searchRows, tableOf, toCsv, whoDoes, type Entry } from "./directory.ts";
import type { Db } from "./kit.ts";

const person = (o: Partial<Entry> & { name: string }): Entry => ({
  ref: `card:${o.name}`,
  kind: "staff",
  company: null,
  department: null,
  role_title: null,
  team: null,
  is_manager: false,
  responsibilities: null,
  email: null,
  phone: null,
  language: null,
  status: "active",
  ...o,
});

const SARA = person({ name: "Sara Adel", role_title: "Production Lead", department: "Production" });
const OMAR = person({ name: "Omar Fathy", role_title: "Video Editor", department: "Production", responsibilities: "Editing and colour" });
const MONA = person({ name: "Mona Ali", role_title: "Head of Finance", department: "Finance", is_manager: true });
const LEFT = person({ name: "Hany Samir", role_title: "Production Lead", status: "left" });
const ARABIC = person({ name: "سارة عادل", role_title: "مدير الإنتاج" });

test("who holds a role: the title first, the best fit only", () => {
  assert.deepEqual(whoDoes([OMAR, SARA, MONA], "production lead").map((r) => r.name), ["Sara Adel"]);
  assert.deepEqual(whoDoes([OMAR, SARA, MONA], "the head of production").map((r) => r.name), ["Sara Adel"]);
  assert.deepEqual(whoDoes([OMAR, SARA, MONA], "finance manager").map((r) => r.name), ["Mona Ali"]);
  assert.deepEqual(whoDoes([OMAR, SARA], "editing").map((r) => r.name), ["Omar Fathy"]);
  assert.deepEqual(whoDoes([ARABIC], "مدير الانتاج").map((r) => r.name), ["سارة عادل"]);
});

test("who holds a role: two holders both come back, nobody is nobody, and someone who left never holds it", () => {
  const other = person({ name: "Tarek Nour", role_title: "Production Lead" });
  assert.equal(whoDoes([SARA, other], "production lead").length, 2);
  assert.deepEqual(whoDoes([OMAR, MONA], "legal lead"), []);
  assert.deepEqual(whoDoes([LEFT], "production lead"), []);
  // Only how senior, not what they do: no guess at who.
  assert.deepEqual(whoDoes([SARA, MONA], "the manager"), []);
  // A word inside a longer one isn't that word.
  assert.deepEqual(whoDoes([SARA], "product lead"), []);
});

test("search: any field, numbers however they're written, the archive only when asked", () => {
  const vendor = person({ name: "Acme Print", kind: "vendor", phone: "201000000123", status: "archived", notes: "Fast on posters" });
  assert.deepEqual(searchRows([SARA, OMAR], "editor").map((r) => r.name), ["Omar Fathy"]);
  assert.deepEqual(searchRows([vendor], "posters"), []);
  assert.deepEqual(searchRows([vendor], "posters", { archived: true }).map((r) => r.name), ["Acme Print"]);
  assert.deepEqual(searchRows([vendor], "0100 000 0123", { archived: true }).map((r) => r.name), ["Acme Print"]);
  assert.deepEqual(searchRows([SARA, MONA], "", { kind: "manager" }).map((r) => r.name), ["Mona Ali"]);
  assert.equal(plain("سارة"), plain("ساره"));
  assert.deepEqual(searchRows([ARABIC], "ساره").length, 1);
});

test("a CSV: quotes, commas in a cell, another separator, Arabic headers", () => {
  const { rows } = rowsOf(tableOf(`﻿Name,Company,Role,Phone,Email\r\n"Sara, Adel",Acme,"Lead ""A""",01001234567,s@acme.test\r\n`));
  assert.deepEqual(rows[0], { kind: "contact", name: "Sara, Adel", company: "Acme", role_title: 'Lead "A"', phone: "201001234567", email: "s@acme.test" });
  assert.equal(rowsOf(tableOf("Name;Phone\nOmar;201001234568\n")).rows[0]!.phone, "201001234568");
  const ar = rowsOf(tableOf("الاسم,الشركة,الموبايل,الوظيفة\nسارة,اكمي,01001234567,مصممة\n")).rows[0]!;
  assert.equal(ar.name, "سارة");
  assert.equal(ar.company, "اكمي");
  assert.equal(ar.phone, "201001234567");
  assert.equal(ar.role_title, "مصممة");
});

test("an Excel sheet as it's read: the sheet with the names, columns kept", () => {
  const { rows } = rowsOf(tableOf("Totals:\nMonth | Sum\nMay | 3\n\nPeople:\nName | Company | Phone\nSara |  | 201001234567\n"));
  assert.deepEqual(rows, [{ kind: "contact", name: "Sara", phone: "201001234567" }]);
});

test("a list gives nobody anything: an admin column is left out, staff is still a contact, a role is a job title", () => {
  const { rows, ignored } = rowsOf(tableOf("Name,Type,Role,Access,Permissions,Admin\nSara,staff,admin,admin,all,yes\nOmar,vendor,,,,\nMona,customer,,,,\n"));
  assert.deepEqual(ignored, ["Access", "Permissions", "Admin"]);
  assert.deepEqual(rows[0], { kind: "contact", name: "Sara", role_title: "admin" });
  assert.equal(rows[1]!.kind, "vendor");
  assert.equal(rows[2]!.kind, "client");
});

test("a list: rows that can't be used are said, the rest go on; no names at all is refused", () => {
  const { rows, bad } = rowsOf(tableOf("Name,Email,Phone\n,a@b.test,\nSara,not-an-email,\nOmar,,123\nMona,m@b.test,201001234567\n"));
  assert.deepEqual(rows.map((r) => r.name), ["Mona"]);
  assert.equal(bad.length, 3);
  assert.match(bad[0]!, /row 2: no name/);
  assert.match(bad[1]!, /Sara.*isn't an email/);
  assert.match(bad[2]!, /Omar.*full number/);
  assert.throws(() => rowsOf(tableOf("Company,Phone\nAcme,201001234567\n")), DirectoryNo);
});

test("planning a list: new, already here, twice in it; nothing is written", async () => {
  const asked: string[] = [];
  const db = {
    rpc: async (name: string, a: { p_what?: string; p: { name?: string } }) => {
      asked.push(`${name}:${a.p_what}`);
      return { data: a.p.name === "Sara" ? [{ ref: "card:1", kind: "vendor", name: "Sara Adel", why: "similar name" }] : [], error: null };
    },
  } as unknown as Db;
  const plan = await planOf(db, [
    { kind: "contact", name: "Sara" },
    { kind: "contact", name: "Omar", phone: "201001234567" },
    { kind: "contact", name: "Omar F", phone: "+201001234567" },
  ]);
  assert.deepEqual(plan.fresh.map((f) => f.name), ["Omar"]);
  assert.deepEqual(plan.known.map((k) => k.name), ["Sara", "Omar F"]);
  assert.equal(plan.known[1]!.matches[0]!.why, "twice in this list");
  assert.ok(asked.every((a) => a === "_directory_read:dupes"));
});

test("the CSV out: reads back in, Excel sees Arabic, and no cell runs as a formula", () => {
  const out = toCsv([person({ name: "=HYPERLINK(1)", phone: "201001234567", notes: 'said "hi", then left', is_manager: true, role_title: "+1 lead" })]);
  assert.ok(out.startsWith("﻿Type,Name,"));
  assert.match(out, /'=HYPERLINK\(1\)/);
  assert.match(out, /'\+1 lead/);
  assert.match(out, /"said ""hi"", then left"/);
  const back = rowsOf(tableOf(toCsv([SARA])));
  assert.equal(back.rows[0]!.name, "Sara Adel");
  assert.equal(back.rows[0]!.role_title, "Production Lead");
  assert.deepEqual(back.ignored, ["Access", "Status"]);
});
