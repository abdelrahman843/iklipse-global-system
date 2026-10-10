import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Zoom and Gmail accounts each person connects (0052, edge functions zoom and
// gmail). Tokens never reach the browser: my_connections() says what's
// connected, and every Zoom / Gmail call goes through the functions.
// -----------------------------------------------------------------------------

export interface GmailAccount {
  id: string;
  email: string;
  name: string | null;
  connected_at: string;
  /** This account sends the workspace's notification emails. */
  sends_notifications: boolean;
}

export interface Connections {
  zoom: { email: string | null; connected_at: string } | null;
  gmail: GmailAccount[];
}

export async function fetchConnections(): Promise<Connections> {
  const { data, error } = await supabase.rpc("my_connections");
  if (error) throw error;
  const c = (data ?? {}) as Partial<Connections>;
  return { zoom: c.zoom ?? null, gmail: c.gmail ?? [] };
}

/** Calls one of the functions; their own error message comes back as the Error. */
export async function callFunction<T>(name: "zoom" | "gmail", body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const msg = await error.context
        .json()
        .then((j: { error?: string }) => j?.error)
        .catch(() => null);
      throw new Error(msg || "Something went wrong. Try again.");
    }
    throw new Error(/fetch|network|offline/i.test(error.message) ? "This needs an internet connection." : error.message);
  }
  return data as T;
}

/** Where Zoom / Google send the browser back: this app's Connected accounts page. */
const returnTo = () => `${location.origin}${location.pathname}#/connections`;

/** Off to Zoom's / Google's consent page (comes back to /connections?<provider>=...). */
export async function startConnect(provider: "zoom" | "gmail") {
  const { url } = await callFunction<{ url: string }>(provider, { action: "connect", returnTo: returnTo() });
  window.location.assign(url);
}

export async function disconnectZoom() {
  await callFunction("zoom", { action: "disconnect" });
}

export async function disconnectGmail(account: string) {
  await callFunction("gmail", { action: "disconnect", account });
}

/** Admin: notification emails go out from this account (null = back to n8n). */
export async function setNotifyGmail(account: string | null) {
  const { error } = await supabase.rpc("admin_set_notify_gmail", { p_account: account });
  if (error) throw error;
}

/** What the provider's return (?zoom= / ?gmail=) means, for the toast. */
export const RETURN_MESSAGES: Record<string, { kind: "success" | "error"; title: string; description?: string }> = {
  "zoom:connected": { kind: "success", title: "Zoom connected" },
  "zoom:denied": { kind: "error", title: "Zoom wasn't connected", description: "You cancelled on Zoom's page." },
  "zoom:error": { kind: "error", title: "Couldn't connect Zoom", description: "Try again in a moment." },
  "gmail:connected": { kind: "success", title: "Gmail connected" },
  "gmail:denied": { kind: "error", title: "Gmail wasn't connected", description: "You cancelled on Google's page." },
  "gmail:missing_scope": {
    kind: "error",
    title: "Gmail wasn't connected",
    description: "Tick the box that lets iklipse read, write and send email, then try again.",
  },
  "gmail:too_many": { kind: "error", title: "Gmail wasn't connected", description: "You can connect up to 10 Gmail accounts." },
  "gmail:error": { kind: "error", title: "Couldn't connect Gmail", description: "Try again in a moment." },
};
