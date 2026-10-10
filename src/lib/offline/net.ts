// -----------------------------------------------------------------------------
// Is the server reachable right now?
//
// navigator.onLine only knows about the network cable / Wi-Fi: on a hotel
// Wi-Fi with no internet, or a phone with one bar, it still says "online".
// So requests report back here too: a request that fails for lack of network
// marks us offline at once, and a quick health check then watches for the way
// back (every few seconds, slower over time).
// -----------------------------------------------------------------------------

import { useSyncExternalStore } from "react";

type Listener = (online: boolean) => void;

let online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
const subs = new Set<Listener>();
let probeUrl: string | null = null;
let probeKey = "";
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeDelay = 2000;

export const isOnline = () => online;

export function onConnectivity(fn: Listener): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Re-renders when the server becomes reachable / unreachable. */
export function useIsOnline(): boolean {
  return useSyncExternalStore(onConnectivity, isOnline, () => true);
}

/** Message for a screen whose data was never loaded on this device. */
export const NOT_ON_DEVICE = {
  title: "Not on this device yet",
  description: "This hasn't been opened here with a connection, so there's no offline copy. It opens as soon as you're back online.",
};

function set(v: boolean) {
  if (v === online) return;
  online = v;
  for (const f of subs) f(v);
  if (!v) {
    probeDelay = 2000;
    scheduleProbe();
  }
}

/** A request failed for lack of network. */
export function reportOffline() {
  set(false);
}

/** A request got an answer from the server (any status). */
export function reportOnline() {
  if (navigator.onLine !== false) set(true);
}

/** The server to probe once offline (set by supabase.ts). */
export function configureProbe(supabaseUrl: string, anonKey: string) {
  probeUrl = `${supabaseUrl.replace(/\/$/, "")}/auth/v1/health`;
  probeKey = anonKey;
}

/** Plain fetch, captured before anything wraps it. */
const rawFetch: typeof fetch = (...a) => fetch(...a);

async function probe() {
  probeTimer = null;
  if (online) return;
  if (navigator.onLine === false || !probeUrl) return; // the "online" event restarts us
  try {
    await rawFetch(probeUrl, { headers: { apikey: probeKey }, cache: "no-store" });
    set(true);
    return;
  } catch {
    /* still unreachable */
  }
  probeDelay = Math.min(30_000, probeDelay * 1.6);
  scheduleProbe();
}

function scheduleProbe(ms = probeDelay) {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(() => void probe(), ms);
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => set(false));
  // The OS says the network is back: check the server right away.
  window.addEventListener("online", () => {
    probeDelay = 2000;
    if (!online) scheduleProbe(0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !online) scheduleProbe(0);
  });
}
