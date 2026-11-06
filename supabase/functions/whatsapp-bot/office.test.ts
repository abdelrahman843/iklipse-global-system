// Word and Excel files as words (office.ts). The zips are built here, stored
// and deflated, so nothing outside is needed. Names and numbers are made up.
//   npm run test:bot

import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { excelText, isExcel, isWord, unzip, wordText } from "./office.ts";

const bytesOf = (s: string) => new TextEncoder().encode(s);

/** A small zip: every entry deflated, or stored when store is set. */
function zip(files: Record<string, string>, store = false) {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = bytesOf(name);
    const plain = bytesOf(text);
    const data = store ? plain : new Uint8Array(deflateRawSync(plain));
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, store ? 0 : 8, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, plain.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(10, store ? 0 : 8, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, plain.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test("Excel: an empty cell isn't in the file, and the next one stays in its column", async () => {
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Company</t></is></c><c r="C1" t="inlineStr"><is><t>Phone</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Sara</t></is></c><c r="C2"><v>201001234567</v></c></row></sheetData></worksheet>';
  assert.equal(await excelText(zip({ "xl/worksheets/sheet1.xml": sheet })), "Sheet 1:\nName | Company | Phone\nSara |  | 201001234567");
});

test("a Word file: its paragraphs in order, Arabic and escapes as written", async () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Scope &amp; price</w:t></w:r></w:p><w:p w:rsid="1"><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>مرحبا</w:t></w:r></w:p><w:p/></w:body></w:document>';
  assert.equal(await wordText(zip({ "word/document.xml": xml })), "Scope & price\nHello مرحبا");
});

test("an Excel file: each sheet by name, shared words, numbers and inline text", async () => {
  const files = {
    "xl/workbook.xml": '<workbook><sheets><sheet name="Orders" sheetId="1"/><sheet name="Empty" sheetId="2"/></sheets></workbook>',
    "xl/sharedStrings.xml": "<sst><si><t>Client</t></si><si><r><t>Acme </t></r><r><t>Ltd</t></r></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1500</v></c><c r="C2"/></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>",
  };
  assert.equal(await excelText(zip(files)), "Orders:\nClient | Total\nAcme Ltd | 1500 | ");
});

test("stored entries open too; only the names asked for are opened", async () => {
  const opened = await unzip(zip({ "a.xml": "one", "b.xml": "two" }, true), (n) => n === "b.xml");
  assert.deepEqual([...opened.entries()], [["b.xml", "two"]]);
});

test("not a zip, or not that kind of file: said, never made up", async () => {
  await assert.rejects(wordText(bytesOf("just some text, long enough to look through")), /Not a zip/);
  await assert.rejects(wordText(zip({ "other.xml": "x" })), /Not a Word file/);
  await assert.rejects(excelText(zip({ "other.xml": "x" })), /Not an Excel file/);
});

test("a file is known by its type or its name", () => {
  assert.ok(isWord("application/vnd.openxmlformats-officedocument.wordprocessingml.document", null));
  assert.ok(isWord("application/octet-stream", "Contract.DOCX"));
  assert.ok(isExcel("application/octet-stream", "plan.xlsx"));
  assert.ok(!isWord("application/msword", "old.doc"));
  assert.ok(!isExcel("application/pdf", "a.pdf"));
});
