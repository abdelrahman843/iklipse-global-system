// The Trello and Miro boards for the brain (brain-tools.ts): the mcp
// function's tools, called as the person who asked, so the database's
// row-level security decides what they may see and change, exactly as in the
// app and for ChatGPT and Claude. For each call a short session is opened for
// them (a magic link made and used here, never sent anywhere) and signed out
// again right after, only that one session (scope local): their own sessions
// stay as they are.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { env, str, type Db } from "./kit.ts";

const SUPABASE = () => env("SUPABASE_URL");
const ANON = () => env("SUPABASE_ANON_KEY");

export interface BoardTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export class BoardsRefused extends Error {}

/** A session as them for the length of fn, signed out after (that session only). */
export async function asThem<T>(db: Db, userId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const { data: u, error } = await db.auth.admin.getUserById(userId);
  const email = str(u?.user?.email);
  if (error || !email) throw new BoardsRefused("Their iklipse account has no sign-in email, so the boards can't be opened as them.");
  const { data: link, error: e2 } = await db.auth.admin.generateLink({ type: "magiclink", email });
  const hashed = str((link as { properties?: { hashed_token?: string } } | null)?.properties?.hashed_token);
  if (e2 || !hashed) throw new BoardsRefused("Couldn't open the boards as them.");
  const them = createClient(SUPABASE(), ANON(), { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: v, error: e3 } = await them.auth.verifyOtp({ token_hash: hashed, type: "magiclink" });
  const token = str(v?.session?.access_token);
  if (e3 || !token) throw new BoardsRefused("Couldn't open the boards as them.");
  try {
    return await fn(token);
  } finally {
    await them.auth.signOut({ scope: "local" }).catch(() => null);
  }
}

/** One JSON-RPC call to the mcp function with their token. */
async function rpc(token: string, method: string, params: Record<string, unknown>, f: typeof fetch = fetch) {
  const res = await f(`${SUPABASE()}/functions/v1/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const out = (await res.json().catch(() => null)) as { result?: Record<string, unknown>; error?: { message?: string } } | null;
  if (!res.ok || !out || out.error) throw new BoardsRefused(str(out?.error?.message) || `The boards answered ${res.status}.`);
  return out.result ?? {};
}

/** The board tools there are (names, what they do, what they take), as they see them. */
export async function boardTools(token: string, f: typeof fetch = fetch): Promise<BoardTool[]> {
  const r = await rpc(token, "tools/list", {}, f);
  return ((r.tools ?? []) as { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }[]).map((t) => ({
    name: t.name,
    description: str(t.description),
    inputSchema: t.inputSchema ?? {},
    readOnly: t.annotations?.readOnlyHint === true,
  }));
}

/** One board tool, as them. What it gave, or what went wrong (a problem they can fix comes back as its words). */
export async function boardCall(token: string, name: string, args: Record<string, unknown>, f: typeof fetch = fetch): Promise<{ text: string; error: boolean }> {
  const r = await rpc(token, "tools/call", { name, arguments: args }, f);
  const text = ((r.content ?? []) as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => str(c.text)).join("\n");
  return { text: text.slice(0, 14_000), error: r.isError === true };
}
