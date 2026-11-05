// Every connection the system lives on, watched (0142): each is checked every 5
// minutes, what happens to it is logged (connection_event), and its state kept
// (connection_state). What can be fixed by itself is tried, up to 3 times. Down
// for two checks in a row, the super admin is told what's down and how to bring
// it back, again every 6 hours while it stays down, and told when it's back:
// in the master group, and on their phone too when WhatsApp, the brain or the
// server is what's down. docs/operations/recovery.md says what to do for each.

import { iso, MIN, str, type Db } from "./kit.ts";

export interface Check {
  service: string;
  label: string;
  ok: boolean;
  error?: string | null;
  /** What a person does to bring it back. */
  how?: string;
  /** Tried by itself while it's down. */
  fix?: () => Promise<void>;
  /** Says something only if it worked before (a worker never signed in isn't down). */
  onlyIfItWorked?: boolean;
}

interface Row {
  service: string;
  ok: boolean;
  since: string;
  fails: number;
  fixes: number;
  alerted_at: string | null;
  ever_ok: boolean;
}

export const ALERT_AFTER = 2;
export const AGAIN_MS = 6 * 60 * MIN;
const MAX_FIXES = 3;

const minutesSince = (at: string, now: number) => Math.max(1, Math.round((now - Date.parse(at)) / MIN));

/** One check's result: kept and logged, fixed if it can be, and said when it should be. */
export async function note(db: Db, c: Check, tell: (text: string, c: Check) => Promise<void>, now = Date.now()) {
  const { data } = await db.from("connection_state").select("service, ok, since, fails, fixes, alerted_at, ever_ok").eq("service", c.service).maybeSingle();
  const was = data ? ({ ...data } as Row) : null;
  const at = iso(now);
  const log = (error: string | null, fixed_by: string | null = null) => db.from("connection_event").insert({ service: c.service, ok: c.ok, error, fixed_by, at });
  if (c.ok) {
    await db.from("connection_state").upsert({ service: c.service, label: c.label, ok: true, since: was?.ok === false ? at : (was?.since ?? at), checked_at: at, error: null, fails: 0, fixes: 0, alerted_at: null, ever_ok: true }, { onConflict: "service" });
    if (was?.ok === false) {
      await log(null);
      if (was.alerted_at) await tell(`✅ ${c.label} is back, after ${minutesSince(was.since, now)} min.`, c);
    }
    return;
  }
  const down = was?.ok === false;
  const error = str(c.error).slice(0, 300) || "not answering";
  const fails = (down ? was.fails : 0) + 1;
  let fixes = down ? was.fixes : 0;
  if (!down) await log(error);
  if (c.fix && fixes < MAX_FIXES) {
    fixes++;
    const tried = await c.fix().then(() => "tried by itself", (e) => `tried by itself, failed: ${(e as Error).message}`.slice(0, 200));
    await log(error, tried);
  }
  const ever = was?.ever_ok ?? false;
  const sayIt = fails >= ALERT_AFTER && (!c.onlyIfItWorked || ever) && (!was?.alerted_at || now - Date.parse(was.alerted_at) >= AGAIN_MS);
  const since = down ? was.since : at;
  await db.from("connection_state").upsert({ service: c.service, label: c.label, ok: false, since, checked_at: at, error, fails, fixes, alerted_at: sayIt ? at : (was?.alerted_at ?? null), ever_ok: ever }, { onConflict: "service" });
  if (sayIt) await tell([`⚠️ ${c.label} is down, ${minutesSince(since, now)} min now: ${error}.`, ...(c.fix ? [`Tried to fix it ${fixes} time${fixes === 1 ? "" : "s"}.`] : []), ...(c.how ? [c.how] : [])].join("\n"), c);
}

/** A connection seen by what it just did (the master's poll): only that it's up, at most once a minute. */
export async function seen(db: Db, service: string, now = Date.now()) {
  const { data } = await db.from("connection_state").update({ seen_at: iso(now) }).eq("service", service).or(`seen_at.is.null,seen_at.lt.${iso(now - MIN)}`).select("service");
  if (data?.length) return;
  const { data: row } = await db.from("connection_state").select("service").eq("service", service).maybeSingle();
  if (!row) await db.from("connection_state").insert({ service, label: service, ok: true, since: iso(now), checked_at: iso(now), seen_at: iso(now), ever_ok: true });
}

/** What the master says of its signed-in workers. */
export function workerChecks(health: unknown): Check[] {
  if (!health || typeof health !== "object") return [];
  const names: Record<string, string> = { claude: "Claude on the server", grok: "Grok on the server", gpt: "GPT on the server", jev: "Jev" };
  return Object.entries(health as Record<string, unknown>)
    .filter(([k]) => names[k])
    .map(([k, v]) => ({
      service: `worker:${k}`,
      label: names[k]!,
      ok: v === true,
      error: "not signed in",
      how: k === "jev" ? "Put the key back in /etc/claude-me/jev.key on the server." : "Sign in again on the server (/logins in the group shows how).",
      onlyIfItWorked: true,
    }));
}

/** A check that fetches: whatever goes wrong is the answer. */
export async function reachable(service: string, label: string, how: string, look: () => Promise<Response>): Promise<Check> {
  try {
    const res = await look();
    return { service, label, how, ok: res.ok, error: res.ok ? null : `answered ${res.status}` };
  } catch (e) {
    return { service, label, how, ok: false, error: (e as Error).message };
  }
}

/** A Google login still works: its refresh token gets a token. */
export async function googleLogin(service: string, label: string, refreshToken: string, id: string, secret: string, f: typeof fetch = fetch): Promise<Check> {
  const how = `Connect ${label.split(": ").pop()} again in Apps.`;
  try {
    const res = await f("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => ({}));
    return { service, label, how, ok: res.ok, error: res.ok ? null : str(j.error_description) || str(j.error) || `answered ${res.status}` };
  } catch (e) {
    return { service, label, how, ok: true, error: `couldn't ask Google: ${(e as Error).message}` };
  }
}
