// What a Claude call costs, for the bot's numbers (Alerts > Metrics) and the
// eval runner (scripts/bot/evals). Anthropic's list prices in US dollars per
// million tokens, October 2026; cache writes are the 5-minute ones (the bot's
// cache). Haiku 5.5 costs more for prompts over 100K tokens; the bot's are far
// smaller. Check anthropic.com/pricing before budgeting on these.

export interface AiPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const AI_PRICES: Record<string, AiPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export interface AiUse {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** The cost of some calls in dollars; null for a model with no price here. */
export function aiCost(u: AiUse): number | null {
  const p = AI_PRICES[u.model];
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cache_read * p.cacheRead + u.cache_write * p.cacheWrite) / 1_000_000;
}
