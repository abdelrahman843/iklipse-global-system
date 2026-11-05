// Word and Excel files as words (files.ts): a .docx or an .xlsx is a zip of XML,
// so they're read here, with no outside service and no model call. The old
// .doc and .xls aren't zips: those are kept, not read.

const MAX_INFLATED = 40 * 1024 * 1024;
const decoder = new TextDecoder();

const WORD = /\.docx$/i;
const EXCEL = /\.xlsx$/i;
const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const isWord = (mime: string, name: string | null) => mime === WORD_MIME || WORD.test(name ?? "");
export const isExcel = (mime: string, name: string | null) => mime === EXCEL_MIME || EXCEL.test(name ?? "");

/** One zip entry's bytes opened, never past the limit (a small file can open to something huge). */
async function inflate(raw: Uint8Array, room: number) {
  const reader = new Blob([new Uint8Array(raw)]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > room) {
      await reader.cancel();
      throw new Error("Too big to open");
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The entries of a zip whose names pass, as text, in the zip's order. */
export async function unzip(bytes: Uint8Array, want: (name: string) => boolean) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, string>();
  let used = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("A broken zip");
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const noteLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + noteLen;
    if (!want(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + packed);
    const open = method === 0 ? raw : method === 8 ? await inflate(raw, MAX_INFLATED - used) : null;
    if (!open) continue;
    used += open.length;
    out.set(name, decoder.decode(open));
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
    e[0] !== "#" ? ENTITIES[e.toLowerCase()] : String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );

/** All that the tags hold, joined. */
const tagged = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => unescape(m[1])).join("");

/** A Word file: its paragraphs, tables' cells included, in order. */
export async function wordText(bytes: Uint8Array) {
  const files = await unzip(bytes, (n) => n === "word/document.xml");
  const xml = files.get("word/document.xml");
  if (!xml) throw new Error("Not a Word file");
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((m) => tagged(m[1], "w:t").trim())
    .filter(Boolean)
    .join("\n");
}

const sheetNumber = (name: string) => Number(/sheet(\d+)\.xml$/.exec(name)?.[1] ?? 0);

/** An Excel file: each sheet by its name, a line a row, its cells with " | " between. */
export async function excelText(bytes: Uint8Array) {
  const files = await unzip(bytes, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => tagged(m[1], "t"));
  const names = [...(files.get("xl/workbook.xml") ?? "").matchAll(/<sheet\s[^>]*name="([^"]*)"/g)].map((m) => unescape(m[1]));
  const sheets = [...files.keys()].filter((n) => n.startsWith("xl/worksheets/")).sort((a, b) => sheetNumber(a) - sheetNumber(b));
  if (!sheets.length) throw new Error("Not an Excel file");
  const out: string[] = [];
  for (const sheet of sheets) {
    const rows: string[] = [];
    for (const row of files.get(sheet)!.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const body = c[2] ?? "";
        const type = /\st="(\w+)"/.exec(c[1] ?? "")?.[1];
        if (type === "inlineStr") return tagged(body, "t");
        const value = tagged(body, "v");
        return type === "s" ? (shared[Number(value)] ?? "") : value;
      });
      if (cells.some((x) => x.trim())) rows.push(cells.join(" | "));
    }
    if (rows.length) out.push(`${names[sheetNumber(sheet) - 1] ?? `Sheet ${sheetNumber(sheet)}`}:\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}
