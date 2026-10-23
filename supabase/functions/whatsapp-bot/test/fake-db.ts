// A stand-in for the Supabase client in tests: tables are arrays of rows in
// memory; eq, neq, in, is, lt/lte/gt/gte, or (PostgREST's "a.eq.1,and(b.in.(x,y),c.like.*z)")
// and limit filter them, insert, update, upsert and delete change them, and
// every query is recorded (calls) so a test can see what was asked (the
// filters find added for who may see what). The other filters (ilike, order...)
// are recorded, not applied.

import type { Db } from "../kit.ts";

type Row = Record<string, unknown>;

/** Splits on commas outside parentheses and quotes. */
function split(s: string) {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && quoted) {
      cur += c + (s[++i] ?? "");
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted && c === "(") depth++;
    if (!quoted && c === ")") depth--;
    if (!quoted && !depth && c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);

/** One PostgREST filter term on a row: "col.op.value", or "and(...)" / "or(...)". */
function term(t: string, r: Row): boolean {
  const group = /^(and|or)\((.*)\)$/.exec(t);
  if (group) return group[1] === "and" ? split(group[2]!).every((x) => term(x, r)) : split(group[2]!).some((x) => term(x, r));
  const [col, op, ...rest] = t.split(".");
  const raw = rest.join(".");
  const x = r[col!];
  switch (op) {
    case "eq":
      return String(x) === unquote(raw);
    case "neq":
      return String(x) !== unquote(raw);
    case "is":
      return raw === "null" ? x == null : String(x) === raw;
    case "in":
      return split(raw.replace(/^\(|\)$/g, "")).map(unquote).includes(String(x));
    case "like":
    case "ilike": {
      const re = new RegExp(`^${unquote(raw).split(/[*%]/).map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, op === "ilike" ? "i" : "");
      return typeof x === "string" && re.test(x);
    }
    default:
      return true;
  }
}

export interface Call {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  values?: unknown;
  options?: Record<string, unknown>;
  ops: [string, ...unknown[]][];
}

export function fakeDb(
  tables: Record<string, Row[]> = {},
  o: {
    /** The database refusing a call: its message (or a message and a Postgres code). */
    fail?: (c: Call) => string | { message: string; code?: string } | null;
    /** Database functions (db.rpc): what each returns, from the tables. */
    rpc?: Record<string, (args: Record<string, unknown>, tables: Record<string, Row[]>) => unknown>;
  } = {},
) {
  const calls: Call[] = [];
  let seq = 0;
  const matches = (call: Call, r: Row) =>
    call.ops.every(([name, col, v]) => {
      const x = r[col as string];
      if (name === "eq") return x === v;
      if (name === "neq") return x !== v;
      if (name === "in") return (v as unknown[]).includes(x);
      if (name === "is") return (x ?? null) === v;
      if (["lt", "lte", "gt", "gte"].includes(name)) {
        if (x == null) return false;
        const c = typeof x === "number" && typeof v === "number" ? x - v : String(x) < String(v) ? -1 : String(x) > String(v) ? 1 : 0;
        return name === "lt" ? c < 0 : name === "lte" ? c <= 0 : name === "gt" ? c > 0 : c >= 0;
      }
      if (name === "or") return split(String(col)).some((t) => term(t, r));
      return true;
    });

  const run = (call: Call) => {
    const error = o.fail?.(call);
    if (error) return { data: null, error: typeof error === "string" ? { message: error } : error, count: null };
    const all = (tables[call.table] ??= []);
    let rows: Row[];
    if (call.op === "insert" || call.op === "upsert") {
      const list = (Array.isArray(call.values) ? call.values : [call.values]) as Row[];
      const key = String(call.options?.onConflict ?? "id");
      rows = [];
      for (const v of list) {
        const had = v[key] !== undefined ? all.find((r) => r[key] === v[key]) : undefined;
        if (had) {
          if (call.op === "upsert" && !call.options?.ignoreDuplicates) rows.push(Object.assign(had, v));
          continue;
        }
        const row = { id: `row-${++seq}`, sent_ids: [], report_ids: [], status: "open", ...v };
        all.push(row);
        rows.push(row);
      }
    } else {
      rows = all.filter((r) => matches(call, r));
      if (call.op === "update") for (const r of rows) Object.assign(r, call.values);
      if (call.op === "delete") tables[call.table] = all.filter((r) => !rows.includes(r));
    }
    const limit = call.ops.find(([n]) => n === "limit");
    if (limit) rows = rows.slice(0, Number(limit[1]));
    const one = call.ops.some(([n]) => n === "single" || n === "maybeSingle");
    const head = call.ops.some(([n, , opts]) => n === "select" && (opts as { head?: boolean } | undefined)?.head);
    return { data: head ? null : one ? rows[0] ?? null : rows, error: null, count: rows.length };
  };

  const from = (table: string) => {
    const call: Call = { table, op: "select", ops: [] };
    calls.push(call);
    // deno-lint-ignore no-explicit-any
    const q: any = {
      insert: (v: unknown) => ((call.op = "insert"), (call.values = v), q),
      update: (v: unknown) => ((call.op = "update"), (call.values = v), q),
      upsert: (v: unknown, options?: Record<string, unknown>) => ((call.op = "upsert"), (call.values = v), (call.options = options), q),
      delete: () => ((call.op = "delete"), q),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve().then(() => run(call)).then(ok, bad),
    };
    for (const m of ["select", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "ilike", "or", "not", "order", "limit", "contains", "single", "maybeSingle"]) {
      q[m] = (...a: unknown[]) => (call.ops.push([m, ...a]), q);
    }
    return q;
  };

  const rpc = async (name: string, args: Record<string, unknown> = {}) => ({ data: o.rpc?.[name] ? o.rpc[name]!(args, tables) : null, error: null });
  return { db: { from, rpc } as unknown as Db, calls, tables };
}
