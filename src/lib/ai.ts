import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { AiModel, BoardVisibility } from "@/lib/database.types";

// -----------------------------------------------------------------------------
// AI assistant client. The browser never sees the OpenAI key: ai_start()
// checks permissions and queues the request inside the database (pg_net),
// then we poll ai_poll() until the answer lands. See migration 0014.
// -----------------------------------------------------------------------------

export type AiWriteMode = "improve" | "fix" | "shorten" | "expand" | "summarize" | "action_items";

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
  /** enabled && configured — show AI entry points only when true. */
  available: boolean;
  model: AiModel;
  // Admin only:
  key_hint?: string | null;
  requests_30d?: number;
  tokens_30d?: number;
}

export interface AiChecklist {
  name: string;
  items: string[];
}

export interface AiBoardPlan {
  title: string;
  description?: string;
  lists: { title: string; cards: { title: string; description?: string }[] }[];
}

export const AI_MODELS: { value: AiModel; label: string; hint: string }[] = [
  { value: "gpt-4o-mini", label: "GPT-4o mini", hint: "Fast and cheapest" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini", hint: "Fast, better writing" },
  { value: "gpt-4o", label: "GPT-4o", hint: "Stronger, costs more" },
  { value: "gpt-4.1", label: "GPT-4.1", hint: "Stronger, costs more" },
  { value: "gpt-5-mini", label: "GPT-5 mini", hint: "Smart, slower" },
  { value: "gpt-5", label: "GPT-5", hint: "Smartest, slowest" },
];

export const AI_WRITE_MODES: { value: AiWriteMode; label: string }[] = [
  { value: "improve", label: "Improve writing" },
  { value: "fix", label: "Fix spelling & grammar" },
  { value: "shorten", label: "Make shorter" },
  { value: "expand", label: "Make longer" },
  { value: "summarize", label: "Summarize" },
  { value: "action_items", label: "Find action items" },
];

export async function fetchAiStatus(): Promise<AiStatus> {
  const { data, error } = await supabase.rpc("ai_status");
  if (error) throw error;
  return data as AiStatus;
}

export function useAiStatus() {
  return useQuery({ queryKey: ["ai-status"], queryFn: fetchAiStatus, staleTime: 60_000 });
}

export async function setAiKey(key: string | null) {
  const { error } = await supabase.rpc("ai_set_key", { p_key: key });
  if (error) throw error;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run<T>(
  action: "write" | "checklist" | "summary" | "board" | "ping",
  args: { board?: string; card?: string; text?: string; mode?: string },
  signal?: AbortSignal,
): Promise<T> {
  const { data: id, error } = await supabase.rpc("ai_start", {
    p_action: action,
    p_board: args.board ?? null,
    p_card: args.card ?? null,
    p_text: args.text ?? null,
    p_mode: args.mode ?? null,
  });
  if (error) throw new Error(error.message);

  const started = Date.now();
  let wait = 700;
  while (Date.now() - started < 150_000) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    await sleep(wait);
    wait = Math.min(wait + 300, 2000);
    const { data, error: pollErr } = await supabase.rpc("ai_poll", { p_id: id as string });
    if (pollErr) throw new Error(pollErr.message);
    const r = data as { status: "pending" | "done" | "error"; result: unknown; error: string | null };
    if (r.status === "done") return r.result as T;
    if (r.status === "error") throw new Error(r.error ?? "AI request failed");
  }
  throw new Error("The AI took too long to answer. Try again.");
}

export const ai = {
  write: (cardId: string, text: string, mode: AiWriteMode, signal?: AbortSignal) =>
    run<string>("write", { card: cardId, text, mode }, signal),
  checklist: (cardId: string, signal?: AbortSignal) => run<AiChecklist>("checklist", { card: cardId }, signal),
  summary: (cardId: string, signal?: AbortSignal) => run<string>("summary", { card: cardId }, signal),
  board: (goal: string, signal?: AbortSignal) => run<AiBoardPlan>("board", { text: goal }, signal),
  ping: () => run<string>("ping", {}),
};

export async function createBoardFromPlan(plan: AiBoardPlan, visibility: BoardVisibility): Promise<string> {
  const { data, error } = await supabase.rpc("create_board_from_plan", { p_plan: plan, p_visibility: visibility });
  if (error) throw error;
  return data as string;
}
