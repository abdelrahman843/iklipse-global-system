// What changed in iklipse lately, so the brain knows: every 10 minutes the
// working copy fetches main from GitHub (fast-forwarding main when that's
// what is checked out and nothing is changed in it), and the last merged PRs
// (date, title, the first line of what they did) go into the instructions.
// A new merge makes a new list, and so a fresh session (instructionsVersion):
// no conversation goes on without knowing about it.

import { syncMain, mergedLately, type GitHub, type Merged } from "./github.js";

const EVERY_MS = 10 * 60_000;
let latest: Merged[] = [];

/** The list for the instructions ("" before the first fetch, or without GitHub). */
export function changesText(list: Merged[] = latest): string {
  return list.map((c) => `- ${c.date} #${c.number} ${c.title}${c.what ? `: ${c.what}` : ""}`).join("\n");
}

export async function refreshChanges(g: GitHub, log: (e: Record<string, unknown>) => void): Promise<void> {
  try {
    const s = await syncMain(g);
    latest = await mergedLately(g);
    if (s.moved) log({ ev: "brain.main_synced", to: s.head });
  } catch (e) {
    log({ ev: "brain.changes_failed", why: (e as Error).message.slice(0, 300) });
  }
}

/** Now, then every 10 minutes. */
export function watchChanges(g: GitHub, log: (e: Record<string, unknown>) => void): () => void {
  void refreshChanges(g, log);
  const t = setInterval(() => void refreshChanges(g, log), EVERY_MS);
  t.unref?.();
  return () => clearInterval(t);
}
