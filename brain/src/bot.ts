// The whatsapp-bot function's API for the brain (brain-tools.ts there):
// POST <BOT_URL>/brain-tools/<name>, signed. Every tool acts as the run's
// asker and is checked there; the brain holds no database key.

import { signature } from "./sign.js";

/** The function said no, or failed. maybeDone: it may have happened anyway. */
export class BotError extends Error {
  constructor(
    message: string,
    readonly maybeDone = false,
  ) {
    super(message);
  }
}

export interface BotClient {
  call<T = Record<string, unknown>>(name: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export function botClient(o: { url: string; secret: string; fetch?: typeof fetch }): BotClient {
  const f = o.fetch ?? fetch;
  return {
    async call<T>(name: string, payload: Record<string, unknown>, timeoutMs = 90_000): Promise<T> {
      const body = JSON.stringify(payload);
      let res: Response;
      try {
        res = await f(`${o.url}/brain-tools/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-brain-signature": signature(o.secret, "to-bot", body) },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new BotError(`iklipse didn't answer (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message}).`, true);
      }
      const out = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string; maybe_done?: boolean } & Record<string, unknown>) | null;
      if (!out) throw new BotError(`iklipse answered ${res.status}.`, res.status >= 500);
      if (!out.ok) throw new BotError(out.error ?? `iklipse answered ${res.status}.`, out.maybe_done === true);
      return out as T;
    },
  };
}
