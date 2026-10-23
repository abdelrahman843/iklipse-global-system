// Calls that can fail for a moment (Anthropic busy, a network blink, a
// database hiccup) are tried again: only when the error says it's passing, a
// few times, further apart each time, and never past a deadline. Anything
// else fails right away. Nothing here knows Deno or the database, so it's
// tested on its own (retry.test.ts).

export interface RetryOptions {
  /** Tries after the first. */
  retries: number;
  /** The first wait; about twice that the next time, and so on. */
  baseMs: number;
  /** No wait is longer than this. */
  maxMs: number;
  /** No new try starts after this (ms since 1970). */
  deadline?: number;
  /** The error is passing, so trying again can help. */
  transient: (e: unknown) => boolean;
  /** How long the error itself asks to wait (Retry-After), when it says. */
  waitHint?: (e: unknown) => number | null;
  onRetry?: (attempt: number, waitMs: number, e: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** fn, tried again on passing errors as o says; the last error when it never works. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? pause;
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= o.retries || !o.transient(e)) throw e;
      const hint = o.waitHint?.(e);
      const wait = Math.min(o.maxMs, Math.max(0, hint ?? o.baseMs * 2 ** attempt * (0.8 + 0.4 * random())));
      if (o.deadline !== undefined && now() + wait >= o.deadline) throw e;
      o.onRetry?.(attempt + 1, wait, e);
      await sleep(wait);
    }
  }
}

/**
 * HTTP answers worth another try: a timeout, too many requests, the server's
 * own trouble (500s, Anthropic's 529 "overloaded"). 0: no answer at all.
 */
export const transientStatus = (status: number) =>
  status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status !== 501 && status !== 505);

/** A Retry-After header (seconds, or a date) in ms; null when there's none or it can't be read. */
export function retryAfterMs(v: string | null | undefined, now = Date.now()): number | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
