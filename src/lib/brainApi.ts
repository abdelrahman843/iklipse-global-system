import { supabase } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// iklipse brain (0119, 0120): Claude on the Agent SDK as the bot's one mind
// on WhatsApp (the team, and clients at phase 3). Admins see its settings, what it spent today and its runs (each
// with the tools it used and the OKs it asked for), and change the settings
// (Alerts > Brain). Everything else about it is on WhatsApp.
// -----------------------------------------------------------------------------

/** Every Claude the API key can use (GET /v1/models, 2026-10-25); 0124 lists the same. */
export const BRAIN_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
] as const;
export type BrainModel = (typeof BRAIN_MODELS)[number];

export interface BrainSettings {
  phase: 0 | 1 | 2 | 3;
  stopped: boolean;
  /** The brain down: the old bot answers (else the person hears it's down). */
  fallback_old: boolean;
  stopped_at: string | null;
  stopped_by: string | null;
  /** Every WhatsApp number of the super admins (kept from owner_users). */
  owner_phones: string[];
  /** The super admins, by account. */
  owner_users: string[];
  model_owner: BrainModel;
  model_member: BrainModel;
  model_fast: BrainModel;
  max_turns: number;
  member_turns: number;
  run_minutes: number;
  run_cost_usd: number;
  day_cost_usd: number;
  updated_at: string;
}

export interface BrainRun {
  id: string;
  chat_id: string;
  asker_name: string | null;
  tier: "owner" | "admin" | "member" | "client";
  via: string | null;
  request: string | null;
  model: string | null;
  status: "queued" | "running" | "done" | "failed" | "stopped" | "timeout" | "budget" | "fallback";
  turns: number | null;
  cost_usd: number;
  ms: number | null;
  error: string | null;
  edits: number;
  created_at: string;
  finished_at: string | null;
  steps: number;
}

/** Someone who can be a super admin (on the team). */
export interface BrainPerson {
  id: string;
  name: string;
  role: "admin" | "member";
}

export interface BrainOverview {
  settings: BrainSettings;
  people?: BrainPerson[];
  today_cost: number;
  waiting: number;
  runs: BrainRun[];
}

export interface BrainStep {
  id: number;
  at: string;
  tool: string;
  input: string | null;
  outcome: string;
  detail: string | null;
  approval_id: string | null;
}

export interface BrainApproval {
  id: string;
  tool: string;
  what: string;
  why: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
  done_at: string | null;
  result: string | null;
}

/** Settings, today, and the last runs (up to 500). */
export async function fetchBrain(limit = 100): Promise<BrainOverview> {
  const { data, error } = await supabase.rpc("brain_admin", { p_limit: limit });
  if (error) throw error;
  return data as BrainOverview;
}

export async function fetchBrainSteps(runId: string): Promise<{ steps: BrainStep[]; approvals: BrainApproval[] }> {
  const { data, error } = await supabase.rpc("brain_steps", { p_run: runId });
  if (error) throw error;
  return data as { steps: BrainStep[]; approvals: BrainApproval[] };
}

export type BrainPatch = Partial<Pick<BrainSettings, "phase" | "stopped" | "fallback_old" | "owner_users" | "model_owner" | "model_member" | "model_fast" | "max_turns" | "member_turns" | "run_minutes" | "run_cost_usd" | "day_cost_usd">>;

export async function saveBrainSettings(p: BrainPatch) {
  const { error } = await supabase.rpc("brain_settings_set", { p });
  if (error) throw error;
}
