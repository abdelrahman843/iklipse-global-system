// A stand-in for the Supabase client in tests: tables are arrays of rows in
// memory; eq, neq, in, is and limit filter them, insert, update, upsert and
// delete change them, and every query is recorded (calls) so a test can see
// what was asked (the filters find added for who may see what). The other
// filters (or, ilike, order...) are recorded, not applied.

import type { Db } from "../kit.ts";

type Row = Record<string, unknown>;

export interface Call {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  values?: unknown;
  options?: Record<string, unknown>;
  ops: [string, ...unknown[]][];
}

export function fakeDb(tables: Record<string, Row[]> = {}, o: { fail?: (c: Call) => string | null } = {}) {
  const calls: Call[] = [];
  let seq = 0;
  const matches = (call: Call, r: Row) =>
    call.ops.every(([name, col, v]) => {
      const x = r[col as string];
      if (name === "eq") return x === v;
      if (name === "neq") return x !== v;
      if (name === "in") return (v as unknown[]).includes(x);
      if (name === "is") return (x ?? null) === v;
      return true;
    });

  const run = (call: Call) => {
    const error = o.fail?.(call);
    if (error) return { data: null, error: { message: error }, count: null };
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

  return { db: { from, rpc: async () => ({ data: null, error: null }) } as unknown as Db, calls, tables };
}
