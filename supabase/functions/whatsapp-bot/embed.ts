// Embeddings for search by meaning (search.ts, 0113): numbers that say what a
// piece of text means, so "is the video done?" finds "الفيديو لسه هيخلص بكرة".
// Claude doesn't make them, so it's another provider, picked by the owner
// with the secrets (nothing is set by default, and search is keywords only):
//   EMBED_PROVIDER  voyage | openai
//   VOYAGE_API_KEY or OPENAI_API_KEY
//   EMBED_MODEL     optional: voyage-4 (default), voyage-4-lite, voyage-4-large;
//                   text-embedding-3-small (default), text-embedding-3-large
// Every model gives 1024 numbers (bot_search_chunk.embedding). A text is
// embedded as a document when kept, and as a query when searched for.

import { env } from "./kit.ts";

export const DIMS = 1024;
/** At most this many texts a call. */
export const BATCH = 128;

export interface Embedder {
  provider: string;
  model: string;
  embed(texts: string[], kind: "document" | "query", timeoutMs?: number): Promise<number[][]>;
}

/** Reads the provider's answer: the embeddings in the order asked, or why not. */
async function vectors(res: Response, n: number): Promise<number[][]> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${res.status} ${str(body?.detail ?? body?.error?.message ?? body?.message ?? res.statusText)}`.slice(0, 300));
  const out: number[][] = [];
  for (const d of (body?.data ?? []) as { embedding: number[]; index: number }[]) out[d.index] = d.embedding;
  if (out.length !== n || out.some((e) => !Array.isArray(e) || e.length !== DIMS)) throw new Error(`expected ${n} embeddings of ${DIMS}`);
  return out;
}
const str = (x: unknown) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x));

/** Voyage AI (docs.voyageai.com/reference/embeddings-api): input_type query or document, 1024 numbers. */
function voyage(key: string, model: string): Embedder {
  return {
    provider: "voyage",
    model,
    embed: async (texts, kind, timeoutMs = 30_000) =>
      await vectors(
        await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ input: texts, model, input_type: kind, output_dimension: DIMS }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
        texts.length,
      ),
  };
}

/** OpenAI (text-embedding-3): dimensions cut to 1024. It has no query or document kind. */
function openai(key: string, model: string): Embedder {
  return {
    provider: "openai",
    model,
    embed: async (texts, _kind, timeoutMs = 30_000) =>
      await vectors(
        await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ input: texts, model, dimensions: DIMS }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
        texts.length,
      ),
  };
}

/** The provider the secrets name, or null: no provider, no key, or one this doesn't know. */
export function embedder(get: (k: string) => string = (k) => env(k)): Embedder | null {
  const provider = get("EMBED_PROVIDER").trim().toLowerCase();
  if (provider === "voyage" && get("VOYAGE_API_KEY")) return voyage(get("VOYAGE_API_KEY"), get("EMBED_MODEL") || "voyage-4");
  if (provider === "openai" && get("OPENAI_API_KEY")) return openai(get("OPENAI_API_KEY"), get("EMBED_MODEL") || "text-embedding-3-small");
  if (provider) console.error("embed", `EMBED_PROVIDER "${provider}" needs its key, or isn't voyage or openai`);
  return null;
}
